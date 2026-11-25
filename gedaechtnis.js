// Arbeitsgedaechtnis: eine kurze Notiz pro Aufgabe (Terminal-Sitzung). Der Agent schreibt Ziel, Stand und naechste
// Schritte hinein und liest sie nach /clear oder dem Zusammenfassen wieder – so geht ihm bei langen Aufgaben nichts
// verloren, ohne dass der Kontext voll mit altem Verlauf ist. Endet die Aufgabe (anderer Ordner, "Forget",
// Glowline beendet), ist auch das Gedaechtnis weg.
// Dazu ein Archiv ("virtueller Kontext", 256k bis 1M Tokens): Details, die der Agent spaeter brauchen koennte, legt er
// dort ab und sucht sie bei Bedarf wieder – nur die passenden Stellen kommen in den echten Kontext. Voll ist voll.
const fs = require('fs');
const path = require('path');
const { woerter } = require('./gehirn');

const MAX = 20000; // Zeichen – ein Arbeitsgedaechtnis soll kurz bleiben
let ordner = null, beiAenderung = () => {}, archivGroesse = () => 256000;
const GROESSEN = { '256k': 256000, '512k': 512000, '1m': 1000000, '1.5m': 1500000 }; // Tokens
const tokens = (t) => Math.ceil(String(t).length / 4); // grob: 4 Zeichen pro Token

function init(userData, hoerer, groesse) {
  ordner = path.join(userData, 'gedaechtnis');
  if (hoerer) beiAenderung = hoerer;
  if (groesse) archivGroesse = groesse;
  alleLoeschen(); // Reste von einem Absturz
}
const gueltig = (id) => /^[a-z0-9]{8,40}$/.test(String(id || ''));
function datei(id) {
  if (!gueltig(id)) throw new Error('Unknown task');
  return path.join(ordner, id + '.md');
}
function lese(id) {
  try { return fs.readFileSync(datei(id), 'utf8'); } catch { return ''; }
}
function schreibe(id, text) {
  text = String(text ?? '');
  if (text.length > MAX) throw new Error(`Memory too long (${text.length} characters, max ${MAX}) – condense it and save it with write_memory`);
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(datei(id), text);
  beiAenderung(id, text, archivStand(id));
  return text.length;
}
function anhaengen(id, t) {
  const alt = lese(id);
  return schreibe(id, alt + (alt && !alt.endsWith('\n') ? '\n' : '') + String(t ?? ''));
}
function ersetze(id, alt, neu) {
  const t = lese(id);
  const n = alt ? t.split(String(alt)).length - 1 : 0;
  if (n !== 1) throw new Error(n ? `The text occurs ${n} times – include more context` : 'The text was not found – read the memory first');
  return schreibe(id, t.replace(String(alt), () => String(neu ?? '')));
}
function loesche(id) {
  if (!gueltig(id)) return;
  try { fs.rmSync(datei(id), { force: true }); } catch {}
  try { fs.rmSync(archivDatei(id), { force: true }); } catch {}
  archivCache.delete(id);
  beiAenderung(id, '', archivStand(id));
}

// ---------- Archiv ----------
const archivDatei = (id) => datei(id).replace(/\.md$/, '.archiv.json');
const archivCache = new Map(); // id -> { eintraege, stuecke }
function archiv(id) {
  if (archivCache.has(id)) return archivCache.get(id);
  let eintraege = [];
  try { eintraege = JSON.parse(fs.readFileSync(archivDatei(id), 'utf8')); } catch {}
  const a = { eintraege, stuecke: null };
  archivCache.set(id, a);
  return a;
}
function archivStand(id) {
  const max = archivGroesse();
  if (!gueltig(id) || !max) return { eintraege: 0, belegt: 0, max };
  const e = archiv(id).eintraege;
  return { eintraege: e.length, belegt: e.reduce((s, x) => s + x.tokens, 0), max };
}
function archivSpeichere(id, titel, text) {
  const max = archivGroesse();
  if (!max) throw new Error('The archive is off – only the short memory note is available');
  titel = String(titel || '').trim().slice(0, 200) || 'Untitled';
  text = String(text ?? '');
  if (!text.trim()) throw new Error('Nothing to save');
  const n = tokens(titel + text), st = archivStand(id);
  if (n > 60000) throw new Error(`Entry too big (~${n} tokens, max 60 000) – split it into several entries`);
  if (st.belegt + n > max) throw new Error(`Archive full: ~${st.belegt} of ${max} tokens used, this entry needs ~${n}. The task's archive limit is reached – keep only the most important things in the memory note.`);
  const a = archiv(id);
  const eintrag = { nr: (a.eintraege.length ? a.eintraege[a.eintraege.length - 1].nr : 0) + 1, titel, text, tokens: n, zeit: Date.now() };
  a.eintraege.push(eintrag);
  a.stuecke = null;
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(archivDatei(id), JSON.stringify(a.eintraege));
  beiAenderung(id, lese(id), archivStand(id));
  return { nr: eintrag.nr, tokens: n, ...archivStand(id) };
}
// Suche: BM25 ueber Stuecke von ~1500 Zeichen (wie im Obsidian-Vault)
function archivSuche(id, frage, n = 5) {
  const a = archiv(id);
  if (!a.stuecke) {
    a.stuecke = [];
    for (const e of a.eintraege) {
      let s = '';
      const weg = () => { if (!s.trim()) return; const w = [...woerter(e.titel), ...woerter(e.titel), ...woerter(s)]; const tf = new Map(); for (const x of w) tf.set(x, (tf.get(x) || 0) + 1); a.stuecke.push({ nr: e.nr, titel: e.titel, text: s, tf, laenge: w.length }); s = ''; };
      for (const absatz of e.text.split(/\n\s*\n/)) {
        if (s && s.length + absatz.length > 1500) weg();
        s += (s ? '\n\n' : '') + absatz;
        while (s.length > 3000) { const rest = s.slice(1500); s = s.slice(0, 1500); weg(); s = rest; }
      }
      weg();
    }
    a.df = new Map();
    for (const x of a.stuecke) for (const w of x.tf.keys()) a.df.set(w, (a.df.get(w) || 0) + 1);
    a.schnitt = a.stuecke.reduce((s, x) => s + x.laenge, 0) / Math.max(1, a.stuecke.length);
  }
  const q = [...new Set(woerter(frage))].slice(0, 40);
  if (!q.length) return [];
  const N = a.stuecke.length;
  const r = [];
  for (const x of a.stuecke) {
    let p = 0;
    for (const w of q) {
      const tf = x.tf.get(w);
      if (!tf) continue;
      const df = a.df.get(w) || 0;
      p += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * x.laenge / a.schnitt));
    }
    if (p > 0) r.push({ ...x, punkte: p });
  }
  return r.sort((x, y) => y.punkte - x.punkte).slice(0, n).map(({ nr, titel, text, punkte }) => ({ nr, titel, text, punkte }));
}
function archivEintrag(id, nr) {
  const e = archiv(id).eintraege.find((x) => x.nr === +nr);
  if (!e) throw new Error(`No archive entry #${nr}`);
  return e;
}
function alleLoeschen() {
  archivCache.clear();
  try { fs.rmSync(ordner, { recursive: true, force: true }); } catch {}
}

module.exports = { init, gueltig, lese, schreibe, anhaengen, ersetze, loesche, alleLoeschen, MAX, GROESSEN, archivStand, archivSpeichere, archivSuche, archivEintrag };
