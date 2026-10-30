/**
 * client.js
 * -----------------------------------------------------------------------
 * P2P::TERMINAL — client logic.
 *
 * Four jobs, kept in four clear sections:
 *   1. SIGNALING   — talk to server.js over WebSocket to find a peer.
 *   2. WEBRTC      — negotiate RTCPeerConnection + RTCDataChannel.
 *   3. TRANSFER    — chunk, send/receive, backpressure, SHA-256, download.
 *   4. BOOT        — first-paint loading screen.
 *
 * Design note on memory: for simplicity and correctness, the sender reads
 * the whole file into one ArrayBuffer up front (file.arrayBuffer()) so the
 * same buffer can both be hashed (crypto.subtle.digest has no streaming
 * API) and sliced into chunks. That means peak memory use is roughly the
 * size of the file being sent, on both ends. Fine for a terminal utility;
 * for multi-GB files you'd swap this for a streaming hash (e.g. a JS
 * incremental SHA-256) and `file.slice()` reads straight off disk.
 *
 * Fix note (sending progress bar freezing): sendChunks() used to run a
 * single synchronous `while` loop across every chunk of the file, only
 * ever pausing when the data channel's bufferedAmount crossed a 16 MB
 * high-water mark. Queuing a 64 KB chunk is almost instant, and
 * bufferedAmount is updated asynchronously by the browser rather than the
 * instant a chunk is queued — so on a fast link the loop could blast
 * straight through an entire file without that condition ever tripping.
 * A synchronous loop blocks the main thread, and the main thread is also
 * what paints the page, so every progress-bar update got queued but never
 * drawn until the loop finally finished. That's why the receiver's
 * progress bar (driven by separate incoming-message events, each its own
 * turn of the event loop) animated smoothly while the sender's froze on
 * the first computed values. The fix below yields back to the browser on
 * a fixed chunk cadence, independent of bufferedAmount, so the UI thread
 * always gets a chance to repaint.
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
  const SIGNALING_URL = 'wss://p2p-web-file-sharing-terminal.onrender.com/';
  // const SIGNALING_URL = 'ws://localhost:8080'; // local testing fallback

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const CHUNK_SIZE = 64 * 1024;                 // 64 KB per data channel message
  // Chromium's RTCDataChannel has an internal hard cap on queued-but-unsent
  // bytes around 16 MB (stricter still on some mobile/WebView builds). The
  // old HIGH_WATER sat exactly on that ceiling, so one more chunk queued
  // right at the limit could overflow it and throw "send queue is full"
  // instead of pausing cleanly. Keep real headroom under it.
  const BUFFER_HIGH_WATER = 1 * 1024 * 1024;    // pause sending above this
  const BUFFER_LOW_WATER = 256 * 1024;          // resume sending below this
  const UI_THROTTLE_MS = 100;                   // max metrics DOM update rate
  const YIELD_EVERY_N_CHUNKS = 12;              // ~768 KB — keeps the UI thread responsive

  const WS_RECONNECT_MIN_MS = 1000;
  const WS_RECONNECT_MAX_MS = 10000;

  const BOOT_MIN_MS = 650;  // loading screen never flashes away instantly
  const BOOT_MAX_MS = 5000; // ...but never blocks the app indefinitely either

  // =========================================================================
  // DOM REFS
  // =========================================================================

  const $ = (id) => document.getElementById(id);

  const el = {
    heroStatus: $('hero-status'),
    dotWs: $('dot-ws'), txtWs: $('txt-ws'),
    dotPeer: $('dot-peer'), txtPeer: $('txt-peer'),
    linkDiagram: $('link-diagram'),
    btnCreate: $('btn-create'),
    btnJoin: $('btn-join'),
    inputJoinCode: $('input-join-code'),
    roomCodeBox: $('room-code-box'),
    roomCodeValue: $('room-code-value'),
    btnCopy: $('btn-copy'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    log: $('terminal-log'),
    btnClearLog: $('btn-clear-log'),
    transferCard: $('transfer-card'),
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
    btnCopyLocalHash: $('btn-copy-local-hash'),
    btnCopyRemoteHash: $('btn-copy-remote-hash'),
    bootLoader: $('boot-loader'),
    bootStatus: $('boot-status'),
    tabBtnDocs: $('tab-btn-docs'),
    tabBtnApp: $('tab-btn-app'),
    panelDocs: $('panel-docs'),
    panelApp: $('panel-app'),
    btnMenu: $('btn-menu'),
    mobileMenu: $('mobile-menu'),
  };

  // =========================================================================
  // STATE
  // =========================================================================

  let ws = null;
  let pc = null;
  let dataChannel = null;
  let roomId = null;
  let isHost = false;
  let wsReconnectAttempts = 0;
  let wsReconnectTimer = null;

  /** Receiver-side accumulation state for the file currently inbound. */
  let inbound = null; // { name, size, mime, chunks: [], received, startTime }

  let lastUiTick = 0;

  // =========================================================================
  // BOOT / LOADING SCREEN
  // =========================================================================

  const bootStart = performance.now();
  let bootDone = false;

  function setBootStatus(text) {
    if (el.bootStatus) el.bootStatus.textContent = text;
  }

  function finishBoot() {
    if (bootDone) return;
    const elapsed = performance.now() - bootStart;
    const wait = Math.max(0, BOOT_MIN_MS - elapsed);
    setTimeout(hideBootLoader, wait);
  }

  function hideBootLoader() {
    if (bootDone || !el.bootLoader) return;
    bootDone = true;
    el.bootLoader.classList.add('boot-loader-hide');
    el.bootLoader.addEventListener('transitionend', () => el.bootLoader.remove(), { once: true });
    setTimeout(() => el.bootLoader?.remove(), 700); // fallback if transitionend never fires
  }

  // Hard cap — never let the loading screen block the app, even if the
  // signaling server is completely unreachable.
  setTimeout(finishBoot, BOOT_MAX_MS);

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
    el.dotWs.className = 'status-dot ' + (state === 'on' ? 'on' : state === 'err' ? 'err' : state === 'connecting' ? 'warn' : 'off');
    el.txtWs.textContent = { off: 'offline', connecting: 'connecting', on: 'online', err: 'error' }[state];
    // A session can only be started once we have a live signaling link.
    const ready = state === 'on';
    el.btnCreate.disabled = !ready;
    el.btnJoin.disabled = !ready;
  }

  function setPeerStatus(state) {
    // state: 'none' | 'waiting' | 'connected' | 'lost'
    el.dotPeer.className = 'status-dot ' + (state === 'connected' ? 'on' : state === 'waiting' ? 'warn' : state === 'lost' ? 'err' : 'off');
    el.txtPeer.textContent = { none: 'none', waiting: 'waiting', connected: 'linked', lost: 'lost' }[state];

    // Drive the hero readout — the single most load-bearing fact on screen.
    el.heroStatus.textContent = {
      none: 'No active session', waiting: 'Awaiting peer', connected: 'Connected', lost: 'Link lost',
    }[state];
    el.heroStatus.className = 'hero-value ' + (
      state === 'connected' ? 'state-on' : state === 'waiting' ? 'state-wait' : state === 'lost' ? 'state-err' : ''
    );
    el.linkDiagram.className = 'link-diagram ' + (
      state === 'connected' ? 'state-on' : state === 'waiting' ? 'state-wait' : state === 'lost' ? 'state-err' : ''
    );
  }

  function setLinkActivity(active) {
    el.linkDiagram.classList.toggle('is-active', active);
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

  async function copyToClipboard(text, successMessage) {
    if (!text || text === '—') return;
    try {
      await navigator.clipboard.writeText(text);
      logLine(successMessage, 'ok');
      return true;
    } catch {
      logLine('clipboard unavailable — copy the value manually', 'warn');
      return false;
    }
  }

  function flashCopied(button) {
    button.classList.add('copied');
    clearTimeout(button._copiedTimer);
    button._copiedTimer = setTimeout(() => button.classList.remove('copied'), 1400);
  }

  // =========================================================================
  // TRANSFER UI
  // =========================================================================

  function resetTransferUi(name, size, direction) {
    el.transferCard.classList.add('has-transfer');
    el.filename.textContent = name;
    el.filesize.textContent = formatBytes(size);
    el.direction.textContent = direction;
    el.progressFill.style.transform = 'scaleX(0)';
    el.pct.textContent = '0%';
    el.bytes.textContent = `0 B / ${formatBytes(size)}`;
    el.speed.textContent = '0 KB/s';
    el.eta.textContent = '—';
    el.checksum.textContent = 'pending';
    el.checksum.className = 'metric-value wait';
    el.hashLocal.textContent = '—';
    el.hashRemote.textContent = '—';
    setLinkActivity(true);
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

    el.progressFill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    el.pct.textContent = `${pct.toFixed(1)}%`;
    el.bytes.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    el.speed.textContent = formatSpeed(speed);
    el.eta.textContent = formatEta(etaSec);
  }

  // =========================================================================
  // SECTION 1 — SIGNALING (WebSocket to server.js)
  // =========================================================================

  function connectSignaling() {
    clearTimeout(wsReconnectTimer);
    setWsStatus('connecting');
    setBootStatus('Connecting to signaling server…');
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
      wsReconnectAttempts = 0;
      setWsStatus('on');
      logLine(`signal channel open — ${SIGNALING_URL}`, 'ok');
      setBootStatus('Connected');
      finishBoot();
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
      logLine('signal channel error', 'err');
    };

    ws.onclose = () => {
      setWsStatus('off');
      setPeerStatus('none');
      teardownPeerConnection();
      roomId = null;
      isHost = false;
      el.roomCodeBox.classList.add('hidden');
      setBootStatus('Signaling unavailable — retrying…');
      finishBoot();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    wsReconnectAttempts += 1;
    const delay = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_MIN_MS * 2 ** (wsReconnectAttempts - 1));
    logLine(`signal channel closed — reconnecting in ${Math.round(delay / 1000)}s`, 'warn');
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectSignaling, delay);
  }

  function sendSignalingMessage(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      logLine('cannot reach signaling server — check your connection', 'err');
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
      if (!pc) return;
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
      if (!pc) return;
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
      setLinkActivity(false);
      logLine('data channel closed', 'warn');
    };

    channel.onerror = (event) => {
      logLine(`data channel error: ${event.error ? event.error.message : 'unknown'}`, 'err');
    };

    channel.onmessage = handleIncomingMessage;
  }

  function teardownPeerConnection() {
    setLinkActivity(false);
    if (dataChannel) {
      dataChannel.onmessage = null;
      dataChannel.onbufferedamountlow = null;
      try { dataChannel.close(); } catch { /* already closed */ }
      dataChannel = null;
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.ondatachannel = null;
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
    resetTransferUi(file.name, file.size, 'Sending');

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

    try {
      await sendChunks(fileBuffer, startTime);
    } catch (err) {
      logLine(`transfer failed: ${err.message}`, 'err');
      setLinkActivity(false);
      return;
    }

    dataChannel.send(JSON.stringify({ type: 'end', hash: hashHex }));
    updateTransferMetrics(file.size, file.size, startTime, true);
    setLinkActivity(false);
    logLine(`transfer complete — ${file.name} sent`, 'ok');
  }

  /**
   * Sends `buffer` over dataChannel in CHUNK_SIZE pieces.
   *
   * Two separate conditions hand control back to the browser:
   *  - backpressure: bufferedAmount above the high-water mark, resumed by
   *    the 'bufferedamountlow' event (keeps memory flat on large files).
   *  - a fixed chunk cadence (YIELD_EVERY_N_CHUNKS), resumed on the next
   *    animation frame (keeps the tab responsive and the progress bar
   *    actually painting, independent of how fast bufferedAmount happens
   *    to report itself).
   */
  function sendChunks(buffer, startTime) {
    return new Promise((resolve, reject) => {
      const total = buffer.byteLength;
      let offset = 0;
      let chunksSinceYield = 0;

      function pauseForDrain() {
        // If bufferedAmount is already at/below the low-water mark, the
        // 'bufferedamountlow' event will never fire (it only fires on a
        // transition down across the threshold) — most often this happens
        // when a send() throws "queue is full" before anything was
        // actually queued, so bufferedAmount never rose in the first
        // place. Retrying on a short timer covers that case instead of
        // waiting forever on an event that won't come.
        if (dataChannel.bufferedAmount <= BUFFER_LOW_WATER) {
          setTimeout(pump, 50);
          return;
        }
        dataChannel.onbufferedamountlow = () => {
          dataChannel.onbufferedamountlow = null;
          pump();
        };
      }

      function pump() {
        try {
          while (offset < total) {
            if (dataChannel.bufferedAmount > BUFFER_HIGH_WATER) {
              pauseForDrain();
              return;
            }

            const end = Math.min(offset + CHUNK_SIZE, total);
            try {
              dataChannel.send(buffer.slice(offset, end));
            } catch (sendErr) {
              // The browser's own internal send queue (independent of our
              // BUFFER_HIGH_WATER check, and not always reflected by
              // bufferedAmount in time) can still overflow under this
              // chunk, e.g. "RTCDataChannel send queue is full" on some
              // mobile builds. Don't abort the whole transfer for a single
              // transient overflow — wait for the channel to drain and
              // retry this exact chunk.
              if (/queue is full/i.test(sendErr.message || '')) {
                pauseForDrain();
                return;
              }
              throw sendErr;
            }
            offset = end;
            chunksSinceYield += 1;
            updateTransferMetrics(offset, total, startTime);

            if (chunksSinceYield >= YIELD_EVERY_N_CHUNKS && offset < total) {
              chunksSinceYield = 0;
              updateTransferMetrics(offset, total, startTime, true); // paint before yielding
              requestAnimationFrame(pump);
              return;
            }
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
        resetTransferUi(msg.name, msg.size, 'Receiving');
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
    el.checksum.className = 'metric-value ' + (match ? 'ok' : 'err');
    logLine(
      match ? `checksum verified — ${name} is intact` : `CHECKSUM MISMATCH — ${name} may be corrupted`,
      match ? 'ok' : 'err'
    );

    setLinkActivity(false);
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
  // TABS — "Docs" and "Transfer" sections, plus the mobile hamburger menu
  // =========================================================================

  const TABS = {
    docs: { tabBtn: el.tabBtnDocs, panel: el.panelDocs },
    app: { tabBtn: el.tabBtnApp, panel: el.panelApp },
  };

  function activateTab(name) {
    if (!TABS[name]) return;

    Object.entries(TABS).forEach(([key, { tabBtn, panel }]) => {
      const isActive = key === name;
      tabBtn.setAttribute('aria-selected', String(isActive));
      tabBtn.tabIndex = isActive ? 0 : -1;
      panel.hidden = !isActive;
    });

    el.mobileMenu.querySelectorAll('.mobile-menu-item').forEach((item) => {
      item.setAttribute('aria-current', String(item.dataset.tab === name));
    });

    closeMobileMenu();

    const hash = `#${name}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function openMobileMenu() {
    el.mobileMenu.hidden = false;
    el.btnMenu.setAttribute('aria-expanded', 'true');
  }

  function closeMobileMenu() {
    el.mobileMenu.hidden = true;
    el.btnMenu.setAttribute('aria-expanded', 'false');
  }

  el.tabBtnDocs.addEventListener('click', () => activateTab('docs'));
  el.tabBtnApp.addEventListener('click', () => activateTab('app'));

  el.btnMenu.addEventListener('click', () => {
    if (el.mobileMenu.hidden) openMobileMenu(); else closeMobileMenu();
  });

  el.mobileMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.mobile-menu-item');
    if (item) activateTab(item.dataset.tab);
  });

  document.querySelectorAll('[data-tab]').forEach((node) => {
    if (node.classList.contains('tab-link') || node.classList.contains('mobile-menu-item')) return;
    node.addEventListener('click', () => activateTab(node.dataset.tab));
  });

  document.addEventListener('click', (e) => {
    if (!el.mobileMenu.hidden && !el.mobileMenu.contains(e.target) && e.target !== el.btnMenu && !el.btnMenu.contains(e.target)) {
      closeMobileMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.mobileMenu.hidden) closeMobileMenu();
  });

  // Docs is the default landing tab; #app / #transfer deep-links open the tool directly.
  activateTab(location.hash === '#app' || location.hash === '#transfer' ? 'app' : 'docs');

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

  el.inputJoinCode.addEventListener('input', () => {
    el.inputJoinCode.value = el.inputJoinCode.value.toUpperCase().slice(0, 6);
  });

  el.btnCopy.addEventListener('click', async () => {
    const ok = await copyToClipboard(roomId, 'room code copied to clipboard');
    if (ok) flashCopied(el.btnCopy);
  });

  el.btnCopyLocalHash.addEventListener('click', async () => {
    const ok = await copyToClipboard(el.hashLocal.textContent, 'local sha-256 copied to clipboard');
    if (ok) flashCopied(el.btnCopyLocalHash);
  });

  el.btnCopyRemoteHash.addEventListener('click', async () => {
    const ok = await copyToClipboard(el.hashRemote.textContent, 'remote sha-256 copied to clipboard');
    if (ok) flashCopied(el.btnCopyRemoteHash);
  });

  el.btnClearLog.addEventListener('click', () => {
    el.log.innerHTML = '';
    logLine('log cleared', 'info');
  });

  el.dropzone.addEventListener('click', () => el.fileInput.click());

  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });

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

  setBootStatus('Initializing interface…');
  logLine('p2p::terminal ready', 'ok');
  connectSignaling();
})();
