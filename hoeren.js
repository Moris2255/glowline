// Spracheingabe: Parakeet TDT v3 (NVIDIA) ueber parakeet-cli aus dem whisper.cpp-Paket (MIT) – laeuft komplett auf diesem PC,
// auf dem Prozessor: keine Grafikkarte, kein Python, kein Internet. Schnell, sehr genau, erkennt die Sprache selbst (25 europaeische Sprachen).
// Einmal laden: das kleine Programm (8 MB) + das Modell. Beides wird per SHA-256 geprueft.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PROGRAMM = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb', groesse: 8.5e6,
};
const MODELLE = {
  parakeet: { name: 'Parakeet', datei: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin', groesse: 668757119, sha: '4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e', url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/', cli: 'parakeet-cli.exe' },
};
// fruehere Whisper-Modelle (bis 6.0.9 waehlbar): liegen sie noch da, werden sie beim Start geloescht
const ALTE_MODELLE = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-small-q5_1.bin'];

let d = null; // { ordner, ladeDatei, sende, cfg, test }
let lauf = null; // laufender Download { modell, geladen, gesamt, ac }
let fehler = null;

function init(x) {
  d = x;
  fs.mkdirSync(d.ordner, { recursive: true });
  for (const f of ALTE_MODELLE) fs.rmSync(path.join(d.ordner, f), { force: true });
}
const testUrl = () => d.test && process.env.GLOWLINE_TEST_HOEREN_URL;

function exe(cli = 'whisper-cli.exe') {
  // Das Zip hat einen Unterordner (Release/) – einfach suchen
  const such = (o, tiefe) => {
    let l = [];
    try { l = fs.readdirSync(o, { withFileTypes: true }); } catch { return null; }
    for (const e of l) if (e.isFile() && e.name.toLowerCase() === cli) return path.join(o, e.name);
    if (tiefe) for (const e of l) if (e.isDirectory()) { const t = such(path.join(o, e.name), tiefe - 1); if (t) return t; }
    return null;
  };
  return such(path.join(d.ordner, 'programm'), 2);
}
const modellPfad = (id) => path.join(d.ordner, MODELLE[id].datei);
const cliFuer = (id) => exe(MODELLE[id].cli);

function stand() {
  const da = {};
  for (const id of Object.keys(MODELLE)) da[id] = fs.existsSync(modellPfad(id));
  const m = Object.keys(MODELLE).find((id) => da[id]) || null;
  return {
    bereit: !!(m && cliFuer(m)), modell: m, da, programm: !!exe(),
    modelle: Object.fromEntries(Object.entries(MODELLE).map(([id, x]) => [id, { name: x.name, groesse: x.groesse }])),
    laedt: lauf ? { modell: lauf.modell, geladen: lauf.geladen, gesamt: lauf.gesamt } : null,
    fehler,
  };
}
const melde = () => d.sende('hoeren', stand());

function sha256(datei) {
  return new Promise((ok, f) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(datei).on('data', (x) => h.update(x)).on('error', f).on('end', () => ok(h.digest('hex')));
  });
}
async function holeGeprueft(url, ziel, sha, ac, fortschritt) {
  await d.ladeDatei(url, ziel, ac, fortschritt);
  if (testUrl()) return; // Test-Server liefert Attrappen
  if ((await sha256(ziel)) !== sha) {
    fs.rmSync(ziel, { force: true });
    throw new Error('The download was damaged – try again');
  }
}
function entpacke(zip, ziel) {
  return new Promise((ok, f) => execFile('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${ziel.replace(/'/g, "''")}' -Force`],
  { windowsHide: true, timeout: 300000 }, (e) => (e ? f(e) : ok())));
}

