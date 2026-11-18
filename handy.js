// Aufs Handy: einen fertigen Film (oder ein Bild/Video aus dem Studio) per QR-Code im Heimnetz teilen.
// Eigener kleiner Server auf Port 3472, laeuft nur, solange etwas geteilt wird. Nur Geraete im Heimnetz,
// jede Freigabe hat einen zufaelligen Schluessel in der Adresse und endet nach einer Stunde von selbst.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-generator');

const PORT = 3472;
const LEBEN = 60 * 60 * 1000;
const TYP = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

let d = null; // { heimnetz, adressen }
let server = null;
const freigaben = new Map(); // schluessel -> { datei, titel, bis, uhr }

function init(x) { d = x; }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// beste Adresse fuers Handy: WLAN/LAN-Netze zuerst
function adresse() {
  const l = d.adressen();
  return l.find((a) => a.startsWith('192.168.')) || l.find((a) => a.startsWith('10.')) || l.find((a) => /^172\./.test(a)) || null;
}

function seite(f, s) {
  const video = /^video\//.test(TYP[path.extname(f.datei).toLowerCase()]);
  const quelle = `/h/${s}/datei`;
  const medium = video ? `<video src="${quelle}" controls playsinline preload="metadata"></video>` : `<img src="${quelle}" alt="">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.titel)} · Glowline</title><style>
body{margin:0;background:#0b0b0d;color:#f2efe8;font:16px system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh}
main{width:100%;max-width:760px;padding:20px 16px;box-sizing:border-box}
h1{font-size:20px;margin:4px 0 14px}video,img{width:100%;max-height:75vh;border-radius:14px;background:#000;display:block}
a{display:block;margin-top:14px;padding:14px;border-radius:12px;background:#ffd66e;color:#111;text-align:center;font-weight:600;text-decoration:none}
small{display:block;margin-top:12px;color:#8d8a82;text-align:center}</style></head>
<body><main><h1>${esc(f.titel)}</h1>${medium}<a href="${quelle}?laden=1" download="${esc(path.basename(f.datei))}">Save to phone</a>
<small>Shared from Glowline on your PC · this link stops working after one hour</small></main></body></html>`;
}

function sendeDatei(req, res, f, laden) {
  let st;
  try { st = fs.statSync(f.datei); } catch { res.writeHead(404); return res.end(); }
  const kopf = { 'content-type': TYP[path.extname(f.datei).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (laden) kopf['content-disposition'] = `attachment; filename="${path.basename(f.datei).replace(/[^\w.\- ]/g, '_')}"`;
  // Videos auf dem Handy (vor allem iPhone) laden in Stuecken: Range muss gehen
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
    let e = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a > e || a >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...kopf, 'content-range': `bytes ${a}-${e}/${st.size}`, 'content-length': e - a + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(f.datei, { start: a, end: e }).pipe(res);
  }
  res.writeHead(200, { ...kopf, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f.datei).pipe(res);
}

function anfrage(req, res) {
  if (!d.heimnetz(req.socket.remoteAddress) || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const m = /^\/h\/([0-9a-f]{32})(\/datei)?$/.exec(u.pathname);
  const f = m && freigaben.get(m[1]);
  if (!f || Date.now() > f.bis) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('This link has expired. Share the file again in Glowline.'); }
  if (m[2]) return sendeDatei(req, res, f, u.searchParams.has('laden'));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(req.method === 'HEAD' ? undefined : seite(f, m[1]));
}

function starten() {
  if (server) return Promise.resolve();
  return new Promise((ok, nein) => {
    const s = http.createServer(anfrage);
    s.once('error', (e) => nein(e.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is already in use`) : e));
    s.listen(PORT, '0.0.0.0', () => { server = s; ok(); });
  });
}
function ende() {
  if (freigaben.size || !server) return;
  server.close();
  server.closeAllConnections && server.closeAllConnections();
  server = null;
}

// datei ist schon geprueft (Film/Studio-Ausgabe). Gibt Adresse und QR-Code (SVG) zurueck.
async function teilen(datei, titel) {
  if (!TYP[path.extname(String(datei)).toLowerCase()] || !fs.existsSync(datei)) throw new Error('Only finished films, videos and images can be shared');
  const ip = adresse();
  if (!ip) throw new Error('This PC is not in a home network (Wi-Fi or LAN)');
  await starten();
  let s = [...freigaben.entries()].find(([, f]) => f.datei === path.resolve(datei));
  if (s) { clearTimeout(s[1].uhr); s = s[0]; } else s = crypto.randomBytes(16).toString('hex');
  const f = { datei: path.resolve(datei), titel: String(titel || path.basename(datei)).slice(0, 80), bis: Date.now() + LEBEN };
  f.uhr = setTimeout(() => stopp(s), LEBEN);
  freigaben.set(s, f);
  const url = `http://${ip}:${PORT}/h/${s}`;
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return { url, schluessel: s, bis: f.bis, svg: q.createSvgTag({ cellSize: 6, margin: 3, scalable: true }) };
}

function stopp(s) {
  const f = freigaben.get(s);
  if (f) { clearTimeout(f.uhr); freigaben.delete(s); }
  ende();
}
function alleStopp() { for (const s of [...freigaben.keys()]) stopp(s); }

module.exports = { init, teilen, stopp, alleStopp, PORT, laeuft: () => !!server, anzahl: () => freigaben.size };
