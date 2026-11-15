'use strict';
// Studio: Bilder, Video, Upscaling und Stimme im Hauptbereich (wie Chat, kein eigenes Fenster).
// Laeuft nach app.js und workspace.js und nutzt deren Hilfen ($, elem, hinweis, MODI, ersterCode, ...).

const BEREICHE = {
  bild: { name: 'Images', knopf: 'Generate', leer: 'Describe an image and press Generate.' },
  video: { name: 'Video', knopf: 'Generate video', leer: 'Describe a short scene – or start from an image.' },
  upscale: { name: 'Upscale', knopf: 'Upscale 4×', leer: 'Drop an image here or pick one to make it 4× sharper.' },
  stimme: { name: 'Voice', knopf: 'Speak', leer: 'Type a text. Add a short voice sample to clone a voice.' },
};
const FORMATE = {
  bild: [['1:1', 1024, 1024], ['16:9', 1344, 768], ['9:16', 768, 1344], ['4:3', 1152, 864], ['3:4', 864, 1152]],
  video: [['16:9', 1280, 704], ['9:16', 704, 1280], ['1:1', 960, 960], ['Fast 16:9', 832, 480]],
};
const SPRACHEN = [['de', 'German'], ['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['tr', 'Turkish'], ['ru', 'Russian'], ['ja', 'Japanese'], ['zh', 'Chinese']];

const studioZustand = {
  bereich: 'bild', st: null, galerie: [], auswahl: null,
  felder: {
    bild: { modell: '', prompt: '', format: 0, seed: '' },
    video: { prompt: '', negativ: '', format: 0, sekunden: 5, bild: null },
    upscale: { bild: null },
    stimme: { prompt: '', sprache: 'de', probe: null, erlaubt: false, ausdruck: 0.5 },
  },
  auftraege: new Map(), // vorgang -> letzter Stand
  laden: new Map(), // modell/einrichten -> Fortschritt
  verbessern: null, nr: 0,
};
const sz = studioZustand;
const dateiUrl = (f) => 'glowline://datei/?f=' + encodeURIComponent(f);
const artVon = (f) => (/\.(mp4|webm)$/i.test(f) ? 'video' : /\.(wav|mp3|flac)$/i.test(f) ? 'audio' : 'bild');

// ---------- Ansicht ----------
const tabsBox = $('#studio-tabs');
for (const [id, b] of Object.entries(BEREICHE)) {
  const k = elem('button', null, b.name);
  k.dataset.bereich = id;
  k.addEventListener('click', () => zeigeStudio(id));
  tabsBox.appendChild(k);
}
$('#studio-ordner').addEventListener('click', () => window.api.studioZeigen(null));

async function zeigeStudio(bereich) {
  ansicht = 'studio';
  document.body.dataset.ansicht = ansicht;
  if (bereich) sz.bereich = bereich;
  el.classList.add('versteckt');
  $('#chat').classList.add('versteckt');
  $('#studio').classList.remove('versteckt');
  zeichneStudio();
  zeichneLeiste();
  await ladeStudio();
}
window.zeigeStudio = zeigeStudio;

async function ladeStudio() {
  const [st, gal] = await Promise.all([window.api.studio().catch(() => null), window.api.studioGalerie().catch(() => [])]);
  sz.st = st;
  sz.galerie = gal;
  if (ansicht === 'studio') zeichneStudio();
}

function titel() {
  $('#titel-text').innerHTML = '';
  $('#titel-text').append(elem('b', null, 'Studio'), '  ·  ' + BEREICHE[sz.bereich].name);
}

function zeichneStudio() {
  if (ansicht !== 'studio') return;
  titel();
  for (const b of tabsBox.children) b.classList.toggle('an', b.dataset.bereich === sz.bereich);
  const links = $('#studio-links'), rechts = $('#studio-rechts');
  // Fokus und Cursor im Textfeld behalten, wenn waehrend des Tippens neu gezeichnet wird
  const a = document.activeElement;
  const merk = a && links.contains(a) && a.dataset.k ? { k: a.dataset.k, s: a.selectionStart, e: a.selectionEnd, top: a.scrollTop } : null;
  const scroll = links.scrollTop;
  links.innerHTML = '';
  rechts.innerHTML = '';
  const st = sz.st;
  $('#studio-haupt').classList.toggle('einrichtung', !st || !st.eingerichtet);
  if (!st) { links.append(elem('div', 's-leer', 'Loading…')); return; }
  if (!st.eingerichtet) { zeichneEinrichtung(rechts); return; }
  zeichneFelder(links);
  zeichneVorschau(rechts);
  links.scrollTop = scroll;
  if (merk) {
    const n = links.querySelector(`[data-k="${merk.k}"]`);
    if (n) { n.focus(); try { n.setSelectionRange(merk.s, merk.e); } catch {} n.scrollTop = merk.top; }
  }
}
function zeichneRechts() {
  if (ansicht !== 'studio' || !sz.st || !sz.st.eingerichtet) return zeichneStudio();
  const rechts = $('#studio-rechts');
  rechts.innerHTML = '';
  zeichneVorschau(rechts);
}
// laufende Auftraege ohne Neuzeichnen aktualisieren (sonst flackern Videos in der Galerie)
function aktualisiereLauf() {
  const lauf = laufenderAuftrag();
  const k = document.querySelector('#studio-rechts .s-lauf');
  if (lauf && !lauf.fertig && k && k.dataset.v === lauf.vorgang && !!k.dataset.wartet === !!lauf.wartet) {
    k.querySelector('b').textContent = lauf.wartet ? 'Waiting for the GPU…' : lauf.text || 'Working…';
    k.querySelector('.s-balken i').style.width = (lauf.prozent || 0) + '%';
    k.querySelector('small').textContent = laufZeile(lauf);
  } else zeichneRechts();
  for (const t of document.querySelectorAll('#studio-rechts .s-kachel.lauf')) {
    const a = sz.auftraege.get(t.dataset.v);
    if (a) t.firstChild.textContent = a.wartet ? '…' : (a.prozent || 0) + '%';
  }
}
const laufZeile = (l) => [l.schritt ? 'Step ' + l.schritt : '', dauer(Date.now() - (l.start || Date.now()))].filter(Boolean).join(' · ');

// ---------- Einrichten (einmalig) ----------
function zeichneEinrichtung(box) {
  const k = elem('div', 's-einrichten');
  k.append(elem('b', null, 'Glowline Studio'),
    elem('p', null, 'Create images, videos, sharper upscales and voices on your own graphics card – private and free. '
      + 'The one-time setup downloads the engine (about 5 GB) into Glowline. Nothing else to install.'));
  const l = sz.laden.get('einrichten');
  if (l && !l.fertig) {
    const b = elem('div', 's-balken');
    const i = elem('i');
    i.style.width = (l.prozent || 0) + '%';
    b.appendChild(i);
    k.append(b, elem('small', null, `Step ${(l.schritt || 0) + 1} of ${l.schritte || 5}: ${l.titel || 'Starting'}${l.text ? ' – ' + l.text : ''}`));
    const ab = elem('button', 'm-knopf', 'Cancel');
    ab.addEventListener('click', () => { ab.disabled = true; ab.textContent = 'Cancelling…'; window.api.studioAbbrechen('einrichten'); });
    k.appendChild(ab);
  } else {
    if (l && l.fehler) k.appendChild(elem('small', 's-fehler', l.fehler === 'cancelled' ? 'Setup cancelled.' : 'Setup failed: ' + l.fehler));
    const los = elem('button', 's-los', l && l.fehler ? 'Try again' : 'Set up Studio');
    los.addEventListener('click', () => { sz.laden.set('einrichten', { prozent: 0 }); window.api.studioEinrichten(); zeichneStudio(); });
    k.appendChild(los);
    k.appendChild(elem('small', null, 'Needs an NVIDIA graphics card (8 GB or more recommended) and about 25–50 GB free space for the models you pick. Stored in ' + String(sz.st.ordner || '').replace(/^C:\\Users\\[^\\]+/i, '~') + '.'));
  }
  box.appendChild(k);
}

// ---------- Eingaben ----------
function modelleFuer(bereich) { return Object.values(sz.st.modelle).filter((m) => m.art === bereich); }
function aktivesModell(bereich) {
  const liste = modelleFuer(bereich);
  if (bereich === 'bild') {
    const gew = liste.find((m) => m.id === sz.felder.bild.modell);
    return gew || liste.find((m) => m.da) || liste[0];
  }
  return liste[0];
}

function modellKarte(m, gewaehlt, waehle) {
  const k = elem('div', 's-modell' + (gewaehlt ? ' an' : '') + (m.da ? ' da' : ''));
  k.dataset.m = m.id;
  const t = elem('div', 's-m-text');
  t.append(elem('b', null, m.name), elem('small', null, `${m.info} · ${m.lizenz}`));
  k.appendChild(t);
  const l = sz.laden.get('modell:' + m.id);
  if (m.da) k.appendChild(elem('span', 's-m-status', '✓ ready'));
  else if (l && !l.fertig) {
    const s = elem('div', 's-m-laden');
    const b = elem('div', 's-balken klein');
    const i = elem('i');
    i.style.width = (l.prozent || 0) + '%';
    b.appendChild(i);
    s.append(b, elem('small', null, l.prozent != null ? l.prozent + '%' : (l.text || 'Installing…').slice(0, 40)));
    const ab = elem('button', 'm-knopf', 'Cancel');
    ab.addEventListener('click', (e) => { e.stopPropagation(); ab.disabled = true; ab.textContent = 'Cancelling…'; window.api.studioAbbrechen('modell:' + m.id); });
    s.appendChild(ab);
    k.appendChild(s);
  } else {
    const d = elem('button', 'm-knopf', m.art === 'stimme' ? 'Install (~4 GB)' : m.teilweise ? 'Resume ' + gb(Math.max(0, m.fehltGroesse - m.teilweise)) : 'Download ' + gb(m.fehltGroesse || m.groesse));
    d.addEventListener('click', (e) => { e.stopPropagation(); sz.laden.set('modell:' + m.id, { prozent: 0 }); window.api.studioModell(m.id); zeichneStudio(); });
    k.appendChild(d);
    if (l && l.fehler && l.fehler !== 'cancelled') k.appendChild(elem('small', 's-fehler', l.fehler));
  }
  if (waehle) k.addEventListener('click', () => waehle(m.id));
  return k;
}

function feld(label, inhalt) {
  // nur einfache Eingaben in ein <label>: ein Klick daneben loest sonst den ersten Knopf darin aus (z. B. Format 1:1, Remove)
  const f = elem(inhalt.matches('input, select, textarea') ? 'label' : 'div', 's-feld');
  f.append(elem('span', null, label), inhalt);
  return f;
}

function promptFeld(f, platz, modus) {
  const box = elem('div', 's-prompt');
  const t = elem('textarea');
  t.value = f.prompt;
  t.placeholder = platz;
  t.spellcheck = false;
  t.rows = 5;
  t.dataset.k = 'prompt';
  t.addEventListener('input', () => { f.prompt = t.value; zeichneKnopfStudio(); });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); starte(); } });
  const v = elem('button', 's-verbessern', sz.verbessern ? 'Improving…' : modus === 'stimme' ? '✨ Write script' : '✨ Improve prompt');
  // waehrend Studio rechnet, wuerde das Sprachmodell die Grafikkarte mitbenutzen
  v.title = studioRechnet() ? 'Available when the current job is done' : 'Your chat model (bottom right) turns your idea into a strong prompt';
  v.disabled = !!sz.verbessern || studioRechnet();
  v.addEventListener('click', () => verbessere(modus, f));
  box.append(t, v);
  return box;
}

