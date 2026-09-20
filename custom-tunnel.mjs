/**
 * ShareWeb Custom Tunnel Agent
 * Created specifically for ShareWeb by slomz
 * Connects local localhost:8080 directly to Cloudflare Edge Hub over an encrypted multiplexed WebSocket
 */

const LOCAL_PORT = process.env.PORT || 8080;
const LOCAL_ORIGIN = process.env.LOCAL_ORIGIN || ("http://127.0.0.1:" + LOCAL_PORT);
const TUNNEL_ENDPOINT = process.env.TUNNEL_ENDPOINT || "wss://shareweb-137.pages.dev/_sw_tunnel/connect";
const TUNNEL_SECRET = process.env.TUNNEL_SECRET; // REQUIRED — set in env (never committed)

if (!TUNNEL_SECRET) {
  console.error("[Custom Tunnel] FATAL: TUNNEL_SECRET must be set in the environment (e.g. ~/.shareweb/env). Refusing to start with no auth secret.");
  process.exit(1);
}

let ws = null;
let pingInterval = null;
let isReconnecting = false;
const activeSockets = new Map();
const pendingUploads = new Map();
const CHUNK_SIZE = 512 * 1024; // 512 KB slices fit safely under 1MB WebSocket frame limit

function log(msg) {
  console.log(`[${new Date().toISOString()}] [Custom Tunnel] ${msg}`);
}

async function handleHttpRequest(req) {
  try {
    const targetUrl = new URL(req.url, LOCAL_ORIGIN);

    const headers = new Headers();
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() !== "host" && k.toLowerCase() !== "content-length") {
          headers.set(k, v);
        }
      }
    }
    const originalHost = (req.headers && req.headers.host) || "shareweb.slomz.is-a.dev";
    headers.set("Host", originalHost);
    headers.set("X-Forwarded-Host", originalHost);
    headers.set("X-Forwarded-Proto", "https");

    let body = null;
    if (req.bodyBuffer) {
      body = req.bodyBuffer;
    } else if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      body = Buffer.from(req.body, "base64");
    }

    const localRes = await fetch(targetUrl.href, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    const resHeaders = {};
    for (const [k, v] of localRes.headers.entries()) {
      resHeaders[k.toLowerCase()] = v;
    }

    const arrayBuf = await localRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    if (buffer.length <= CHUNK_SIZE) {
      // Direct single frame for small payloads
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "res",
          id: req.id,
          status: localRes.status,
          headers: resHeaders,
          body: buffer.toString("base64"),
          isBase64: true
        }));
      }
    } else {
      // Streamed multi-chunk frame for large payloads (avoids 1MB WebSocket frame limit)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "res_start",
          id: req.id,
          status: localRes.status,
          headers: resHeaders
        }));

        for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
          if (!ws || ws.readyState !== WebSocket.OPEN) break;
          const slice = buffer.subarray(offset, offset + CHUNK_SIZE);
          ws.send(JSON.stringify({
            type: "res_chunk",
            id: req.id,
            chunk: slice.toString("base64")
          }));

          if (ws.bufferedAmount > CHUNK_SIZE) {
            await new Promise(r => setImmediate(r));
          }
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "res_end",
            id: req.id
          }));
        }
      }
    }
  } catch (err) {
    log(`Error handling request ${req.id} (${req.url}): ${err.message}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "res",
        id: req.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "Local host proxy error: " + err.message })).toString("base64"),
        isBase64: true
      }));
    }
  }
}

function handleWebSocketOpen(msg) {
  const localWsUrl = (LOCAL_ORIGIN.replace(/^http/, "ws")) + msg.url;
  log(`Opening local WebSocket bridge for ${msg.id} -> ${localWsUrl}`);

  try {
    const originalHost = (msg.headers && msg.headers.host) || "shareweb.slomz.is-a.dev";
    const localWs = new WebSocket(localWsUrl, {
      headers: {
        "Host": originalHost,
        "X-Forwarded-Host": originalHost,
        "X-Forwarded-Proto": "https"
      }
    });

    activeSockets.set(msg.id, localWs);

    localWs.onopen = () => {
      log(`Local WebSocket ${msg.id} connected`);
    };

    localWs.onmessage = (event) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "ws_msg",
          id: msg.id,
          data: event.data
        }));
      }
    };

    localWs.onclose = (event) => {
      activeSockets.delete(msg.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "ws_close",
          id: msg.id,
          code: event.code,
          reason: event.reason
        }));
      }
    };

    localWs.onerror = (err) => {
      log(`Local WebSocket ${msg.id} error: ${err.message || err}`);
    };
  } catch (err) {
    log(`Failed to create local WebSocket for ${msg.id}: ${err.message}`);
  }
}

function connect() {
  if (isReconnecting) return;
  isReconnecting = true;

  const url = `${TUNNEL_ENDPOINT}?auth=${TUNNEL_SECRET}`;
  log(`Connecting to Edge Hub: ${TUNNEL_ENDPOINT}...`);

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      isReconnecting = false;
      log("==================================================");
      log("✅ CUSTOM TUNNEL CONNECTED SECURELY TO CLOUDFLARE EDGE!");
      log(`Localhost: ${LOCAL_ORIGIN} ➔ https://shareweb.slomz.is-a.dev/`);
      log("Zero third-party tunnels. 100% custom protocol.");
      log("==================================================");

      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 10000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "req") {
          handleHttpRequest(msg);
        } else if (msg.type === "req_start") {
          pendingUploads.set(msg.id, {
            id: msg.id,
            method: msg.method,
            url: msg.url,
            headers: msg.headers,
            chunks: []
          });
        } else if (msg.type === "req_chunk") {
          const upload = pendingUploads.get(msg.id);
          if (upload) {
            upload.chunks.push(Buffer.from(msg.chunk, "base64"));
          }
        } else if (msg.type === "req_end") {
          const upload = pendingUploads.get(msg.id);
          if (upload) {
            pendingUploads.delete(msg.id);
            const fullBody = Buffer.concat(upload.chunks);
            handleHttpRequest({
              id: upload.id,
              method: upload.method,
              url: upload.url,
              headers: upload.headers,
              bodyBuffer: fullBody
            });
          }
        } else if (msg.type === "req_abort") {
          pendingUploads.delete(msg.id);
        } else if (msg.type === "ws_open") {
          handleWebSocketOpen(msg);
        } else if (msg.type === "ws_msg") {
          const lWs = activeSockets.get(msg.id);
          if (lWs && lWs.readyState === WebSocket.OPEN) {
            lWs.send(msg.data);
          }
        } else if (msg.type === "ws_close") {
          const lWs = activeSockets.get(msg.id);
          if (lWs) {
            activeSockets.delete(msg.id);
            try { lWs.close(msg.code || 1000, msg.reason || ""); } catch (_) {}
          }
        } else if (msg.type === "pong") {
          // Heartbeat acknowledged
        }
      } catch (err) {
        log(`Error processing edge message: ${err.message}`);
      }
    };

    ws.onclose = (event) => {
      if (pingInterval) clearInterval(pingInterval);
      for (const [id, lWs] of activeSockets.entries()) {
        try { lWs.close(); } catch (_) {}
      }
      activeSockets.clear();
      log(`Tunnel disconnected (code: ${event.code}, reason: ${event.reason || "none"}). Reconnecting in 3s...`);
      ws = null;
      isReconnecting = false;
      setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      log(`Tunnel connection error: ${err.message || err}`);
    };
  } catch (err) {
    log(`Fatal error creating WebSocket: ${err.message}. Retrying in 3s...`);
    isReconnecting = false;
    setTimeout(connect, 3000);
  }
}

connect();
