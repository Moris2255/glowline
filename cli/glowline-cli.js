// Glowline im Terminal: Cowork mit "gl" oder "glowline".
// Laeuft mit Glowlines eigenem Programm (ELECTRON_RUN_AS_NODE) und spricht mit der laufenden App ueber 127.0.0.1
// (terminal.js). Die App macht die Arbeit (Modelle, Studio, Grafikkarte) – hier ist nur Ein- und Ausgabe.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const tty = require('tty');
const os = require('os');
const { spawn } = require('child_process');

// ---------- Argumente ----------
const argv = process.argv.slice(2);
let apiDatei = path.join(process.env.APPDATA || os.homedir(), 'Glowline', 'terminal.json');
let appExe = null;
const freieArgs = [];
let nurAusgabe = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--api') apiDatei = argv[++i];
  else if (a === '--app') appExe = argv[++i];
  else if (a === '-p' || a === '--print') nurAusgabe = true;
  else if (a === '-h' || a === '--help' || a === '/?') { hilfeText(); process.exit(0); }
  else if (a === '-v' || a === '--version') { const k = liesApi(); console.log('Glowline' + (k && k.version ? ' ' + k.version : '')); process.exit(0); }
  else freieArgs.push(a);
}
function hilfeText() {
  console.log(`Glowline – Cowork in your terminal

  gl                    start a chat
  gl "question"         start a chat with this message
  gl -p "question"      answer once and exit (good for scripts)

In the chat: type / for commands, drag an image in to attach it,
Esc stops an answer, Ctrl+O opens the last result, Ctrl+C twice exits.`);
}
function liesApi() { try { return JSON.parse(fs.readFileSync(apiDatei, 'utf8')); } catch { return null; } }

const IST_TTY = !!process.stdout.isTTY && !nurAusgabe;
if (!IST_TTY) nurAusgabe = true;
const FARBE = !process.env.NO_COLOR && !!process.stdout.isTTY;
const out = (s) => process.stdout.write(s);

// ---------- Farben ----------
const rgb = (r, g, b) => (FARBE ? `\x1b[38;2;${r};${g};${b}m` : '');
const bgRgb = (r, g, b) => (FARBE ? `\x1b[48;2;${r};${g};${b}m` : '');
const C = {
  hell: rgb(235, 232, 227), text: rgb(214, 211, 206), leise: rgb(150, 147, 142), dunkel: rgb(96, 94, 90),
  rot: rgb(240, 113, 103), gruen: rgb(126, 204, 145), gelb: rgb(230, 190, 105), code: rgb(173, 204, 240),
  fett: FARBE ? '\x1b[1m' : '', kursiv: FARBE ? '\x1b[3m' : '', inv: FARBE ? '\x1b[7m' : '', aus: FARBE ? '\x1b[0m' : '',
  nutzerBg: bgRgb(42, 42, 46),
};
const f = (farbe, s) => farbe + s + C.aus;
// eigene Nachricht: grauer Hintergrund auch hinter farbigen Stuecken (jedes C.aus setzt ihn sonst auf schwarz zurueck)
const mitHintergrund = (s) => (FARBE ? s.split(C.aus).join(C.aus + C.nutzerBg) : s);

// ---------- Breite von Text im Terminal ----------
function zb(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
function breite(s) { let b = 0; for (const ch of String(s).replace(ANSI, '')) b += zb(ch.codePointAt(0)); return b; }
// auf Breite kuerzen (mit …)
function kuerze(s, w) {
  if (breite(s) <= w) return s;
  let b = 0, r = '';
  for (const ch of String(s).replace(ANSI, '')) { const z = zb(ch.codePointAt(0)); if (b + z > w - 1) break; r += ch; b += z; }
  return r + '…';
}
// Fenstergroesse: Electron liest sie beim Start manchmal zu frueh (dann immer 120x30, ohne Aenderungen) –
// deshalb fragt Glowline das Terminal selbst (Cursor nach ganz rechts unten, Position melden lassen)
const fenster = { spalten: 0, zeilen: 0, offen: 0 };
const breiteFenster = () => fenster.spalten || process.stdout.columns || 100;
const hoeheFenster = () => fenster.zeilen || process.stdout.rows || 30;
const spalten = () => Math.max(30, breiteFenster());
const zeilenHoch = () => Math.max(12, hoeheFenster());
const link = (url, text) => (FARBE ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);
const dateiUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
const kurzPfad = (p) => { const h = os.homedir(); return p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p; };

// ---------- Markdown -> Zeilen ----------
// Inline: `code`, **fett**, *kursiv*, [Text](Link) -> Stuecke { t, s }
const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;
function inline(text, basis) {
  const teile = [];
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > i) teile.push({ t: text.slice(i, m.index), s: basis });
    if (m[2] != null) teile.push({ t: m[2], s: C.code });
    else if (m[3] != null || m[4] != null) teile.push({ t: m[3] ?? m[4], s: basis + C.fett });
    else if (m[5] != null) teile.push({ t: m[5], s: C.code, url: m[6] });
    else if (m[7] != null) teile.push({ t: m[7], s: basis + C.kursiv });
    i = m.index + m[0].length;
  }
  if (i < text.length) teile.push({ t: text.slice(i), s: basis });
  return teile;
}
// Stuecke auf Breite umbrechen (an Wortgrenzen), erste Zeile mit vor1, weitere mit vor2
function umbrechen(teile, w, vor1 = '', vor2 = '') {
  const zeilen = [];
  let z = vor1, b = breite(vor1), leer = true;
  const neu = () => { zeilen.push(z); z = vor2; b = breite(vor2); leer = true; };
  for (const st of teile) {
    for (const wort of st.t.split(/(\s+)/)) {
      if (!wort) continue;
      const wb = breite(wort);
      if (/^\s+$/.test(wort)) { if (leer) continue; if (b + wb > w) { neu(); continue; } z += wort; b += wb; continue; }
      if (b + wb > w && !leer) neu();
      if (wb > w - breite(vor2)) {
        // zu langes Wort (Link, Pfad): hart teilen
        for (const ch of wort) { const cb = zb(ch.codePointAt(0)); if (b + cb > w) neu(); z += st.s + ch + C.aus; b += cb; leer = false; }
        continue;
      }
      z += st.s + (st.url ? link(st.url, wort) : wort) + C.aus;
      b += wb;
      leer = false;
    }
  }
  if (!leer || !zeilen.length) zeilen.push(z);
  return zeilen;
}
// eine Markdown-Zeile -> Bildschirmzeilen; st = { code, sprache } wird fuer Codebloecke mitgefuehrt
function mdZeile(zeile, st, w) {
  const E = '  ';
  const zaun = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(zeile);
  if (zaun) {
    st.code = !st.code;
    return [st.code ? f(C.dunkel, E + '╭─ ' + (zaun[2] || 'code')) : f(C.dunkel, E + '╰─')];
  }
  if (st.code) {
    const r = [];
    let rest = zeile.replace(/\t/g, '  ');
    do { const teil = kuerzeHart(rest, w - 6); r.push(f(C.dunkel, E + '│ ') + f(C.code, teil)); rest = rest.slice(teil.length); } while (rest.length);
    return r;
  }
  if (!zeile.trim()) return [''];
  let m;
  if ((m = /^(#{1,6})\s+(.*)$/.exec(zeile))) return umbrechen(inline(m[2], C.hell + C.fett), w, E, E);
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(zeile)) return [f(C.dunkel, E + '─'.repeat(Math.min(40, w - 4)))];
  if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(zeile))) {
    const tief = Math.min(6, Math.floor(m[1].replace(/\t/g, '  ').length / 2) * 2);
    const zeichen = /\d/.test(m[2]) ? m[2] : '•';
    const vor = E + ' '.repeat(tief);
    return umbrechen(inline(m[3], C.text), w, vor + f(C.leise, zeichen) + ' ', vor + ' '.repeat(breite(zeichen) + 1));
  }
  if ((m = /^>\s?(.*)$/.exec(zeile))) return umbrechen(inline(m[1], C.leise), w, E + f(C.dunkel, '│ '), E + f(C.dunkel, '│ '));
  if (/^\s*\|.*\|\s*$/.test(zeile)) {
    // Tabelle: Spalten so breit wie bisher noetig, Kopfzeile fett, Trennlinie aus ─ und ┼
    const zellen = zeile.trim().slice(1, -1).split('|').map((z) => z.trim());
    const tb = st.tabelle || (st.tabelle = { breiten: [], zeilen: 0 });
    if (zellen.every((z) => /^:?-+:?$/.test(z))) {
      const n = Math.max(zellen.length, tb.breiten.length);
      const b = Array.from({ length: n }, (_, i) => tb.breiten[i] || 3);
      return [kuerze(f(C.dunkel, E + b.map((x, i) => '─'.repeat(x + (i === 0 || i === n - 1 ? 1 : 2))).join('┼')), w)];
    }
    const kopfZeile = tb.zeilen++ === 0;
    const teile = zellen.map((z) => inline(z, kopfZeile ? C.hell + C.fett : C.text));
    teile.forEach((t, i) => { tb.breiten[i] = Math.max(tb.breiten[i] || 0, t.reduce((s, x) => s + breite(x.t), 0)); });
    const z = teile.map((t, i) => t.map((x) => x.s + x.t + C.aus).join('') + ' '.repeat(Math.max(0, tb.breiten[i] - t.reduce((s, x) => s + breite(x.t), 0)))).join(f(C.dunkel, ' │ '));
    return [breite(z) + 2 > w ? schneideFarbig(E + z, w) : E + z];
  }
  st.tabelle = null;
  return umbrechen(inline(zeile, C.text), w, E, E);
}
function kuerzeHart(s, w) {
  let b = 0, r = '';
  for (const ch of s) { const z = zb(ch.codePointAt(0)); if (b + z > w) break; r += ch; b += z; }
  return r || [...s][0] || '';
}