// Bild/Audio waehlen oder hineinziehen
function dateiFeld(f, schluessel, art, text) {
  const z = elem('div', 's-datei' + (f[schluessel] ? ' voll' : ''));
  if (f[schluessel]) {
    if (art === 'audio') { const a = elem('audio'); a.controls = true; a.src = dateiUrl(f[schluessel]); z.appendChild(a); } else { const i = elem('img'); i.src = dateiUrl(f[schluessel]); z.appendChild(i); }
    const n = elem('small', null, f[schluessel].split(/[\\/]/).pop());
    const weg = elem('button', 'm-knopf', 'Remove');
    weg.addEventListener('click', (e) => { e.stopPropagation(); f[schluessel] = null; zeichneStudio(); });
    z.append(n, weg);
  } else z.append(elem('span', null, text), elem('small', null, 'click or drop a file'));
  z.addEventListener('click', async (e) => {
    if (e.target.closest('button, audio')) return;
    const p = await window.api.studioWaehle(art);
    if (p) { f[schluessel] = p; zeichneStudio(); }
  });
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('ziehen'); });
  z.addEventListener('dragleave', () => z.classList.remove('ziehen'));
  z.addEventListener('drop', (e) => {
    e.preventDefault();
    const d = e.dataTransfer.files[0];
    const p = d && window.api.pfadVon(d);
    if (!p) return;
    const ok = art === 'audio' ? /\.(wav|mp3|flac|ogg|m4a)$/i.test(p) : /\.(png|jpe?g|webp)$/i.test(p);
    if (!ok) { hinweis(art === 'audio' ? 'Please drop an audio file' : 'Please drop an image'); return; }
    window.api.studioFreigeben(p);
    f[schluessel] = p;
    zeichneStudio();
  });
  return z;
}

