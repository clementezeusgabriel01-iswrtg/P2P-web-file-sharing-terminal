/**
 * server.js
 * -----------------------------------------------------------------------
 * Minimal WebRTC signaling server for the P2P Web File Sharing Terminal.
 *
 * Responsibilities (and ONLY these — no file data ever touches this
 * process):
 *   1. Let a "host" peer create a room and receive a short room code,
 *      optionally protected by a PIN.
 *   2. Let a "guest" peer join that room with the code (and PIN, if set).
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
const PIN_PATTERN = /^\d{4,8}$/; // 4-8 digit numeric PIN, matches client-side input[pattern]

const wss = new WebSocketServer({ port: PORT });

/**
 * roomId -> { sockets: Set<WebSocket>, pinHash: string|null }
 * pinHash is a SHA-256 hex digest, never the raw PIN — this process never
 * needs (and never stores) the PIN itself once the room is created.
 * @type {Map<string, { sockets: Set<import('ws').WebSocket>, pinHash: string|null }>}
 */
const rooms = new Map();

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

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

function broadcastToRoom(roomRecord, senderSocket, payload) {
  for (const peer of roomRecord.sockets) {
    if (peer !== senderSocket) send(peer, payload);
  }
}

function leaveRoom(socket) {
  const { roomId } = socket;
  if (!roomId || !rooms.has(roomId)) return;

  const roomRecord = rooms.get(roomId);
  roomRecord.sockets.delete(socket);
  broadcastToRoom(roomRecord, socket, { type: 'peer-left' });

  if (roomRecord.sockets.size === 0) {
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
        const pin = typeof msg.pin === 'string' ? msg.pin.trim() : '';
        if (pin && !PIN_PATTERN.test(pin)) {
          return send(socket, { type: 'error', code: 'BAD_PIN_FORMAT', message: 'PIN must be 4-8 digits.' });
        }

        const roomId = generateRoomCode();
        const pinHash = pin ? hashPin(pin) : null;
        rooms.set(roomId, { sockets: new Set([socket]), pinHash });
        socket.roomId = roomId;
        log('ROOM_CREATED', { room: roomId, host: socket.id, pin: pinHash ? 'yes' : 'no' });
        send(socket, { type: 'created', roomId, pinRequired: !!pinHash });
        break;
      }

      case 'join': {
        const roomId = String(msg.roomId || '').toUpperCase().trim();
        const roomRecord = rooms.get(roomId);

        if (!roomRecord) {
          log('JOIN_FAILED', { room: roomId, peer: socket.id, reason: 'not_found' });
          return send(socket, { type: 'error', code: 'ROOM_NOT_FOUND', message: `Room ${roomId} does not exist.` });
        }
        if (roomRecord.sockets.size >= MAX_PEERS_PER_ROOM) {
          log('JOIN_FAILED', { room: roomId, peer: socket.id, reason: 'full' });
          return send(socket, { type: 'error', code: 'ROOM_FULL', message: `Room ${roomId} is already full.` });
        }
        if (roomRecord.pinHash) {
          const suppliedPin = typeof msg.pin === 'string' ? msg.pin.trim() : '';
          // Reject silently-missing and wrong PINs the same way — don't
          // let a response difference tell a guesser "that part was right".
          if (!suppliedPin || hashPin(suppliedPin) !== roomRecord.pinHash) {
            log('JOIN_FAILED', { room: roomId, peer: socket.id, reason: 'bad_pin' });
            return send(socket, { type: 'error', code: 'BAD_PIN', message: 'Incorrect or missing PIN.' });
          }
        }

        roomRecord.sockets.add(socket);
        socket.roomId = roomId;
        log('PEER_JOINED', { room: roomId, peer: socket.id });

        send(socket, { type: 'joined', roomId });
        broadcastToRoom(roomRecord, socket, { type: 'peer-joined' });
        break;
      }

      case 'signal': {
        const roomRecord = rooms.get(socket.roomId);
        if (!roomRecord) {
          return send(socket, { type: 'error', message: 'You are not in a room yet.' });
        }
        // Opaque relay — server never inspects SDP/ICE contents.
        broadcastToRoom(roomRecord, socket, { type: 'signal', data: msg.data });
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
