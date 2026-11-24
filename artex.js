// ARTEX: ein lokales, autonomes Pentest-Werkzeug mit eigener Web-Oberflaeche (http://localhost:8787).
// Glowline bettet diese Oberflaeche als eigene Ansicht ein. Dieses Modul findet die ARTEX-Installation,
// startet davor PostgreSQL und dann ARTEX, prueft ob der Port erreichbar ist und stoppt beides wieder.
// Nur gegen eigene oder ausdruecklich freigegebene Ziele richten.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Hilfsprogramm ausfuehren und auf sein Ende warten. Ohne Ausgabe-Kanaele: pg_ctl startet den Datenbank-Server,
// der sonst die Kanaele erbt und offen haelt – dann kaeme die Rueckmeldung nie (execFile haengt).
function lauf(exe, args, { ms = 30000, los = false } = {}) {
  return new Promise((loese) => {
    let p;
    try { p = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: los }); } catch { return loese(false); }
    if (los) { p.unref(); return loese(true); }
    const t = setTimeout(() => { try { p.kill(); } catch {} loese(false); }, ms);
    p.on('error', () => { clearTimeout(t); loese(false); });
    p.on('exit', (code) => { clearTimeout(t); loese(code === 0); });
  });
}

const PORT = 8787;
const URL = `http://localhost:${PORT}`;
let holeConfig = () => ({}), setzeConfig = () => {}, home = '';
let artexProc = null, wirStartetenPg = false;

function init({ cfg, setCfg, userData }) {
  holeConfig = cfg || holeConfig;
  setzeConfig = setCfg || setzeConfig;
  home = process.env.USERPROFILE || process.env.HOME || userData || '';
}

// ---------- Installation finden ----------
// Entweder der vom Nutzer gesetzte Ordner oder ein paar uebliche Orte. Ein gueltiger ARTEX-Ordner
// enthaelt Postgres (pg/pgsql/bin/pg_ctl.exe) und irgendwo darunter app/<version>/artex.exe.
function kandidaten() {
  const c = [];
  const gesetzt = (holeConfig().artexOrdner || '').trim();
  if (gesetzt) c.push(gesetzt);
  if (home) { c.push(path.join(home, 'Projekte', 'ARTEX')); c.push(path.join(home, 'ARTEX')); c.push(path.join(home, 'Documents', 'ARTEX')); }
  return [...new Set(c.filter(Boolean))];
}
function findeExe(appDir) {
  try {
    for (const e of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const exe = path.join(appDir, e.name, 'artex.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return null;
}
function pruefeOrdner(ordner) {
  if (!ordner) return null;
  const pgBin = path.join(ordner, 'pg', 'pgsql', 'bin');
  const pgCtl = path.join(pgBin, 'pg_ctl.exe');
  const pgData = path.join(ordner, 'pg', 'data');
  const exe = findeExe(path.join(ordner, 'app'));
  if (!fs.existsSync(pgCtl) || !exe) return null;
  return { ordner, pgBin, pgCtl, pgData, pgLog: path.join(ordner, 'pg', 'pg.log'), exe, appDir: path.dirname(exe) };
}
function gefunden() {
  for (const k of kandidaten()) { const g = pruefeOrdner(k); if (g) return g; }
  return null;
}
// Nutzer hat in Glowline einen Ordner gewaehlt: pruefen und merken
function setzeOrdner(ordner) {
  const g = pruefeOrdner(ordner);
  if (!g) return { ok: false };
  const cfg = holeConfig(); cfg.artexOrdner = ordner; setzeConfig();
  return { ok: true };
}

// ---------- Erreichbarkeit ----------
function erreichbar(ms = 1200) {
  return new Promise((loese) => {
    const req = http.get(URL, { timeout: ms }, (res) => { res.resume(); loese(true); });
    req.on('error', () => loese(false));
    req.on('timeout', () => { req.destroy(); loese(false); });
  });
}
function warteBis(erreicht, versuche = 40, abstand = 500) {
  return new Promise((loese) => {
    let n = 0;
    const tick = async () => {
      if ((await erreichbar()) === erreicht) return loese(true);
      if (++n >= versuche) return loese(false);
      setTimeout(tick, abstand);
    };
    tick();
  });
}

// ---------- Starten / Stoppen ----------
async function starten() {
  const g = gefunden();
  if (!g) return { ok: false, grund: 'nicht-gefunden' };
  if (await erreichbar()) return { ok: true, schon: true };
  // 1) PostgreSQL (kein Dienst, kein Admin) auf Port 5433 starten
  if (!(await lauf(path.join(g.pgBin, 'pg_isready.exe'), ['-p', '5433'], { ms: 5000 }))) {
    const ok = await lauf(g.pgCtl, ['-D', g.pgData, '-o', '-p 5433', '-l', g.pgLog, '-w', 'start']);
    if (ok) wirStartetenPg = true; // nur dann gehoert es uns und wird beim Stoppen wieder beendet
  }
  // 2) ARTEX starten (artex.exe im App-Ordner, damit es seine config.json findet)
  try {
    const log = fs.openSync(path.join(g.appDir, 'artex.log'), 'a');
    artexProc = spawn(g.exe, [], { cwd: g.appDir, windowsHide: true, stdio: ['ignore', log, log], detached: false });
    fs.closeSync(log);
    artexProc.on('exit', () => { artexProc = null; });
  } catch (e) { return { ok: false, grund: 'start-fehler', fehler: e.message }; }
  const da = await warteBis(true);
  return da ? { ok: true } : { ok: false, grund: 'kein-port' };
}
async function stoppen() {
  if (artexProc && artexProc.pid) {
    if (process.platform === 'win32') await lauf('taskkill', ['/pid', String(artexProc.pid), '/t', '/f'], { ms: 10000 });
    else { try { artexProc.kill(); } catch {} }
    artexProc = null;
  }
  // Nur das Postgres stoppen, das wir selbst gestartet haben
  if (wirStartetenPg) {
    const g = gefunden();
    if (g) await lauf(g.pgCtl, ['-D', g.pgData, '-m', 'fast', '-w', 'stop']);
    wirStartetenPg = false;
  }
}
function beimBeenden() {
  // synchron genug fuer will-quit: nur unseren ARTEX-Prozess beenden
  // losgeloest starten, damit es auch nach dem Ende von Glowline noch fertig wird
  if (artexProc && artexProc.pid) { lauf('taskkill', ['/pid', String(artexProc.pid), '/t', '/f'], { los: true }); artexProc = null; }
  if (wirStartetenPg) { const g = gefunden(); if (g) lauf(g.pgCtl, ['-D', g.pgData, '-m', 'fast', '-w', 'stop'], { los: true }); wirStartetenPg = false; }
}

async function status() {
  const g = gefunden();
  return { installiert: !!g, ordner: g ? g.ordner : (holeConfig().artexOrdner || ''), laeuft: await erreichbar(), unser: !!artexProc, url: URL, port: PORT };
}

module.exports = { init, status, starten, stoppen, beimBeenden, erreichbar, setzeOrdner, gefunden, URL, PORT };
