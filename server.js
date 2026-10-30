/**
 * server.js
 * -----------------------------------------------------------------------
 * Minimal WebRTC signaling server for the P2P Web File Sharing Terminal.
 *
 * Responsibilities (and ONLY these — no file data ever touches this
 * process):
 *   1. Let a "host" peer create a room and receive a short room code.
 *   2. Let a "guest" peer join that room with the code.
 *   3. Relay SDP offers/answers and ICE candidates between the two peers.
 *   4. Clean up rooms on disconnect and log every state transition.
 *
 * Dependencies: the `ws` package only (no Express, no heavy framework).
 *   npm install ws
 *   node server.js
 * -----------------------------------------------------------------------
 */

'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_PEERS_PER_ROOM = 2; // strict 1:1 pairing — this is a P2P transfer tool, not a chat room

const wss = new WebSocketServer({ port: PORT });

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

log('SERVER_UP', { port: PORT, url: `ws://localhost:${PORT}` });
