/**
 * client.js
 * -----------------------------------------------------------------------
 * P2P::TERMINAL — client logic.
 *
 * Three jobs, kept in three clear sections:
 *   1. SIGNALING   — talk to server.js over WebSocket to find a peer.
 *   2. WEBRTC      — negotiate RTCPeerConnection + RTCDataChannel.
 *   3. TRANSFER    — chunk, send/receive, backpressure, SHA-256, download.
 *
 * Design note on memory: for simplicity and correctness, the sender reads
 * the whole file into one ArrayBuffer up front (file.arrayBuffer()) so the
 * same buffer can both be hashed (crypto.subtle.digest has no streaming
 * API) and sliced into chunks. That means peak memory use is roughly the
 * size of the file being sent, on both ends. Fine for a terminal utility;
 * for multi-GB files you'd swap this for a streaming hash (e.g. a JS
 * incremental SHA-256) and `file.slice()` reads straight off disk.
 * -----------------------------------------------------------------------
 */

(() => {
  'use strict';

  // =========================================================================
  // CONFIG
  // =========================================================================

  // Point this at your deployed Render service, e.g.:
  //   const SIGNALING_URL = 'wss://p2p-terminal-signaling.onrender.com';
  // Render terminates TLS on 443 and proxies internally to your app's PORT,
  // so no :port suffix goes here — just the bare host, scheme wss://.
  // (Only use the localhost fallback below while testing on one machine.)
  const SIGNALING_URL = 'wss://YOUR-RENDER-SERVICE-NAME.onrender.com';
  // const SIGNALING_URL = 'ws://localhost:8080'; // local testing fallback

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const CHUNK_SIZE = 64 * 1024;                 // 64 KB per data channel message
  const BUFFER_HIGH_WATER = 16 * 1024 * 1024;   // pause sending above this
  const BUFFER_LOW_WATER = 1 * 1024 * 1024;     // resume sending below this
  const UI_THROTTLE_MS = 100;                   // max metrics DOM update rate

  // =========================================================================
  // DOM REFS
  // =========================================================================

  const $ = (id) => document.getElementById(id);

  const el = {
    dotWs: $('dot-ws'), txtWs: $('txt-ws'),
    dotPeer: $('dot-peer'), txtPeer: $('txt-peer'),
    btnCreate: $('btn-create'),
    btnJoin: $('btn-join'),
    inputJoinCode: $('input-join-code'),
    roomCodeBox: $('room-code-box'),
    roomCodeValue: $('room-code-value'),
    btnCopy: $('btn-copy'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    log: $('terminal-log'),
    filename: $('stat-filename'),
    direction: $('stat-direction'),
    filesize: $('stat-filesize'),
    progressFill: $('progress-fill'),
    pct: $('stat-pct'),
    bytes: $('stat-bytes'),
    speed: $('stat-speed'),
    eta: $('stat-eta'),
    checksum: $('stat-checksum'),
    hashLocal: $('hash-local'),
    hashRemote: $('hash-remote'),
  };

  // =========================================================================
  // STATE
  // =========================================================================

  let ws = null;
  let pc = null;
  let dataChannel = null;
  let roomId = null;
  let isHost = false;

  /** Receiver-side accumulation state for the file currently inbound. */
  let inbound = null; // { name, size, mime, chunks: [], received, startTime }

  let lastUiTick = 0;

  // =========================================================================
  // LOG + STATUS HELPERS
  // =========================================================================

  function logLine(message, level = 'info') {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const row = document.createElement('div');
    row.className = 'log-line';
    row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-${level}">${escapeHtml(message)}</span>`;
    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function setWsStatus(state) {
    // state: 'off' | 'connecting' | 'on' | 'err'
    el.dotWs.className = 'dot ' + (state === 'on' ? 'on' : state === 'err' ? 'err' : state === 'connecting' ? 'warn' : 'off');
    el.txtWs.textContent = { off: 'OFFLINE', connecting: 'CONNECTING', on: 'ONLINE', err: 'ERROR' }[state];
  }

  function setPeerStatus(state) {
    // state: 'none' | 'waiting' | 'connected' | 'lost'
    el.dotPeer.className = 'dot ' + (state === 'connected' ? 'on' : state === 'waiting' ? 'warn' : state === 'lost' ? 'err' : 'off');
    el.txtPeer.textContent = { none: 'NONE', waiting: 'WAITING', connected: 'LINKED', lost: 'LOST' }[state];
  }

  // =========================================================================
  // FORMATTING UTILITIES
  // =========================================================================

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function formatSpeed(bytesPerSec) {
    return `${formatBytes(bytesPerSec)}/s`;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return '<1s';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function bufferToHex(buffer) {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // =========================================================================
  // TRANSFER UI
  // =========================================================================

  function resetTransferUi(name, size, direction) {
    el.filename.textContent = name;
    el.filesize.textContent = formatBytes(size);
    el.direction.textContent = direction;
    el.progressFill.style.width = '0%';
    el.pct.textContent = '0%';
    el.bytes.textContent = `0 B / ${formatBytes(size)}`;
    el.speed.textContent = '0 KB/s';
    el.eta.textContent = '—';
    el.checksum.textContent = 'pending';
    el.checksum.className = 'wait';
    el.hashLocal.textContent = '—';
    el.hashRemote.textContent = '—';
  }

  function updateTransferMetrics(done, total, startTime, force = false) {
    const now = performance.now();
    if (!force && now - lastUiTick < UI_THROTTLE_MS) return;
    lastUiTick = now;

    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const elapsedSec = (now - startTime) / 1000;
    const speed = elapsedSec > 0 ? done / elapsedSec : 0;
    const remaining = total - done;
    const etaSec = speed > 0 ? remaining / speed : Infinity;

    el.progressFill.style.width = `${pct.toFixed(1)}%`;
    el.pct.textContent = `${pct.toFixed(1)}%`;
    el.bytes.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    el.speed.textContent = formatSpeed(speed);
    el.eta.textContent = formatEta(etaSec);
  }

  // =========================================================================
  // SECTION 1 — SIGNALING (WebSocket to server.js)
  // =========================================================================

  function connectSignaling() {
    setWsStatus('connecting');
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
      setWsStatus('on');
      logLine(`signal channel open — ${SIGNALING_URL}`, 'ok');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return logLine('received malformed signaling message', 'err');
      }
      handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      setWsStatus('err');
      logLine('signal channel error — is server.js running on :8080?', 'err');
    };

    ws.onclose = () => {
      setWsStatus('off');
      setPeerStatus('none');
      logLine('signal channel closed', 'warn');
    };
  }

  function sendSignalingMessage(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      logLine('cannot reach signaling server — refresh and retry', 'err');
    }
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'created':
        roomId = msg.roomId;
        isHost = true;
        el.roomCodeValue.textContent = roomId;
        el.roomCodeBox.classList.remove('hidden');
        setPeerStatus('waiting');
        logLine(`room created — code ${roomId}`, 'ok');
        logLine('waiting for peer to join...', 'info');
        break;

      case 'joined':
        roomId = msg.roomId;
        isHost = false;
        setPeerStatus('waiting');
        logLine(`joined room ${roomId} — negotiating link...`, 'ok');
        // Guest waits passively; host initiates the offer once it sees peer-joined.
        initPeerConnection(false);
        break;

      case 'peer-joined':
        // Fires on the HOST once the guest joins. Host drives the offer.
        logLine('peer joined — opening data channel...', 'ok');
        initPeerConnection(true);
        break;

      case 'peer-left':
        logLine('peer disconnected', 'warn');
        setPeerStatus('lost');
        teardownPeerConnection();
        break;

      case 'signal':
        handleRemoteSignal(msg.data);
        break;

      case 'error':
        logLine(`server: ${msg.message}`, 'err');
        break;

      default:
        logLine(`unhandled signaling message: ${msg.type}`, 'warn');
    }
  }

  // =========================================================================
  // SECTION 2 — WEBRTC (RTCPeerConnection + RTCDataChannel)
  // =========================================================================

  function initPeerConnection(isInitiator) {
    if (pc) return; // already negotiating/connected

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({ type: 'signal', data: { candidate: event.candidate } });
      }
    };

    pc.oniceconnectionstatechange = () => {
      logLine(`ice state: ${pc.iceConnectionState}`, 'info');
      if (pc.iceConnectionState === 'failed') {
        logLine('ice handshake failed — peer may be behind a restrictive NAT', 'err');
        setPeerStatus('lost');
      }
      if (pc.iceConnectionState === 'disconnected') {
        setPeerStatus('lost');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        logLine(`connection ${pc.connectionState}`, 'err');
        teardownPeerConnection();
      }
    };

    if (isInitiator) {
      dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
      wireDataChannel(dataChannel);
      negotiateOffer();
    } else {
      pc.ondatachannel = (event) => {
        dataChannel = event.channel;
        wireDataChannel(dataChannel);
      };
    }
  }

  async function negotiateOffer() {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignalingMessage({ type: 'signal', data: { sdp: pc.localDescription } });
    } catch (err) {
      logLine(`failed to create offer: ${err.message}`, 'err');
    }
  }

  async function handleRemoteSignal(data) {
    if (!pc) {
      // Guest may receive the offer before it has called initPeerConnection —
      // shouldn't happen given message order, but guard anyway.
      initPeerConnection(false);
    }

    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignalingMessage({ type: 'signal', data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      logLine(`signal handling error: ${err.message}`, 'err');
    }
  }

  function wireDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    channel.onopen = () => {
      setPeerStatus('connected');
      logLine('data channel open — link established', 'ok');
    };

    channel.onclose = () => {
      setPeerStatus('lost');
      logLine('data channel closed', 'warn');
    };

    channel.onerror = (event) => {
      logLine(`data channel error: ${event.error ? event.error.message : 'unknown'}`, 'err');
    };

    channel.onmessage = handleIncomingMessage;
  }

  function teardownPeerConnection() {
    if (dataChannel) {
      dataChannel.onmessage = null;
      try { dataChannel.close(); } catch { /* already closed */ }
      dataChannel = null;
    }
    if (pc) {
      try { pc.close(); } catch { /* already closed */ }
      pc = null;
    }
  }

  // =========================================================================
  // SECTION 3 — TRANSFER (chunking, backpressure, hashing, download)
  // =========================================================================

  async function sendFile(file) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      logLine('no active peer link — create or join a room first', 'err');
      return;
    }

    logLine(`reading ${file.name} into memory (${formatBytes(file.size)})...`, 'info');
    resetTransferUi(file.name, file.size, 'SENDING');

    let fileBuffer;
    try {
      fileBuffer = await file.arrayBuffer();
    } catch (err) {
      logLine(`failed to read file: ${err.message}`, 'err');
      return;
    }

    // Announce the incoming file so the receiver can prep its buffer.
    dataChannel.send(JSON.stringify({
      type: 'meta',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    }));

    logLine('hashing (sha-256)...', 'info');
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashHex = bufferToHex(hashBuffer);
    el.hashLocal.textContent = hashHex;
    logLine(`local sha-256: ${hashHex}`, 'info');

    logLine(`transmitting ${Math.ceil(file.size / CHUNK_SIZE)} chunks...`, 'info');
    const startTime = performance.now();

    await sendChunks(fileBuffer, startTime);

    dataChannel.send(JSON.stringify({ type: 'end', hash: hashHex }));
    updateTransferMetrics(file.size, file.size, startTime, true);
    logLine(`transfer complete — ${file.name} sent`, 'ok');
  }

  function sendChunks(buffer, startTime) {
    return new Promise((resolve, reject) => {
      const total = buffer.byteLength;
      let offset = 0;

      function pump() {
        try {
          while (offset < total) {
            // Backpressure: if the channel's send buffer is too full, stop
            // pushing and wait for 'bufferedamountlow' before resuming. This
            // is what keeps memory flat instead of spiking on large files.
            if (dataChannel.bufferedAmount > BUFFER_HIGH_WATER) {
              dataChannel.onbufferedamountlow = () => {
                dataChannel.onbufferedamountlow = null;
                pump();
              };
              return;
            }

            const end = Math.min(offset + CHUNK_SIZE, total);
            dataChannel.send(buffer.slice(offset, end));
            offset = end;
            updateTransferMetrics(offset, total, startTime);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      }

      pump();
    });
  }

  function handleIncomingMessage(event) {
    if (typeof event.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return logLine('received malformed control message', 'err');
      }

      if (msg.type === 'meta') {
        inbound = {
          name: msg.name,
          size: msg.size,
          mime: msg.mime,
          chunks: [],
          received: 0,
          startTime: performance.now(),
        };
        resetTransferUi(msg.name, msg.size, 'RECEIVING');
        logLine(`incoming: ${msg.name} (${formatBytes(msg.size)})`, 'info');
      } else if (msg.type === 'end') {
        finalizeInbound(msg.hash);
      }
      return;
    }

    // Binary chunk
    if (!inbound) {
      logLine('chunk received with no active transfer — ignoring', 'warn');
      return;
    }
    inbound.chunks.push(event.data);
    inbound.received += event.data.byteLength;
    updateTransferMetrics(inbound.received, inbound.size, inbound.startTime);
  }

  async function finalizeInbound(remoteHash) {
    if (!inbound) return;
    const { name, mime, size, chunks, startTime } = inbound;

    updateTransferMetrics(size, size, startTime, true);
    el.hashRemote.textContent = remoteHash;
    logLine('verifying integrity (sha-256)...', 'info');

    const blob = new Blob(chunks, { type: mime });
    const localHashBuffer = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const localHash = bufferToHex(localHashBuffer);
    el.hashLocal.textContent = localHash;

    const match = localHash === remoteHash;
    el.checksum.textContent = match ? 'verified' : 'mismatch';
    el.checksum.className = match ? 'ok' : 'err';
    logLine(
      match ? `checksum verified — ${name} is intact` : `CHECKSUM MISMATCH — ${name} may be corrupted`,
      match ? 'ok' : 'err'
    );

    triggerDownload(blob, name);
    inbound = null;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    logLine(`download triggered: ${filename}`, 'ok');
  }

  // =========================================================================
  // UI EVENT WIRING
  // =========================================================================

  el.btnCreate.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return logLine('not connected to signaling server yet', 'err');
    }
    sendSignalingMessage({ type: 'create' });
  });

  el.btnJoin.addEventListener('click', () => {
    const code = el.inputJoinCode.value.trim().toUpperCase();
    if (code.length !== 6) {
      return logLine('enter a valid 6-character room code', 'err');
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return logLine('not connected to signaling server yet', 'err');
    }
    sendSignalingMessage({ type: 'join', roomId: code });
  });

  el.inputJoinCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.btnJoin.click();
  });

  el.btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomId || '');
      logLine('room code copied to clipboard', 'ok');
    } catch {
      logLine('clipboard unavailable — copy the code manually', 'warn');
    }
  });

  el.dropzone.addEventListener('click', () => el.fileInput.click());

  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files[0]) sendFile(el.fileInput.files[0]);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('dragover');
    })
  );

  ['dragleave', 'drop'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('dragover');
    })
  );

  
  el.dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) sendFile(file);
  });

  // =========================================================================
  // BOOT
  // =========================================================================

  logLine('p2p::terminal ready', 'ok');
  connectSignaling();
})();
