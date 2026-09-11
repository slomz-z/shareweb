export default {
  async fetch(request, env) {
    if (!env.TUNNEL_HUB) {
      return new Response("Configuration Error: TUNNEL_HUB not bound", { status: 500 });
    }
    const id = env.TUNNEL_HUB.idFromName("global_shareweb_hub");
    const stub = env.TUNNEL_HUB.get(id);
    return stub.fetch(request);
  }
};
