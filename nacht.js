// Nacht-Warteschlange: Studio-Auftraege sammeln und nachts nacheinander rechnen.
// cfg.nacht = { start: '23:00', ende: '05:00', liste: [...] } – um "ende" ist Schluss (laufender Auftrag wird abgebrochen
// und kommt in der naechsten Nacht wieder dran). "Start now" rechnet sofort, unabhaengig von der Uhrzeit.
let d = null; // { cfg, speichere, studio, vramFrei, sende, test }
let aktuell = null, sofort = false, pause = false, timer = null;

const MAX = 50;
const n = () => {
  const c = d.cfg();
  c.nacht = { start: '23:00', ende: '05:00', liste: [], ...(c.nacht || {}) };
  return c.nacht;
};
const minuten = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t)); return m ? (+m[1] % 24) * 60 + (+m[2] % 60) : 0; };
const jetztMin = (z = new Date()) => z.getHours() * 60 + z.getMinutes();
function imFenster(z) {
  const s = minuten(n().start), e = minuten(n().ende), j = jetztMin(z);
  return s > e ? j >= s || j < e : j >= s && j < e;
}

function stand() {
  const x = n();
  return { start: x.start, ende: x.ende, liste: x.liste, laeuft: !!aktuell, sofort, pause, imFenster: imFenster() };
}
const melde = () => d.sende('nacht', stand());

function init(hilfen) {
  d = hilfen;
  // nach einem Absturz: "laeuft" gibt es nicht mehr, wieder in die Reihe
  for (const x of n().liste) if (x.status === 'laeuft') x.status = 'wartet';
  if (!d.test) timer = setInterval(tick, 30000);
}

function dazu(a, info) {
  const x = n();
  if (x.liste.filter((e) => e.status === 'wartet').length >= MAX) throw new Error(`The night queue is full (${MAX} jobs)`);
  const km = d.studio.KATALOG[a && a.modell];
  if (!km) throw new Error('Unknown model');
  if (km.wolke) throw new Error('Cloud models cost money per use – they can’t go in the night queue');
  const { id, vonAgent, vonChat, ...auftrag } = a;
  x.liste.push({ nr: Date.now() + '' + Math.floor(Math.random() * 1000), a: auftrag, art: km.art, name: km.name, prompt: String(a.prompt || (info && info.titel) || '').slice(0, 300), zeit: Date.now(), status: 'wartet' });
  d.speichere();
  melde();
  return stand();
}

function weg(nr) {
  const x = n();
  const e = x.liste.find((y) => y.nr === nr);
  if (e && e.status === 'laeuft' && aktuell) { aktuell.weg = true; d.studio.abbrechen(aktuell.vorgang); }
  x.liste = x.liste.filter((y) => y.nr !== nr);
  d.speichere();
  melde();
  return stand();
}
function aufraeumen() {
  const x = n();
  x.liste = x.liste.filter((y) => y.status === 'wartet' || y.status === 'laeuft');
  d.speichere();
  melde();
  return stand();
}
function zeiten(start, ende) {
  const x = n();
  if (/^\d{1,2}:\d{2}$/.test(start)) x.start = start;
  if (/^\d{1,2}:\d{2}$/.test(ende)) x.ende = ende;
  d.speichere();
  melde();
  tick();
  return stand();
}
function jetztStarten() { sofort = true; pause = false; melde(); tick(); return stand(); }
// Stop: bis zur naechsten Nacht nichts mehr starten
function stoppen() {
  sofort = false;
  pause = imFenster();
  if (aktuell) { aktuell.zurueck = true; d.studio.abbrechen(aktuell.vorgang); }
  melde();
  return stand();
}

async function tick(z) {
  const x = n();
  // harte Grenze: um "ende" Schluss (nur wenn die Nacht-Runde laeuft, nicht bei "Start now")
  if (aktuell && aktuell.nachts && !imFenster(z)) { aktuell.zurueck = true; d.studio.abbrechen(aktuell.vorgang); return; }
  if (aktuell) return;
  if (pause && !imFenster(z)) pause = false;
  if (pause) return;
  const naechster = x.liste.find((e) => e.status === 'wartet');
  if (!naechster) { if (sofort) { sofort = false; melde(); } return; }
  const nachts = imFenster(z);
  if (!nachts && !sofort) return;
  const id = 'nacht' + Date.now();
  aktuell = { vorgang: 'auftrag:' + id, nachts: nachts && !sofort };
  naechster.status = 'laeuft';
  naechster.fehler = null;
  melde();
  let r;
  try { r = await d.studio.auftrag({ ...naechster.a, id }, d.vramFrei); } catch (e) { r = { fehler: e.message }; }
  const war = aktuell;
  aktuell = null;
  if (war.zurueck) { naechster.status = 'wartet'; naechster.fehler = 'Stopped – continues next time'; }
  else if (!war.weg) {
    naechster.status = r && r.fehler ? 'fehler' : 'fertig';
    naechster.fehler = (r && r.fehler) || null;
    naechster.dateien = (r && r.dateien) || [];
    naechster.fertigUm = Date.now();
  }
  d.speichere();
  melde();
  if (!war.zurueck) setTimeout(() => tick(), 1500); // gleich den naechsten
}

module.exports = { init, stand, dazu, weg, aufraeumen, zeiten, jetztStarten, stoppen, tick, imFenster };
