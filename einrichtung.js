// Express-Einrichtung: schaut sich den PC an, schlaegt eine Tempo-Stufe vor und installiert alles in einem Rutsch
// (Ollama, drei Sprachmodelle, Studio-Motor und Studio-Modelle). Laeuft im Hauptprozess weiter, auch wenn das Fenster zu ist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Sprachmodelle aus der Ollama-Bibliothek: [Name, GB, Kontext in k]. "frei" = abliterated (ohne Ablehn-Filter)
const HELFER = { normal: ['lfm3:1.7b', 1.1, 32], frei: ['huihui_ai/lfm2.5-abliterated:1.2b', 0.73, 32] };
// Coder: Qwen 3.5 (wenig Speicher fuer langen Kontext, kann Werkzeuge), Denker: Qwen 3 mit Denkmodus
const STUFEN = {
  schnell: {
    name: 'Fast', info: 'Small models, quick answers – runs on almost any PC',
    coder: { normal: ['qwen3.5:4b', 3.32, 64], frei: ['huihui_ai/qwen3.5-abliterated:4b', 3.32, 64] },
    denker: { normal: ['qwen3:4b', 2.5, 16], frei: ['huihui_ai/qwen3-abliterated:4b', 2.5, 16] },
  },
  mittel: {
    name: 'Balanced', info: 'Good answers at a good speed – for 8–12 GB graphics cards',
    coder: { normal: ['qwen3.5:9b', 6.55, 64], frei: ['huihui_ai/qwen3.5-abliterated:9b', 6.59, 64] },
    denker: { normal: ['qwen3:8b', 5.23, 16], frei: ['huihui_ai/qwen3-abliterated:8b', 5.03, 16] },
  },
  stark: {
    name: 'Best quality', info: 'The biggest models – best answers, needs a strong PC',
    coder: { normal: ['qwen3.5:35b', 22.07, 128], frei: ['huihui_ai/qwen3.5-abliterated:35b', 23.87, 128] },
    denker: { normal: ['qwen3:30b', 18.56, 16], frei: ['huihui_ai/qwen3-abliterated:30b', 18.56, 16] },
  },
};
const ROLLEN = {
  coder: { name: 'Coder', info: 'Writes and fixes code in Claude Code, Codex and OpenCode' },
  denker: { name: 'Reasoning', info: 'Thinks through harder questions in Chat' },
  helfer: { name: 'Fast helper', info: 'Quick answers in Chat and the Prompt helper' },
};
// Studio-Teile (GB grob geschaetzt fuer Motor und Stimme, die laden Python-Pakete)
const STUDIO = {
  bild: { id: 'z-image', name: 'Images', info: 'Z-Image Turbo – photos and art from text' },
  video: { id: 'wan22-5b', name: 'Video', info: 'Wan 2.2 5B – short clips from text or an image' },
  stimme: { id: 'chatterbox', name: 'Voice', info: 'Chatterbox – voice cloning, 20+ languages', gb: 10 },
  upscale: { id: 'esrgan-x4', name: 'Upscaling', info: 'Real-ESRGAN – makes images 4× sharper' },
};
const MOTOR_GB = 10;
const TEILE = ['coder', 'denker', 'helfer', 'bild', 'video', 'stimme', 'upscale'];

let d = null; // Hilfen aus main.js
let lauf = null; // laufende (oder letzte) Installation
let zuletzt = 0;

function init(hilfen) { d = hilfen; }

const gb = (bytes) => bytes / 1e9;
const laufwerk = (p) => (/^([a-z]:)/i.exec(path.resolve(p)) || [, '?'])[1].toUpperCase();
function freiAuf(p) {
  try {
    let q = path.resolve(p);
    while (!fs.existsSync(q) && path.dirname(q) !== q) q = path.dirname(q);
    const s = fs.statfsSync(q);
    return gb(s.bavail * s.bsize);
  } catch { return null; }
}
const ollamaOrdner = () => process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
// lokaler Name der Variante mit festem Kontext: "huihui_ai/qwen3.5-abliterated:9b" -> "qwen3.5-abliterated:9b-64k"
const varianteVon = ([name, , k]) => name.split('/').pop() + '-' + k + 'k';

function grafikkarte() {
  return new Promise((ok) => {
    if (process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_OHNE_GPU) return ok(null); // Test: PC ohne NVIDIA-Karte
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 }, (e, aus) => {
      if (e || !aus) return ok(null);
      const [name, mb] = String(aus).split('\n')[0].split(',').map((x) => x.trim());
      ok(name ? { name, vram: Math.round((+mb / 1024) * 10) / 10 } : null);
    });
  });
}