function formatWahl(bereich, f) {
  const box = elem('div', 's-formate');
  FORMATE[bereich].forEach(([n, w, h], i) => {
    const b = elem('button', i === f.format ? 'an' : null, n);
    b.title = `${w} × ${h}`;
    b.addEventListener('click', () => { f.format = i; zeichneStudio(); });
    box.appendChild(b);
  });
  return box;
}

function zeichneFelder(box) {
  const b = sz.bereich, f = sz.felder[b];
  const m = aktivesModell(b);
  const liste = modelleFuer(b);
  box.appendChild(elem('div', 's-gruppe', liste.length > 1 ? 'Model' : 'Model'));
  for (const x of liste) box.appendChild(modellKarte(x, liste.length > 1 && x.id === m.id, liste.length > 1 ? (id) => { f.modell = id; zeichneStudio(); } : null));

  if (b === 'bild') {
    box.appendChild(feld('Prompt', promptFeld(f, 'A cozy cabin in a snowy forest at night, warm light in the windows…', 'bild')));
    box.appendChild(feld('Format', formatWahl('bild', f)));
    const s = elem('input');
    s.value = f.seed; s.placeholder = 'random'; s.inputMode = 'numeric'; s.dataset.k = 'seed';
    s.addEventListener('input', () => { f.seed = s.value.replace(/\D/g, ''); });
    box.appendChild(feld('Seed', s));
  } else if (b === 'video') {
    box.appendChild(feld('Prompt', promptFeld(f, 'A red fox runs through deep snow at sunset, slow tracking shot…', 'video')));
    box.appendChild(feld('Start image (optional)', dateiFeld(f, 'bild', 'bild', 'Animate an image')));
    box.appendChild(feld('Format', formatWahl('video', f)));
    const r = elem('input');
    r.type = 'range'; r.min = 1; r.max = 5; r.step = 1; r.value = f.sekunden;
    const w = elem('b', null, f.sekunden + ' s');
    r.addEventListener('input', () => { f.sekunden = +r.value; w.textContent = r.value + ' s'; });
    const z = elem('div', 's-regler'); z.append(r, w);
    box.appendChild(feld('Length', z));
    const n = elem('textarea');
    n.rows = 2; n.dataset.k = 'negativ'; n.value = f.negativ; n.placeholder = 'blurry, low quality, static, distorted…'; n.spellcheck = false;
    n.addEventListener('input', () => { f.negativ = n.value; });
    box.appendChild(feld('Avoid (optional)', n));
  } else if (b === 'upscale') {
    box.appendChild(feld('Image', dateiFeld(f, 'bild', 'bild', 'Pick an image')));
  } else if (b === 'stimme') {
    box.appendChild(feld('Text', promptFeld(f, 'Hallo! Das ist meine neue Stimme aus Glowline…', 'stimme')));
    const sp = elem('select');
    for (const [c, n] of SPRACHEN) { const o = elem('option', null, n); o.value = c; o.selected = c === f.sprache; sp.appendChild(o); }
    sp.addEventListener('change', () => { f.sprache = sp.value; });
    box.appendChild(feld('Language', sp));
    box.appendChild(feld('Voice sample (optional, 5–15 s)', dateiFeld(f, 'probe', 'audio', 'Clone a voice')));
    if (f.probe) {
      const c = elem('label', 's-erlaubt');
      const x = elem('input'); x.type = 'checkbox'; x.checked = f.erlaubt;
      x.addEventListener('change', () => { f.erlaubt = x.checked; zeichneKnopfStudio(); });
      c.append(x, elem('span', null, 'This is my voice, or I have permission to use it.'));
      box.appendChild(c);
    }
    const r = elem('input');
    r.type = 'range'; r.min = 0.25; r.max = 1.5; r.step = 0.05; r.value = f.ausdruck;
    const w = elem('b', null, f.ausdruck.toFixed(2));
    r.addEventListener('input', () => { f.ausdruck = +r.value; w.textContent = (+r.value).toFixed(2); });
    const z = elem('div', 's-regler'); z.append(r, w);
    box.appendChild(feld('Expressiveness', z));
  }
  const los = elem('button', 's-los', BEREICHE[b].knopf);
  los.id = 'studio-los';
  los.addEventListener('click', starte);
  box.appendChild(los);
  box.appendChild(elem('div', 's-fuss', b === 'stimme'
    ? 'Only clone voices you are allowed to use. Generated audio is for your own projects.'
    : 'Runs on your GPU. Language models are unloaded while Studio works.'));
  zeichneKnopfStudio();
}

