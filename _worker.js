export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = (request.headers.get("host") || "").toLowerCase();

    // Single-entry rule: the app is reachable ONLY at shareweb.slomz.is-a.dev.
    // The tunnel control plane (/_sw_tunnel/*) is exempt so the agent can dial in.
    if (!url.pathname.startsWith("/_sw_tunnel/") && host !== "shareweb.slomz.is-a.dev") {
      return new Response("403 Forbidden: available only at https://shareweb.slomz.is-a.dev", { status: 403 });
    }

    if (!env.TUNNEL_HUB) {
      return new Response("Configuration Error: TUNNEL_HUB not bound", { status: 500 });
    }
    const id = env.TUNNEL_HUB.idFromName("global_shareweb_hub_v6");
    const stub = env.TUNNEL_HUB.get(id);
    return stub.fetch(request);
  }
};
