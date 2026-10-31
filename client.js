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

  // p2p.ai runs as a Vercel Serverless Function alongside this static site
  // (api/chat.js) — same origin as the page, so no CORS and no dependency
  // on the Render signaling server's uptime.
  const AI_ENDPOINT = '/api/chat';
  const AI_HISTORY_LIMIT = 8; // messages (not pairs) kept as context for the assistant

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
    joinLinkBox: $('join-link-box'),
    joinLinkValue: $('join-link-value'),
    btnCopyJoinLink: $('btn-copy-join-link'),
    qrContainer: $('qr-container'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    btnChooseFolder: $('btn-choose-folder'),
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
    tabBtnAi: $('tab-btn-ai'),
    panelDocs: $('panel-docs'),
    panelApp: $('panel-app'),
    panelAi: $('panel-ai'),
    btnMenu: $('btn-menu'),
    mobileMenu: $('mobile-menu'),
    aiChat: $('ai-chat'),
    aiForm: $('ai-form'),
    aiInput: $('ai-input'),
    aiSend: $('ai-send'),
    aiTyping: $('ai-typing'),
    aiSuggestList: $('ai-suggest-list'),
    tabBtnSpeed: $('tab-btn-speed'),
    panelSpeed: $('panel-speed'),
    speedHeroStatus: $('speed-hero-status'),
    speedDot: $('speed-dot'),
    speedPhaseText: $('speed-phase-text'),
    btnSpeedStart: $('btn-speed-start'),
    btnSpeedStop: $('btn-speed-stop'),
    speedProgressWrap: $('speed-progress-wrap'),
    speedProgressFill: $('speed-progress-fill'),
    speedProgressLabel: $('speed-progress-label'),
    speedLog: $('speed-log'),
    btnSpeedClearLog: $('btn-speed-clear-log'),
    speedStatPing: $('speed-stat-ping'),
    speedStatJitter: $('speed-stat-jitter'),
    speedStatDownload: $('speed-stat-download'),
    speedStatUpload: $('speed-stat-upload'),
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

  // A code carried in the page URL as ?join=XXXXXX (from a shared link or
  // scanned QR code) — auto-joined once the signaling socket comes up,
  // then cleared so a later reconnect doesn't repeat it.
  let pendingJoinCode = (() => {
    const raw = new URLSearchParams(location.search).get('join');
    if (!raw) return null;
    const code = raw.trim().toUpperCase().slice(0, 6);
    return code.length === 6 ? code : null;
  })();

  // Guards the dropzone/file inputs while a multi-file or folder selection
  // is being bundled into a zip, so a second drop can't interleave with it.
  let isBundling = false;

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

  function logLine(message, level = 'info', target = el.log) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const row = document.createElement('div');
    row.className = 'log-line';
    row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-${level}">${escapeHtml(message)}</span>`;
    target.appendChild(row);
    target.scrollTop = target.scrollHeight;
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
  // JOIN LINK + QR CODE
  // =========================================================================

  /** The one-click join link for `code` — works wherever this page is hosted. */
  function buildJoinLink(code) {
    return `${location.origin}${location.pathname}?join=${code}`;
  }

  function showJoinLink(code) {
    const link = buildJoinLink(code);
    el.joinLinkValue.textContent = link;
    el.joinLinkBox.classList.remove('hidden');

    try {
      // Hardcoded, not var(--ink) — this SVG is injected inline via
      // innerHTML and its <path fill="..."> is a presentation attribute,
      // not a stylesheet rule, so CSS custom-property resolution there is
      // inconsistent across browsers. The QR box background is also
      // always white (see .join-link-qr), so a fixed near-black fill is
      // both simpler and safer than depending on var() support here.
      el.qrContainer.innerHTML = window.QRCode.toSvgString(link, {
        ecLevel: 'M',
        moduleSize: 4,
        margin: 2,
        dark: '#11151c',
        light: 'none',
      });
    } catch (err) {
      el.qrContainer.innerHTML = '';
      logLine(`qr generation failed: ${err.message}`, 'warn');
    }
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

      if (pendingJoinCode && !roomId) {
        const code = pendingJoinCode;
        pendingJoinCode = null; // one-shot — don't repeat on a later reconnect
        el.inputJoinCode.value = code;
        logLine(`join link detected — joining room ${code}...`, 'info');
        sendSignalingMessage({ type: 'join', roomId: code });

        // Drop ?join=... from the address bar now that it's been used, so
        // refreshing the page doesn't silently retry joining a room that
        // may no longer exist or already has its second peer.
        const url = new URL(location.href);
        url.searchParams.delete('join');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
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
      el.joinLinkBox.classList.add('hidden');
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
        showJoinLink(roomId);
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
      } else if (msg.type === 'verify-result') {
        // Sent back by the receiver once it has hashed what it got, so the
        // sender's own UI (which otherwise has no way to know) can show the
        // same verified/mismatch result and remote hash.
        el.hashRemote.textContent = msg.hash;
        el.checksum.textContent = msg.match ? 'verified' : 'mismatch';
        el.checksum.className = 'metric-value ' + (msg.match ? 'ok' : 'err');
        logLine(
          msg.match ? 'peer confirmed checksum match' : 'PEER REPORTED CHECKSUM MISMATCH',
          msg.match ? 'ok' : 'err'
        );
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
      match ? `checksum verified: ${name} is intact` : `CHECKSUM MISMATCH: ${name} may be corrupted`,
      match ? 'ok' : 'err'
    );

    // Let the sender know too — it has no visibility into what we
    // actually received or computed otherwise, and its own checksum/remote
    // hash fields would sit on "pending" forever without this.
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'verify-result', hash: localHash, match }));
    }

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
  // SECTION 3b — MULTI-FILE / FOLDER SEND (bundles into a zip, then reuses
  // sendFile() above unchanged — the receiving side needs no changes at
  // all, it just gets a .zip as the inbound file).
  // =========================================================================

  /**
   * Walks a dropped FileSystemDirectoryEntry, collecting every descendant
   * file. readEntries() only returns entries in batches (an implementation
   * detail of the API, not a fixed page size) so it must be called
   * repeatedly until it comes back empty.
   */
  function readDirEntries(dirReader) {
    return new Promise((resolve, reject) => {
      const all = [];
      function readBatch() {
        dirReader.readEntries((batch) => {
          if (!batch.length) { resolve(all); return; }
          all.push(...batch);
          readBatch();
        }, reject);
      }
      readBatch();
    });
  }

  async function walkFileEntry(entry, basePath, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: basePath + entry.name });
    } else if (entry.isDirectory) {
      const children = await readDirEntries(entry.createReader());
      for (const child of children) {
        await walkFileEntry(child, `${basePath}${entry.name}/`, out);
      }
    }
  }

  /** Expands a DataTransfer from a drop event into a flat [{file, path}]. */
  async function collectDroppedEntries(dataTransfer) {
    const out = [];
    const items = dataTransfer.items;

    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      for (const entry of entries) {
        await walkFileEntry(entry, '', out);
      }
    } else {
      // Fallback for browsers without the FileSystem entry API — flat
      // files only, no folder support.
      for (const file of dataTransfer.files) out.push({ file, path: file.name });
    }
    return out;
  }

  /** A sensible .zip name: the shared top folder if there is one, else a generic bundle name. */
  function deriveZipName(entries) {
    const topSegments = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : null)));
    if (topSegments.size === 1 && !topSegments.has(null)) {
      return `${[...topSegments][0]}.zip`;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `files-${entries.length}-${stamp}.zip`;
  }

  function setDropzoneBusy(busy) {
    isBundling = busy;
    el.dropzone.classList.toggle('is-busy', busy);
    el.btnChooseFolder.disabled = busy;
  }

  async function sendZippedBundle(entries) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      logLine('no active peer link — create or join a room first', 'err');
      return;
    }

    const zipName = deriveZipName(entries);
    logLine(`bundling ${entries.length} item${entries.length === 1 ? '' : 's'} into ${zipName}...`, 'info');
    setDropzoneBusy(true);

    try {
      const zipEntries = [];
      for (const { file, path } of entries) {
        zipEntries.push({ name: path, data: new Uint8Array(await file.arrayBuffer()) });
      }
      const zipBlob = await window.ZipWriter.createZipBlob(zipEntries);
      logLine(`zip built — ${formatBytes(zipBlob.size)}`, 'ok');
      const zipFile = new File([zipBlob], zipName, { type: 'application/zip' });
      await sendFile(zipFile);
    } catch (err) {
      logLine(`failed to build zip: ${err.message}`, 'err');
    } finally {
      setDropzoneBusy(false);
    }
  }

  /**
   * Single entry point for anything the dropzone, file input, or folder
   * input hands us. A lone flat file (no folder, nothing else selected
   * alongside it) skips zipping entirely and goes straight through the
   * existing single-file path — no size/overhead cost for the common case.
   */
  async function sendEntries(entries) {
    if (isBundling) {
      logLine('still bundling the previous selection — try again in a moment', 'warn');
      return;
    }
    if (entries.length === 0) {
      logLine('nothing to send — drop a file or a folder', 'warn');
      return;
    }
    if (entries.length === 1 && entries[0].path === entries[0].file.name) {
      await sendFile(entries[0].file);
      return;
    }
    await sendZippedBundle(entries);
  }

  // =========================================================================
  // TABS — "Docs" and "Transfer" sections, plus the mobile hamburger menu
  // =========================================================================

  const TABS = {
    docs: { tabBtn: el.tabBtnDocs, panel: el.panelDocs },
    app: { tabBtn: el.tabBtnApp, panel: el.panelApp },
    ai: { tabBtn: el.tabBtnAi, panel: el.panelAi },
    speed: { tabBtn: el.tabBtnSpeed, panel: el.panelSpeed },
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
  el.tabBtnAi.addEventListener('click', () => activateTab('ai'));
  el.tabBtnSpeed.addEventListener('click', () => activateTab('speed'));

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

  // Docs is the default landing tab; #app / #transfer and #ai deep-link directly.
  // A ?join=CODE link always lands on the Transfer tab, regardless of hash,
  // since that's where the auto-join (wired in ws.onopen above) plays out.
  activateTab(
    pendingJoinCode ? 'app'
      : location.hash === '#app' || location.hash === '#transfer' ? 'app'
      : location.hash === '#ai' ? 'ai'
      : location.hash === '#speed' ? 'speed'
      : 'docs'
  );

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

  el.btnCopyJoinLink.addEventListener('click', async () => {
    const ok = await copyToClipboard(el.joinLinkValue.textContent, 'join link copied to clipboard');
    if (ok) flashCopied(el.btnCopyJoinLink);
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

  el.dropzone.addEventListener('click', () => {
    if (!isBundling) el.fileInput.click();
  });

  el.dropzone.addEventListener('keydown', (e) => {
    // Ignore keydowns bubbling up from the "choose a folder" button nested
    // inside the dropzone — it has its own click handler, and reacting
    // here too would open both file inputs at once on Enter/Space.
    if (e.target !== el.dropzone) return;
    if ((e.key === 'Enter' || e.key === ' ') && !isBundling) {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  // Multiple files from the browse dialog have no folder structure, so
  // each one's path is just its own name — sendEntries() sends a lone
  // file straight through, or zips a multi-selection automatically.
  el.fileInput.addEventListener('change', () => {
    const entries = Array.from(el.fileInput.files).map((file) => ({ file, path: file.name }));
    el.fileInput.value = '';
    sendEntries(entries);
  });

  // A folder picked via the browse dialog (input[webkitdirectory]) reports
  // each file's path relative to — and including — the chosen folder, so
  // it already carries the structure a zip should preserve.
  el.btnChooseFolder.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isBundling) el.folderInput.click();
  });

  el.folderInput.addEventListener('change', () => {
    const entries = Array.from(el.folderInput.files).map((file) => ({
      file, path: file.webkitRelativePath || file.name,
    }));
    el.folderInput.value = '';
    sendEntries(entries);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (!isBundling) el.dropzone.classList.add('dragover');
    })
  );

  ['dragleave', 'drop'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('dragover');
    })
  );

  el.dropzone.addEventListener('drop', async (e) => {
    if (isBundling) return;
    const entries = await collectDroppedEntries(e.dataTransfer);
    sendEntries(entries);
  });

  // =========================================================================
  // P2P.AI — assistant chat tab
  // =========================================================================

  let aiHistory = [];   // [{ role: 'user'|'assistant', content }]
  let aiBusy = false;

  function appendAiMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `ai-msg ai-msg-${role}`;
    wrap.innerHTML = `
      <span class="ai-msg-tag">${role === 'user' ? 'you' : 'p2p.ai'}</span>
      <p class="ai-msg-text"></p>
    `;
    wrap.querySelector('.ai-msg-text').textContent = text;
    el.aiChat.appendChild(wrap);
    el.aiChat.scrollTop = el.aiChat.scrollHeight;
    return wrap;
  }

  function setAiBusy(isBusy) {
    aiBusy = isBusy;
    el.aiInput.disabled = isBusy;
    el.aiSend.disabled = isBusy;
    el.aiTyping.classList.toggle('hidden', !isBusy);
    if (isBusy) el.aiChat.scrollTop = el.aiChat.scrollHeight;
  }

  async function askAi(question) {
    const text = question.trim();
    if (!text || aiBusy) return;

    appendAiMessage('user', text);
    aiHistory.push({ role: 'user', content: text });
    aiHistory = aiHistory.slice(-AI_HISTORY_LIMIT);
    setAiBusy(true);

    try {
      const res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: aiHistory.slice(0, -1) }),
      });

      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const reply = (data && data.reply ? String(data.reply) : '').trim();

      if (!reply) throw new Error('empty reply');

      appendAiMessage('bot', reply);
      aiHistory.push({ role: 'assistant', content: reply });
      aiHistory = aiHistory.slice(-AI_HISTORY_LIMIT);
    } catch (err) {
      appendAiMessage('err', '> assistant unreachable. check your connection and try again.');
    } finally {
      setAiBusy(false);
      el.aiInput.focus();
    }
  }

  el.aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.aiInput.value;
    el.aiInput.value = '';
    askAi(text);
  });

  el.aiSuggestList.addEventListener('click', (e) => {
    const btn = e.target.closest('.ai-suggest');
    if (!btn || aiBusy) return;
    askAi(btn.dataset.q);
  });

  // =========================================================================
  // SECTION 5 — SPEED TEST
  // Client-server HTTPS throughput check against api/speed.js. Separate
  // from the WebRTC link entirely — see the note in the Speed test tab.
  // =========================================================================

  const SPEED_ENDPOINT = '/api/speed';
  const SPEED_PING_SAMPLES = 8;
  const SPEED_DOWNLOAD_MS = 4500;
  const SPEED_DOWNLOAD_STREAMS = 4;
  const SPEED_DOWNLOAD_CHUNK_BYTES = 3 * 1024 * 1024; // per request, well under the 4.5 MB platform cap
  const SPEED_UPLOAD_MS = 4500;
  const SPEED_UPLOAD_STREAMS = 3;
  const SPEED_UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024;
  const SPEED_PROGRESS_TICK_MS = 200;

  const speedState = { running: false, cancelled: false, controller: null };
  let speedUploadPayload = null; // built lazily, reused across the whole test run

  function formatMs(ms) {
    return `${Math.round(ms)} ms`;
  }

  function formatMbps(mbps) {
    if (!isFinite(mbps) || mbps < 0) return '—';
    return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} Mbps`;
  }

  function buildRandomPayload(size) {
    const buf = new Uint8Array(size);
    const MAX_SLICE = 65536; // crypto.getRandomValues' per-call ceiling
    for (let offset = 0; offset < size; offset += MAX_SLICE) {
      crypto.getRandomValues(buf.subarray(offset, Math.min(offset + MAX_SLICE, size)));
    }
    return buf;
  }

  function setSpeedPhase(label, dotState) {
    el.speedPhaseText.textContent = label;
    el.speedDot.className = 'status-dot ' + (dotState || 'off');
  }

  function setSpeedProgress(pct, label) {
    el.speedProgressFill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct / 100)).toFixed(4)})`;
    el.speedProgressLabel.textContent = label;
  }

  function resetSpeedResults() {
    el.speedStatPing.textContent = '—';
    el.speedStatJitter.textContent = '—';
    el.speedStatDownload.textContent = '—';
    el.speedStatUpload.textContent = '—';
    [el.speedStatPing, el.speedStatJitter, el.speedStatDownload, el.speedStatUpload]
      .forEach((n) => { n.className = 'metric-value'; });
  }

  function setSpeedUiRunning(running) {
    el.btnSpeedStart.classList.toggle('hidden', running);
    el.btnSpeedStop.classList.toggle('hidden', !running);
    el.speedProgressWrap.classList.toggle('hidden', !running);
  }

  async function runPingTest(samples) {
    const times = [];
    for (let i = 0; i < samples; i++) {
      if (speedState.cancelled) break;
      const t0 = performance.now();
      try {
        const res = await fetch(`${SPEED_ENDPOINT}?r=${Math.random()}`, { cache: 'no-store' });
        if (!res.ok) continue;
        await res.json();
      } catch {
        continue;
      }
      times.push(performance.now() - t0);
    }
    // Drop the first sample — it usually eats a fresh connection's TLS
    // handshake and isn't representative of steady-state latency.
    const usable = times.slice(1);
    if (usable.length < 2) return { ping: times[0] ?? null, jitter: null };

    const sorted = [...usable].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    let jitterSum = 0;
    for (let i = 1; i < usable.length; i++) jitterSum += Math.abs(usable[i] - usable[i - 1]);
    const jitter = jitterSum / (usable.length - 1);

    return { ping: median, jitter };
  }

  async function runDownloadTest(durationMs, streamCount, chunkBytes, onProgress) {
    const controller = new AbortController();
    speedState.controller = controller;
    let totalBytes = 0;
    const start = performance.now();
    const durationTimer = setTimeout(() => controller.abort(), durationMs);

 async function worker() {
      while (!controller.signal.aborted) {
        let res;
        try {
          res = await fetch(`${SPEED_ENDPOINT}?dl=1&n=${chunkBytes}&r=${Math.random()}`, {
            signal: controller.signal,
            cache: 'no-store',
          });
        } catch {
          return;
        }
        if (!res.ok) return;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            let step;
            try {
              step = await reader.read();
            } catch {
              return;
            }
            if (step.done) break;
            totalBytes += step.value.length;
          }
        } else {
          // Fallback for a response type without a readable stream.
          const buf = await res.arrayBuffer();
          totalBytes += buf.byteLength;
        }
      }
    }

    const workers = Array.from({ length: streamCount }, worker);
    const progressTimer = setInterval(() => {
      onProgress(totalBytes, (performance.now() - start) / 1000);
    }, SPEED_PROGRESS_TICK_MS);

    await Promise.allSettled(workers);
    clearTimeout(durationTimer);
    clearInterval(progressTimer);
    speedState.controller = null;

    return { bytes: totalBytes, seconds: (performance.now() - start) / 1000 };
  }

  async function runUploadTest(durationMs, streamCount, chunkBytes, onProgress) {
    if (!speedUploadPayload || speedUploadPayload.length !== chunkBytes) {
      speedUploadPayload = buildRandomPayload(chunkBytes);
    }
    const payload = speedUploadPayload;

    const controller = new AbortController();
    speedState.controller = controller;
    let totalBytes = 0;
    const start = performance.now();
    const durationTimer = setTimeout(() => controller.abort(), durationMs);

    async function worker() {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(SPEED_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: payload,
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!res.ok) return;
          await res.json().catch(() => {});
          totalBytes += payload.length;
        } catch {
          return;
        }
      }
    }

    const workers = Array.from({ length: streamCount }, worker);
    const progressTimer = setInterval(() => {
      onProgress(totalBytes, (performance.now() - start) / 1000);
    }, SPEED_PROGRESS_TICK_MS);

    await Promise.allSettled(workers);
    clearTimeout(durationTimer);
    clearInterval(progressTimer);
    speedState.controller = null;

    return { bytes: totalBytes, seconds: (performance.now() - start) / 1000 };
  }

  async function runSpeedTest() {
    if (speedState.running) return;
    speedState.running = true;
    speedState.cancelled = false;
    setSpeedUiRunning(true);
    resetSpeedResults();
    setSpeedPhase('running', 'warn');
    logLine('starting speed test…', 'info', el.speedLog);

    try {
      // --- ping ------------------------------------------------------
      setSpeedProgress(5, 'Measuring ping…');
      const { ping, jitter } = await runPingTest(SPEED_PING_SAMPLES);
      if (speedState.cancelled) throw new Error('cancelled');

      if (ping != null) {
        el.speedStatPing.textContent = formatMs(ping);
        el.speedStatJitter.textContent = jitter != null ? formatMs(jitter) : '—';
        logLine(`ping ${formatMs(ping)}${jitter != null ? `, jitter ${formatMs(jitter)}` : ''}`, 'ok', el.speedLog);
      } else {
        el.speedStatPing.textContent = 'failed';
        el.speedStatPing.className = 'metric-value err';
        logLine('ping test failed — server unreachable', 'err', el.speedLog);
      }

      // --- download ----------------------------------------------------
      setSpeedProgress(20, 'Testing download…');
      el.speedStatDownload.className = 'metric-value live';
      const dl = await runDownloadTest(
        SPEED_DOWNLOAD_MS, SPEED_DOWNLOAD_STREAMS, SPEED_DOWNLOAD_CHUNK_BYTES,
        (bytes, sec) => {
          const mbps = sec > 0 ? (bytes * 8) / sec / 1e6 : 0;
          el.speedStatDownload.textContent = formatMbps(mbps);
          const frac = Math.min(1, (sec * 1000) / SPEED_DOWNLOAD_MS);
          setSpeedProgress(20 + frac * 35, `Testing download — ${formatMbps(mbps)}`);
        },
      );
      if (speedState.cancelled) throw new Error('cancelled');
      const dlMbps = dl.seconds > 0 ? (dl.bytes * 8) / dl.seconds / 1e6 : 0;
      el.speedStatDownload.textContent = formatMbps(dlMbps);
      el.speedStatDownload.className = 'metric-value ok';
      logLine(`download ${formatMbps(dlMbps)} (${formatBytes(dl.bytes)} in ${dl.seconds.toFixed(1)}s)`, 'ok', el.speedLog);

      // --- upload --------------------------------------------------------
      setSpeedProgress(55, 'Testing upload…');
      el.speedStatUpload.className = 'metric-value live';
      const ul = await runUploadTest(
        SPEED_UPLOAD_MS, SPEED_UPLOAD_STREAMS, SPEED_UPLOAD_CHUNK_BYTES,
        (bytes, sec) => {
          const mbps = sec > 0 ? (bytes * 8) / sec / 1e6 : 0;
          el.speedStatUpload.textContent = formatMbps(mbps);
          const frac = Math.min(1, (sec * 1000) / SPEED_UPLOAD_MS);
          setSpeedProgress(55 + frac * 40, `Testing upload — ${formatMbps(mbps)}`);
        },
      );
      if (speedState.cancelled) throw new Error('cancelled');
      const ulMbps = ul.seconds > 0 ? (ul.bytes * 8) / ul.seconds / 1e6 : 0;
      el.speedStatUpload.textContent = formatMbps(ulMbps);
      el.speedStatUpload.className = 'metric-value ok';
      logLine(`upload ${formatMbps(ulMbps)} (${formatBytes(ul.bytes)} in ${ul.seconds.toFixed(1)}s)`, 'ok', el.speedLog);

      setSpeedProgress(100, 'Done');
      setSpeedPhase('done', 'on');
      logLine('speed test complete', 'ok', el.speedLog);
    } catch (err) {
      if (speedState.cancelled || err.message === 'cancelled') {
        setSpeedPhase('stopped', 'warn');
        setSpeedProgress(0, 'Stopped');
        logLine('speed test stopped', 'warn', el.speedLog);
      } else {
        setSpeedPhase('error', 'err');
        setSpeedProgress(0, 'Failed');
        logLine(`speed test error: ${err.message}`, 'err', el.speedLog);
      }
    } finally {
      speedState.running = false;
      setSpeedUiRunning(false);
    }
  }

  function stopSpeedTest() {
    if (!speedState.running) return;
    speedState.cancelled = true;
    if (speedState.controller) speedState.controller.abort();
    logLine('stopping…', 'warn', el.speedLog);
  }

  el.btnSpeedStart.addEventListener('click', runSpeedTest);
  el.btnSpeedStop.addEventListener('click', stopSpeedTest);
  el.btnSpeedClearLog.addEventListener('click', () => { el.speedLog.innerHTML = ''; });

  // =========================================================================
  // BOOT
  // =========================================================================

  setBootStatus('Initializing interface…');
  logLine('p2p::terminal ready', 'ok');
  connectSignaling();
})();
