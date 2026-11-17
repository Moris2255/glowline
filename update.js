// Auto-Update: neue Version auf GitHub finden, Installer laden, Pruefsumme (sha256) checken, still installieren.
// cfg.updates: 'auto' = im Hintergrund laden, beim Beenden installieren (oder sofort per Knopf) | 'fragen' = nur melden | 'aus'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const API = 'https://api.github.com/repos/Moris2255/glowline/releases/latest';
let d = null; // { version, ordner, link, cfg, sende, ladeDatei, beenden, test }
let st = { neu: null, notizen: '', geladen: 0, gesamt: 0, laedt: false, bereit: false, fehler: null, geprueft: 0 };
let ac = null, asset = null, datei = null, timer = null;

function init(hilfen) {
  d = hilfen;
  if (d.test) return;
  setTimeout(() => automatisch(), 15000); // nicht gleich beim Start, erst wenn alles laeuft
  timer = setInterval(() => automatisch(), 6 * 3600 * 1000);
}

const stand = () => ({ version: d.version, modus: modus(), ...st });
const melde = () => d.sende('update', stand());
const modus = () => (['auto', 'fragen', 'aus'].includes(d.cfg().updates) ? d.cfg().updates : 'auto');

// 4.5.10 > 4.5.9
function neuer(a, b) {
  const x = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function automatisch() {
  if (modus() === 'aus') return;
  await pruefen().catch(() => {});
  if (st.neu && modus() === 'auto' && !st.bereit && !st.laedt) laden().catch(() => {});
}

async function pruefen() {
  st.fehler = null;
  const url = (d.test && process.env.GLOWLINE_TEST_UPDATE) ? process.env.GLOWLINE_TEST_UPDATE + '/latest' : API;
  const r = await fetch(url, { headers: { 'user-agent': 'Glowline', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Could not check for updates (HTTP ' + r.status + ')');
  const j = await r.json();
  st.geprueft = Date.now();
  const tag = String(j.tag_name || '');
  const name = new RegExp('^' + (d.link ? 'Glowline-Link-Setup-' : 'Glowline-Setup-') + '\\d+\\.\\d+\\.\\d+\\.exe$');
  const a = (j.assets || []).find((x) => name.test(x.name));
  if (!/^v?\d+\.\d+\.\d+$/.test(tag) || !a || !neuer(tag, d.version)) { st.neu = null; melde(); return stand(); }
  if (!st.neu || st.neu !== tag.replace(/^v/, '')) { st.bereit = false; st.geladen = 0; }
  st.neu = tag.replace(/^v/, '');
  st.notizen = String(j.body || '').slice(0, 1500);
  st.punkte = punkte(j.body);
  st.gesamt = +a.size || 0;
  asset = a;
  melde();
  return stand();
}

// Release Notes kurz: die Abschnitts-Ueberschriften (ohne "Download"), sonst die ersten Stichpunkte – ohne Markdown
function punkte(text) {
  const z = String(text || '').split(/\r?\n/).map((x) => x.trim());
  const ueber = z.filter((x) => /^#{2,3} /.test(x)).map((x) => x.replace(/^#+ */, '')).filter((x) => !/^downloads?$/i.test(x));
  const liste = ueber.length ? ueber : z.filter((x) => /^[-*] /.test(x)).map((x) => x.replace(/^[-*] */, ''));
  return liste.map((x) => x.replace(/\*\*|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).filter(Boolean).slice(0, 6);
}

async function laden() {
  if (!asset) await pruefen();
  if (!asset || st.laedt) return stand();
  if (st.bereit && datei && fs.existsSync(datei)) return stand();
  ac = new AbortController();
  st.laedt = true; st.fehler = null; st.geladen = 0;
  d.sende('installer', { id: 'update', geladen: 0, gesamt: st.gesamt, laeuft: true });
  melde();
  const ziel = path.join(d.ordner, asset.name);
  let zuletzt = 0;
  try {
    await d.ladeDatei(asset.browser_download_url, ziel, ac, (g, t) => {
      st.geladen = g; if (t) st.gesamt = t;
      if (Date.now() - zuletzt > 500) { zuletzt = Date.now(); d.sende('installer', { id: 'update', geladen: g, gesamt: st.gesamt, laeuft: true }); melde(); }
    });
    // Pruefsumme von GitHub: kaputter oder veraenderter Download wird nicht installiert
    const soll = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    if (soll) {
      const ist = await new Promise((ok, f) => { const h = crypto.createHash('sha256'); fs.createReadStream(ziel).on('data', (x) => h.update(x)).on('end', () => ok(h.digest('hex'))).on('error', f); });
      if (ist !== soll[1].toLowerCase()) { fs.rmSync(ziel, { force: true }); throw new Error('The download was damaged – try again'); }
    }
    datei = ziel;
    st.bereit = true;
    // alte Installer im Update-Ordner wegraeumen
    for (const f of fs.readdirSync(d.ordner)) if (f !== asset.name && /^Glowline-(Link-)?Setup-[\d.]+\.exe(\.part)?$/.test(f)) fs.rmSync(path.join(d.ordner, f), { force: true });
  } catch (e) {
    st.fehler = ac.signal.aborted ? null : String((e && e.message) || e).slice(0, 200);
  }
  st.laedt = false; ac = null;
  d.sende('installer', { id: 'update', geladen: st.geladen, gesamt: st.gesamt, laeuft: false });
  melde();
  return stand();
}

function abbrechen() { if (ac) ac.abort(); }

// still installieren; neustart = Glowline danach wieder oeffnen
function installieren(neustart) {
  if (!st.bereit || !datei || !fs.existsSync(datei)) return false;
  if (d.test) { console.log('UPDATE WUERDE INSTALLIEREN', path.basename(datei), neustart ? 'mit Neustart' : 'ohne Neustart'); return true; }
  const args = ['/S', '--updated'];
  if (neustart) args.push('--force-run');
  spawn(datei, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  st.bereit = false;
  return true;
}

// Knopf "Update now": falls noetig laden, dann installieren und neu starten
async function jetzt() {
  if (!st.bereit) await laden();
  if (!st.bereit) return stand();
  if (installieren(true) && !d.test) d.beenden();
  return stand();
}

// beim Beenden: fertig geladenes Update (nur bei "auto") noch schnell still installieren
function beimBeenden() {
  if (modus() === 'auto' && st.bereit) installieren(false);
}

module.exports = { init, stand, pruefen, laden, abbrechen, jetzt, beimBeenden, neuer };
