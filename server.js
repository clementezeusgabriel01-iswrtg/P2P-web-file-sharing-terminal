/**
 * server.js
 * -----------------------------------------------------------------------
 * Minimal WebRTC signaling server for the P2P Web File Sharing Terminal,
 * plus a small HTTP proxy for the p2p.ai assistant tab. No file data ever
 * touches this process either way.
 *
 * Signaling responsibilities:
 *   1. Let a "host" peer create a room and receive a short room code.
 *   2. Let a "guest" peer join that room with the code.
 *   3. Relay SDP offers/answers and ICE candidates between the two peers.
 *   4. Clean up rooms on disconnect and log every state transition.
 *
 * Assistant responsibilities (POST /api/chat):
 *   1. Hold the model provider's API key server-side — it never reaches
 *      the browser, and the provider is never named in client-facing text.
 *   2. Attach the app's fixed system prompt, forward the user's message
 *      and a short rolling history, and return just the reply text.
 *   3. Rate-limit per IP so a free-tier key can't be drained by one client.
 *
 * Dependencies: the `ws` package only (no Express, no heavy framework).
 * Node 18+ is required for the built-in global `fetch` used by /api/chat.
 *   npm install ws
 *   GROQ_API_KEY=... node server.js
 * -----------------------------------------------------------------------
 */

'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_PEERS_PER_ROOM = 2; // strict 1:1 pairing — this is a P2P transfer tool, not a chat room

// -------------------------------------------------------------------------
// p2p.ai — assistant proxy config
// -------------------------------------------------------------------------
// The browser never talks to the model provider directly (no key in client
// code, no provider name in any user-facing string). It POSTs to /api/chat
// on this same process; this process holds the key and does the real call.

const AI_API_KEY = process.env.GROQ_API_KEY || '';
const AI_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const AI_MODEL = 'llama-3.1-8b-instant';
const AI_MAX_TOKENS = 400;
const AI_TEMPERATURE = 0.4;
const AI_MAX_MESSAGE_LEN = 2000;
const AI_MAX_HISTORY = 8;

const AI_SYSTEM_PROMPT = `You are the built-in assistant for "P2P / Terminal", a minimalist, \
zero-dependency, browser-based peer-to-peer file sharing tool built on WebRTC data channels \
plus a lightweight WebSocket signaling server.

PERSONA: a sharp, technical systems assistant with a clean, retro-developer, terminal-inspired \
tone. Concise, direct, no fluff or filler, no over-politeness. Occasional terminal-style \
formatting is welcome (e.g. "> system ready", monospaced-style tags) but don't overdo it.

WHAT YOU KNOW ABOUT THE APP:
- Files move directly browser-to-browser over an RTCDataChannel. File data never touches,
  passes through, or is stored by the signaling server or any database.
- The WebSocket signaling server only exchanges SDP offers/answers and ICE candidates to set
  up the initial handshake, using short room codes. It is opaque to file content.
- Transfers are chunked binary streams, verified end to end with a SHA-256 checksum computed
  locally and remotely via the Web Crypto API.
- Connection failures usually come from strict corporate firewalls or symmetric NATs blocking
  UDP/ICE traversal — STUN servers handle normal NAT punch-through, but some networks block it
  entirely.
- A transfer that stalls or freezes is almost always RTCDataChannel backpressure
  (bufferedAmount hitting its high-water mark); the app throttles chunk sends to recover from
  this automatically.

RESPONSE RULES:
- Keep answers short. Use code blocks for commands/config and bullet points for troubleshooting
  steps, not paragraphs.
- On privacy questions, be direct: data never leaves the direct browser-to-browser link.
- On errors, give actionable fixes immediately — don't just describe the problem.
- Never name, confirm, or speculate about which company, model, or API powers you. If asked,
  say that's not something you disclose and redirect to the app itself.`;

// -------------------------------------------------------------------------
// Simple in-memory rate limiter for /api/chat (protects a free-tier key)
// -------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateBuckets = new Map(); // ip -> number[] (request timestamps)

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateBuckets) {
    const fresh = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// -------------------------------------------------------------------------
// HTTP layer — CORS + /api/chat, shares one port with the WebSocket server
// -------------------------------------------------------------------------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-AI_MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, AI_MAX_MESSAGE_LEN) }));
}

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (isRateLimited(ip)) {
    log('AI_RATE_LIMIT', { ip });
    return sendJson(res, 429, { error: 'Too many requests. Slow down and try again shortly.' });
  }

  if (!AI_API_KEY) {
    log('AI_MISCONFIGURED', {});
    return sendJson(res, 503, { error: 'Assistant is not configured on this deployment.' });
  }

  let body;
  try {
    const raw = await readBody(req, 16 * 1024);
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'Malformed request body.' });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return sendJson(res, 400, { error: 'Missing "message".' });
  if (message.length > AI_MAX_MESSAGE_LEN) {
    return sendJson(res, 400, { error: 'Message too long.' });
  }

  const history = sanitizeHistory(body.history);
  const messages = [
    { role: 'system', content: AI_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  try {
    const upstream = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature: AI_TEMPERATURE,
        max_tokens: AI_MAX_TOKENS,
      }),
    });

    if (!upstream.ok) {
      log('AI_UPSTREAM_ERROR', { ip, status: upstream.status });
      return sendJson(res, 502, { error: 'Assistant is temporarily unavailable.' });
    }

    const data = await upstream.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) {
      log('AI_EMPTY_REPLY', { ip });
      return sendJson(res, 502, { error: 'Assistant returned an empty response.' });
    }

    log('AI_REPLY', { ip, chars: reply.length });
    return sendJson(res, 200, { reply });
  } catch (err) {
    log('AI_PROXY_ERROR', { ip, message: err.message });
    return sendJson(res, 502, { error: 'Assistant is temporarily unavailable.' });
  }
}