async function ollamaStand() {
  const basis = d.cfg().backends.ollama;
  try {
    const r = await fetch(basis + '/api/tags', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { online: true, installiert: true, modelle: (j.models || []).map((m) => String(m.name)) };
  } catch {
    return { online: false, installiert: await d.ollamaInstalliert(), modelle: [] };
  }
}

// Empfehlung: Grafikspeicher und Arbeitsspeicher muessen die Modelle tragen
function empfehlung(gpu, ram) {
  const vram = gpu ? gpu.vram : 0;
  if (vram >= 15 && ram >= 30) return 'stark';
  if (vram >= 7.5 && ram >= 28) return 'mittel';
  return 'schnell';
}

let sysMerk = null, sysZeit = 0;
async function system(frisch) {
  // Plan wird bei jedem Klick neu berechnet: Systemdaten kurz zwischenspeichern
  if (!frisch && sysMerk && Date.now() - sysZeit < 15000) return sysMerk;
  const [gpu, ollama] = await Promise.all([grafikkarte(), ollamaStand()]);
  const ram = Math.round((os.totalmem() / 2 ** 30) * 10) / 10; // GiB, wie Windows es anzeigt
  const st = d.studio.status();
  sysZeit = Date.now();
  return sysMerk = {
    gpu, ram, ollama, empfohlen: empfehlung(gpu, ram),
    studioMoeglich: !!gpu, // ComfyUI und die Stimme brauchen eine NVIDIA-Karte
    stufen: Object.fromEntries(Object.entries(STUFEN).map(([k, s]) => [k, { name: s.name, info: s.info }])),
    rollen: ROLLEN, studioTeile: Object.fromEntries(Object.entries(STUDIO).map(([k, s]) => [k, { name: s.name, info: s.info }])),
    studioOrdner: st.ordner,
  };
}

// Aus der Wahl ({ stufe, frei, teile: { coder: true, ... } }) die Liste der Schritte bauen
async function plan(wahl, sys) {
  sys = sys || await system();
  const stufe = STUFEN[wahl && wahl.stufe] ? wahl.stufe : sys.empfohlen;
  const art = wahl && wahl.frei ? 'frei' : 'normal';
  const teile = (wahl && wahl.teile) || {};
  const an = (t) => teile[t] !== false && (!STUDIO[t] || sys.studioMoeglich);
  const vorhanden = new Set(sys.ollama.modelle.map((n) => n.toLowerCase().replace(/:latest$/, '')));
  const da = (n) => vorhanden.has(n.toLowerCase().replace(/:latest$/, ''));
  const schritte = [];
  const sprach = TEILE.filter((t) => ROLLEN[t] && an(t));
  if (sprach.length && !sys.ollama.installiert) schritte.push({ art: 'ollama', titel: 'Ollama', info: 'Runs the language models on your PC', gb: 1.9, ordner: process.env.LOCALAPPDATA || os.homedir() });
  for (const t of sprach) {
    const m = (t === 'helfer' ? HELFER : STUFEN[stufe][t])[art];
    const variante = varianteVon(m);
    const vorh = da(variante) ? 'ganz' : da(m[0]) ? 'basis' : null;
    schritte.push({ art: 'sprache', rolle: t, titel: ROLLEN[t].name, info: `${m[0]} · ${m[2]}k context`, name: m[0], variante, kontext: m[2], gb: vorh ? 0 : m[1], da: vorh === 'ganz', basis: vorh === 'basis', ordner: ollamaOrdner() });
  }
  const st = d.studio.status();
  const studioTeile = TEILE.filter((t) => STUDIO[t] && an(t));
  if (studioTeile.length) {
    schritte.push({ art: 'motor', titel: 'Studio engine', info: 'ComfyUI + PyTorch, runs image and video models', gb: st.eingerichtet ? 0 : MOTOR_GB, da: st.eingerichtet, ordner: st.ordner });
    // kleine zuerst, das groesste Modell (Video) zuletzt
    for (const t of ['upscale', 'bild', 'stimme', 'video'].filter((x) => studioTeile.includes(x))) {
      const m = st.modelle[STUDIO[t].id];
      if (!m) continue;
      schritte.push({ art: 'studio', teil: t, id: m.id, titel: STUDIO[t].name, info: STUDIO[t].info, gb: m.da ? 0 : STUDIO[t].gb || Math.round(gb(m.fehltGroesse) * 100) / 100, da: m.da, ordner: st.ordner });
    }
  }
  // Platz je Laufwerk (mit 5 GB Reserve)
  const platz = {};
  for (const s of schritte) {
    const l = laufwerk(s.ordner);
    if (!platz[l]) platz[l] = { braucht: 0, frei: freiAuf(s.ordner) };
    platz[l].braucht += s.gb;
  }
  for (const x of Object.values(platz)) { x.braucht = Math.round(x.braucht * 10) / 10; if (x.frei != null) x.frei = Math.round(x.frei); }
  const gesamt = schritte.reduce((x, s) => x + s.gb, 0);
  const zuWenig = Object.entries(platz).filter(([, p]) => p.frei != null && p.braucht > 0 && p.braucht + 5 > p.frei).map(([l]) => l);
  return { stufe, frei: art === 'frei', schritte, gesamt: Math.round(gesamt * 10) / 10, platz, zuWenig };
}

// ---------- Installation ----------
function stand() {
  if (!lauf) return null;
  return { fertig: lauf.fertig, abgebrochen: lauf.ac.signal.aborted, schritte: lauf.schritte.map(({ titel, info, status, text, prozent, fehler, gb }) => ({ titel, info, status, text, prozent, fehler, gb })) };
}
function melde(sofort) {
  if (!sofort && Date.now() - zuletzt < 250) return;
  zuletzt = Date.now();
  d.sende('einrichtung', stand());
}

function befehl(exe, args, ac) {
  return new Promise((ok, fehler) => {
    const p = spawn(exe, args, { windowsHide: true });
    let aus = '';
    p.stdout.on('data', (x) => { aus = (aus + x).slice(-2000); });
    p.stderr.on('data', (x) => { aus = (aus + x).slice(-2000); });
    const weg = () => { try { p.kill(); } catch {} };
    ac.signal.addEventListener('abort', weg, { once: true });
    p.on('error', (e) => { ac.signal.removeEventListener('abort', weg); fehler(e); });
    p.on('close', (code) => { ac.signal.removeEventListener('abort', weg); ok({ code, aus }); });
  });
}
const warte = (ms, ac) => new Promise((ok) => { const t = setTimeout(ok, ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });

// Ollama laeuft nicht? Die Tray-App starten (die startet den Server mit)
function ollamaStarten() {
  const la = process.env.LOCALAPPDATA || '';
  const app = path.join(la, 'Programs', 'Ollama', 'ollama app.exe');
  try {
    const p = fs.existsSync(app) ? spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}
async function warteAufOllama(ac, sek) {
  for (let i = 0; i < sek && !ac.signal.aborted; i++) {
    if ((await ollamaStand()).online) return true;
    await warte(1000, ac);
  }
  return false;
}

async function schrittOllama(s, ac) {
  s.text = 'Installing Ollama…';
  melde(true);
  // winget gehoert zu Windows 10/11; Ollama installiert sich fuer den aktuellen Nutzer (ohne Adminrechte)
  const winget = (process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_WINGET) || 'winget';
  let r;
  try {
    r = await befehl(winget, ['install', '-e', '--id', 'Ollama.Ollama', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], ac);
  } catch { r = { code: -1, aus: 'winget not found' }; }
  if (ac.signal.aborted) throw new Error('cancelled');
  if (!(await d.ollamaInstalliert())) throw new Error('Could not install Ollama automatically (ollama.com/download)');
  s.text = 'Starting Ollama…';
  melde(true);
  if (!(await warteAufOllama(ac, 20))) { ollamaStarten(); if (!(await warteAufOllama(ac, 60))) throw new Error(ac.signal.aborted ? 'cancelled' : 'Ollama is installed but does not start – start it once from the Start menu, then press Retry'); }
}

async function schrittSprache(s, ac) {
  const basis = d.cfg().backends.ollama;
  if (!(await ollamaStand()).online) {
    ollamaStarten();
    if (!(await warteAufOllama(ac, 60))) throw new Error(ac.signal.aborted ? 'cancelled' : 'Ollama is not running – start it, then press Retry');
  }
  const da = (await ollamaStand()).modelle.map((n) => n.toLowerCase());
  if (!da.includes(s.name.toLowerCase()) && !da.includes(s.name.toLowerCase() + ':latest')) {
    await d.ollamaHolen(s.name, ac, (x) => {
      if (x.total) { s.prozent = Math.min(99, Math.round((x.completed / x.total) * 100)); s.text = `${(x.completed / 1e9).toFixed(1)} of ${(x.total / 1e9).toFixed(1)} GB`; }
      else s.text = x.status || '';
      melde();
    });
  }
  if (ac.signal.aborted) throw new Error('cancelled');
  // Variante mit festem Kontext anlegen (kein neuer Download, nur ein Verweis)
  s.text = `Setting ${s.kontext}k context…`;
  melde(true);
  const r = await fetch(basis + '/api/create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
    body: JSON.stringify({ model: s.variante, from: s.name, parameters: { num_ctx: s.kontext * 1024 }, stream: false }),
  });
  if (!r.ok) throw new Error(`Ollama could not create ${s.variante} (HTTP ${r.status}) ${(await r.text()).slice(0, 150)}`);
}

// Studio-Schritte laufen ueber studio.js; Fortschritt und Fehler kommen per studioEreignis zurueck
async function schrittStudio(s, ac, vorgang, starten, fertig) {
  s.vorgang = vorgang;
  s.studioFehler = null;
  const stopp = () => d.studio.abbrechen(vorgang);
  ac.signal.addEventListener('abort', stopp, { once: true });
  try {
    await starten();
    // lief das schon (z. B. im Studio angestossen)? Dann warten, bis es fertig ist
    while (d.studio.beschaeftigtMit(vorgang) && !ac.signal.aborted) await warte(1000, ac);
  } finally { ac.signal.removeEventListener('abort', stopp); }
  if (ac.signal.aborted) throw new Error('cancelled');
  if (!fertig()) throw new Error(s.studioFehler || 'Did not finish – press Retry');
}
function studioEreignis(x) {
  const s = lauf && !lauf.fertig && lauf.schritte.find((y) => y.status === 'laeuft' && y.vorgang === x.vorgang);
  if (!s) return;
  if (x.fehler) s.studioFehler = x.fehler;
  if (x.prozent != null) s.prozent = x.prozent;
  if (x.total) s.text = `${(x.completed / 1e9).toFixed(1)} of ${(x.total / 1e9).toFixed(1)} GB`;
  else if (x.titel || x.text) s.text = [x.titel, x.text].filter(Boolean).join(' · ').slice(0, 120);
  melde();
}

let startet = false;
async function starten(wahl) {
  if (startet || (lauf && !lauf.fertig)) return stand();
  startet = true;
  let p;
  try { p = await plan(wahl, await system(true)); } finally { startet = false; }
  if (p.zuWenig.length) throw new Error(`Not enough free space on ${p.zuWenig.join(', ')}`);
  const ac = new AbortController();
  lauf = { ac, fertig: false, schritte: p.schritte.map((s) => ({ ...s, status: s.da ? 'da' : 'wartet', text: s.da ? 'Already installed' : '', prozent: s.da ? 100 : 0 })) };
  melde(true);
  (async () => {
    let ohneOllama = false;
    for (const s of lauf.schritte) {
      if (s.status === 'da') continue;
      if (ac.signal.aborted) { s.status = 'abgebrochen'; s.text = 'Cancelled'; continue; }
      if (s.art === 'sprache' && ohneOllama) { s.status = 'fehler'; s.fehler = 'Needs Ollama'; continue; }
      s.status = 'laeuft';
      melde(true);
      try {
        if (s.art === 'ollama') await schrittOllama(s, ac);
        else if (s.art === 'sprache') await schrittSprache(s, ac);
        else if (s.art === 'motor') await schrittStudio(s, ac, 'einrichten', () => d.studio.einrichten(), () => d.studio.status().eingerichtet);
        else if (s.art === 'studio') await schrittStudio(s, ac, 'modell:' + s.id, () => d.studio.modellHolen(s.id), () => (d.studio.status().modelle[s.id] || {}).da);
        s.status = 'fertig'; s.prozent = 100; s.text = 'Done';
      } catch (e) {
        if (ac.signal.aborted) { s.status = 'abgebrochen'; s.text = 'Cancelled'; }
        else { s.status = 'fehler'; s.fehler = e.message; if (s.art === 'ollama') ohneOllama = true; }
      }
      melde(true);
    }
    // fertige Sprachmodelle gleich als Standard setzen: Coder fuers Terminal, Helfer (sonst Denker) fuer den Chat
    const ok = (rolle) => lauf.schritte.find((s) => s.rolle === rolle && (s.status === 'fertig' || s.status === 'da'));
    const coder = ok('coder') || ok('denker') || ok('helfer');
    const chat = ok('helfer') || ok('denker') || ok('coder');
    // erst wenn alles geklappt hat, gilt die Einrichtung als erledigt (sonst kommt der Assistent beim naechsten Start wieder)
    const neu = lauf.schritte.some((s) => s.status === 'fehler') ? {} : { einrichtung: 'express' };
    if (coder) neu.defaultModel = 'ollama,' + coder.variante;
    if (chat) neu.chatModel = 'ollama,' + chat.variante;
    if (!ac.signal.aborted && Object.keys(neu).length) d.setzeConfig(neu);
    lauf.fertig = true;
    melde(true);
  })();
  return stand();
}

function abbrechen() { if (lauf && !lauf.fertig) lauf.ac.abort(); }
const laeuft = () => !!(lauf && !lauf.fertig);

module.exports = { init, system, plan, starten, abbrechen, stand, laeuft, studioEreignis, STUFEN, HELFER, varianteVon };
