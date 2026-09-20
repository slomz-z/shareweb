# shareweb

ShareWeb — LAN-first file sharing web client + tunnel layer. The app itself lives in
`~/shareweb` on the host Mac; this repo is the public frontend that GitHub Pages +
Cloudflare Pages deploy, plus the tunnel agents that keep the live endpoint
(`https://shareweb.slomz.is-a.dev`) reachable.

## What's in this repo

- `index.html`, `landing.html`, `login.html`, `account.html`, `manage.html`, …
  — the static frontend (single-document build; the app smart-loader lives at the
  end of `index.html`).
- `app.js`, `crypto.js`, `qr-code.js`, `sound-effects.js`, `lock-frame.js`,
  `modules/`, `vendor/` — client JS + vendored libs.
- `page-i18n.js`, `translations_44_master.json` — 44-language UI copy.
- `custom-tunnel.mjs` — Cloudflare tunnel agent (streaming protocol; reads
  `TUNNEL_SECRET` from the environment, disables uploads when unset).
- `shareweb-tunnel-worker.js` — Cloudflare Durable-Objects relay worker.
- `direct-tunnel.mjs` — **no-Cloudflare direct tunnel**: a pure-Node supervisor
  that discovers the router via UPnP/SSDP, maps TCP 80/443 to the Mac, runs a
  self-signed TLS reverse proxy on `:8443` → the local Node app (`:8080`), and
  publishes its endpoint to this repo's `direct.json`. See below.
- `direct.json` / `tunnel.json` — live endpoint state, auto-published by the
  running agents (kept out of git via `.gitignore`).

## Deployment notes

### Cloudflare path (automatic fallback)

`_worker.js` requires a `TUNNEL_HUB` binding; the Pages project + DO relay point
the domain at the Mac through `custom-tunnel.mjs`. This keeps the site live from
the public internet and does not depend on the local network.

### Direct tunnel (no Cloudflare)

Run in user-context on the Mac (no sudo — listeners use unprivileged ports):

    node direct-tunnel.mjs                # normal run
    node direct-tunnel.mjs --probe        # discovery + connectivity check only

It installs itself as a user LaunchAgent at
`~/Library/LaunchAgents/com.shareweb.directtunnel.plist`
(`launchctl load` / `unload`). On boot it:

1. Discovers the ISP router via SSDP (`upnp:rootdevice`) and reads the UPnP
   `WANIPConnection:1` service.
2. Resolves the public IP (router WAN when public, else an IP echo service).
3. Provisions a self-signed certificate (SANs: domain, localhost, 127.0.0.1, WAN
   IP) via `openssl` when the IP changes.
4. Runs `https://0.0.0.0:8443` → `127.0.0.1:8080` (HTTP + WebSocket upgrade),
   injecting `X-Forwarded-Proto/Host` and stripping hop-by-hop headers.
5. Maps TCP 80 → :8080 and 443 → :8443 on the router (UPnP `AddPortMapping`),
   re-asserted every 60 s.
6. Publishes `~/.shareweb/direct.json` + this repo's `direct.json` with
   `directReachable`, `directUrl`, and `reachNotes`. Publishes are skipped when
   the file is unchanged.

Reachability of the router WAN through the ISP is checked and reported honestly
in `direct.json`: if the router WAN IP is RFC1918/CGNAT (this connection currently
reports `10.10.10.146` behind public `150.228.105.113`), `directReachable` is
`false` and the Cloudflare path remains the internet fallback. LAN clients can
always use the direct endpoint immediately.