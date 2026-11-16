// Glowline Link: ein starker PC teilt seine Modelle im eigenen Netzwerk, ein Laptop mit "Glowline Link" nutzt sie.
// PC (Glowline): HTTP-Tor auf Port 3470, nur fuer Geraete im Heimnetz, Kopplung per 6-stelligem Code -> geheimer Schluessel.
// Laptop (Glowline Link): findet PCs per UDP-Rundruf (3471) und leitet Ollama/LM Studio ueber das Tor um.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const PORT = 3470, SUCH_PORT = 3471;
const FRAGE = 'GLOWLINE_LINK?', ANTWORT = 'GLOWLINE_LINK!';

let d = null; // Hilfen aus main.js: cfg, speichere, version, gpu, sende
let server = null, rundruf = null;
const versuche = new Map(); // IP -> [Zeitpunkte falscher Codes]
const geraete = new Map(); // IP -> zuletzt gesehen

function init(hilfen) { d = hilfen; }

// nur Heimnetz: private Adressen und dieser PC
function heimnetz(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd]|^fe80/i.test(a);
}
const neuerCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const neuerSchluessel = () => crypto.randomBytes(24).toString('hex');

function adressen() {
  const l = [];
  for (const [name, liste] of Object.entries(os.networkInterfaces())) {
    for (const x of liste || []) {
      if (x.family === 'IPv4' && !x.internal && heimnetz(x.address) && !/vethernet|virtual|vmware|vbox|wsl|hyper-v/i.test(name)) l.push(x.address);
    }
  }
  return l;
}

function stand() {
  const c = d.cfg().link || {};
  const jetzt = Date.now();
  return {
    teilen: !!server, code: c.code || '', name: os.hostname(), adressen: adressen(), port: PORT,
    geraete: [...geraete.entries()].filter(([, t]) => jetzt - t < 60000).map(([ip]) => ip.replace(/^::ffff:/, '')),
    fehler: stand.fehler || null,
  };
}

// ---------- PC: Tor oeffnen ----------
function json(res, code, j) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }

function weiterleiten(req, res, ziel) {
  let u;
  try { u = new URL(ziel); } catch { return json(res, 502, { error: 'backend not set' }); }
  const kopf = { ...req.headers, host: u.host };
  delete kopf['content-length'];
  if (req.headers['content-length']) kopf['content-length'] = req.headers['content-length'];
  const p = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname.replace(/\/$/, '') + req.url, method: req.method, headers: kopf }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  p.on('error', (e) => { if (!res.headersSent) json(res, 502, { error: 'backend offline: ' + e.code }); else res.end(); });
  req.pipe(p);
  res.on('close', () => p.destroy());
}

async function anfrage(req, res) {
  const ip = req.socket.remoteAddress;
  if (!heimnetz(ip)) { res.writeHead(403); return res.end(); }
  const c = d.cfg().link || {};
  const pfad = req.url.split('?')[0];
  if (pfad === '/glowline-link') return json(res, 200, { glowline: true, name: os.hostname(), version: d.version });
  if (pfad === '/glowline-link/pair' && req.method === 'POST') {
    const alt = (versuche.get(ip) || []).filter((t) => Date.now() - t < 60000);
    if (alt.length >= 5) return json(res, 429, { error: 'Too many wrong codes – wait a minute' });
    let roh = '';
    for await (const x of req) { roh += x; if (roh.length > 2000) break; }
    let code = '';
    try { code = String(JSON.parse(roh).code || '').replace(/\D/g, ''); } catch {}
    if (!c.code || code !== c.code) {
      versuche.set(ip, [...alt, Date.now()]);
      return json(res, 401, { error: 'Wrong code' });
    }
    if (!c.schluessel) { c.schluessel = neuerSchluessel(); d.cfg().link = c; d.speichere(); }
    geraete.set(ip, Date.now());
    d.sende('link', stand());
    return json(res, 200, { schluessel: c.schluessel, name: os.hostname() });
  }
  // alles andere nur mit Schluessel: /<schluessel>/ollama/..., /<schluessel>/lmstudio/..., /<schluessel>/status
  const m = /^\/([0-9a-f]{48})(\/(ollama|lmstudio|status))(\/.*)?$/.exec(pfad);
  if (!m || !c.schluessel || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(c.schluessel))) { res.writeHead(401); return res.end(); }
  const neu = !geraete.has(ip);
  geraete.set(ip, Date.now());
  if (neu) d.sende('link', stand());
  if (m[3] === 'status') return json(res, 200, { gpu: await d.gpu(), name: os.hostname() });
  req.url = req.url.slice(1 + 48 + m[2].length) || '/';
  return weiterleiten(req, res, d.cfg().backends[m[3]]);
}

function rundrufStarten() {
  if (rundruf) return;
  rundruf = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  rundruf.on('message', (msg, von) => {
    if (String(msg) !== FRAGE || !heimnetz(von.address)) return;
    const antwort = Buffer.from(ANTWORT + JSON.stringify({ name: os.hostname(), port: PORT, adressen: adressen() }));
    rundruf.send(antwort, von.port, von.address);
  });
  rundruf.on('error', () => { try { rundruf.close(); } catch {} rundruf = null; });
  rundruf.bind(SUCH_PORT);
}

