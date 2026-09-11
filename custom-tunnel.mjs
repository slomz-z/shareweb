/**
 * ShareWeb Custom Tunnel Agent
 * Created specifically for ShareWeb by slomz
 * Connects local localhost:8080 directly to Cloudflare Edge Hub over an encrypted multiplexed WebSocket
 */

const LOCAL_PORT = process.env.PORT || 8080;
const LOCAL_ORIGIN = process.env.LOCAL_ORIGIN || ("http://127.0.0.1:" + LOCAL_PORT);
const TUNNEL_ENDPOINT = process.env.TUNNEL_ENDPOINT || "wss://shareweb-137.pages.dev/_sw_tunnel/connect";
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || "sw_sec_0569da26f2d63a71b1d3d3a12650175316bdfe070270ca09";

let ws = null;
let pingInterval = null;
let isReconnecting = false;
const activeSockets = new Map();

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
    headers.set("Host", "shareweb.slomz.is-a.dev");
    headers.set("X-Forwarded-Host", "shareweb.slomz.is-a.dev");
    headers.set("X-Forwarded-Proto", "https");

    let body = null;
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      body = Buffer.from(req.body, "base64");
    }

    const localRes = await fetch(targetUrl.href, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    const arrayBuf = await localRes.arrayBuffer();
    const base64Body = Buffer.from(arrayBuf).toString("base64");

    const resHeaders = {};
    for (const [k, v] of localRes.headers.entries()) {
      resHeaders[k.toLowerCase()] = v;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "res",
        id: req.id,
        status: localRes.status,
        headers: resHeaders,
        body: base64Body,
        isBase64: true
      }));
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
    const localWs = new WebSocket(localWsUrl, {
      headers: {
        "Host": "shareweb.slomz.is-a.dev",
        "X-Forwarded-Host": "shareweb.slomz.is-a.dev",
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