// Programm + Modell laden (bricht nichts ab, was schon da ist)
async function holen(id) {
  if (!MODELLE[id]) return stand();
  if (lauf) return stand();
  const ac = new AbortController();
  const m = MODELLE[id];
  lauf = { modell: id, geladen: 0, gesamt: m.groesse + (cliFuer(id) ? 0 : PROGRAMM.groesse), ac };
  fehler = null;
  melde();
  let zuletzt = 0, basis = 0;
  const fort = (g) => { lauf.geladen = basis + g; if (Date.now() - zuletzt > 400) { zuletzt = Date.now(); melde(); } };
  try {
    if (!cliFuer(id)) {
      const zip = path.join(d.ordner, 'whisper.zip');
      await holeGeprueft(testUrl() ? testUrl() + '/whisper.zip' : PROGRAMM.url, zip, PROGRAMM.sha, ac, fort);
      fs.rmSync(path.join(d.ordner, 'programm'), { recursive: true, force: true });
      await entpacke(zip, path.join(d.ordner, 'programm'));
      fs.rmSync(zip, { force: true });
      if (!cliFuer(id)) throw new Error(m.cli + ' is missing in the download');
      basis = PROGRAMM.groesse;
    }
    if (!fs.existsSync(modellPfad(id))) await holeGeprueft(testUrl() ? testUrl() + '/' + m.datei : m.url + m.datei, modellPfad(id), m.sha, ac, fort);
  } catch (e) {
    fehler = ac.signal.aborted ? null : String((e && e.message) || e).slice(0, 200);
  }
  lauf = null;
  melde();
  return stand();
}
function abbrechen() { if (lauf) lauf.ac.abort(); }
// alles wieder loeschen (Programm + Modelle)
function entfernen() {
  if (lauf) return stand();
  fs.rmSync(path.join(d.ordner, 'programm'), { recursive: true, force: true });
  for (const id of Object.keys(MODELLE)) fs.rmSync(modellPfad(id), { force: true });
  melde();
  return stand();
}

// WAV (16 kHz, mono, 16 bit) -> Text
async function schreiben(wav) {
  const roh = Buffer.from(wav || []);
  if (roh.length < 44 || roh.toString('ascii', 0, 4) !== 'RIFF' || roh.toString('ascii', 8, 12) !== 'WAVE') return { fehler: 'No audio' };
  if (roh.length > 16000 * 2 * 300 + 44) return { fehler: 'Too long – max. 5 minutes' };
  const s = stand();
  if (!s.bereit && !(d.test && process.env.GLOWLINE_TEST_HOEREN_TEXT)) return { fehler: 'Voice input is not set up yet' };
  const datei = path.join(d.ordner, `diktat_${Date.now()}.wav`);
  fs.writeFileSync(datei, roh);
  try {
    // Test: Text vorgeben statt parakeet-cli laufen zu lassen
    if (d.test && process.env.GLOWLINE_TEST_HOEREN_TEXT) return { text: process.env.GLOWLINE_TEST_HOEREN_TEXT, sekunden: (roh.length - 44) / 32000 };
    const kerne = Math.max(2, Math.min(8, os.cpus().length - 2));
    const t0 = Date.now();
    const text = await new Promise((ok, f) => {
      // Parakeet erkennt die Sprache selbst (kein -l)
      const args = ['-m', modellPfad(s.modell), '-f', datei, '-np', '-t', String(kerne)];
      const p = spawn(cliFuer(s.modell), args, { windowsHide: true });
      const teile = [];
      let err = '';
      p.stdout.on('data', (x) => { teile.push(x); }); // erst am Ende dekodieren: Umlaute koennen ueber zwei Pakete gehen
      const aus = () => Buffer.concat(teile).toString('utf8');
      p.stderr.on('data', (x) => { err = (err + x).slice(-600); });
      const uhr = setTimeout(() => { p.kill(); f(new Error('Speech recognition took too long')); }, 180000);
      p.on('error', (e) => { clearTimeout(uhr); f(e); });
      p.on('exit', (c) => { clearTimeout(uhr); c === 0 ? ok(aus()) : f(new Error(`Speech recognition failed (${c}) ${err.split(/\r?\n/).filter(Boolean).pop() || ''}`)); });
    });
    // Markierungen fuer Stille wie "[BLANK_AUDIO]" oder "(Musik)" weg
    const sauber = text.split(/\r?\n/).map((z) => z.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return { text: sauber, sekunden: (roh.length - 44) / 32000, dauer: (Date.now() - t0) / 1000, modell: s.modell };
  } catch (e) {
    return { fehler: String((e && e.message) || e).slice(0, 200) };
  } finally {
    fs.rmSync(datei, { force: true });
  }
}

const ordner = () => d.ordner;

module.exports = { init, stand, holen, abbrechen, entfernen, schreiben, ordner, MODELLE };
