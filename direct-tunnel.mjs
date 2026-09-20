#!/usr/bin/env node
/**
 * ShareWeb Direct Tunnel
 * ======================
 * A fully self-owned tunnel that exposes the local ShareWeb Node server to the
 * public internet WITHOUT Cloudflare or any third-party relay:
 *
 *   browser ──> https://shareweb.slomz.is-a.dev (or https://<public-ip>:8443)
 *        │
 *        ▼  port 80 ──> router (UPnP) ──> 127.0.0.1:8080   (Node http)
 *        ▼  port 443 ──> router (UPnP) ──> 127.0.0.1:8443  (this TLS proxy) ──> 127.0.0.1:8080
 *
 * Responsibilities:
 *   1. Discover the router's public (WAN) IP via UPnP GetExternalIPAddress
 *      (falls back to a public IP echo service).
 *   2. Open port mappings on the router over UPnP IGD (pure Node SOAP): 80->8080, 443->8443.
 *   3. Terminate TLS with a certificate for the domain + current public IP and
 *      tunnel the connection into the local Node server (HTTP + WebSocket upgrades),
 *      injecting X-Forwarded-Proto/Host so the app sees a normal public request.
 *   4. Publish the live endpoint to the GitHub repo (direct.json) + ~/.shareweb/direct.json
 *      so the GitHub Pages/deployed frontend always knows where its host is.
 *   5. Watch the public IP; on change, re-issue the cert, re-assert the mappings,
 *      and re-publish the endpoint.
 *
 * No third-party tunnel services, no external relay, no Cloudflare.
 * Requires: Node >= 18, openssl (macOS ships it). Router must support UPnP.
 *
 * Run:  node scripts/direct-tunnel.mjs
 */

import net from 'net';
import tls from 'tls';
import http from 'http';
import https from 'https';
import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Configuration (all overridable via env)
// ---------------------------------------------------------------------------
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '8080', 10);
const TLS_PORT = parseInt(process.env.TLS_PORT || '8443', 10);
const DOMAIN = process.env.DOMAIN || 'shareweb.slomz.is-a.dev';
const REPO = process.env.TUNNEL_REPO || 'slomz-z/shareweb';
const BRANCH = process.env.TUNNEL_BRANCH || 'main';
const STATE_DIR = path.join(os.homedir(), '.shareweb');
const STATE_FILE = path.join(STATE_DIR, 'direct.json');
const CERT_DIR = path.join(STATE_DIR, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const LOG_FILE = '/tmp/shareweb-direct.log';
const TOKEN_FILE = path.join(os.homedir(), '.github_token');
const LAN_CHECK_MS = 60 * 1000;
const PUBLISH_MS = 60 * 1000;
const HEALTH_MS = 5 * 1000;

const TLS_KEY = process.env.TLS_KEY;
const TLS_CERT = process.env.TLS_CERT;

let tlsServer = null;
let upnpInfo = null; // { controlHost, controlPort, controlURL, serviceType, wanIp }
let currentPublicIp = null;
let currentReach = { directReachable: false, wanIp: null, publicIp: null, lanIp: null, notes: [] };
let lastPublished = '';
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
function ensureCertsDir() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
}

function gatewayIf() {
  try {
    const out = execSync('route -n get default').toString();
    const m = out.match(/interface:\s*(\S+)/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function lanIp() {
  const wantIf = gatewayIf();
  const ifaces = os.networkInterfaces();
  const walk = (name) => (ifaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
  if (wantIf) {
    const v = walk(wantIf);
    if (v) return v.address;
  }
  for (const name of Object.keys(ifaces)) {
    if (/^(utun|awdl|llw|bridge|lo|gif|stf|vbox|vmnet)/.test(name)) continue;
    const v = walk(name);
    if (v) return v.address;
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// WAN IP discovery via UPnP (preferred) and public echo (fallback)
// ---------------------------------------------------------------------------
function ssdpDiscoverIgd(timeoutMs = 7000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const seen = new Set();
    const results = [];
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(results);
    }
    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      const loc = (s.match(/LOCATION:\s*(\S+)/i) || [])[1];
      const st = (s.match(/ST:\s*(\S+)/i) || [])[1] || '';
      if (loc && !seen.has(loc) && rinfo.port === 1900) {
        const isIgd = st.includes('InternetGatewayDevice') || /igd\.xml$/i.test(loc);
        seen.add(loc);
        if (isIgd) results.push({ url: loc, from: rinfo.address });
      }
    });
    sock.on('error', (err) => { log(`SSDP error: ${err.message}`); finish(); });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const m = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: upnp:rootdevice\r\n\r\n';
      const sendAll = () => {
        try { sock.send(m, 1900, '239.255.255.250'); } catch (_) {}
        try { sock.send(m, 1900, '192.168.1.1'); } catch (_) {}
      };
      sendAll();
      const interval = setInterval(sendAll, 1200);
      setTimeout(() => { clearInterval(interval); finish(); }, timeoutMs);
    });
  });
}