function teilen(an) {
  const c = d.cfg().link || {};
  stand.fehler = null;
  if (!an) {
    if (server) { server.close(); server = null; }
    if (rundruf) { try { rundruf.close(); } catch {} rundruf = null; }
    c.teilen = false;
    d.cfg().link = c; d.speichere();
    d.sende('link', stand());
    return Promise.resolve(stand());
  }
  if (!c.code) c.code = neuerCode();
  c.teilen = true;
  d.cfg().link = c; d.speichere();
  if (server) return Promise.resolve(stand());
  return new Promise((ok) => {
    const s = http.createServer((req, res) => anfrage(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }));
    s.on('error', (e) => { stand.fehler = e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use` : e.message; server = null; d.sende('link', stand()); ok(stand()); });
    s.listen(PORT, '0.0.0.0', () => { server = s; rundrufStarten(); d.sende('link', stand()); ok(stand()); });
  });
}

// neuer Code und neuer Schluessel: gekoppelte Laptops muessen sich neu verbinden
function neuKoppeln() {
  const c = d.cfg().link || {};
  c.code = neuerCode();
  c.schluessel = '';
  d.cfg().link = c; d.speichere();
  geraete.clear();
  d.sende('link', stand());
  return stand();
}

// ---------- Laptop: PCs finden und koppeln ----------
function suchen(ms = 1500) {
  return new Promise((ok) => {
    const funde = new Map();
    const s = dgram.createSocket('udp4');
    s.on('message', (msg, von) => {
      const t = String(msg);
      if (!t.startsWith(ANTWORT)) return;
      try {
        const j = JSON.parse(t.slice(ANTWORT.length));
        const name = String(j.name || von.address).slice(0, 60);
        // ein PC antwortet ueber mehrere Netzadapter: nur einmal zeigen, die echte Adresse (nicht WSL/Hyper-V) bevorzugen
        const echt = Array.isArray(j.adressen) && j.adressen.includes(von.address);
        const alt = funde.get(name);
        if (!alt || (echt && !alt.echt)) funde.set(name, { host: von.address, port: +j.port || PORT, name, echt });
      } catch {}
    });
    s.on('error', () => {});
    s.bind(0, () => {
      s.setBroadcast(true);
      const ziele = new Set(['255.255.255.255']);
      // gezielter Rundruf je Netz (manche Router lassen 255.255.255.255 nicht durch)
      for (const liste of Object.values(os.networkInterfaces())) for (const x of liste || []) {
        if (x.family !== 'IPv4' || x.internal || !x.netmask) continue;
        const a = x.address.split('.').map(Number), n = x.netmask.split('.').map(Number);
        ziele.add(a.map((v, i) => (v & n[i]) | (~n[i] & 255)).join('.'));
      }
      const senden = () => { for (const z of ziele) s.send(FRAGE, SUCH_PORT, z, () => {}); };
      senden();
      setTimeout(senden, 500);
    });
    setTimeout(() => { try { s.close(); } catch {} ok([...funde.values()].map(({ echt, ...f }) => f)); }, ms);
  });
}

async function koppeln(host, code, port = PORT) {
  host = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hp = /^(.+?)(?::(\d+))?$/.exec(host);
  if (!hp) throw new Error('Enter the address of your PC');
  const h = hp[1], p = +hp[2] || port;
  let r;
  try {
    r = await fetch(`http://${h}:${p}/glowline-link/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(6000) });
  } catch { throw new Error(`Can't reach ${h} – is Glowline open there and “Share this PC” turned on?`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  const c = d.cfg().link || {};
  c.verbindung = { host: h, port: p, schluessel: j.schluessel, name: j.name || h };
  d.cfg().link = c;
  umleiten();
  d.speichere();
  return c.verbindung;
}

function trennen() {
  const c = d.cfg().link || {};
  delete c.verbindung;
  d.cfg().link = c;
  d.cfg().backends = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' };
  d.speichere();
}

// Laptop: Ollama und LM Studio zeigen auf das Tor des PCs
function basis() {
  const v = ((d.cfg().link || {}).verbindung);
  return v ? `http://${v.host}:${v.port}/${v.schluessel}` : null;
}
function umleiten() {
  const b = basis();
  if (b) d.cfg().backends = { ollama: b + '/ollama', lmstudio: b + '/lmstudio' };
}
let gpuMerk = null, gpuZeit = 0;
async function fernGpu() {
  const b = basis();
  if (!b) return null;
  if (Date.now() - gpuZeit < 1800) return gpuMerk;
  gpuZeit = Date.now();
  try { const r = await fetch(b + '/status', { signal: AbortSignal.timeout(1500) }); gpuMerk = r.ok ? (await r.json()).gpu : null; } catch { gpuMerk = null; }
  return gpuMerk;
}
async function laptopStand() {
  const v = (d.cfg().link || {}).verbindung;
  if (!v) return { verbunden: false };
  let online = false;
  try { online = (await fetch(basis() + '/status', { signal: AbortSignal.timeout(2500) })).ok; } catch {}
  return { verbunden: true, online, name: v.name, host: v.host };
}

module.exports = { init, teilen, neuKoppeln, stand, suchen, koppeln, trennen, umleiten, fernGpu, laptopStand, heimnetz, PORT };