function zeichneKnopfStudio() {
  const k = $('#studio-los');
  if (!k) return;
  const b = sz.bereich, f = sz.felder[b], m = aktivesModell(b);
  let grund = '';
  if (!m || !m.da) grund = 'Download the model first';
  else if ((b === 'bild' || b === 'video' || b === 'stimme') && !f.prompt.trim()) grund = b === 'stimme' ? 'Type a text first' : 'Write a prompt first';
  else if (b === 'upscale' && !f.bild) grund = 'Pick an image first';
  else if (b === 'stimme' && f.probe && !f.erlaubt) grund = 'Confirm the voice permission first';
  k.disabled = !!grund;
  k.title = grund;
}

// ---------- Starten ----------
function starte() {
  const b = sz.bereich, f = sz.felder[b], m = aktivesModell(b);
  zeichneKnopfStudio();
  if ($('#studio-los') && $('#studio-los').disabled) { hinweis($('#studio-los').title); return; }
  const id = String(Date.now()) + (++sz.nr);
  const a = { id, modell: m.id };
  if (b === 'bild') { const [, w, h] = FORMATE.bild[f.format]; Object.assign(a, { prompt: f.prompt.trim(), breite: w, hoehe: h, seed: f.seed }); }
  if (b === 'video') { const [, w, h] = FORMATE.video[f.format]; Object.assign(a, { prompt: f.prompt.trim(), negativ: f.negativ.trim(), breite: w, hoehe: h, sekunden: f.sekunden, bildDatei: f.bild }); }
  if (b === 'upscale') a.bildDatei = f.bild;
  if (b === 'stimme') Object.assign(a, { prompt: f.prompt.trim(), sprache: f.sprache, bildDatei: f.probe, ausdruck: f.ausdruck });
  sz.auftraege.set('auftrag:ui' + id, { vorgang: 'auftrag:ui' + id, art: b, modell: m.id, prompt: a.prompt || '', text: 'Waiting…', start: Date.now() });
  sz.auswahl = { vorgang: 'auftrag:ui' + id };
  window.api.studioAuftrag(a);
  zeichneStudio();
}