function httpGetText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function xmlServiceBlocks(xml) {
  const out = [];
  const re = /<service(?:\s[^>]*)?>([\s\S]*?)<\/service>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

const upnpQueue = new Map(); // simple per-host mutex not needed; sequential calls fine

async function discoverIgdService() {
  const found = await ssdpDiscoverIgd();
  for (const { url } of found.slice(0, 4)) {
    try {
      const xml = await httpGetText(url);
      const base = xmlTag(xml, 'URLBase');
      const origin = (base && /^https?:\/\//i.test(base))
        ? base.replace(/\/+$/, '')
        : new URL(url).origin;
      for (const block of xmlServiceBlocks(xml)) {
        const svcType = xmlTag(`<s>${block}</s>`, 'serviceType') || '';
        if (svcType.includes('WANIPConnection') || svcType.includes('WANPPPConnection')) {
          const ctrl = xmlTag(`<s>${block}</s>`, 'controlURL');
          if (ctrl) {
            const abs = ctrl.startsWith('/')
              ? `${origin}${ctrl}`
              : `${origin}/${ctrl}`;
            const u = new URL(abs);
            return {
              controlHost: u.hostname,
              controlPort: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
              controlURL: u.pathname + u.search,
              serviceType: svcType,
              host: u.host,
              protocol: u.protocol
            };
          }
        }
      }
    } catch (err) {
      log(`UPnP service discovery skipped (${url}): ${err.message}`);
    }
  }
  return null;
}

function soapCall(igd, action, payloadArgs, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body =
      `<?xml version="1.0"?>\n` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${igd.serviceType}">${payloadArgs}</u:${action}></s:Body></s:Envelope>`;
    const ports = igd.controlPort === 80 ? [80] : [igd.controlPort, 80];
    let attemptIdx = -1;
    function attempt() {
      attemptIdx++;
      const port = ports[attemptIdx];
      if (port === undefined) return reject(new Error(`SOAP ${action} failed on all control ports`));
      const req = http.request({
        host: igd.controlHost,
        port,
        path: igd.controlURL,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': `${igd.serviceType}#${action}`,
          'Content-Length': Buffer.byteLength(body),
          'Connection': 'close'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const result = { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') };
          if (result.status >= 200 && result.status < 300) resolve(result);
          else if (attemptIdx < ports.length - 1) attempt();
          else resolve(result);
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (attemptIdx < ports.length - 1) attempt(); else reject(err);
      });
      req.end(body);
    }
    attempt();
  });
}

let upnpWarnLogged = false;

async function getWanIpFromIgd(igd) {
  if (!igd) return null;
  try {
    const res = await soapCall(igd, 'GetExternalIPAddress', '');
    const ip = xmlTag(res.body, 'NewExternalIPAddress');
    if (res.status >= 200 && res.status < 300 && ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    if (!upnpWarnLogged) {
      log(`UPnP GetExternalIPAddress returned HTTP ${res.status} (no WAN IP from router).`);
      upnpWarnLogged = true;
    }
    return null;
  } catch (err) {
    if (!upnpWarnLogged) {
      log(`UPnP GetExternalIPAddress error: ${err.message}`);
      upnpWarnLogged = true;
    }
    return null;
  }
}

async function addPortMapping(igd, externalPort, internalPort, proto = 'TCP') {
  if (!igd) return false;
  const client = lanIp();
  const args =
    `<NewRemoteHost></NewRemoteHost>` +
    `<NewExternalPort>${externalPort}</NewExternalPort>` +
    `<NewProtocol>${proto}</NewProtocol>` +
    `<NewInternalPort>${internalPort}</NewInternalPort>` +
    `<NewInternalClient>${client}</NewInternalClient>` +
    `<NewEnabled>1</NewEnabled>` +
    `<NewPortMappingDescription>ShareWeb Direct</NewPortMappingDescription>` +
    `<NewLeaseDuration>86400</NewLeaseDuration>`;
  try {
    const res = await soapCall(igd, 'AddPortMapping', args);
    if (res.status >= 200 && res.status < 300) {
      log(`UPnP mapping OK: ${proto} ${externalPort} -> ${client}:${internalPort}`);
      return true;
    }
    log(`UPnP AddPortMapping ${externalPort}->${internalPort} rejected (HTTP ${res.status})`);
    return false;
  } catch (err) {
    log(`UPnP AddPortMapping ${externalPort}->${internalPort} error: ${err.message}`);
    return false;
  }
}

async function assertPortMappings(igd) {
  if (!igd) return { http: false, https: false };
  const httpOk = await addPortMapping(igd, 80, LOCAL_PORT, 'TCP');
  const httpsOk = await addPortMapping(igd, 443, TLS_PORT, 'TCP');
  return { http: httpOk, https: httpsOk, ip: currentPublicIp };
}

async function resolvePublicIp() {
  // Prefer the router's WAN IP when it is a real public address.
  if (upnpInfo) {
    const ip = await getWanIpFromIgd(upnpInfo);
    if (ip && isPublicIpv4(ip)) return ip;
  }
  // Fallback: lightweight public IP echo (not a tunnel relay).
  for (const u of ['https://api.ipify.org', 'https://icanhazip.com']) {
    try {
      const text = (await httpGetText(u, 6000)).trim();
      if (isPublicIpv4(text)) return text;
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// TLS certificate (self-signed until a Let's Encrypt cert is provisioned)
// ---------------------------------------------------------------------------
function certSans(ip) {
  return `subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1${ip ? `,IP:${ip}` : ''}`;
}

function certMatchesIp(ip) {
  try {
    if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) return false;
    const txt = fs.readFileSync(CERT_FILE, 'utf8');
    if (!txt.includes(ip)) return false;
    return true;
  } catch (_) { return false; }
}

function provisionCert(ip) {
  if (TLS_KEY && TLS_CERT) {
    log('Using TLS_KEY/TLS_CERT from environment.');
    return true;
  }
  ensureCertsDir();
  if (certMatchesIp(ip)) {
    log(`Certificates are current (IP ${ip}).`);
    return true;
  }
  const cmd = 'openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 ' +
    `-keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
    `-subj "/CN=${DOMAIN}" -addext "${certSans(ip)}"`;
  const r = spawnSync('/bin/zsh', ['-lc', cmd], { stdio: 'pipe' });
  if (r.status !== 0) {
    log(`openssl cert generation failed: ${r.stderr.toString()}`);
    return false;
  }
  log(`Generated self-signed certificate for ${DOMAIN} (IP ${ip}).`);
  return true;
}

// ---------------------------------------------------------------------------
// TLS reverse proxy (HTTP + WebSocket upgrade) into the local Node server
// ---------------------------------------------------------------------------
function stripHopHeaders(headers) {
  const out = { ...headers };
  for (const h of ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete out[h];
  return out;
}

function forwardHttp(req, res) {
  const options = {
    host: '127.0.0.1',
    port: LOCAL_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...stripHopHeaders(req.headers),
      host: DOMAIN,
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
      'x-forwarded-host': DOMAIN,
      'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress
    }
  };
  const proxy = http.request(options, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
    res.on('close', () => pres.destroy());
  });
  proxy.setTimeout(45000, () => proxy.destroy(new Error('proxy timeout')));
  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'ShareWeb host unreachable: ' + err.message }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

function forwardUpgrade(req, socket, head) {
  const options = {
    host: '127.0.0.1',
    port: LOCAL_PORT,
    path: req.url,
    method: req.method || 'GET',
    headers: {
      ...stripHopHeaders(req.headers),
      host: DOMAIN,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': DOMAIN,
      'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      upgrade: req.headers.upgrade || 'websocket',
      connection: 'Upgrade'
    }
  };
  const proxy = http.request(options);
  proxy.setTimeout(45000, () => proxy.destroy(new Error('ws proxy timeout')));
  proxy.on('upgrade', (_pres, upstream) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + req.headers['sec-websocket-key'] + '\r\n\r\n');
    socket.removeAllListeners('data');
    socket.pipe(upstream);
    upstream.pipe(socket);
    const cleanup = () => { try { socket.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    upstream.on('close', cleanup);
    upstream.on('error', cleanup);
    if (head && head.length) upstream.write(head);
  });
  proxy.on('error', () => {
    try { socket.destroy(); } catch (_) {}
  });
  proxy.end();
}

function startTlsProxy() {
  const cert = TLS_CERT ? fs.readFileSync(TLS_CERT) : fs.readFileSync(CERT_FILE);
  const key = TLS_KEY ? fs.readFileSync(TLS_KEY) : fs.readFileSync(KEY_FILE);

  tlsServer = https.createServer({ key, cert }, forwardHttp);
  tlsServer.on('upgrade', forwardUpgrade);
  tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
    log(`TLS proxy listening on 0.0.0.0:${TLS_PORT} -> 127.0.0.1:${LOCAL_PORT}`);
  });
  tlsServer.on('error', (err) => {
    log(`TLS proxy error: ${err.message}`);
    if (err.code === 'EADDRINUSE' && !shuttingDown) {
      log(`Port ${TLS_PORT} already in use. Waiting 10s then retrying...`);
      setTimeout(startTlsProxy, 10000);
    }
  });
}

// ---------------------------------------------------------------------------
// Publishing: ~/.shareweb/status.json + GitHub repo tunnel.json
// ---------------------------------------------------------------------------
function writeStatus(status, publicUrl, ip, extra = {}) {
  const state = {
    status,
    localUrl: `http://127.0.0.1:${LOCAL_PORT}`,
    publicUrl: publicUrl || null,
    tunnel: 'direct',
    wanIp: ip || null,
    tunnelPort: TLS_PORT,
    directReachable: currentReach.directReachable,
    directUrl: currentReach.publicIp && ip ? `https://${ip}:${TLS_PORT}` : null,
    reachNotes: currentReach.notes,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log(`Failed to write status file: ${err.message}`);
  }
}

async function publishToGitHub(publicUrl, ip) {
  if (!fs.existsSync(TOKEN_FILE)) {
    log('No ~/.github_token — skipping GitHub direct.json publish.');
    return;
  }
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) return;

  const payload = JSON.stringify({
    publicUrl,
    tunnel: 'direct',
    wanIp: ip,
    tunnelPort: TLS_PORT,
    directReachable: currentReach.directReachable,
    directUrl: ip && currentReach.publicIp ? `https://${ip}:${TLS_PORT}` : null,
    updatedAt: new Date().toISOString()
  }, null, 2);

  if (payload === lastPublished) return;
  try {
    const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/direct.json`, {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'ShareWeb-DirectTunnel' }
    });
    let sha = null;
    if (getRes.ok) {
      const remote = await getRes.json();
      sha = remote.sha;
      const remoteJson = remote.content ? JSON.parse(Buffer.from(remote.content, 'base64').toString()) : null;
      const local = { ...JSON.parse(payload), updatedAt: null };
      if (remoteJson && JSON.stringify({ ...remoteJson, updatedAt: null }) === JSON.stringify(local)) {
        lastPublished = payload;
        return;
      }
    }

    const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/direct.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ShareWeb-DirectTunnel' },
      body: JSON.stringify({
        message: 'Auto-sync live endpoint (direct tunnel)',
        content: Buffer.from(payload).toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {})
      })
    });
    if (putRes.ok) {
      lastPublished = payload;
      log(`Published direct.json -> ${publicUrl} (${ip})`);
    } else {
      log(`GitHub publish failed (HTTP ${putRes.status})`);
    }
  } catch (err) {
    log(`GitHub publish error: ${err.message}`);
  }
}

function isNodeHealthy() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${LOCAL_PORT}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function boot() {
  log('============================================');
  log('ShareWeb Direct Tunnel starting');
  log(`Local Node:  http://127.0.0.1:${LOCAL_PORT}  | TLS proxy: :${TLS_PORT}`);
  log(`Domain:      ${DOMAIN}`);
  log('============================================');

  // 1. Discover the UPnP IGD service.
  upnpInfo = await discoverIgdService();
  if (upnpInfo) {
    log(`UPnP IGD found: ${upnpInfo.controlHost}:${upnpInfo.controlPort} (${upnpInfo.serviceType})`);
  } else {
    log('UPnP IGD NOT found — routers that block UPnP will not port-forward. Ports 80/443 must be mapped manually.');
  }

  // 2. Resolve public IP + reachability.
  currentPublicIp = await resolvePublicIp();
  const routerWan = await getWanIpFromIgd(upnpInfo);
  currentReach = await reachability(routerWan, currentPublicIp);
  log(`Public IP: ${currentPublicIp || 'unknown'} | router WAN: ${routerWan || 'unknown'} | direct inbound reachable: ${currentReach.directReachable}`);

  // 3. Certificates + TLS proxy.
  const healthy = await isNodeHealthy();
  if (!healthy) log(`WARNING: Node server not responding on :${LOCAL_PORT} yet — proxy will retry per connection.`);

  if (!provisionCert(currentPublicIp)) {
    log('FATAL: could not provision a certificate. Exiting.');
    process.exit(1);
  }
  startTlsProxy();

  // 4. Router mappings + first publish.
  await assertPortMappings(upnpInfo);
  const publicUrl = `https://${DOMAIN}`;
  writeStatus(currentPublicIp ? 'online' : 'connecting', publicUrl, currentPublicIp);
  await publishToGitHub(publicUrl, currentPublicIp);

  // 5. Watchdog.
  setInterval(async () => {
    const nodeOk = await isNodeHealthy();
    if (currentPublicIp && nodeOk) writeStatus('online', `https://${DOMAIN}`, currentPublicIp);
    else writeStatus('connecting', `https://${DOMAIN}`, currentPublicIp);

    // Detect IP change -> re-issue cert, re-map, re-publish.
    const ip = await resolvePublicIp();
    if (ip && ip !== currentPublicIp) {
      log(`Public IP changed: ${currentPublicIp} -> ${ip}`);
      currentPublicIp = ip;
      const newWan = await getWanIpFromIgd(upnpInfo);
      currentReach = await reachability(newWan, ip);
      provisionCert(ip);
      await assertPortMappings(upnpInfo);
      writeStatus('online', `https://${DOMAIN}`, ip);
      lastPublished = ''; // force re-publish
      await publishToGitHub(`https://${DOMAIN}`, ip);
    } else if (!ip && !upnpInfo) {
      // Routers without UPnP: nothing more we can do automatically.
    }
  }, HEALTH_MS);

  // Periodically re-assert mappings + heartbeat publish.
  setInterval(async () => {
    await assertPortMappings(upnpInfo);
    await publishToGitHub(`https://${DOMAIN}`, currentPublicIp);
  }, PUBLISH_MS);

  log('Direct tunnel supervisor running.');
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${sig}).`);
  writeStatus('offline', null, currentPublicIp);
  try { if (tlsServer) tlsServer.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (err) => log(`Uncaught: ${err.stack || err.message}`));

// ---------------------------------------------------------------------------
// Reachability analysis (CGNAT / double-NAT detection)
// ---------------------------------------------------------------------------
function isPublicIpv4(ip) {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return false;                       // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 0 || a === 127) return false;
  return true;
}

async function reachability(wanIp, publicIp) {
  const routerPrivate = wanIp && !isPublicIpv4(wanIp);
  const notes = [];
  if (routerPrivate) {
    notes.push(`router WAN is private (${wanIp}) — the ISP carrier-grade NATs the connection, so router port mappings DON'T reach the public internet`);
  } else if (!wanIp) {
    notes.push('router WAN IP not available');
  }
  if (!publicIp) notes.push('public IP unknown');
  return {
    directReachable: !routerPrivate && !!publicIp,
    wanIp,
    publicIp,
    lanIp: lanIp(),
    notes
  };
}

async function probe() {
  log('--- Direct Tunnel probe ---');
  const igd = await discoverIgdService();
  if (!igd) { log('UPnP IGD: NOT FOUND'); process.exit(1); }
  log(`UPnP IGD: ${igd.controlHost}:${igd.controlPort} ${igd.serviceType} :: ${igd.controlURL}`);
  const wan = await getWanIpFromIgd(igd);
  log(`Router WAN IP: ${wan}`);
  const echo = await resolvePublicIp();
  log(`Public IP (probe): ${echo}`);
  const r = await reachability(wan, echo);
  log(`Direct inbound reachable: ${r.directReachable}`);
  for (const n of r.notes) log(`  note: ${n}`);
  log(`LAN IP: ${lanIp()}`);
  process.exit(0);
}

if (process.argv.includes('--probe')) probe();
else boot().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  writeStatus('offline', null, null);
  process.exit(1);
});