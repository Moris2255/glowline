// Eigene Apps: der Nutzer fuegt per GitHub-Link ein lokales Web-Projekt hinzu (so wie ARTEX fest eingebaut ist).
// Glowline klont es, errät womit es startet und auf welchem Port, zeigt das zum Bestaetigen, startet es und
// bettet die Oberflaeche als eigenen Tab ein. Code aus dem Internet laeuft nur nach Bestaetigung des Nutzers.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let holeConfig = () => ({}), setzeConfig = () => {}, WDIR = '';
const prozesse = new Map(); // id -> ChildProcess (laufend)

function init({ cfg, setCfg, userData }) {
  holeConfig = cfg || holeConfig;
  setzeConfig = setCfg || setzeConfig;
  WDIR = path.join(userData, 'apps');
  fs.mkdirSync(WDIR, { recursive: true });
}

const liste = () => (holeConfig().apps || []).slice();
const hol = (id) => liste().find((a) => a.id === id) || null;
function sichere(apps) { const c = holeConfig(); c.apps = apps; setzeConfig(); }

// Hilfsprogramm starten und auf sein Ende warten (ohne Ausgabe-Kanaele, sonst haengt ein Server die offen)
function lauf(exe, args, { cwd, ms = 180000, los = false, shell = false } = {}) {
  return new Promise((loese) => {
    let p;
    try { p = spawn(exe, args, { cwd, windowsHide: true, stdio: 'ignore', detached: los, shell }); } catch { return loese(false); }
    if (los) { p.unref(); return loese(true); }
    const t = setTimeout(() => { try { p.kill(); } catch {} loese(false); }, ms);
    p.on('error', () => { clearTimeout(t); loese(false); });
    p.on('exit', (code) => { clearTimeout(t); loese(code === 0); });
  });
}
function erreichbar(port, ms = 1200) {
  return new Promise((loese) => {
    const req = http.get({ host: '127.0.0.1', port, timeout: ms }, (res) => { res.resume(); loese(true); });
    req.on('error', () => loese(false));
    req.on('timeout', () => { req.destroy(); loese(false); });
  });
}
function warteAufPort(port, versuche = 60, abstand = 500) {
  return new Promise((loese) => {
    let n = 0;
    const tick = async () => {
      if (await erreichbar(port)) return loese(true);
      if (++n >= versuche) return loese(false);
      setTimeout(tick, abstand);
    };
    tick();
  });
}

// ---------- Hinzufuegen (klonen) ----------
// Nur echte GitHub-Repos: https://github.com/<nutzer>/<repo>
function githubTeile(url) {
  const m = String(url || '').trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? { nutzer: m[1], repo: m[2] } : null;
}
// Ordnernamen immer sauber aus dem Repo-Namen ableiten und sicher INNERHALB von WDIR halten
// (ein Repo-Name wie "." oder ".." darf nicht aus dem apps-Ordner herausfuehren)
function sichererName(repo) {
  let name = String(repo || '').replace(/[^\w.-]/g, '').replace(/^\.+/, '').slice(0, 40);
  return name || 'app';
}
function imOrdner(ziel) {
  const r = path.resolve(ziel), basis = path.resolve(WDIR);
  return r === basis || r.startsWith(basis + path.sep);
}
function freierOrdner(repo) {
  const name = sichererName(repo);
  let ziel = path.join(WDIR, name), i = 2;
  while (fs.existsSync(ziel)) { ziel = path.join(WDIR, name + '-' + i); i++; }
  return imOrdner(ziel) ? ziel : path.join(WDIR, 'app-' + Date.now().toString(36));
}
async function klonen(url) {
  const t = githubTeile(url);
  if (!t) return { ok: false, grund: 'kein-github' };
  const ordner = freierOrdner(t.repo);
  const ok = await lauf('git', ['clone', '--depth', '1', `https://github.com/${t.nutzer}/${t.repo}.git`, ordner], { ms: 240000 });
  if (!ok || !fs.existsSync(ordner)) { try { fs.rmSync(ordner, { recursive: true, force: true }); } catch {} return { ok: false, grund: 'klon-fehler' }; }
  const vorschlag = analysiere(ordner);
  return { ok: true, name: t.repo, ordner, ...vorschlag };
}