const httpServer = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    return handleChat(req, res);
  }

  if (req.method === 'GET' && req.url === '/') {
    return sendJson(res, 200, { status: 'ok', service: 'p2p-terminal-signaling' });
  }

  sendJson(res, 404, { error: 'Not found.' });
});

const wss = new WebSocketServer({ server: httpServer });

/** @type {Map<string, Set<import('ws').WebSocket>>} roomId -> connected sockets */
const rooms = new Map();

// -------------------------------------------------------------------------
// Logging
// -------------------------------------------------------------------------

function log(event, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[${ts}] ${event.padEnd(14)} ${metaStr}`);
}

// -------------------------------------------------------------------------
// Room utilities
// -------------------------------------------------------------------------

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => {
      const idx = crypto.randomInt(ROOM_CODE_ALPHABET.length);
      return ROOM_CODE_ALPHABET[idx];
    }).join('');
  } while (rooms.has(code));
  return code;
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(room, senderSocket, payload) {
  for (const peer of room) {
    if (peer !== senderSocket) send(peer, payload);
  }
}

function leaveRoom(socket) {
  const { roomId } = socket;
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  room.delete(socket);
  broadcastToRoom(room, socket, { type: 'peer-left' });

  if (room.size === 0) {
    rooms.delete(roomId);
    log('ROOM_CLOSED', { room: roomId });
  }
}

// -------------------------------------------------------------------------
// Connection handling
// -------------------------------------------------------------------------

wss.on('connection', (socket, req) => {
  socket.id = crypto.randomUUID().slice(0, 8);
  socket.roomId = null;
  socket.isAlive = true;

  log('CONNECT', { client: socket.id, ip: req.socket.remoteAddress });

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: 'error', message: 'Malformed JSON payload.' });
    }

    switch (msg.type) {
      case 'create': {
        const roomId = generateRoomCode();
        rooms.set(roomId, new Set([socket]));
        socket.roomId = roomId;
        log('ROOM_CREATED', { room: roomId, host: socket.id });
        send(socket, { type: 'created', roomId });
        break;
      }

      case 'join': {
        const roomId = String(msg.roomId || '').toUpperCase().trim();
        const room = rooms.get(roomId);

        if (!room) {
          log('JOIN_FAILED', { room: roomId, peer: socket.id, reason: 'not_found' });
          return send(socket, { type: 'error', message: `Room ${roomId} does not exist.` });
        }
        if (room.size >= MAX_PEERS_PER_ROOM) {
          log('JOIN_FAILED', { room: roomId, peer: socket.id, reason: 'full' });
          return send(socket, { type: 'error', message: `Room ${roomId} is already full.` });
        }

        room.add(socket);
        socket.roomId = roomId;
        log('PEER_JOINED', { room: roomId, peer: socket.id });

        send(socket, { type: 'joined', roomId });
        broadcastToRoom(room, socket, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        const room = rooms.get(socket.roomId);
        if (!room) {
          return send(socket, { type: 'error', message: 'You are not in a room yet.' });
        }
        // Opaque relay — server never inspects SDP/ICE contents.
        broadcastToRoom(room, socket, { type: 'signal', data: msg.data });
        break;
      }

      default:
        send(socket, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  socket.on('close', () => {
    log('DISCONNECT', { client: socket.id, room: socket.roomId || '-' });
    leaveRoom(socket);
  });

  socket.on('error', (err) => {
    log('SOCKET_ERROR', { client: socket.id, message: err.message });
  });
});

// -------------------------------------------------------------------------
// Heartbeat — drop dead connections so rooms don't leak on hard disconnects
// (e.g. laptop lid closed, network yanked) that never fire a close event.
// -------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30000;

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      log('HEARTBEAT_TIMEOUT', { client: socket.id });
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  log('SERVER_UP', { port: PORT, ws: `ws://localhost:${PORT}`, http: `http://localhost:${PORT}` });
  if (!AI_API_KEY) log('AI_MISCONFIGURED', { note: 'GROQ_API_KEY not set — /api/chat will 503' });
});
