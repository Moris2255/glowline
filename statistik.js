// Statistik pro Tag fuer die Stats-Seite (Heatmap): lokale Tokens, Anfragen, gesparte $, Modelle, Studio-Ergebnisse.
// Eigene Datei statistik.json neben config.json, damit die Einstellungen klein bleiben.
const fs = require('fs');
const path = require('path');

let datei = null, daten = { tage: {} }, speichernTimer = null;

function init(ordner) {
  datei = path.join(ordner, 'statistik.json');
  try { const j = JSON.parse(fs.readFileSync(datei, 'utf8')); if (j && typeof j.tage === 'object') daten = j; } catch {}
}
function speichern() {
  clearTimeout(speichernTimer);
  speichernTimer = setTimeout(jetztSpeichern, 3000);
}
function jetztSpeichern() {
  clearTimeout(speichernTimer);
  if (!datei) return;
  try { fs.writeFileSync(datei + '.tmp', JSON.stringify(daten)); fs.renameSync(datei + '.tmp', datei); } catch {}
}
// lokales Datum (nicht UTC), z. B. 2026-11-17
function heute(z = new Date()) {
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
}
function tag() {
  const k = heute();
  daten.tage[k] = { tokens: 0, ausgabe: 0, anfragen: 0, dollar: 0, modelle: {}, medien: {}, ...(daten.tage[k] || {}) };
  return daten.tage[k];
}
const zahl = (x) => (Number.isFinite(+x) && +x > 0 ? +x : 0);

// eine fertige Antwort eines lokalen Modells (vom Renderer, mit denselben Zahlen wie "Saved costs")
function zaehle(x) {
  if (!x || typeof x !== 'object') return;
  const t = tag();
  const tokens = Math.min(zahl(x.tokens), 5e6);
  t.tokens += tokens;
  t.ausgabe += Math.min(zahl(x.ausgabe), 5e6);
  t.anfragen += 1;
  t.dollar += Math.min(zahl(x.dollar), 1000);
  const m = String(x.model || '').replace(/^(ollama|lmstudio),/, '').slice(0, 80);
  if (m) t.modelle[m] = (t.modelle[m] || 0) + tokens;
  speichern();
}
// Studio-Ergebnis (bild, video, upscale, stimme)
function medien(art, n = 1) {
  if (!art) return;
  const t = tag();
  t.medien[art] = (t.medien[art] || 0) + n;
  speichern();
}

function stand() { return { heute: heute(), tage: daten.tage }; }

module.exports = { init, zaehle, medien, stand, jetztSpeichern, heute };