// ---------- Erraten: womit startet das Projekt, welcher Port ----------
function liesDatei(ordner, name) { try { return fs.readFileSync(path.join(ordner, name), 'utf8'); } catch { return ''; } }
function suchePort(texte, standard) {
  for (const t of texte) {
    const m = String(t).match(/(?:localhost|127\.0\.0\.1)[:\/](\d{2,5})|(?:\bport\b["':=\s]{1,4})(\d{2,5})/i);
    if (m) { const p = +(m[1] || m[2]); if (p >= 80 && p <= 65535) return p; }
  }
  return standard;
}
function analysiere(ordner) {
  const readme = liesDatei(ordner, 'README.md') || liesDatei(ordner, 'readme.md');
  const da = (f) => fs.existsSync(path.join(ordner, f));
  // Node
  if (da('package.json')) {
    let pkg = {}; try { pkg = JSON.parse(liesDatei(ordner, 'package.json')); } catch {}
    const s = pkg.scripts || {};
    const start = s.dev ? 'npm run dev' : s.start ? 'npm start' : s.serve ? 'npm run serve' : 'npm start';
    const pm = da('pnpm-lock.yaml') ? 'pnpm' : da('yarn.lock') ? 'yarn' : 'npm';
    const install = pm === 'npm' ? 'npm install' : pm + ' install';
    const port = suchePort([readme, JSON.stringify(s), liesDatei(ordner, 'vite.config.js'), liesDatei(ordner, 'vite.config.ts')], s.dev || /vite/.test(JSON.stringify(pkg)) ? 5173 : 3000);
    return { install: pm === 'npm' ? install : install.replace('npm', pm), start: pm === 'npm' ? start : start.replace('npm', pm), port, art: 'node' };
  }
  // Python
  if (da('requirements.txt') || da('pyproject.toml') || da('manage.py')) {
    const install = da('requirements.txt') ? 'pip install -r requirements.txt' : da('pyproject.toml') ? 'pip install .' : '';
    const start = da('manage.py') ? 'python manage.py runserver' : da('app.py') ? 'python app.py' : da('main.py') ? 'python main.py' : 'python app.py';
    const port = suchePort([readme], da('manage.py') ? 8000 : 5000);
    return { install, start, port, art: 'python' };
  }
  // Go
  if (da('go.mod')) return { install: '', start: 'go run .', port: suchePort([readme], 8080), art: 'go' };
  // Docker
  if (da('docker-compose.yml') || da('compose.yaml')) return { install: '', start: 'docker compose up', port: suchePort([readme], 8080), art: 'docker' };
  // Statisch
  if (da('index.html')) return { install: '', start: 'npx --yes serve -l 8080 .', port: 8080, art: 'static' };
  return { install: '', start: '', port: suchePort([readme], 3000), art: '' };
}

// ---------- Speichern / Entfernen ----------
function speichere({ id, name, quelle, ordner, install, start, port }) {
  const apps = liste();
  const i = id ? apps.findIndex((a) => a.id === id) : -1;
  const alt = i >= 0 ? apps[i] : null;
  // Beim Bearbeiten "eingerichtet" nur behalten, wenn der Install-Befehl gleich bleibt (sonst neu installieren)
  const eingerichtet = !!(alt && alt.eingerichtet && (alt.install || '') === (install || ''));
  const eintrag = {
    id: id || 'a' + Date.now().toString(36),
    name: String(name || (alt && alt.name) || 'App').slice(0, 60),
    quelle: quelle || (alt && alt.quelle) || '',
    ordner: ordner || (alt && alt.ordner) || '',
    install: install || '', start: start || '', port: +port || 0, eingerichtet,
  };
  if (i >= 0) apps[i] = { ...alt, ...eintrag }; else apps.push(eintrag);
  sichere(apps);
  return eintrag;
}
async function entfernen(id) {
  const a = hol(id);
  await stop(id);
  if (a && a.ordner && imOrdner(a.ordner) && path.resolve(a.ordner) !== path.resolve(WDIR)) { try { fs.rmSync(a.ordner, { recursive: true, force: true }); } catch {} }
  sichere(liste().filter((x) => x.id !== id));
  return { ok: true };
}

// ---------- Starten / Stoppen ----------
async function einrichten(id) {
  const a = hol(id);
  if (!a) return { ok: false, grund: 'weg' };
  if (a.install && !a.eingerichtet) {
    const ok = await lauf(a.install, [], { cwd: a.ordner, shell: true, ms: 900000 });
    if (!ok) return { ok: false, grund: 'install-fehler' };
    const apps = liste(); const x = apps.find((p) => p.id === id); if (x) { x.eingerichtet = true; sichere(apps); }
  }
  return { ok: true };
}
async function start(id) {
  const a = hol(id);
  if (!a) return { ok: false, grund: 'weg' };
  if (!a.start || !a.port) return { ok: false, grund: 'kein-start' };
  if (await erreichbar(a.port)) return { ok: true, schon: true };
  const vor = await einrichten(id);
  if (!vor.ok) return vor;
  try {
    const p = spawn(a.start, [], { cwd: a.ordner, windowsHide: true, stdio: 'ignore', shell: true });
    p.on('error', () => { if (prozesse.get(id) === p) prozesse.delete(id); });
    p.on('exit', () => { if (prozesse.get(id) === p) prozesse.delete(id); });
    prozesse.set(id, p);
  } catch (e) { return { ok: false, grund: 'start-fehler', fehler: e.message }; }
  const da = await warteAufPort(a.port);
  if (!da) { await stop(id); return { ok: false, grund: 'kein-port' }; }
  return { ok: true };
}
async function stop(id) {
  const p = prozesse.get(id);
  if (p && p.pid) {
    if (process.platform === 'win32') await lauf('taskkill', ['/pid', String(p.pid), '/t', '/f'], { ms: 10000 });
    else { try { p.kill(); } catch {} }
    prozesse.delete(id);
  }
  return { ok: true };
}
async function status(id) {
  const a = hol(id);
  if (!a) return { da: false };
  return { da: true, laeuft: a.port ? await erreichbar(a.port) : false, unser: prozesse.has(id), url: a.port ? `http://localhost:${a.port}` : '', port: a.port };
}
function beimBeenden() {
  for (const [id, p] of prozesse) { if (p && p.pid) { lauf('taskkill', ['/pid', String(p.pid), '/t', '/f'], { los: true }); } prozesse.delete(id); }
}

module.exports = { init, liste, hol, klonen, analysiere, speichere, entfernen, start, stop, status, beimBeenden, githubTeile, sichererName, freierOrdner, imOrdner, WDIR: () => WDIR };
