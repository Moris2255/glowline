// Arbeitsgedaechtnis: eine kurze Notiz pro Aufgabe (Terminal-Sitzung). Der Agent schreibt Ziel, Stand und naechste
// Schritte hinein und liest sie nach /clear oder dem Zusammenfassen wieder – so geht ihm bei langen Aufgaben nichts
// verloren, ohne dass der Kontext voll mit altem Verlauf ist. Endet die Aufgabe (anderer Ordner, "Forget",
// Glowline beendet), ist auch das Gedaechtnis weg.
const fs = require('fs');
const path = require('path');

const MAX = 20000; // Zeichen – ein Arbeitsgedaechtnis soll kurz bleiben
let ordner = null, beiAenderung = () => {};

function init(userData, hoerer) {
  ordner = path.join(userData, 'gedaechtnis');
  if (hoerer) beiAenderung = hoerer;
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
  beiAenderung(id, text);
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
  beiAenderung(id, '');
}
function alleLoeschen() {
  try { fs.rmSync(ordner, { recursive: true, force: true }); } catch {}
}

module.exports = { init, gueltig, lese, schreibe, anhaengen, ersetze, loesche, alleLoeschen, MAX };