// ---------- Verbindung zur App ----------
let verb = null; // { port, schluessel }
function anfrage(methode, pfad, daten, { strom } = {}) {
  return new Promise((ok, fehl) => {
    if (!verb) return fehl(new Error('not connected'));
    const body = daten ? Buffer.from(JSON.stringify(daten)) : null;
    const req = http.request({
      host: '127.0.0.1', port: verb.port, path: pfad, method: methode,
      headers: { 'x-glowline': verb.schluessel, ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
    }, (res) => {
      if (strom) return ok({ res, req });
      const teile = [];
      res.on('data', (x) => teile.push(x));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(teile).toString('utf8')); } catch {}
        if (res.statusCode >= 400) fehl(new Error((j && j.fehler) || 'HTTP ' + res.statusCode)); else ok(j);
      });
    });
    req.on('error', fehl);
    req.setTimeout(strom ? 0 : 15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
let info = null;
let kaltstart = false; // gl musste die App erst starten
async function verbinden(melde) {
  const versuch = async () => { const k = liesApi(); if (!k) return false; verb = k; try { info = await anfrage('GET', '/info'); return true; } catch { return false; } };
  if (await versuch()) return;
  if (!appExe || !fs.existsSync(appExe)) throw new Error('Glowline is not running – start the Glowline app first.');
  // App unsichtbar im Infobereich starten (wie beim Windows-Start)
  melde('Starting Glowline…');
  kaltstart = true;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(appExe, ['--tray'], { detached: true, stdio: 'ignore', env }).unref();
  for (let i = 0; i < 160; i++) {
    await warte(250);
    if (await versuch()) return;
  }
  throw new Error('Glowline did not answer. If it is open, update it to the newest version (terminal support came in 5.3.0).');
}

// ---------- Zustand ----------
const S = {
  verlauf: [], // { role, content, medien, datei, anhang, lokal, fehler, rolle, bild }
  fest: '', immerDenken: false, immerSchnell: false, ziel: '',
  sitzung: { start: Date.now(), nachrichten: 0, tokens: 0 },
  laeuft: null, // { req, antwort, start }
  wartend: null,
  eingabe: '', cursor: 0, // cursor = Index in [...eingabe]
  historie: [], hPos: -1, hEntwurf: '',
  wahl: 0, // Auswahl in der Befehlsliste
  zuletztModell: '', tps: null, gpu: null,
  ctrlC: 0, hinweis: '', hinweisBis: 0,
  letztes: null, // { art: 'medium'|'datei', pfad }
};
const histDatei = () => path.join(path.dirname(apiDatei), 'terminal-eingaben.json');
try { S.historie = JSON.parse(fs.readFileSync(histDatei(), 'utf8')).slice(-300); } catch {}
function historieMerken(t) {
  if (!t.trim() || S.historie[S.historie.length - 1] === t) return;
  S.historie.push(t);
  S.historie = S.historie.slice(-300);
  try { fs.writeFileSync(histDatei(), JSON.stringify(S.historie)); } catch {}
}

const BEFEHLE = [
  { n: 'help', info: 'show all commands and keys' },
  { n: 'clear', alias: ['new'], info: 'start a new chat' },
  { n: 'retry', info: 'ask your last message again' },
  { n: 'copy', info: 'copy the last answer' },
  { n: 'open', info: 'open the last image, video or file (Ctrl+O)' },
  { n: 'think', arg: 'question', info: 'answer with the reasoning model' },
  { n: 'code', arg: 'question', info: 'answer with the coder model' },
  { n: 'fast', arg: 'question', info: 'answer with the fast model' },
  { n: 'thinking', arg: 'on | off', info: 'always use the reasoning model' },
  { n: 'image', arg: 'description', info: 'create an image' },
  { n: 'video', arg: 'description', info: 'create a video' },
  { n: 'voice', arg: 'text', info: 'read a text aloud' },
  { n: 'upscale', arg: 'path', info: 'upscale an image / video (drag it in) or the last one' },
  { n: 'file', arg: 'what', info: 'create a file in this folder' },
  { n: 'goal', arg: 'text | off', info: 'keep every answer focused on a goal' },
  { n: 'model', arg: 'name', info: 'use one model for everything (no name: list)' },
  { n: 'auto', info: 'let Cowork pick the model again' },
  { n: 'effort', arg: 'low | medium | high', info: 'fast model, Auto or always the reasoning model' },
  { n: 'usage', info: 'tokens and saved costs: this chat, today, all time' },
  { n: 'stats', info: 'your last weeks: activity, favourite model, Studio results' },
  { n: 'autostart', arg: 'on | off', info: 'start Glowline with Windows, so gl is ready at once' },
  { n: 'update', info: 'install the newest Glowline version (download, install, restart)' },
  { n: 'exit', alias: ['quit'], info: 'leave (or Ctrl+C twice)' },
];
const befehlFinden = (w) => BEFEHLE.find((b) => b.n === w || (b.alias || []).includes(w));
function befehlTreffer() {
  const m = /^\/([a-z]*)$/i.exec(S.eingabe);
  if (!m) return [];
  const w = m[1].toLowerCase();
  return BEFEHLE.filter((b) => b.n.startsWith(w) || (b.alias || []).some((a) => a.startsWith(w)));
}

const ROLLE = { schnell: 'fast', denker: 'thinking', coder: 'coder', sehen: 'vision' };
const modellName = (id) => { if (!id) return ''; const m = info && info.modelle.find((x) => x.id === id); return (m && m.name) || String(id).split(',').pop(); };

// ---------- Bildschirm: Ausgabe waechst von oben, die Eingabe klebt immer ganz unten ----------
// live.zeile = so viele Bildschirmzeilen sind oben mit Ausgabe belegt; darunter Luecke, dann Fortschritt + Eingabe
const live = { gezeichnet: false, zeile: 0 };
const hoehe = () => Math.max(6, hoeheFenster());
const geheZu = (z, s = 1) => `\x1b[${z};${s}H`;
function liveLeeren() {
  if (!live.gezeichnet) return '';
  live.gezeichnet = false;
  return geheZu(Math.min(live.zeile, hoehe() - 1) + 1) + '\x1b[J';
}
// n Zeilen hochschieben – die obersten wandern in den Verlauf des Terminals (Mausrad)
function schiebe(n) {
  if (n <= 0) return '';
  live.zeile = Math.max(0, live.zeile - n);
  if (live.kopf != null && (live.kopf -= n) < 1) live.kopf = null;
  return geheZu(hoehe()) + '\n'.repeat(n);
}
// leerer Bildschirm, alte Ausgabe bleibt im Verlauf
function neueSeite() { const s = liveLeeren() + schiebe(live.zeile); live.zeile = 0; bisher.length = 0; kopfIndex = null; return s; }
// die letzten Zeilen merken, um sie nach einer Groessenaenderung neu zu zeigen
const bisher = [];
let kopfIndex = null; // wo Glims erste Bildzeile in bisher steht (damit er nach dem Neuaufbau weiter lebt)
let kopfMitGlim = true; // im sehr schmalen Fenster kommt der Kopf ohne Glim
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// leuchtender Punkt (pulsiert) und ein Glanz, der ueber das Status-Wort laeuft
function glimmen() {
  const t = (Math.sin(Date.now() / 260) + 1) / 2;
  const v = Math.round(110 + 145 * t);
  return f(rgb(v, v, Math.min(255, v + 6)), '●');
}
function glanz(text) {
  if (!FARBE) return text;
  const z = [...text];
  const pos = ((Date.now() / 70) % (z.length + 12)) - 6;
  return z.map((ch, i) => { const n = Math.max(0, 1 - Math.abs(i - pos) / 4); const v = Math.round(150 + 105 * n); return rgb(v, v, v) + ch; }).join('') + C.aus;
}
function sekunden(t) { const s = Math.floor((Date.now() - t) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
function balken(p, n = 14) { const v = Math.round((Math.max(0, Math.min(100, p)) / 100) * n); return f(C.hell, '▰'.repeat(v)) + f(C.dunkel, '▱'.repeat(n - v)); }
function liveZeilen() {
  const w = spalten() - 1;
  const z = [];
  let cur = { zeile: 0, spalte: 0 };
  const L = S.laeuft;
  if (L) {
    const a = L.antwort;
    // angefangene Zeile der Antwort
    if (a.teil) for (const r of a.teil) z.push(r);
    const sp = glimmen();
    let was;
    if (a.medien && !a.medien.dateien) {
      const art = { image: 'Creating image', video: 'Creating video', voice: 'Recording voice', upscale: 'Upscaling' }[a.medien.art] || 'Studio';
      was = `${sp} ${glanz(art + '…')}${a.medien.modell ? f(C.leise, ' · ' + a.medien.modell) : ''} ${f(C.leise, '· ' + (a.medien.status || 'Starting…'))}` + (a.medien.prozent != null ? ' ' + balken(a.medien.prozent) + f(C.leise, ' ' + Math.floor(a.medien.prozent) + '%') : '');
    } else if (a.datei && a.datei.status) was = `${sp} ${glanz('Writing file…')} ${f(C.leise, '· ' + a.datei.status)}`;
    else if (!a.text) was = `${sp} ${glanz(a.denken ? 'Thinking…' : 'Working…')}`;
    else was = `${sp} ${glanz('Writing…')}`;
    z.push('', kuerze(was + f(C.dunkel, ` ${sekunden(L.start)} · Esc to stop`), w));
  }
  if (S.wartend) z.push(kuerze(f(C.leise, '  ⏵ next: ') + f(C.text, S.wartend.replace(/\n/g, ' ')), w));
  const oben = z.splice(0);
  // Eingabe im Rahmen
  const innen = w - 4;
  z.push(f(C.dunkel, '╭' + '─'.repeat(w - 2) + '╮'));
  const zeichen = [...S.eingabe];
  const rows = [[]];
  let rb = 0, curRow = 0, curCol = 0;
  const vorW = 2;
  zeichen.forEach((ch, i) => {
    if (i === S.cursor) { curRow = rows.length - 1; curCol = rb; }
    if (ch === '\n') { rows.push([]); rb = 0; return; }
    const cb = zb(ch.codePointAt(0));
    if (rb + cb > innen - vorW) { rows.push([]); rb = 0; }
    rows[rows.length - 1].push(ch);
    rb += cb;
  });
  if (S.cursor >= zeichen.length) { if (rb >= innen - vorW) { rows.push([]); rb = 0; } curRow = rows.length - 1; curCol = rb; }
  // hoechstens 8 Zeilen zeigen, rund um den Cursor
  const max = 8;
  const von = Math.max(0, Math.min(curRow - max + 1, rows.length - max));
  const leer = !S.eingabe;
  rows.slice(von, von + max).forEach((r, i) => {
    const vor = von + i === 0 ? f(C.hell, '› ') : '  ';
    let t = r.join('');
    if (leer && i === 0) t = f(C.dunkel, S.laeuft ? 'Type your next message…' : 'Ask anything – or “create an image of …”  ·  / for commands');
    const tb = breite(t);
    if (von + i === curRow) cur = { zeile: z.length, spalte: 2 + vorW + curCol };
    z.push(f(C.dunkel, '│ ') + vor + C.text + t + C.aus + ' '.repeat(Math.max(0, innen - vorW - tb)) + f(C.dunkel, ' │'));
  });
  z.push(f(C.dunkel, '╰' + '─'.repeat(w - 2) + '╯'));
  // Befehlsliste oder Fusszeile
  const tr = befehlTreffer();
  if (tr.length) {
    S.wahl = Math.min(S.wahl, tr.length - 1);
    const von2 = Math.max(0, S.wahl - 7);
    tr.slice(von2, von2 + 8).forEach((b, i) => {
      const an = von2 + i === S.wahl;
      const name = ('/' + b.n + (b.arg ? ' ' + b.arg : '')).padEnd(24);
      z.push(kuerze((an ? f(C.hell, '  › ' + name) : f(C.leise, '    ' + name)) + f(an ? C.text : C.dunkel, b.info), w));
    });
  } else if (hoehe() >= 18) z.push(fusszeile(w, false), ...leiste(w));
  else z.push(fusszeile(w, true));
  return { oben, unten: z, cur };
}
// ---------- Leiste unter der Eingabe: dieselben Werte wie unten im Glowline-Fenster ----------
const strich = (anteil, n, farbe = C.hell) => { const voll = Math.round(Math.max(0, Math.min(1, anteil || 0)) * n); return f(farbe, '━'.repeat(voll)) + f(C.dunkel, '━'.repeat(n - voll)); };
const schoeneSkala = (v) => { for (const x of [50, 100, 150, 200, 300, 400, 500, 1000]) if (v <= x) return x; return Math.ceil(v / 500) * 500; };
const minSek = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function leiste(w) {
  const id = (S.laeuft && S.laeuft.antwort.modell) || S.fest || S.zuletztModell || '';
  const m = id && info ? info.modelle.find((x) => x.id === id) : null;
  const name = modellName(id), g = S.gpu;
  const backend = { ollama: 'Ollama', lmstudio: 'LM Studio' }[String(id).split(',')[0]] || '';
  const da = (S.geladen || []).find((x) => x.name === name);
  const gpuTxt = g && g.name && (backend || !id) ? ' · ' + gpuKurz(g) : '';
  const kopf = id
    ? f(C.hell + C.fett, name + [m && m.params, m && m.quant].filter(Boolean).map((x) => ', ' + x).join('')) + f(C.leise, (backend ? ' on ' + backend : '') + gpuTxt + (backend && !da ? ' · not loaded' : ''))
    : f(C.hell + C.fett, 'Auto') + f(C.leise, ' · picks the model for every message' + gpuTxt);
  // Spalten: [Wichtigkeit, Ueberschrift, Wert] – wird es zu eng, fallen die unwichtigsten weg
  const L = S.laeuft, wartet = L && S.ttft == null;
  const skala = schoeneSkala(Math.max(50, (S.spitze || 0) * 1.15, S.tps || 0));
  const ctx = (da && da.ctx) || (m && m.ctx) || 0;
  const sp = [
    [10, 'tok/s', f(C.hell + C.fett, wartet ? '…' : S.tps ? S.tps.toFixed(1) : '–') + ' ' + strich((S.tps || 0) / skala, 12) + f(C.dunkel, ' ' + skala)],
    [5, 'First token', f(C.hell, S.ttft != null ? S.ttft.toFixed(1) + 's' : wartet ? minSek(Date.now() - L.start) : '–')],
    [2, 'Prefill', f(C.hell, S.prefill ? Math.round(S.prefill) + ' tok/s' : S.kontext && S.prefill === 0 ? 'cached' : '–')],
    [6, 'Prompt', S.kontext ? f(C.hell, kurzZahl(S.kontext) + (ctx ? ' / ' + kurzZahl(ctx) : '')) + (ctx ? ' ' + strich(S.kontext / ctx, 6, S.kontext / ctx > 0.85 ? C.rot : C.hell) : '') : f(C.hell, '–')],
    [7, 'Output', f(C.hell, S.ausgabe ? kurzZahl(S.ausgabe) + ' tok' : '–')],
    [3, 'Turn', f(C.hell, L ? minSek(Date.now() - L.start) : S.turnDauer ? minSek(S.turnDauer) : '–')],
    [4, 'GPU power', f(C.hell, g && g.power ? Math.round(g.power) + ' W' : '–')],
    [8, 'VRAM', g && g.total ? f(C.hell, `${(g.used / 1024).toFixed(1)} / ${(g.total / 1024).toFixed(1)} GB`) + ' ' + strich(g.used / g.total, 6) : f(C.hell, '–')],
    [9, 'Saved costs', f(C.hell, (S.gespart || 0).toFixed(2) + ' $')],
  ];
  const breiteVon = (s) => Math.max(breite(s[1]), breite(s[2]));
  const gesamt = () => 2 + sp.reduce((a, s) => a + breiteVon(s), 0) + 3 * (sp.length - 1);
  while (sp.length > 1 && gesamt() > w) { let k = 0; for (let i = 1; i < sp.length; i++) if (sp[i][0] < sp[k][0]) k = i; sp.splice(k, 1); }
  const zeile = (i, farbe) => '  ' + sp.map((s) => { const t = i === 1 ? f(farbe, s[1]) : s[2]; return t + ' '.repeat(breiteVon(s) - breite(t)); }).join('   ');
  return [f(C.dunkel, '─'.repeat(w)), kuerze('  ' + kopf, w), zeile(1, C.dunkel), zeile(2)];
}
function fusszeile(w, mitWerten) {
  if (S.hinweis && Date.now() < S.hinweisBis) return kuerze('  ' + f(C.gelb, S.hinweis), w);
  const modus = S.fest ? modellName(S.fest) + ' (fixed)' : S.immerDenken ? 'Auto · always thinking' : S.immerSchnell ? 'Auto · fast' : 'Auto' + (S.zuletztModell ? ' · ' + modellName(S.zuletztModell) : '');
  // wie die Leiste im Fenster: [Wichtigkeit, Text] – wird es zu eng, fallen die unwichtigsten zuerst weg
  const g = S.gpu, wert = (zahlTxt, rest) => f(C.hell, zahlTxt) + f(C.leise, rest);
  const teile = [[9, f(C.hell, '⏵ ') + f(C.leise, modus)]];
  if (mitWerten && S.tps) teile.push([8, wert(Math.round(S.tps) + '', ' tok/s')]);
  if (mitWerten && S.ttft != null) teile.push([4, f(C.leise, 'first ') + wert(S.ttft.toFixed(1) + 's', '')]);
  if (mitWerten && S.ausgabe) teile.push([3, wert(kurzZahl(S.ausgabe), ' tok')]);
  if (mitWerten && S.kontext) teile.push([5, f(C.leise, 'ctx ') + wert(kurzZahl(S.kontext), '')]);
  if (mitWerten && g && g.total) teile.push([7, f(C.leise, 'GPU ') + wert(g.util + '%', '')], [6, wert((g.used / 1024).toFixed(1), `/${Math.round(g.total / 1024)} GB`)]);
  if (mitWerten && S.gespart >= 0.01) teile.push([2, f(C.leise, 'saved ') + wert(S.gespart.toFixed(2) + ' $', ' today')]);
  if (S.ziel) teile.push([1, f(C.leise, 'goal: ' + kuerze(S.ziel, 24))]);
  // neue Version da (wie bei OpenCode): rechts unten zeigen, /update installiert sie
  const rechts = S.laeuft ? f(C.dunkel, 'Esc stop') : S.updateNeu ? f(C.gelb, '✦ New update available: ' + S.updateNeu) + f(C.dunkel, ' · ') + f(C.hell, '/update')
    : f(C.dunkel, S.letztes ? 'Ctrl+O open · / commands' : '/ commands');
  const baue = () => '  ' + teile.map((t) => t[1]).join(f(C.dunkel, ' · '));
  let links = baue();
  while (teile.length > 1 && breite(links) + breite(rechts) + 2 > w) {
    let k = 1; for (let i = 2; i < teile.length; i++) if (teile[i][0] < teile[k][0]) k = i;
    teile.splice(k, 1); links = baue();
  }
  const platz = w - breite(links) - breite(rechts);
  return platz > 1 ? links + ' '.repeat(platz) + rechts : kuerze(links, w);
}
function liveZeichnen() {
  const H = hoehe();
  let { oben, unten, cur } = liveZeilen();
  if (unten.length > H) unten = unten.slice(0, H);
  // Fortschritt direkt unter der Ausgabe, Eingabe ganz unten – reicht der Platz nicht, rutscht die Ausgabe hoch
  oben = oben.slice(Math.max(0, oben.length - (H - unten.length)));
  let s = schiebe(live.zeile + oben.length + unten.length - H);
  if (oben.length) s += geheZu(live.zeile + 1) + oben.join('\r\n');
  const u = H - unten.length + 1;
  s += geheZu(u) + unten.join('\r\n');
  // Cursor zurueck in die Eingabe
  s += geheZu(u + cur.zeile, cur.spalte + 1);
  live.gezeichnet = true;
  return s;
}
let malenGeplant = false;
function malen() {
  if (nurAusgabe) return;
  malenGeplant = false;
  out('\x1b[?2026h\x1b[?25l' + liveLeeren() + liveZeichnen() + '\x1b[?25h\x1b[?2026l');
}
function bald() { if (!malenGeplant && !nurAusgabe) { malenGeplant = true; setImmediate(malen); } }
// dauerhafte Ausgabe ueber dem Eingabebereich
function drucke(zeilen) {
  if (!Array.isArray(zeilen)) zeilen = [zeilen];
  if (nurAusgabe) { out(zeilen.map((z) => (FARBE ? z : z.replace(ANSI, ''))).join('\n') + '\n'); return; }
  out('\x1b[?2026h\x1b[?25l' + liveLeeren() + zeilenSchreiben(zeilen) + liveZeichnen() + '\x1b[?25h\x1b[?2026l');
  bisher.push(...zeilen);
  if (bisher.length > 400) { const weg = bisher.length - 400; bisher.splice(0, weg); if (kopfIndex != null && (kopfIndex -= weg) < 0) kopfIndex = null; }
}
function zeilenSchreiben(zeilen) {
  const H = hoehe(), W = breiteFenster();
  let s = '';
  for (const z of zeilen) {
    const n = Math.min(H, Math.max(1, Math.ceil(breite(z) / W)));
    s += schiebe(live.zeile + n - H) + geheZu(live.zeile + 1) + '\x1b[2K' + z + C.aus;
    live.zeile += n;
  }
  return s;
}
// Fenstergroesse geaendert: Bildschirm neu aufbauen (die letzten Zeilen, passend gekuerzt)
let groesseUhr = null;
// auf Breite schneiden, Farben bleiben erhalten
function schneideFarbig(s, w) {
  let b = 0, r = '', i = 0;
  const re = new RegExp(ANSI.source, 'y');
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m) { r += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const z = zb(ch.codePointAt(0));
    if (b + z > w) break;
    r += ch; b += z; i += ch.length;
  }
  return r + C.aus;
}
function neuAufbauen() {
  const H = hoehe(), w = spalten() - 1;
  log('neuAufbauen', breiteFenster(), hoeheFenster());
  // Kopf passend zur neuen Breite neu bauen (mit oder ohne Glim)
  if (FARBE && kopfIndex != null && kopfIndex >= 1) bisher.splice(kopfIndex - 1, 7, ...kopf());
  const platz = Math.max(0, H - 6);
  const ab = Math.max(0, bisher.length - platz);
  const zeilen = bisher.slice(ab).map((z) => (breite(z) > w + 1 ? schneideFarbig(z, w) : z));
  live.gezeichnet = false;
  live.zeile = 0;
  live.kopf = null;
  // Glim mitnehmen, wenn er noch zu sehen ist
  const k = FARBE && kopfMitGlim && kopfIndex != null && kopfIndex >= ab ? kopfIndex - ab : -1;
  let s = zeilenSchreiben(k < 0 ? zeilen : zeilen.slice(0, k));
  if (k >= 0) { live.kopf = live.zeile + 1; s += zeilenSchreiben(zeilen.slice(k)); }
  out('\x1b[?2026h\x1b[?25l' + geheZu(1) + '\x1b[J' + s + liveZeichnen() + '\x1b[?25h\x1b[?2026l');
}
function hinweis(t, ms = 3500) { S.hinweis = t; S.hinweisBis = Date.now() + ms; bald(); setTimeout(bald, ms + 50); }

// ---------- Kopf ----------
// Glim – das Glowline-Maskottchen: ein Gluehwuermchen. Wenn es fliegt, zieht es eine Leuchtlinie hinter sich her (Glow-line).
const GLIM = [
  '...w........w...',
  '....w......w....',
  '...WWWWWWWWWW...',
  'gg.WWTEWWTEWW.gg',
  'ggg.WWWWWWWW.ggg',
  '.gg..wwwwww..gg.',
  '....hyYYYYyh....',
  '...hYYYTTYYYh...',
  '....hyYYYYyh....',
  'LLLLLLLLLLLLLLLL',
];
const GLIM_FARBEN = { T: [255, 255, 255], W: [236, 238, 243], w: [196, 200, 208], E: [24, 25, 30], g: [128, 132, 142], Y: [255, 236, 160], y: [232, 200, 112], h: [70, 62, 40] };
// leuchtender Bauch: pulsiert langsam (t = 0..1)
function glimFarben(t) {
  const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return { ...GLIM_FARBEN, Y: mix([240, 214, 138], [255, 244, 184]), y: mix([200, 168, 90], [244, 212, 126]), h: mix([44, 39, 26], [92, 80, 48]) };
}
// Pixel -> Halbblock-Zeichen (ein Zeichen = zwei Pixel uebereinander)
function pixelZeilen(raster, pal = GLIM_FARBEN) {
  const farbe = (zeile, x) => {
    const c = (raster[zeile] || '')[x];
    if (c === 'L') { const t = x / Math.max(1, raster[zeile].length - 1); const v = Math.round(150 + 105 * t); return [v, v, Math.min(255, v + 4)]; }
    return pal[c] || null;
  };
  const r = [];
  for (let y = 0; y < raster.length; y += 2) {
    let z = '';
    for (let x = 0; x < raster[y].length; x++) {
      const o = farbe(y, x), u = farbe(y + 1, x);
      if (!o && !u) z += C.aus + ' ';
      else if (o && u) z += `\x1b[38;2;${o.join(';')}m\x1b[48;2;${u.join(';')}m▀`;
      else if (o) z += `\x1b[49m\x1b[38;2;${o.join(';')}m▀`;
      else z += `\x1b[49m\x1b[38;2;${u.join(';')}m▄`;
    }
    r.push(z + C.aus);
  }
  return r;
}
// Kopf drucken und merken, wo Glim steht (zum Blinzeln)
function zeigeKopf() {
  drucke(kopf());
  live.kopf = FARBE && kopfMitGlim ? live.zeile - 5 : null;
  kopfIndex = bisher.length - 6;
}
// Glim lebt, solange er oben zu sehen ist: der Bauch leuchtet auf und ab, ab und zu blinzelt er
const GLIM_ZU = GLIM.map((z, i) => (i === 3 ? z.replace(/TE/g, 'ww') : z));
const glimTier = { zu: false, naechstesBlinzeln: Date.now() + 3000 };
function blinzeln() {
  setInterval(() => {
    if (live.kopf == null || !live.gezeichnet || !kopfMitGlim) return;
    const jetzt = Date.now();
    if (!glimTier.zu && jetzt > glimTier.naechstesBlinzeln) { glimTier.zu = true; glimTier.auf = jetzt + 160; }
    if (glimTier.zu && jetzt > glimTier.auf) { glimTier.zu = false; glimTier.naechstesBlinzeln = jetzt + 3500 + Math.random() * 4500; }
    const z = pixelZeilen(glimTier.zu ? GLIM_ZU : GLIM, glimFarben((Math.sin(jetzt / 650) + 1) / 2));
    // Augen (Zeile 2) und Bauch (Zeilen 4–5) neu malen, Cursor bleibt in der Eingabe
    let s = '\x1b[?2026h\x1b7';
    for (const i of [1, 3, 4]) if (live.kopf + i >= 1) s += geheZu(live.kopf + i, 3) + z[i];
    out(s + '\x1b8\x1b[?2026l');
  }, 120).unref();
}
function kopf() {
  const v = info && info.version ? info.version : '';
  const g = (info && info.gpu) || S.gpu;
  const gpuName = g && g.name ? String(g.name).replace(/^NVIDIA\s+(GeForce\s+)?/i, '') : '';
  const vram = g && g.total ? `${(g.used / 1024).toFixed(1)} / ${Math.round(g.total / 1024)} GB VRAM` : '';
  const ordner = kurzPfad(process.cwd());
  const w = spalten() - 1;
  const textBreite = Math.max(10, w - 26); // Rahmen + Glim + Abstaende
  const roh = [
    f(C.hell + C.fett, 'Glowline') + f(C.leise, ' ' + v),
    f(C.text, 'Cowork') + f(C.leise, [gpuName, vram].filter(Boolean).map((t) => ' · ' + t).join('')),
    f(C.leise, ordner),
    '',
    f(C.dunkel, '/help for all commands · drag in an image · Esc stops'),
  ];
  const text = roh.map((t) => (breite(t) > textBreite ? schneideFarbig(t, textBreite - 1) + f(C.dunkel, '…') : t));
  if (!FARBE) return ['', '  Glowline ' + v + ' · Cowork', '  ' + ordner, '  /help for all commands', ''];
  // sehr schmales Fenster: ohne Glim und Rahmen (passt sonst nicht und bricht um) – gleich viele Zeilen
  kopfMitGlim = w >= 44;
  if (!kopfMitGlim) return ['', ...roh.map((t) => '  ' + (breite(t) > w - 2 ? schneideFarbig(t, w - 3) + f(C.dunkel, '…') : t)), ''];
  // Glim und die Infos in einem schmalen Rahmen (so breit wie der Inhalt)
  const bild = pixelZeilen(GLIM);
  const innen = 1 + 16 + 3 + Math.max(...text.map(breite)) + 2;
  const rand = (t) => f(C.dunkel, t);
  return [
    rand('╭' + '─'.repeat(innen) + '╮'),
    ...bild.map((b, i) => rand('│') + ' ' + b + '   ' + text[i] + ' '.repeat(innen - 20 - breite(text[i])) + rand('│')),
    rand('╰' + '─'.repeat(innen) + '╯'),
  ];
}

// ---------- Senden ----------
const MEDIUM = /\.(png|jpe?g|webp|mp4|webm)$/i;
// gezogene oder getippte Pfade zu Bildern/Videos finden (auch "foto.jpg" im aktuellen Ordner)
function findeMedium(text) {
  const kandidaten = [];
  for (const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|(\S+)/g)) kandidaten.push({ roh: m[0], p: m[1] || m[2] || m[3] });
  for (const k of kandidaten) {
    if (!MEDIUM.test(k.p)) continue;
    const p = path.resolve(process.cwd(), k.p.replace(/^file:\/\/\/?/i, ''));
    try { if (fs.statSync(p).isFile()) return { pfad: p, roh: k.roh }; } catch {}
  }
  return null;
}
const fuerModell = (n) => ({
  role: n.role,
  content: n.medien && n.medien.dateien
    ? `[Created ${n.medien.art === 'voice' ? 'a voice recording of the text' : n.medien.art === 'upscale' ? 'a 4× upscale' : 'an ' + n.medien.art + ' with the prompt'}: ${n.medien.prompt || ''}]`
    : n.datei && n.datei.dateien
      ? `[${n.datei.geaendert ? 'Updated' : 'Saved'} ${n.datei.dateien.map((x) => x.name).join(', ')} in ${n.datei.ordner} on the user's computer] ${n.content || ''}`
      : n.content + (n.anhang ? ' [attached an image]' : ''),
});
function letztesMedium() {
  const v = S.verlauf;
  for (let i = v.length - 1; i >= 0; i--) {
    const n = v[i];
    if (n.role === 'user' && n.anhang) return { art: 'image', bild: n.anhang, prompt: '' };
    if (n.medien && n.medien.dateien && n.medien.dateien.length) {
      const d = n.medien.dateien[0];
      return { art: n.medien.art, prompt: n.medien.prompt || '', bild: /\.(png|jpe?g|webp)$/i.test(d) ? d : null, video: /\.(mp4|webm)$/i.test(d) ? d : null };
    }
    if (n.role === 'assistant' && !n.fehler) return null;
  }
  return null;
}
function letzteDatei() {
  let antworten = 0;
  for (let i = S.verlauf.length - 1; i >= 0 && antworten < 4; i--) {
    const n = S.verlauf[i];
    if (n.role !== 'assistant' || n.lokal) continue;
    antworten++;
    if (n.datei && n.datei.dateien && n.datei.dateien.length) return (n.datei.dateien.find((x) => /\.html?$/i.test(x.pfad)) || n.datei.dateien[0]).pfad;
  }
  return null;
}
function bildImGespraech(v) {
  const a = [...v].reverse().find((n) => n.role === 'assistant');
  const u = [...v].reverse().find((n) => n.role === 'user');
  if (a && a.rolle === 'sehen' && a.bild) return a.bild;
  if (u && u.anhang && !(a && a.medien)) return u.anhang;
  return null;
}
function nutzerZeilen(text, anhang) {
  const w = spalten() - 1;
  const r = [];
  const zeilen = text.split('\n');
  zeilen.forEach((z, i) => {
    for (const teil of umbrechen([{ t: z || ' ', s: C.hell }], w - 2, i === 0 ? f(C.leise, '› ') : '  ', '  ')) r.push(C.nutzerBg + mitHintergrund(teil) + C.nutzerBg + ' '.repeat(Math.max(0, w - breite(teil))) + C.aus);
  });
  if (anhang) r.push(C.nutzerBg + mitHintergrund(kuerze('  ' + f(C.leise, '📎 ' + path.basename(anhang)) + C.nutzerBg, w)) + ' '.repeat(Math.max(0, w - 4 - breite(path.basename(anhang)))) + C.aus);
  return r;
}

function senden(text, vorgabe = {}) {
  if (S.laeuft) { S.wartend = text; bald(); return; }
  let anhang = vorgabe.anhang || null;
  let erzwinge = vorgabe.erzwinge || null;
  if (!vorgabe.ohneMedium) {
    const m = findeMedium(text);
    if (m) {
      anhang = m.pfad;
      text = text.replace(m.roh, '').replace(/\s{2,}/g, ' ').trim();
      if (/\.(mp4|webm)$/i.test(m.pfad)) erzwinge = { art: 'upscale', quelle: m.pfad }; // Videos kann das Studio nur hochskalieren
      if (!text) text = /\.(mp4|webm)$/i.test(m.pfad) ? 'Upscale this' : 'What is in this image?';
    }
  }
  if (erzwinge && erzwinge.art === 'upscale' && anhang && !erzwinge.quelle) erzwinge.quelle = anhang;
  const istAuto = !S.fest;
  const model = S.fest || (info && info.chatModel) || '';
  const v = S.verlauf;
  const mitStudio = !vorgabe.ohneStudio;
  const vorher = mitStudio ? letztesMedium() : null;
  const voriges = istAuto ? [...v].reverse().find((n) => n.role === 'assistant' && !n.fehler && !n.lokal) : null;
  drucke(['', ...nutzerZeilen(vorgabe.anzeige || text, anhang)]);
  v.push({ role: 'user', content: text, anhang });
  const antwort = { role: 'assistant', content: '', text: '', denken: '', fertigZeilen: 0, st: { code: false }, teil: null, teilGedruckt: 0, kopf: false };
  const args = {
    model, system: [(info && info.chatSystem) || '', S.ziel ? `The user's goal for this conversation: ${S.ziel}\nKeep your answers focused on this goal.` : ''].filter(Boolean).join('\n\n'),
    nachrichten: v.filter((n) => !n.fehler && !n.lokal).map(fuerModell),
    medien: mitStudio, anhang, letztesMedium: vorher, erzwinge, letzteDatei: letzteDatei(), datei: !!vorgabe.datei,
    auto: istAuto, vorigeRolle: voriges && voriges.rolle, rolle: vorgabe.rolle || (S.immerDenken ? 'denker' : S.immerSchnell ? 'schnell' : undefined),
    bildFrage: istAuto ? bildImGespraech(v.slice(0, -1)) : null, ordner: process.cwd(),
  };
  v.push(antwort);
  const L = { antwort, start: Date.now(), req: null, gestoppt: false };
  S.laeuft = L;
  S.tps = null; S.ttft = null; S.ausgabe = 0; S.prefill = null;
  const tick = setInterval(bald, 90);
  return new Promise((fertig) => {
    let ende = false;
    const schluss = (fehler) => {
      if (ende) return;
      ende = true;
      clearInterval(tick);
      if (!fehler) S.sitzung.nachrichten++;
      S.turnDauer = Date.now() - L.start;
      if (!fehler && S.tps && (L.tokens || 0) > 20) S.spitze = Math.max(S.spitze || 0, S.tps);
      S.sitzung.tokens += L.tokens || 0;
      abschliessen(L, fehler).then(() => {
        S.laeuft = null;
        bald();
        fertig();
        if (S.wartend) { const t = S.wartend; S.wartend = null; befehlOderSenden(t); }
      });
    };
    L.stopp = () => { L.gestoppt = true; try { L.req && L.req.destroy(); } catch {} schluss('stopped'); };
    anfrage('POST', '/chat', args, { strom: true }).then(({ res, req }) => {
      L.req = req;
      let puffer = '';
      res.setEncoding('utf8');
      res.on('data', (x) => {
        puffer += x;
        let i;
        while ((i = puffer.indexOf('\n')) >= 0) {
          const z = puffer.slice(0, i);
          puffer = puffer.slice(i + 1);
          let o;
          try { o = JSON.parse(z); } catch { continue; }
          if (o.chat) { empfange(L, o.chat); if (o.chat.fertig) schluss(o.chat.fehler || null); }
          else if (o.studio && antwort.medien) { if (o.studio.prozent != null) antwort.medien.prozent = o.studio.prozent; if (o.studio.text) antwort.medien.status = o.studio.text; }
          else if (o.stat) {
            if (o.stat.tps) S.tps = o.stat.tps;
            if (o.stat.tokens) L.tokens = S.ausgabe = o.stat.tokens;
            if (o.stat.ttft != null) S.ttft = o.stat.ttft;
            if (o.stat.kontext) S.kontext = o.stat.kontext;
            if (o.stat.prefill != null) S.prefill = o.stat.prefill;
          }
        }
      });
      res.on('end', () => schluss(ende ? null : 'Glowline closed the connection'));
      res.on('error', () => schluss(L.gestoppt ? 'stopped' : 'Connection lost'));
    }).catch((e) => schluss('Glowline is not reachable: ' + e.message));
  });
}

// Antwort-Teile verarbeiten (die App schickt immer den ganzen Text bis jetzt)
function empfange(L, p) {
  const a = L.antwort;
  if (p.denken != null) a.denken = p.denken;
  if (p.rolle) a.rolle = p.rolle;
  if (p.bild) a.bild = p.bild;
  if (p.modell) { a.modell = p.modell; S.zuletztModell = p.modell; }
  if (p.medien) a.medien = { ...(a.medien || {}), ...p.medien };
  if ('datei' in p) a.datei = p.datei ? { ...(a.datei || {}), ...p.datei } : null;
  if (p.text != null && !p.fertig) { a.text = p.text; zeilenRaus(L, false); }
  if (p.text != null && p.fertig) a.text = p.text;
  bald();
}
function antwortKopf(L) {
  const a = L.antwort;
  if (a.kopf) return [];
  a.kopf = true;
  const r = [''];
  if (a.denken) r.push(f(C.dunkel, `  ✻ Thought for ${sekunden(L.start)}`));
  return r;
}
// fertige Zeilen dauerhaft drucken, angefangene Zeile im unteren Bereich zeigen
function zeilenRaus(L, alles) {
  const a = L.antwort;
  const w = spalten() - 1;
  const zeilen = a.text.split('\n');
  const bis = alles ? zeilen.length : zeilen.length - 1;
  const neu = [];
  for (let i = a.fertigZeilen; i < bis; i++) {
    let r = mdZeile(zeilen[i], a.st, w);
    if (i === a.fertigZeilen && a.teilGedruckt) { r = r.slice(a.teilGedruckt); a.teilGedruckt = 0; }
    neu.push(...r);
  }
  if (bis > a.fertigZeilen) a.fertigZeilen = bis;
  // erste Zeile bekommt den Punkt
  if (neu.length || (!alles && zeilen[zeilen.length - 1])) {
    const k = antwortKopf(L);
    if (k.length) neu.unshift(...k);
  }
  if (!a.erster && neu.some((z) => z.replace(ANSI, '').trim())) {
    const i = neu.findIndex((z) => z.replace(ANSI, '').trim());
    neu[i] = neu[i].replace(/^ {2}/, f(C.hell, '● '));
    a.erster = true;
  }
  if (!alles) {
    const letzte = zeilen[zeilen.length - 1];
    let teil = letzte ? mdZeile(letzte, { ...a.st, tabelle: a.st.tabelle && { breiten: [...a.st.tabelle.breiten], zeilen: a.st.tabelle.zeilen } }, w).slice(a.teilGedruckt) : null;
    // sehr lange Absaetze: was nicht mehr umbricht, schon nach oben schieben
    const max = Math.max(3, zeilenHoch() - 14);
    if (teil && teil.length > max) {
      const weg = teil.length - max;
      neu.push(...teil.slice(0, weg));
      a.teilGedruckt += weg;
      teil = teil.slice(weg);
    }
    if (teil && !a.erster && teil[0].replace(ANSI, '').trim()) teil = [teil[0].replace(/^ {2}/, f(C.hell, '● ')), ...teil.slice(1)];
    a.teil = teil;
  } else a.teil = null;
  if (neu.length) drucke(neu);
}
async function abschliessen(L, fehler) {
  const a = L.antwort;
  if (a.text) zeilenRaus(L, true);
  a.teil = null;
  if (a.st.code) { drucke(f(C.dunkel, '  ╰─')); a.st.code = false; }
  a.content = a.text;
  const w = spalten() - 1;
  if (fehler) {
    if (fehler === 'stopped') { drucke([...antwortKopf(L), f(C.dunkel, '  ⎿ Stopped')]); if (!a.text) a.fehler = 'Stopped.'; }
    else { drucke([...antwortKopf(L), ...umbrechen([{ t: String(fehler), s: C.rot }], w, f(C.rot, '  ✗ '), '    ')]); a.fehler = fehler; }
  }
  // Ergebnis aus dem Studio
  if (a.medien && a.medien.dateien && a.medien.dateien.length) {
    const art = { image: 'Image', video: 'Video', voice: 'Voice', upscale: 'Upscale' }[a.medien.art] || 'Result';
    const r = [...antwortKopf(L), `${f(C.hell + C.fett, '  ✓ ')}${f(C.hell, art + ' ready')}${f(C.leise, (a.medien.modell ? ' · ' + a.medien.modell : '') + ' · ' + sekunden(L.start))}`];
    if (a.medien.prompt && a.medien.art !== 'upscale') r.push(...umbrechen([{ t: a.medien.prompt, s: C.dunkel }], Math.min(w, 100), '    ', '    ').slice(0, 3));
    drucke(r);
    for (const d of a.medien.dateien) {
      if (/\.(png|jpe?g|webp|mp4|webm)$/i.test(d)) await vorschauDrucken(d);
      drucke('    ' + f(C.code, link(dateiUrl(d), kurzPfad(d))));
      S.letztes = { pfad: d };
    }
    drucke(f(C.dunkel, '    Ctrl+O opens it · ask for changes, e.g. “make it darker”'));
  } else if (a.medien && a.medien.fehlt) {
    // Studio fehlt etwas: Text kommt als normale Antwort
  }
  // gespeicherte Dateien
  if (a.datei && a.datei.dateien && a.datei.dateien.length) {
    const r = [`${f(C.hell + C.fett, '  ✓ ')}${f(C.hell, (a.datei.geaendert ? 'Updated ' : 'Saved ') + a.datei.dateien.map((x) => x.name).join(', '))}${f(C.leise, ' in ' + a.datei.ordner)}`];
    for (const d of a.datei.dateien) r.push('    ' + f(C.code, link(dateiUrl(d.pfad), kurzPfad(d.pfad))));
    S.letztes = { pfad: (a.datei.dateien.find((x) => /\.html?$/i.test(x.pfad)) || a.datei.dateien[0]).pfad };
    r.push(f(C.dunkel, '    Ctrl+O opens it'));
    drucke(r);
  }
  // kurze Statistik
  if (!fehler && a.text && !(a.medien && a.medien.dateien)) {
    const t = [modellName(a.modell || S.fest), a.rolle && ROLLE[a.rolle], sekunden(L.start), S.tps && a.text ? Math.round(S.tps) + ' tok/s' : ''].filter(Boolean);
    drucke(f(C.dunkel, '  ⎿ ' + t.join(' · ')));
  }
}

// Halbblock-Vorschau: jedes Zeichen zeigt zwei Pixel uebereinander
async function vorschauDrucken(d) {
  if (nurAusgabe || !FARBE) return;
  const b = Math.min(spalten() - 8, 64);
  const h = Math.min(32, (zeilenHoch() - 12) * 2);
  let v;
  try { v = await anfrage('GET', `/vorschau?f=${encodeURIComponent(d)}&b=${b}&h=${h}`); } catch { return; }
  if (!v || !v.px) return;
  const px = Buffer.from(v.px, 'base64');
  const p = (x, y) => { const i = (y * v.b + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
  const r = [];
  for (let y = 0; y < v.h; y += 2) {
    let z = '    ';
    for (let x = 0; x < v.b; x++) {
      const o = p(x, y);
      z += `\x1b[38;2;${o[0]};${o[1]};${o[2]}m` + (y + 1 < v.h ? `\x1b[48;2;${p(x, y + 1).join(';')}m` : '\x1b[49m') + '▀';
    }
    r.push(z + C.aus);
  }
  drucke(r);
}

// ---------- Befehle ----------
function lokal(zeilen) { drucke(['', ...zeilen, '']); }

// ---------- /usage und /stats (Zahlen von der Stats-Seite der App) ----------
const kurzZahl = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const datumKey = (z) => `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
const gpuKurz = (g) => (g && g.name ? String(g.name).replace(/^NVIDIA\s+(GeForce\s+)?/i, '') : '');
const passend = (r) => { const w = spalten() - 1; return r.map((z) => (breite(z) > w ? schneideFarbig(z, w - 1) + f(C.dunkel, '…') : z)); };
function usageZeilen(st) {
  const tage = st.tage || {}, h = tage[st.heute] || {};
  const alle = { tokens: 0, anfragen: 0, dollar: 0 };
  for (const t of Object.values(tage)) for (const k in alle) alle[k] += t[k] || 0;
  const min = Math.max(1, Math.round((Date.now() - S.sitzung.start) / 60000));
  const n = S.sitzung.nachrichten, g = st.gpu;
  const zeile = (k, v) => '  ' + f(C.text, k.padEnd(12)) + v;
  const r = [f(C.hell + C.fett, '  Usage')];
  r.push(zeile('This chat', f(C.hell, n + (n === 1 ? ' answer' : ' answers')) + f(C.leise, ` · ${kurzZahl(S.sitzung.tokens)} tokens written · ${min} min`)));
  r.push(zeile('Today', f(C.hell, kurzZahl(h.tokens) + ' tokens') + f(C.leise, ` · ${h.anfragen || 0} requests · saved `) + f(C.hell, (h.dollar || 0).toFixed(2) + ' $')));
  r.push(zeile('All time', f(C.hell, kurzZahl(alle.tokens) + ' tokens') + f(C.leise, ` · ${alle.anfragen} requests · saved `) + f(C.hell, alle.dollar.toFixed(2) + ' $')));
  if (g && g.total) r.push(zeile('GPU now', f(C.leise, [gpuKurz(g), g.util + '%', `${(g.used / 1024).toFixed(1)} / ${Math.round(g.total / 1024)} GB VRAM`].filter(Boolean).join(' · '))));
  r.push('', f(C.dunkel, '  Everything runs on your PC, so there is no limit. “Saved” is what the same tokens would cost in the cloud.'));
  return passend(r);
}
function statsZeilen(st) {
  const tage = st.tage || {};
  const WOCHEN = Math.max(4, Math.min(20, Math.floor((spalten() - 10) / 2)));
  // Heatmap wie auf der Stats-Seite: Spalten = Wochen, Zeilen = Montag bis Sonntag
  const heute = new Date(); heute.setHours(12, 0, 0, 0);
  const montag = new Date(heute); montag.setDate(heute.getDate() - ((heute.getDay() + 6) % 7) - 7 * (WOCHEN - 1));
  const werte = Object.values(tage).map((t) => t.tokens || 0).filter(Boolean).sort((a, b) => a - b);
  const grenze = (q) => werte[Math.floor((werte.length - 1) * q)];
  const stufe = (v) => (!v ? 0 : v <= grenze(0.25) ? 1 : v <= grenze(0.5) ? 2 : v <= grenze(0.75) ? 3 : 4);
  const FARBEN = [C.dunkel, rgb(105, 103, 99), rgb(155, 152, 147), rgb(205, 202, 197), rgb(255, 253, 248)];
  const r = [f(C.hell + C.fett, '  Stats') + f(C.leise, `  – last ${WOCHEN} weeks`), ''];
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((name, tg) => {
    let z = '  ' + f(C.dunkel, name.padEnd(4));
    for (let wo = 0; wo < WOCHEN; wo++) {
      const d = new Date(montag); d.setDate(montag.getDate() + wo * 7 + tg);
      if (d > heute) break;
      const s = stufe((tage[datumKey(d)] || {}).tokens);
      z += FARBEN[s] + (s ? '■' : '·') + C.aus + ' ';
    }
    r.push(z);
  });
  // Zahlen fuer denselben Zeitraum
  const ab = datumKey(montag);
  const zeitraum = Object.entries(tage).filter(([k]) => k >= ab).map(([, t]) => t);
  const summe = (k) => zeitraum.reduce((a, t) => a + (t[k] || 0), 0);
  const aktiv = zeitraum.filter((t) => t.anfragen || t.tokens).length;
  const tageGesamt = Math.round((heute - montag) / 864e5) + 1;
  let serie = 0;
  for (const d = new Date(heute); ; d.setDate(d.getDate() - 1)) {
    const t = tage[datumKey(d)];
    if (t && (t.anfragen || t.tokens)) serie++;
    else if (datumKey(d) === st.heute) continue; // heute noch nichts: ab gestern zaehlen
    else break;
  }
  r.push('');
  r.push('  ' + f(C.hell, kurzZahl(summe('tokens')) + ' tokens') + f(C.leise, ' · ') + f(C.hell, summe('anfragen') + ' requests') + f(C.leise, ' · saved ') + f(C.hell, summe('dollar').toFixed(2) + ' $'));
  r.push('  ' + f(C.leise, 'Active days ') + f(C.hell, aktiv + ' of ' + tageGesamt) + f(C.leise, ' · streak ') + f(C.hell, serie + (serie === 1 ? ' day' : ' days')));
  const mod = {};
  for (const t of zeitraum) for (const [n, v] of Object.entries(t.modelle || {})) mod[n] = (mod[n] || 0) + v;
  const ges = Object.values(mod).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(mod).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) r.push('  ' + f(C.leise, 'Favourite models ') + top.map(([n, v]) => f(C.hell, n) + f(C.leise, ' ' + Math.round((v / ges) * 100) + '%')).join(f(C.leise, ' · ')));
  const med = {};
  for (const t of zeitraum) for (const [n, v] of Object.entries(t.medien || {})) med[n] = (med[n] || 0) + v;
  const mt = [['bild', 'image', 'images'], ['video', 'video', 'videos'], ['upscale', 'upscale', 'upscales'], ['stimme', 'voice clip', 'voice clips']]
    .filter(([k]) => med[k]).map(([k, e, m]) => f(C.hell, String(med[k])) + f(C.leise, ' ' + (med[k] === 1 ? e : m)));
  if (mt.length) r.push('  ' + f(C.leise, 'Studio ') + mt.join(f(C.leise, ' · ')));
  if (!zeitraum.length) r.push(f(C.leise, '  Nothing counted yet – ask something and come back.'));
  r.push('', f(C.dunkel, '  More charts in the Glowline app under Stats.'));
  return passend(r);
}
async function befehlOderSenden(text) {
  const t = text.trim();
  if (!t) return;
  historieMerken(text);
  const m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(t);
  if (!m) return senden(text);
  const b = befehlFinden(m[1].toLowerCase());
  if (!b) { hinweis('Unknown command – type /help'); return; }
  const rest = m[2].trim();
  const w = spalten() - 1;
  switch (b.n) {
    case 'help': {
      const r = [f(C.hell + C.fett, '  Commands')];
      for (const x of BEFEHLE) r.push(kuerze('  ' + f(C.hell, ('/' + x.n + (x.arg ? ' ' + x.arg : '')).padEnd(24)) + f(C.leise, x.info), w));
      r.push('', f(C.hell + C.fett, '  Keys'));
      for (const [k, i] of [['Enter', 'send'], ['Ctrl+J or \\ + Enter', 'new line'], ['Esc', 'stop the answer'], ['↑ ↓', 'earlier messages'], ['Tab', 'complete a command'], ['Ctrl+O', 'open the last image, video or file'], ['Ctrl+L', 'clear the screen'], ['Ctrl+C', 'stop / clear / exit']]) r.push('  ' + f(C.hell, k.padEnd(24)) + f(C.leise, i));
      r.push('', f(C.leise, '  Drag an image or video into the window to attach it (e.g. “upscale” or “what is in it?”).'), f(C.leise, '  Files you ask for are saved in this folder: ' + kurzPfad(process.cwd())));
      lokal(r);
      break;
    }
    case 'clear':
      if (S.laeuft) S.laeuft.stopp();
      S.verlauf = []; S.ziel = ''; S.immerDenken = false; S.immerSchnell = false; S.letztes = null;
      S.sitzung = { start: Date.now(), nachrichten: 0, tokens: 0 };
      out(neueSeite());
      zeigeKopf();
      hinweis('New chat');
      break;
    case 'exit': beenden(); break;
    case 'retry': {
      const v = S.verlauf;
      const i = v.map((n) => n.role).lastIndexOf('user');
      if (i < 0 || S.laeuft) { hinweis(S.laeuft ? 'Wait for the answer first' : 'Nothing to retry'); break; }
      const alt = v[i];
      v.splice(i);
      senden(alt.content, { anhang: alt.anhang || null, ohneMedium: true });
      break;
    }
    case 'copy': {
      const a = [...S.verlauf].reverse().find((n) => n.role === 'assistant' && n.content && !n.lokal);
      if (!a) { hinweis('No answer yet'); break; }
      await anfrage('POST', '/kopieren', { text: a.content }).then(() => hinweis('Copied'), () => hinweis('Could not copy'));
      break;
    }
    case 'open': oeffneLetztes(); break;
    case 'think': case 'code': case 'fast':
      if (!rest) { hinweis(`Type your question after /${b.n}`); break; }
      senden(rest, { rolle: { think: 'denker', code: 'coder', fast: 'schnell' }[b.n], ohneStudio: true, anzeige: t });
      break;
    case 'thinking':
      S.immerDenken = rest ? !/^(off|aus|0|no|nein)$/i.test(rest) : !S.immerDenken;
      if (S.immerDenken) { S.fest = ''; S.immerSchnell = false; }
      hinweis(S.immerDenken ? 'Every message now goes to the reasoning model' : 'Cowork picks the model again');
      break;
    case 'image': case 'video': case 'voice':
      if (!rest) { hinweis(`Describe what you want after /${b.n}`); break; }
      senden(rest, { erzwinge: { art: b.n }, ohneMedium: b.n === 'voice', anzeige: t });
      break;
    case 'upscale': {
      const mm = rest && findeMedium(rest);
      if (rest && !mm) { hinweis('File not found: ' + kuerze(rest, 60)); break; }
      senden(mm ? 'Upscale ' + path.basename(mm.pfad) : 'Upscale this', { erzwinge: { art: 'upscale', quelle: mm ? mm.pfad : undefined }, anhang: mm && /\.(png|jpe?g|webp)$/i.test(mm.pfad) ? mm.pfad : null, ohneMedium: true, anzeige: t });
      break;
    }
    case 'file':
      if (!rest) { hinweis('Say what the file should contain, e.g. /file a jump game as HTML'); break; }
      senden(rest, { datei: true, ohneMedium: true, anzeige: t });
      break;
    case 'goal':
      if (!rest) { lokal([f(C.leise, S.ziel ? '  Current goal: ' + S.ziel + ' – /goal off clears it' : '  No goal set. Example: /goal learn Python basics')]); break; }
      S.ziel = /^(off|aus|clear|none)$/i.test(rest) ? '' : rest.slice(0, 300);
      hinweis(S.ziel ? 'Goal set' : 'Goal cleared');
      break;
    case 'model': {
      try { info = await anfrage('GET', '/info'); } catch {}
      const l = (info && info.modelle) || [];
      if (!rest) {
        const r = [f(C.hell + C.fett, '  Models') + f(C.leise, '  – /model <number or name> · /auto to let Cowork pick')];
        l.slice(0, 60).forEach((x, i) => r.push(kuerze('  ' + f(C.dunkel, String(i + 1).padStart(3)) + ' ' + (x.id === S.fest ? f(C.hell, '› ' + x.name) : f(C.text, '  ' + x.name)) + f(C.dunkel, '  ' + x.id.split(',')[0]), w)));
        if (!l.length) r.push(f(C.leise, '  No models found – is Ollama running?'));
        lokal(r);
        break;
      }
      const nr = /^\d+$/.test(rest) ? l[+rest - 1] : null;
      const q = rest.toLowerCase();
      const treffer = nr || l.find((x) => x.name.toLowerCase() === q || x.id.toLowerCase() === q) || l.find((x) => x.name.toLowerCase().startsWith(q)) || l.find((x) => x.id.toLowerCase().includes(q));
      if (!treffer) { hinweis('No model called “' + rest + '” – type /model for the list'); break; }
      S.fest = treffer.id; S.immerDenken = false; S.immerSchnell = false;
      hinweis('Every message now goes to ' + treffer.name);
      break;
    }
    case 'auto': S.fest = ''; S.immerDenken = false; S.immerSchnell = false; hinweis('Cowork picks the model again'); break;
    case 'effort': {
      const jetzt = S.immerDenken ? 'high' : S.immerSchnell ? 'low' : 'medium';
      const stufe = { low: 'low', l: 'low', fast: 'low', min: 'low', medium: 'medium', m: 'medium', mid: 'medium', auto: 'medium', high: 'high', h: 'high', max: 'high', think: 'high' }[rest.toLowerCase()];
      if (!stufe) {
        const r = [f(C.hell + C.fett, '  Effort') + f(C.leise, '  – now ') + f(C.hell, jetzt)];
        for (const [s, i] of [['low', 'every message goes to the fast model – quickest answers'], ['medium', 'Auto: Cowork picks the right model for each message'], ['high', 'every message goes to the reasoning model – thinks longer']]) r.push('  ' + (s === jetzt ? f(C.hell, '› ' + s.padEnd(9)) : f(C.text, '  ' + s.padEnd(9))) + f(C.leise, i));
        r.push(f(C.dunkel, '  /effort low | medium | high'));
        lokal(r);
        break;
      }
      S.fest = ''; S.immerDenken = stufe === 'high'; S.immerSchnell = stufe === 'low';
      hinweis({ low: 'Effort low – every message goes to the fast model', medium: 'Effort medium – Cowork picks the model again', high: 'Effort high – every message goes to the reasoning model' }[stufe]);
      break;
    }
    case 'usage': case 'stats': {
      let st;
      try { st = await anfrage('GET', '/stats'); } catch { hinweis('Could not read the stats'); break; }
      lokal(b.n === 'usage' ? usageZeilen(st) : statsZeilen(st));
      break;
    }
    case 'autostart': {
      const an = /^(on|an|ein|yes|ja)$/i.test(rest) ? true : /^(off|aus|no|nein)$/i.test(rest) ? false : undefined;
      try {
        const r = await anfrage('POST', '/autostart', { an });
        lokal([an === undefined
          ? f(C.leise, '  Start with Windows is ') + f(C.hell, r.an ? 'on' : 'off') + f(C.leise, ' · /autostart ' + (r.an ? 'off' : 'on') + ' to change it')
          : f(C.hell + C.fett, '  ✓ ') + f(C.hell, r.an ? 'Glowline now starts with Windows (hidden in the tray) – gl is ready right away.' : 'Glowline no longer starts with Windows – gl starts it when you need it.')]);
      } catch { hinweis('Update the Glowline app to use /autostart'); }
      break;
    }
    case 'update': await updateBefehl(); break;
  }
  bald();
}
// /update: neue Version suchen, zeigen was neu ist, laden (mit Balken), installieren – Glowline startet neu
async function updateBefehl() {
  let st;
  hinweis('Checking for updates…', 15000);
  try { st = await anfrage('GET', '/update'); } catch { hinweis('Update the Glowline app to use /update'); return; }
  S.hinweis = '';
  if (st.fehler && !st.neu) { lokal([f(C.rot, '  ' + st.fehler)]); return; }
  S.updateNeu = st.neu || null;
  if (!st.neu) { lokal([f(C.hell + C.fett, '  ✓ ') + f(C.hell, 'Glowline ' + st.version + ' is up to date.')]); return; }
  if (S.laeuft) { hinweis('Wait for the answer first'); return; }
  lokal([
    f(C.hell + C.fett, '  Updating to Glowline ' + st.neu) + f(C.leise, ' · you have ' + st.version),
    ...(st.punkte || []).map((z) => f(C.leise, '  • ') + f(C.text, z)),
  ]);
  try { st = await anfrage('POST', '/update/laden'); } catch { hinweis('Glowline is not reachable'); return; }
  while (!st.bereit && !st.fehler) {
    const p = st.gesamt ? (st.geladen / st.gesamt) * 100 : 0;
    hinweis(`Downloading Glowline ${st.neu}  ${balken(p, 20)}  ${Math.floor(p)} %  ·  ${(st.geladen / 1048576).toFixed(0)} / ${(st.gesamt / 1048576).toFixed(0)} MB`, 2000);
    await new Promise((r) => setTimeout(r, 400));
    try { st = await anfrage('GET', '/update/stand'); } catch { hinweis('Glowline is not reachable'); return; }
    if (!st.laedt && !st.bereit && !st.fehler) st.fehler = 'The download stopped – try /update now again';
  }
  S.hinweis = '';
  if (!st.bereit) { lokal([f(C.rot, '  ' + st.fehler)]); return; }
  let ok = false;
  try { ok = (await anfrage('POST', '/update/installieren')).ok; } catch {}
  if (!ok) { lokal([f(C.rot, '  Could not start the update – try /update now again')]); return; }
  lokal([f(C.hell + C.fett, '  ✓ ') + f(C.hell, `Installing Glowline ${st.neu} – Glowline restarts in a few seconds.`)]);
  beenden(0, 'Then type gl again to use Glowline ' + st.neu + '.');
}
function oeffneLetztes() {
  if (!S.letztes) { hinweis('Nothing to open yet'); return; }
  anfrage('POST', '/oeffnen', { pfad: S.letztes.pfad }).then((r) => hinweis(r && r.ok ? 'Opened ' + path.basename(S.letztes.pfad) : 'Can’t open that file'), () => hinweis('Glowline is not reachable'));
}

// ---------- Tastatur ----------
function einfuegen(t) {
  const z = [...S.eingabe];
  const neu = [...t];
  z.splice(S.cursor, 0, ...neu);
  S.eingabe = z.join('');
  S.cursor += neu.length;
  S.wahl = 0;
  S.hPos = -1;
}
function absenden() {
  const tr = befehlTreffer();
  if (tr.length) {
    const b = tr[S.wahl] || tr[0];
    // Befehl mit Argument: erst vervollstaendigen, ohne Argument direkt ausfuehren
    if (b.arg && !['model', 'upscale', 'goal', 'thinking', 'effort', 'autostart', 'update'].includes(b.n)) { S.eingabe = '/' + b.n + ' '; S.cursor = [...S.eingabe].length; bald(); return; }
    S.eingabe = '/' + b.n;
  }
  // "\" am Zeilenende + Enter = neue Zeile
  if (/\\$/.test(S.eingabe) && S.cursor === [...S.eingabe].length) { S.eingabe = S.eingabe.slice(0, -1); S.cursor--; einfuegen('\n'); bald(); return; }
  const t = S.eingabe;
  if (!t.trim()) return;
  S.eingabe = ''; S.cursor = 0; S.hPos = -1;
  befehlOderSenden(t);
  bald();
}
function wortGrenze(richtung) {
  const z = [...S.eingabe];
  let i = S.cursor;
  if (richtung < 0) { while (i > 0 && /\s/.test(z[i - 1])) i--; while (i > 0 && !/\s/.test(z[i - 1])) i--; }
  else { while (i < z.length && /\s/.test(z[i])) i++; while (i < z.length && !/\s/.test(z[i])) i++; }
  return i;
}
function historie(richtung) {
  if (!S.historie.length) return;
  if (S.hPos === -1) { if (richtung > 0) return; S.hEntwurf = S.eingabe; S.hPos = S.historie.length; }
  S.hPos = Math.max(0, Math.min(S.historie.length, S.hPos + richtung));
  S.eingabe = S.hPos === S.historie.length ? S.hEntwurf : S.historie[S.hPos];
  if (S.hPos === S.historie.length) S.hPos = -1;
  S.cursor = [...S.eingabe].length;
}
function taste(k) {
  const z = [...S.eingabe];
  const tr = befehlTreffer();
  if (k !== '\x03') S.ctrlC = 0;
  switch (k) {
    case '\r': absenden(); return;
    case '\n': einfuegen('\n'); break; // Ctrl+J / Ctrl+Enter
    case '\x7f': case '\b': if (S.cursor > 0) { z.splice(S.cursor - 1, 1); S.eingabe = z.join(''); S.cursor--; S.wahl = 0; } break;
    case '\x1b[3~': if (S.cursor < z.length) { z.splice(S.cursor, 1); S.eingabe = z.join(''); } break;
    case '\x1b[D': case '\x1bOD': S.cursor = Math.max(0, S.cursor - 1); break;
    case '\x1b[C': case '\x1bOC': S.cursor = Math.min(z.length, S.cursor + 1); break;
    case '\x1b[1;5D': case '\x1b[1;3D': case '\x1bb': S.cursor = wortGrenze(-1); break;
    case '\x1b[1;5C': case '\x1b[1;3C': case '\x1bf': S.cursor = wortGrenze(1); break;
    case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': S.cursor = 0; break;
    case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': S.cursor = z.length; break;
    case '\x1b[A': case '\x1bOA': if (tr.length) S.wahl = (S.wahl + tr.length - 1) % tr.length; else historie(-1); break;
    case '\x1b[B': case '\x1bOB': if (tr.length) S.wahl = (S.wahl + 1) % tr.length; else historie(1); break;
    case '\t': if (tr.length) { const b = tr[S.wahl] || tr[0]; S.eingabe = '/' + b.n + (b.arg ? ' ' : ''); S.cursor = [...S.eingabe].length; } break;
    case '\x15': z.splice(0, S.cursor); S.eingabe = z.join(''); S.cursor = 0; break; // Ctrl+U
    case '\x0b': S.eingabe = z.slice(0, S.cursor).join(''); break; // Ctrl+K
    case '\x17': { const i = wortGrenze(-1); z.splice(i, S.cursor - i); S.eingabe = z.join(''); S.cursor = i; break; } // Ctrl+W
    case '\x0f': oeffneLetztes(); break; // Ctrl+O
    case '\x0c': out(neueSeite()); zeigeKopf(); break; // Ctrl+L
    case '\x1b':
      if (tr.length) { S.eingabe = ''; S.cursor = 0; }
      else if (S.laeuft) S.laeuft.stopp();
      else if (S.wartend) S.wartend = null;
      break;
    case '\x03':
      if (S.laeuft) { S.laeuft.stopp(); S.ctrlC = 0; }
      else if (S.eingabe) { S.eingabe = ''; S.cursor = 0; }
      else if (Date.now() - S.ctrlC < 2000) return beenden();
      else { S.ctrlC = Date.now(); hinweis('Press Ctrl+C again to exit', 2000); }
      break;
    case '\x04': if (!S.eingabe) return beenden(); break;
    default:
      // normale Zeichen (Steuerzeichen und unbekannte Sequenzen weglassen)
      if (!k.startsWith('\x1b') && !/[\x00-\x08\x0e-\x1f]/.test(k)) einfuegen(k);
  }
  bald();
}
// Eingabe zerlegen: Tasten, Escape-Sequenzen, eingefuegter Text
// ---------- Fenstergroesse vom Terminal ----------
let groesseWarten = null;
function frageGroesse() {
  if (fenster.offen > 3) {
    // Terminal antwortet nicht – nicht weiter fragen. Hat es frueher geantwortet, ging nur eine Antwort verloren: neu anfangen.
    if (!fenster.antwort || Date.now() - fenster.antwort < 3000) return;
    fenster.offen = 0;
  }
  fenster.offen++;
  out('\x1b[?2026h\x1b7\x1b[9999;9999H\x1b[6n\x1b8\x1b[?2026l');
}
function groesseErhalten(s, z) {
  fenster.antwort = Date.now();
  if (s < 20 || z < 5) return;
  const neu = s !== breiteFenster() || z !== hoeheFenster();
  fenster.spalten = s; fenster.zeilen = z;
  if (groesseWarten) { const w = groesseWarten; groesseWarten = null; w(); return; }
  // Glim pausiert bis zum Neuaufbau (sonst blinzelt er kurz an der alten Stelle ins umgebrochene Bild)
  if (neu) { live.kopf = null; clearTimeout(groesseUhr); groesseUhr = setTimeout(neuAufbauen, 25); }
}
// beim Start kurz auf die erste Antwort warten (hoechstens 400 ms)
function ersteGroesse() {
  return new Promise((ok) => { groesseWarten = ok; frageGroesse(); setTimeout(() => { if (groesseWarten === ok) { groesseWarten = null; ok(); } }, 400); });
}
let einPuffer = '', imPaste = false, pasteText = '', escUhr = null;
const LOG = process.env.GLOWLINE_CLI_LOG;
const log = (...x) => { if (LOG) try { fs.appendFileSync(LOG, x.map((y) => (typeof y === 'string' ? y : JSON.stringify(y))).join(' ') + '\n'); } catch {} };
function eingang(d) {
  log('ein', JSON.stringify(d));
  einPuffer += d;
  clearTimeout(escUhr);
  while (einPuffer.length) {
    if (imPaste) {
      const e = einPuffer.indexOf('\x1b[201~');
      if (e < 0) { pasteText += einPuffer; einPuffer = ''; break; }
      pasteText += einPuffer.slice(0, e);
      einPuffer = einPuffer.slice(e + 6);
      imPaste = false;
      // eine Groessen-Antwort, die mitten ins Einfuegen gefallen ist, nicht als Text einfuegen
      pasteText = pasteText.replace(/\x1b\[(\d+);(\d+)R/g, (_, z, s) => { if (fenster.offen) { fenster.offen--; groesseErhalten(+s, +z); } return ''; });
      einfuegen(pasteText.replace(/\r\n?/g, '\n').replace(/\n$/, ''));
      pasteText = '';
      bald();
      continue;
    }
    if (einPuffer.startsWith('\x1b[200~')) { imPaste = true; einPuffer = einPuffer.slice(6); continue; }
    if (einPuffer[0] === '\x1b') {
      // Antwort auf die Groessen-Frage (nur wenn gefragt – Shift+F3 sieht genauso aus)
      const g = fenster.offen ? /^\x1b\[(\d+);(\d+)R/.exec(einPuffer) : null;
      if (g) { einPuffer = einPuffer.slice(g[0].length); fenster.offen--; groesseErhalten(+g[2], +g[1]); continue; }
      const m = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z]|[bf])/.exec(einPuffer);
      if (m) { taste(m[0]); einPuffer = einPuffer.slice(m[0].length); continue; }
      // einzelnes Esc: kurz warten, ob noch etwas folgt (laenger, wenn eine Groessen-Antwort unterwegs ist –
      // sonst wuerde eine geteilte Antwort wie ein Esc die laufende Antwort stoppen)
      if (einPuffer.length === 1) { escUhr = setTimeout(() => { if (einPuffer === '\x1b') { einPuffer = ''; taste('\x1b'); } }, fenster.offen ? 200 : 40); break; }
      if (einPuffer[1] === '\r') { einfuegen('\n'); bald(); einPuffer = einPuffer.slice(2); continue; } // Alt+Enter
      einPuffer = einPuffer.slice(1);
      taste('\x1b');
      continue;
    }
    // ohne Bracketed Paste: ein Stueck mit Text UND Enter ist eingefuegt, nicht getippt
    const bis = einPuffer.search(/\x1b/);
    const stueck = bis < 0 ? einPuffer : einPuffer.slice(0, bis);
    if (stueck.length > 1 && /[^\r\n]/.test(stueck) && /[\r\n]/.test(stueck.replace(/[\r\n]+$/, ''))) {
      einfuegen(stueck.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
      einPuffer = einPuffer.slice(stueck.length);
      bald();
      continue;
    }
    // einzelne Zeichen (Ersatzpaare zusammenlassen)
    const ch = String.fromCodePoint(einPuffer.codePointAt(0));
    einPuffer = einPuffer.slice(ch.length);
    if (ch.length === 1 && ch < ' ' && ch !== '\r' && ch !== '\n' && ch !== '\t' && ch !== '\x7f') { taste(ch); continue; }
    if (ch === '\r' || ch === '\n' || ch === '\t' || ch === '\x7f') { taste(ch); continue; }
    // mehrere normale Zeichen auf einmal einfuegen (schneller)
    let text = ch;
    while (einPuffer.length && !/^[\x00-\x1f\x7f]/.test(einPuffer)) { const c = String.fromCodePoint(einPuffer.codePointAt(0)); text += c; einPuffer = einPuffer.slice(c.length); }
    einfuegen(text);
    bald();
  }
}

// ---------- Start / Ende ----------
let ein = null;
function beenden(code = 0, abschied = 'Bye – Glowline keeps running in the tray.') {
  if (S.laeuft) try { S.laeuft.req && S.laeuft.req.destroy(); } catch {}
  if (!nurAusgabe) {
    out(liveLeeren() + schiebe(live.zeile + 2 - hoehe()) + geheZu(live.zeile + 1) + '\x1b[?2004l\x1b[?25h');
    try { ein && ein.setRawMode(false); } catch {}
    out(f(C.dunkel, '  ' + abschied) + '\n');
  }
  process.exit(code);
}
async function start() {
  const text = freieArgs.join(' ').trim();
  if (nurAusgabe) {
    if (!text) { hilfeText(); process.exit(1); }
    try { await verbinden((t) => process.stderr.write(t + '\n')); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
    await senden(text);
    const a = S.verlauf[S.verlauf.length - 1];
    process.exit(a && a.fehler ? 1 : 0);
  }
  // Tastatur: Glowlines Programm bekommt die Konsole nicht als stdin – direkt oeffnen
  // process.stdin nur anfassen, wenn es wirklich das Terminal ist (sonst liest es mit und schluckt Tasten)
  ein = tty.isatty(0) ? process.stdin : null;
  if (!ein) {
    try { ein = new tty.ReadStream(fs.openSync('\\\\.\\CONIN$', 'r+')); } catch { ein = null; }
  }
  if (!ein || !ein.isTTY) { process.stderr.write('Glowline needs a terminal window for the chat. Use  gl -p "question"  in scripts.\n'); process.exit(1); }
  log('stdin tty', tty.isatty(0), 'ein', ein === process.stdin ? 'stdin' : 'conin');
  ein.setRawMode(true);
  ein.setEncoding('utf8');
  // Tasten schon jetzt lesen (die Groessen-Antwort kommt ueber die Tastatur-Leitung)
  ein.on('data', eingang);
  await ersteGroesse();
  log('fenster', breiteFenster(), hoeheFenster(), 'stdout', process.stdout.columns, process.stdout.rows);
  // alten Inhalt nach oben in den Verlauf schieben: Glowline bekommt einen leeren Bildschirm
  out('\x1b[?2004h' + '\n'.repeat(hoehe()) + geheZu(1));
  live.zeile = 0;
  zeigeKopf();
  // verbinden (startet die App, wenn noetig)
  let warteText = 'Connecting…';
  S.laeuft = null;
  const uhr = setInterval(() => { S.hinweis = SPIN[Math.floor(Date.now() / 90) % SPIN.length] + ' ' + warteText; S.hinweisBis = Date.now() + 500; malen(); }, 90);
  try { await verbinden((t) => { warteText = t; }); } catch (e) {
    clearInterval(uhr);
    S.hinweis = '';
    drucke(umbrechen([{ t: e.message, s: C.rot }], spalten() - 1, f(C.rot, '  ✗ '), '    '));
    beenden(1);
    return;
  }
  clearInterval(uhr);
  S.hinweis = '';
  out(liveLeeren() + geheZu(1) + '\x1b[J');
  live.zeile = 0; bisher.length = 0; kopfIndex = null;
  zeigeKopf();
  blinzeln();
  process.stdout.on('resize', () => { frageGroesse(); clearTimeout(groesseUhr); groesseUhr = setTimeout(neuAufbauen, 80); });
  // Fenster groesser/kleiner gezogen? Das Terminal alle 150 ms fragen (Electron meldet es oft nicht, die Frage ist nur ein paar Bytes)
  setInterval(frageGroesse, 150).unref();
  // GPU-Anzeige alle paar Sekunden
  setInterval(async () => {
    try { const s = await anfrage('GET', '/status'); const neu = JSON.stringify([s.gpu, s.gespart, s.geladen]); if (neu !== JSON.stringify([S.gpu, S.gespart, S.geladen])) { S.gpu = s.gpu; S.gespart = s.gespart; S.geladen = s.geladen; bald(); } } catch {}
  }, 2000).unref();
  S.gpu = info && info.gpu;
  // neue Glowline-Version? einmal beim Start und dann jede Stunde nachsehen (die App fragt GitHub hoechstens stuendlich)
  const updateSehen = () => anfrage('GET', '/update/hinweis').then((u) => { const n = (u && u.neu) || null; if (n !== S.updateNeu) { S.updateNeu = n; bald(); } }, () => {});
  setTimeout(updateSehen, 1500);
  setInterval(updateSehen, 3600 * 1000).unref();
  malen();
  // App war aus: einmal zeigen, wie gl sofort bereit ist
  if (kaltstart) {
    anfrage('POST', '/autostart', {}).then((r) => { if (r && !r.an) drucke(f(C.dunkel, '  Tip: /autostart on – Glowline starts with Windows, then gl is ready instantly.')); }).catch(() => {});
  }
  if (text) befehlOderSenden(text);
}
process.on('uncaughtException', (e) => {
  try { out(liveLeeren() + '\x1b[?2004l\x1b[?25h'); ein && ein.setRawMode && ein.setRawMode(false); } catch {}
  process.stderr.write('\nGlowline terminal crashed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
start();
