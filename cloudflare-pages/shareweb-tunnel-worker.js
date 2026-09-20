import { DurableObject } from "cloudflare:workers";

export class ShareWebTunnelHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.macWs = null;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer, writer, isStream }
    this.visitorSockets = new Map();  // id -> WebSocket
    this.TUNNEL_SECRET = env.TUNNEL_SECRET || ""; // REQUIRED — set as a Cloudflare Pages/Workers secret
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 1. Tunnel Agent Connection from Mac
    if (url.pathname === "/_sw_tunnel/connect") {
      const auth = url.searchParams.get("auth") || request.headers.get("x-tunnel-auth");
      if (auth !== this.TUNNEL_SECRET) {
        return new Response("Unauthorized tunnel connection", { status: 401 });
      }

      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      if (this.macWs) {
        try { this.macWs.close(1000, "New tunnel client connected"); } catch (_) {}
      }

      this.macWs = server;
      server.accept();

      server.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "res") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingRequests.delete(msg.id);
              pending.resolve(msg);
            }
          } else if (msg.type === "res_start") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              const { readable, writable } = new TransformStream();
              pending.writer = writable.getWriter();
              pending.isStream = true;
              pending.resolve({
                status: msg.status || 200,
                headers: msg.headers || {},
                stream: readable
              });
            }
          } else if (msg.type === "res_chunk") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending && pending.writer) {
              try {
                const binStr = atob(msg.chunk);
                const len = binStr.length;
                const u8 = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  u8[i] = binStr.charCodeAt(i);
                }
                pending.writer.write(u8);
              } catch (err) {
                console.error("Failed to write chunk to stream:", err);
              }
            }
          } else if (msg.type === "res_end") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              if (pending.writer) {
                try { pending.writer.close(); } catch (_) {}
              }
              this.pendingRequests.delete(msg.id);
            }
          } else if (msg.type === "res_err") {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              if (pending.writer) {
                try { pending.writer.abort(new Error(msg.error || "Tunnel error")); } catch (_) {}
              }
              this.pendingRequests.delete(msg.id);
            }
          } else if (msg.type === "ws_msg") {
            const vWs = this.visitorSockets.get(msg.id);
            if (vWs) {
              try { vWs.send(msg.data); } catch (_) {}
            }
          } else if (msg.type === "ws_close") {
            const vWs = this.visitorSockets.get(msg.id);
            if (vWs) {
              this.visitorSockets.delete(msg.id);
              try { vWs.close(msg.code || 1000, msg.reason || ""); } catch (_) {}
            }
          } else if (msg.type === "ping") {
            server.send(JSON.stringify({ type: "pong" }));
          }
        } catch (err) {
          console.error("Tunnel message parse error:", err);
        }
      });

      server.addEventListener("close", () => {
        if (this.macWs === server) {
          this.macWs = null;
        }
        for (const [reqId, pending] of this.pendingRequests.entries()) {
          clearTimeout(pending.timer);
          if (pending.writer) {
            try { pending.writer.abort(new Error("Tunnel disconnected")); } catch (_) {}
          } else {
            pending.resolve({
              status: 502,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ error: "ShareWeb host tunnel disconnected" }),
              isBase64: false
            });
          }
        }
        this.pendingRequests.clear();
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Health check of tunnel status
    if (url.pathname === "/_sw_tunnel/status") {
      return new Response(JSON.stringify({
        tunnelOnline: !!this.macWs,
        pendingCount: this.pendingRequests.size,
        activeWebSockets: this.visitorSockets.size
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Visitor Traffic: If Mac is offline, return immediate 502/503
    if (!this.macWs) {
      const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/");
      if (isApi) {
        return new Response(JSON.stringify({
          error: "ShareWeb host is offline",
          status: 503
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("502 Bad Gateway: ShareWeb host is offline", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 4. Handle Visitor WebSocket Upgrades (e.g. /ws for signaling)
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const wsId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const pair = new WebSocketPair();
      const client = pair[0];
      const visitorWs = pair[1];

      visitorWs.accept();
      this.visitorSockets.set(wsId, visitorWs);

      const headersObj = {};
      for (const [k, v] of request.headers.entries()) {
        headersObj[k.toLowerCase()] = v;
      }

      this.macWs.send(JSON.stringify({
        type: "ws_open",
        id: wsId,
        url: url.pathname + url.search,
        headers: headersObj
      }));

      visitorWs.addEventListener("message", (event) => {
        if (this.macWs) {
          this.macWs.send(JSON.stringify({
            type: "ws_msg",
            id: wsId,
            data: event.data
          }));
        }
      });

      visitorWs.addEventListener("close", (event) => {
        this.visitorSockets.delete(wsId);
        if (this.macWs) {
          this.macWs.send(JSON.stringify({
            type: "ws_close",
            id: wsId,
            code: event.code,
            reason: event.reason
          }));
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 5. Handle Normal HTTP Requests over Tunnel
    const reqId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);

    const headersObj = {};
    for (const [k, v] of request.headers.entries()) {
      headersObj[k.toLowerCase()] = v;
    }

    const resPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          this.pendingRequests.delete(reqId);
          if (pending.writer) {
            try { pending.writer.abort(); } catch (_) {}
          }
          resolve({
            status: 504,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "Custom tunnel timeout waiting for Mac host" }),
            isBase64: false
          });
        }
      }, 45000);

      this.pendingRequests.set(reqId, { resolve, reject, timer, writer: null, isStream: false });
    });

    if (request.signal) {
      request.signal.addEventListener("abort", () => {
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          if (pending.writer) {
            try { pending.writer.abort(); } catch (_) {}
          }
          this.pendingRequests.delete(reqId);
        }
        if (this.macWs) {
          try {
            this.macWs.send(JSON.stringify({ type: "req_abort", id: reqId }));
          } catch (_) {}
        }
      });
    }

    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const arrayBuffer = await request.arrayBuffer();
        const CHUNK_SIZE = 256 * 1024;
        if (arrayBuffer.byteLength > CHUNK_SIZE) {
          this.macWs.send(JSON.stringify({
            type: "req_start",
            id: reqId,
            method: request.method,
            url: url.pathname + url.search,
            headers: headersObj
          }));
          for (let offset = 0; offset < arrayBuffer.byteLength; offset += CHUNK_SIZE) {
            const slice = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
            const bytes = new Uint8Array(slice);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            this.macWs.send(JSON.stringify({
              type: "req_chunk",
              id: reqId,
              chunk: btoa(binary)
            }));
          }
          this.macWs.send(JSON.stringify({
            type: "req_end",
            id: reqId
          }));
        } else {
          let bodyBase64 = null;
          if (arrayBuffer.byteLength > 0) {
            const bytes = new Uint8Array(arrayBuffer);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            bodyBase64 = btoa(binary);
          }
          this.macWs.send(JSON.stringify({
            type: "req",
            id: reqId,
            method: request.method,
            url: url.pathname + url.search,
            headers: headersObj,
            body: bodyBase64
          }));
        }
      } else {
        this.macWs.send(JSON.stringify({
          type: "req",
          id: reqId,
          method: request.method,
          url: url.pathname + url.search,
          headers: headersObj,
          body: null
        }));
      }
    } catch (err) {
      return new Response("Failed to send to Mac tunnel client: " + err.message, { status: 502 });
    }

    const resData = await resPromise;

    const resHeaders = new Headers();
    if (resData.headers) {
      for (const [k, v] of Object.entries(resData.headers)) {
        if (k.toLowerCase() !== "content-encoding") {
          resHeaders.set(k, v);
        }
      }
    }

    if (resData.stream) {
      return new Response(resData.stream, {
        status: resData.status || 200,
        headers: resHeaders
      });
    }

    let responseBody = null;
    if (resData.body) {
      if (resData.isBase64) {
        const binStr = atob(resData.body);
        const len = binStr.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          u8[i] = binStr.charCodeAt(i);
        }
        responseBody = u8;
      } else {
        responseBody = resData.body;
      }
    }

    return new Response(responseBody, {
      status: resData.status || 200,
      headers: resHeaders
    });
  }
}

export default {
  async fetch(request, env) {
    if (!env.TUNNEL_HUB) {
      return new Response("Durable Object binding TUNNEL_HUB not found", { status: 500 });
    }
    const id = env.TUNNEL_HUB.idFromName("global_shareweb_hub");
    return env.TUNNEL_HUB.get(id).fetch(request);
  }
};
