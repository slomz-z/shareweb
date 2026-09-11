export default {
  async fetch(request, env) {
    const now = Date.now();
    let tunnelUrl = env.TUNNEL_URL;

    if (!tunnelUrl) {
      try {
        const res = await fetch("https://raw.githubusercontent.com/slomz-z/shareweb/main/tunnel.json?t=" + now);
        if (res.ok) {
          const data = await res.json();
          if (data && data.publicUrl) {
            tunnelUrl = data.publicUrl.replace(/\/$/, "");
          }
        }
      } catch (_) {}
    }

    if (!tunnelUrl) {
      tunnelUrl = "https://spin-expenditures-homepage-dance.trycloudflare.com";
    }

    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, tunnelUrl);

    // Stream WebSockets natively
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const wsTarget = new URL(url.pathname + url.search, tunnelUrl.replace(/^http/, "ws"));
      return fetch(new Request(wsTarget, request));
    }

    const reqHeaders = new Headers(request.headers);
    reqHeaders.set("Host", targetUrl.host);
    reqHeaders.set("X-Forwarded-Host", url.host);
    reqHeaders.set("X-Forwarded-Proto", "https");

    const reqInit = {
      method: request.method,
      headers: reqHeaders,
      redirect: "manual"
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      reqInit.body = request.body;
    }

    const response = await fetch(new Request(targetUrl, reqInit));

    const resHeaders = new Headers(response.headers);
    const loc = resHeaders.get("Location");
    if (loc && loc.includes(targetUrl.host)) {
      resHeaders.set("Location", loc.replace(targetUrl.origin, url.origin));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders
    });
  }
};
