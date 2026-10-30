# P2P / Terminal

A lightweight, serverless, and browser-to-browser file transfer application built with a sleek terminal-inspired aesthetic. **P2P / Terminal** allows users to stream files directly from one device to another over an encrypted `RTCDataChannel` without intermediate server uploads.

---

## 🌟 Key Features

* **Direct Browser-to-Browser Transfer:** Files are sent straight from peer to peer using WebRTC data channels, bypassing intermediate servers entirely.
* **Zero Server Storage for Files:** The signaling server only handles connection metadata (room establishment); file contents never touch or get stored on any server.
* **End-to-End Cryptographic Integrity (SHA-256):** Automatically computes and compares SHA-256 checksums on both the sender and receiver sides to guarantee file integrity down to the last byte.
* **Live Transfer Readouts:** Real-time metrics tracking transfer speed, progress percentage, elapsed/remaining time, active chunk size (64 KB default), and live verification hashes.
* **Terminal-Inspired UI:** Clean, minimalist, and responsive developer-focused interface designed with crisp typography and robust navigation tabs (`Docs`, `Transfer`, and `p2p.ai`).

---

## 🛠️ Technology Stack

* **Frontend Architecture:** Pure JavaScript (`client.js`), HTML5, and CSS3.
* **Networking & Protocols:** WebRTC (`RTCPeerConnection`, `RTCDataChannel`), STUN servers, and WebSocket signaling.
* **Security & Cryptography:** Web Crypto API (`SubtleCrypto` for SHA-256 hashing) and direct end-to-end encryption.
* **Hosting & Deployment:** Vercel / Netlify compatible.

---

## 🚀 How It Works (Step-by-Step)

1. **Create a Session:** Click **Create a session** on the Transfer tab to generate a unique 6-character room code.
2. **Share & Join:** Share the code with your peer. They enter the code into their session input and click **Join** to establish a secure handshake.
3. **Link Established:** Once the WebRTC negotiation completes, the connection status automatically updates from *awaiting peer* to *Connected* with online signal indicators.
4. **Stream & Verify:** Drag and drop any file onto the transfer panel. The file is split into manageable chunks, streamed across the channel with live progress tracking, and automatically verified against its SHA-256 checksum upon completion.

---

## 📋 Architecture & Core Workflow (`client.js`)

The core client script manages the entire lifecycle of the P2P connection and file chunking process:

* **Signaling & State Machine:** Establishes communication protocols to exchange ICE candidates and SDP offers/answers via signaling infrastructure.
* **Chunked Binary Streaming:** Reads files via the File API (`FileReader` / `ArrayBuffer`), breaks them into optimized chunks (e.g., 64 KB), and pushes them through the `RTCDataChannel` while monitoring buffer backpressure.
* **Hash Verification Engine:** Utilizes browser-native cryptographic libraries (`crypto.subtle.digest`) to generate local SHA-256 hashes prior to transmission and verifies incoming stream buffers against the remote checksum.

---

## 🔒 Privacy & Security

* **True Peer-to-Peer:** Because data travels over a direct WebRTC connection, transfer speeds are governed by your local network capability rather than cloud bandwidth limitations.
* **Ephemeral Rooms:** Rooms are strictly limited to exactly two peers. Sessions terminate immediately upon disconnection, and room codes cannot be reused.
* **No File Retention:** No logs or files are retained on any remote server.

---

## ⚙️ Requirements & Limitations

* **Browser Support:** Modern web browsers with robust WebRTC support (Google Chrome, Mozilla Firefox, Microsoft Edge, Apple Safari).
* **Simultaneous Presence:** Both users must have the application session active concurrently; offline file queuing is not supported.
* **Network Constraints:** Connections rely on public STUN servers. Highly restrictive corporate firewalls or symmetric NATs may occasionally require TURN relay configurations if direct hole-punching fails.
* **Memory Constraints:** Because the sender handles file buffering in memory during active streaming, extremely large files are limited by the host device's available RAM.

---

## 🌐 Links & Resources

* **Live Application:** [P2P / Terminal on Vercel](https://file-sharing-terminal.vercel.app/#docs)
* **Documentation & Help:** Built-in interactive guide available at the `#docs` endpoint.