// ---------- Prompt verbessern (mit dem Chat-Modell) ----------
const studioRechnet = () => [...sz.auftraege.values()].some((a) => !a.fertig);
function verbessere(modus, f) {
  if (studioRechnet()) { hinweis('Available when the current job is done'); return; }
  const model = chatModell();
  if (!model) { hinweis('Pick a chat model first (bottom right)'); return; }
  if (!f.prompt.trim()) { hinweis('Type your idea first'); return; }
  const id = 'studio' + ++sz.nr;
  sz.verbessern = { id, f, modus, text: '' };
  window.api.chat({ id, model, system: MODI[modus].system, nachrichten: [{ role: 'user', content: f.prompt.trim() }] });
  zeichneStudio();
}
window.api.onChat((p) => {
  const v = sz.verbessern;
  if (!v || p.id !== v.id) return;
  if (p.text != null) v.text = p.text;
  if (!p.fertig) return;
  sz.verbessern = null;
  if (p.fehler) hinweis(p.fehler === 'stopped' ? 'Stopped' : fehlerText(p.fehler));
  else {
    const bloecke = [...v.text.matchAll(/```[^\n`]*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
    const neu = ersterCode(v.text) || v.text.trim();
    if (neu) v.f.prompt = neu;
    if (v.modus === 'video' && bloecke[1]) v.f.negativ = bloecke[1];
    hinweis('Prompt improved – edit it if you like');
  }
  zeichneStudio();
});

// ---------- Vorschau + Galerie ----------
function laufenderAuftrag() {
  if (sz.auswahl && sz.auswahl.vorgang) return sz.auftraege.get(sz.auswahl.vorgang) || null;
  return null;
}

function medienElem(datei, gross) {
  const a = artVon(datei);
  if (a === 'video') { const v = elem('video'); v.src = dateiUrl(datei); v.loop = true; v.muted = !gross; v.playsInline = true; if (gross) { v.controls = true; v.autoplay = true; } else v.preload = 'metadata'; return v; }
  if (a === 'audio') {
    if (!gross) return elem('div', 's-audio-mini', '♪');
    const box = elem('div', 's-audio');
    const au = elem('audio'); au.controls = true; au.src = dateiUrl(datei);
    box.append(elem('div', 's-welle', '♪'), au);
    return box;
  }
  const i = elem('img'); i.src = dateiUrl(datei); i.loading = 'lazy'; return i;
}

function zeichneVorschau(box) {
  const b = sz.bereich;
  const buehne = elem('div', 's-buehne');
  const lauf = laufenderAuftrag();
  const datei = lauf && lauf.dateien ? lauf.dateien[0] : sz.auswahl && sz.auswahl.datei;
  if (lauf && !lauf.fertig) {
    const k = elem('div', 's-lauf');
    k.dataset.v = lauf.vorgang;
    if (lauf.wartet) k.dataset.wartet = '1';
    k.append(elem('b', null, lauf.wartet ? 'Waiting for the GPU…' : lauf.text || 'Working…'));
    const bal = elem('div', 's-balken');
    const i = elem('i');
    i.style.width = (lauf.prozent || 0) + '%';
    bal.appendChild(i);
    k.append(bal, elem('small', null, laufZeile(lauf)));
    if (lauf.prompt) k.appendChild(elem('p', null, lauf.prompt.slice(0, 220)));
    const ab = elem('button', 'm-knopf', 'Cancel');
    ab.addEventListener('click', () => { ab.disabled = true; ab.textContent = 'Cancelling…'; window.api.studioAbbrechen(lauf.vorgang); });
    k.appendChild(ab);
    buehne.appendChild(k);
  } else if (lauf && lauf.fehler) {
    const k = elem('div', 's-lauf');
    k.append(elem('b', 's-fehler', lauf.fehler === 'cancelled' ? 'Cancelled' : 'Something went wrong'), elem('p', null, lauf.fehler === 'cancelled' ? '' : lauf.fehler));
    buehne.appendChild(k);
  } else if (datei) {
    buehne.appendChild(medienElem(datei, true));
    const leiste = elem('div', 's-aktionen');
    const knopf = (t, fn) => { const x = elem('button', 'm-knopf', t); x.addEventListener('click', fn); leiste.appendChild(x); return x; };
    if (lauf && lauf.dauer) leiste.appendChild(elem('small', null, 'Done in ' + dauer(lauf.dauer)));
    knopf('Show in folder', () => window.api.studioZeigen(datei));
    if (artVon(datei) === 'bild') {
      knopf('Animate →', () => { sz.felder.video.bild = datei; zeigeStudio('video'); });
      // ein schon vergroessertes Bild nochmal x4 waere riesig (z. B. 21504 × 12288)
      if (!/[\\/]upscale[\\/]/.test(datei)) knopf('Upscale →', () => { sz.felder.upscale.bild = datei; zeigeStudio('upscale'); });
    }
    const weg = knopf('Delete', async () => {
      if (!weg.classList.contains('sicher')) { weg.classList.add('sicher'); weg.textContent = 'Sure?'; return; }
      await window.api.studioWegwerfen(datei);
      sz.auswahl = null;
      hinweis('Moved to the recycle bin');
      ladeStudio();
    });
    buehne.appendChild(leiste);
  } else {
    const l = elem('div', 'chat-leer');
    l.append(elem('b', null, BEREICHE[b].name), elem('span', null, BEREICHE[b].leer));
    buehne.appendChild(l);
  }
  box.appendChild(buehne);

  // Warteschlange + Galerie des Bereichs
  const art = { bild: 'bild', video: 'video', upscale: 'bild', stimme: 'audio' }[b];
  const unter = /[\\/](bild|video|upscale|stimme)[\\/]/;
  const passend = sz.galerie.filter((g) => { const m = unter.exec(g.datei); return m ? m[1] === b : artVon(g.datei) === art; });
  const leiste = elem('div', 's-galerie');
  for (const a of sz.auftraege.values()) {
    if (a.art !== b || a.fertig) continue;
    const k = elem('button', 's-kachel lauf' + (sz.auswahl && sz.auswahl.vorgang === a.vorgang ? ' an' : ''));
    k.dataset.v = a.vorgang;
    k.append(elem('span', null, a.wartet ? '…' : (a.prozent || 0) + '%'));
    k.title = (a.vonAgent ? 'From a coding agent: ' : '') + (a.prompt || '');
    k.addEventListener('click', () => { sz.auswahl = { vorgang: a.vorgang }; zeichneStudio(); });
    leiste.appendChild(k);
  }
  for (const g of passend.slice(0, 60)) {
    const k = elem('button', 's-kachel' + (datei === g.datei ? ' an' : ''));
    k.appendChild(medienElem(g.datei, false));
    k.title = g.datei.split(/[\\/]/).pop();
    k.addEventListener('click', () => { sz.auswahl = { datei: g.datei }; zeichneStudio(); });
    leiste.appendChild(k);
  }
  if (leiste.children.length) box.appendChild(leiste);
}

// ---------- Ereignisse aus dem Hauptprozess ----------
let studioZeichnen = 0;
window.api.onStudio((p) => {
  if (p.vorgang === 'einrichten' || p.vorgang.startsWith('modell:')) {
    sz.laden.set(p.vorgang, { ...(sz.laden.get(p.vorgang) || {}), ...p });
    if (p.fertig) {
      if (p.fehler && p.fehler !== 'cancelled') hinweis(fehlerText(p.fehler));
      else if (!p.fehler) hinweis(p.vorgang === 'einrichten' ? 'Studio is ready' : 'Model ready');
      ladeStudio();
    }
  } else if (p.vorgang.startsWith('auftrag:')) {
    const alt = sz.auftraege.get(p.vorgang) || { start: Date.now() };
    const neu = { ...alt, ...p };
    if (!p.wartet) neu.wartet = false;
    if (alt.wartet && !p.wartet) neu.start = Date.now();
    sz.auftraege.set(p.vorgang, neu);
    if (!alt.vorgang) { const v = document.querySelector('.s-verbessern'); if (v) { v.disabled = true; v.title = 'Available when the current job is done'; } }
    if (p.vonAgent && !alt.vorgang) {
      if (ansicht !== 'studio') hinweis('A coding agent started a Studio job');
      // Auftrag eines Agenten zeigen, wenn gerade nichts Eigenes laeuft
      const l = laufenderAuftrag();
      if (!l || l.fertig) { sz.auswahl = { vorgang: p.vorgang }; if (p.art && BEREICHE[p.art]) sz.bereich = p.art; if (ansicht === 'studio') zeichneStudio(); }
    }
    if (p.fertig) {
      if (p.fehler && p.fehler !== 'cancelled') hinweis(fehlerText(p.fehler));
      else if (!p.fehler && ansicht !== 'studio') hinweis('Studio: ' + (BEREICHE[p.art === 'bild' && /upscale/.test(p.modell || '') ? 'upscale' : p.art] || { name: 'Job' }).name + ' ready');
      ladeStudio();
      return;
    }
  }
  // nicht bei jedem Schritt alles neu zeichnen
  if (ansicht !== 'studio' || Date.now() - studioZeichnen < 250) return;
  studioZeichnen = Date.now();
  if (p.vorgang.startsWith('auftrag:')) aktualisiereLauf();
  else if (p.vorgang.startsWith('modell:') && ladeFortschritt(p.vorgang.slice(7))) return;
  else zeichneStudio();
});
function ladeFortschritt(id) {
  const s = document.querySelector(`#studio-links .s-modell[data-m="${id}"] .s-m-laden`);
  const l = sz.laden.get('modell:' + id);
  if (!s || !l) return false;
  s.querySelector('.s-balken i').style.width = (l.prozent || 0) + '%';
  s.querySelector('small').textContent = l.prozent != null ? l.prozent + '%' : (l.text || 'Installing…').slice(0, 40);
  return true;
}
// Laufzeit im Fortschritt aktuell halten
setInterval(() => { const l = ansicht === 'studio' && laufenderAuftrag(); if (l && !l.fertig) aktualisiereLauf(); }, 1000);
