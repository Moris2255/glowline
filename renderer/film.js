'use strict';
// Studio → Film: Thema eingeben, Drehbuch schreiben lassen, Szenen anpassen, Film machen (sofort oder nachts).
// Laeuft nach studio.js und nutzt dessen Hilfen (sz, feld, sicherKnopf, nachtBereich, dateiUrl, SPRACHEN …).

const filmZustand = {
  geladen: false, liste: [], film: null, plant: false, bedarf: [],
  neu: { thema: '', laenge: 60, format: 'quer', sprache: /^de/i.test(navigator.language || '') ? 'de' : 'en' },
  lauf: new Map(), // id -> { text, prozent, teil }
  uhr: null,
};
const fz = filmZustand;
const FILM_FEHLT = { studio: 'Set up the Studio', bild: 'Image model', video: 'Video model', stimme: 'Voice' };
const FILM_TAB = { bild: 'bild', video: 'video', stimme: 'stimme' };

async function ladeFilme() {
  const [liste, bedarf] = await Promise.all([window.api.filmListe().catch(() => []), window.api.filmBedarf(fz.film && fz.film.id).catch(() => [])]);
  fz.liste = liste;
  fz.bedarf = bedarf;
  if (fz.film) fz.film = (await window.api.filmLaden(fz.film.id).catch(() => null)) || null;
  fz.geladen = true;
  if (ansicht === 'studio' && sz.bereich === 'film') zeichneStudio();
}
// von Cowork aus: diesen Film oeffnen
async function zeigeFilm(id) {
  fz.film = id ? await window.api.filmLaden(id).catch(() => null) : null;
  await zeigeStudio('film');
  ladeFilme();
}
window.zeigeFilm = zeigeFilm;

const filmLaeuft = (f) => !!f && (fz.lauf.has(f.id) || f.laeuft);
const knopfReihe = (werte, jetzt, an) => {
  const box = elem('div', 's-formate');
  for (const [w, t] of werte) {
    const b = elem('button', w === jetzt ? 'an' : null, t);
    b.addEventListener('click', () => an(w));
    box.appendChild(b);
  }
  return box;
};
const haken = (text, an, wechsel) => {
  const c = elem('label', 's-erlaubt');
  const x = elem('input'); x.type = 'checkbox'; x.checked = !!an;
  x.addEventListener('change', () => wechsel(x.checked));
  c.append(x, elem('span', null, text));
  return c;
};

function zeichneFilm(links, rechts) {
  if (!fz.geladen) { links.append(elem('div', 's-leer', 'Loading…')); ladeFilme(); return; }
  // eigene Filme
  if (fz.liste.length) {
    links.appendChild(elem('div', 's-gruppe', 'Your films'));
    const l = elem('div', 'f-filme');
    const neu = elem('button', 'f-film' + (!fz.film ? ' an' : ''));
    neu.append(elem('b', null, '+ New film'));
    neu.addEventListener('click', () => { fz.film = null; zeichneStudio(); });
    l.appendChild(neu);
    for (const x of fz.liste.slice(0, 12)) {
      const b = elem('button', 'f-film' + (fz.film && fz.film.id === x.id ? ' an' : ''));
      const st = fz.lauf.has(x.id) || x.laeuft ? 'making…' : x.status === 'fertig' ? 'done' : x.status === 'fehler' ? 'failed' : 'script';
      b.append(elem('b', null, x.titel), elem('small', null, `${x.laenge} s · ${x.format === 'hoch' ? '9:16' : '16:9'} · ${st}`));
      b.addEventListener('click', async () => { fz.film = await window.api.filmLaden(x.id).catch(() => null); fz.bedarf = await window.api.filmBedarf(x.id).catch(() => []); zeichneStudio(); });
      l.appendChild(b);
    }
    links.appendChild(l);
  }
  if (fz.film) filmEinstellungen(links, fz.film);
  else filmNeu(links);
  filmRechts(rechts);
}

// ---------- Neuer Film ----------
function filmNeu(box) {
  const n = fz.neu;
  box.appendChild(elem('div', 's-gruppe', 'New film'));
  const t = elem('textarea');
  t.rows = 5; t.dataset.k = 'f-thema'; t.value = n.thema; t.spellcheck = false;
  t.placeholder = 'A hamster builds a rocket because the moon looks like a giant cheese…';
  t.addEventListener('input', () => { n.thema = t.value; const k = $('#film-planen'); if (k) k.disabled = fz.plant || !n.thema.trim(); });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); filmPlanen(); } });
  box.appendChild(feld('What is the film about?', t));
  box.appendChild(feld('Length', knopfReihe([[30, '30 s'], [60, '60 s'], [90, '90 s']], n.laenge, (w) => { n.laenge = w; zeichneStudio(); })));
  box.appendChild(feld('Format', knopfReihe([['quer', '16:9 YouTube'], ['hoch', '9:16 TikTok']], n.format, (w) => { n.format = w; zeichneStudio(); })));
  const sp = elem('select');
  for (const [c, name] of SPRACHEN) { const o = elem('option', null, name); o.value = c; o.selected = c === n.sprache; sp.appendChild(o); }
  sp.addEventListener('change', () => { n.sprache = sp.value; });
  box.appendChild(feld('Narrator language', sp));
  const los = elem('button', 's-los', fz.plant ? 'Writing the script…' : 'Write script');
  los.id = 'film-planen';
  los.disabled = fz.plant || !n.thema.trim();
  los.addEventListener('click', filmPlanen);
  box.appendChild(los);
  box.appendChild(elem('div', 's-fuss', `Your chat model (bottom right) writes ${n.laenge / 5} scenes of 5 seconds – picture, motion and narrator text. You can change everything before the Studio starts.`));
  if (!sz.st.fern) nachtBereich(box);
}

async function filmPlanen() {
  const n = fz.neu;
  if (fz.plant || !n.thema.trim()) return;
  fz.plant = true;
  zeichneStudio();
  try {
    fz.film = await window.api.filmPlanen({ thema: n.thema.trim(), laenge: n.laenge, format: n.format, sprache: n.sprache, modell: chatModell() });
    n.thema = '';
    hinweis('Script ready – change anything you like');
  } catch (e) { hinweis(fehlerText(e)); }
  fz.plant = false;
  await ladeFilme();
}

// ---------- Einstellungen eines Films ----------
// Aenderungen sammeln und kurz nach dem Tippen speichern
function filmAendern(neu, sofort) {
  const f = fz.film;
  if (!f) return;
  Object.assign(f, neu);
  f.offen = { ...(f.offen || {}), ...neu };
  clearTimeout(fz.uhr);
  const senden = async () => {
    const o = f.offen;
    f.offen = null;
    if (!o) return;
    const r = await window.api.filmAendern(f.id, o).catch((e) => { hinweis(fehlerText(e)); return null; });
    if (!r || !fz.film || fz.film.id !== r.id) return;
    // nur neu zeichnen, wenn sich an fertigen Dateien etwas geaendert hat (sonst springt der Cursor)
    const marke = (x) => x.szenen.map((s) => [s.bildDatei, s.videoDatei, s.sprachDatei].map(Boolean).join()).join('|') + x.status + x.probe + x.musik;
    const neuZeichnen = marke(r) !== marke(fz.film) || sofort;
    fz.film = { ...r, offen: fz.film.offen };
    await ladeFilmListe();
    if (neuZeichnen) zeichneStudio();
  };
  if (sofort) senden(); else fz.uhr = setTimeout(senden, 600);
}
async function ladeFilmListe() { fz.liste = await window.api.filmListe().catch(() => fz.liste); }

function filmEinstellungen(box, f) {
  const aus = filmLaeuft(f);
  box.appendChild(elem('div', 's-gruppe', 'Film'));
  const titel = elem('input');
  titel.value = f.titel; titel.dataset.k = 'f-titel'; titel.disabled = aus;
  titel.addEventListener('input', () => filmAendern({ titel: titel.value }));
  box.appendChild(feld('Title', titel));
  const figur = elem('textarea');
  figur.rows = 3; figur.value = f.figur; figur.dataset.k = 'f-figur'; figur.disabled = aus; figur.spellcheck = false;
  figur.placeholder = 'No main character';
  figur.addEventListener('input', () => filmAendern({ figur: figur.value }));
  box.appendChild(feld('Main character (same in every scene)', figur));
  const stil = elem('textarea');
  stil.rows = 2; stil.value = f.stil; stil.dataset.k = 'f-stil'; stil.disabled = aus; stil.spellcheck = false;
  stil.addEventListener('input', () => filmAendern({ stil: stil.value }));
  box.appendChild(feld('Look', stil));
  if (!aus) box.appendChild(feld('Format', knopfReihe([['quer', '16:9 YouTube'], ['hoch', '9:16 TikTok']], f.format, (w) => { if (w !== f.format) filmAendern({ format: w }, true); })));

  // Sprecher + Musik
  box.appendChild(haken('Narrator', f.stimme, (an) => filmAendern({ stimme: an }, true)));
  if (f.stimme) {
    const sp = elem('select');
    sp.disabled = aus;
    for (const [c, name] of SPRACHEN) { const o = elem('option', null, name); o.value = c; o.selected = c === f.sprache; sp.appendChild(o); }
    sp.addEventListener('change', () => filmAendern({ sprache: sp.value }, true));
    box.appendChild(feld('Narrator language', sp));
    box.appendChild(feld('Narrator voice (optional, 5–15 s sample)', filmDatei(f, 'probe', 'Default voice – click to clone one', aus)));
    if (f.probe) box.appendChild(haken('This is my voice, or I have permission to use it.', f.erlaubt, (an) => filmAendern({ erlaubt: an }, true)));
    box.appendChild(haken('Subtitles', f.untertitel, (an) => filmAendern({ untertitel: an }, true)));
  }
  box.appendChild(feld('Music (optional, your own file)', filmDatei(f, 'musik', 'No music – click to add a song', aus)));
  if (f.musik) {
    const r = elem('input');
    r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.05; r.value = f.musikLaut;
    const w = elem('b', null, Math.round(f.musikLaut * 100) + '%');
    r.addEventListener('input', () => { w.textContent = Math.round(r.value * 100) + '%'; filmAendern({ musikLaut: +r.value }); });
    const z = elem('div', 's-regler'); z.append(r, w);
    box.appendChild(feld('Music volume', z));
  }

  // was fehlt noch?
  if (fz.bedarf.length) {
    const b = elem('div', 'f-bedarf');
    b.appendChild(elem('span', null, 'Needs first:'));
    for (const x of fz.bedarf) {
      const k = elem('button', 'm-knopf', FILM_FEHLT[x] + ' →');
      k.addEventListener('click', () => zeigeStudio(FILM_TAB[x] || 'bild'));
      b.appendChild(k);
    }
    box.appendChild(b);
  }
  const grund = fz.bedarf.length ? 'Download the missing models first' : f.stimme && f.probe && !f.erlaubt ? 'Confirm the voice permission first' : !f.szenen.length ? 'Add a scene first' : '';
  if (!aus) {
    const los = elem('button', 's-los', f.status === 'fertig' ? 'Make it again' : f.szenen.some((s) => s.videoDatei) ? 'Continue the film' : 'Make film now');
    los.id = 'film-los';
    los.disabled = !!grund; los.title = grund;
    los.addEventListener('click', () => filmMachen(f));
    box.appendChild(los);
    const n = elem('button', 's-nacht-dazu', 'Add to night queue');
    n.disabled = !!grund; n.title = grund || 'The Studio makes the film tonight – it continues where it stopped';
    n.addEventListener('click', async () => {
      try { nachtStand = await window.api.filmNacht(f.id); hinweis(`Added to the night queue – starts at ${nachtStand.start}`); } catch (e) { hinweis(fehlerText(e)); }
      zeichneNacht();
    });
    box.appendChild(n);
    const leiste = elem('div', 'f-leiste');
    const wuerfeln = elem('button', 'm-knopf', 'New pictures');
    wuerfeln.title = 'Throw away all pictures and videos and make new ones (texts stay)';
    wuerfeln.addEventListener('click', () => filmAendern({ neuWuerfeln: true }, true));
    if (f.szenen.some((s) => s.bildDatei)) leiste.appendChild(wuerfeln);
    leiste.appendChild(sicherKnopf('Delete film', 'filmweg:' + f.id, async () => {
      await window.api.filmLoeschen(f.id).catch(() => {});
      fz.film = null;
      hinweis('Film deleted');
      ladeFilme();
    }));
    box.appendChild(leiste);
  }
  box.appendChild(elem('div', 's-fuss', `Every scene is made on your GPU: a picture, a 5 s video and the narrator, then everything is cut together with ${f.musik ? 'your music, ' : ''}fades${f.stimme && f.untertitel ? ' and subtitles' : ''}. A ${f.szenen.length * 5} s film can take an hour or more – the night queue is ideal. Use only music you are allowed to use.`));
  nachtBereich(box);
}

// Sprachprobe / Musik waehlen
function filmDatei(f, schluessel, leer, aus) {
  const z = elem('div', 's-datei' + (f[schluessel] ? ' voll' : ''));
  if (f[schluessel]) {
    const a = elem('audio'); a.controls = true; a.preload = 'none'; a.src = dateiUrl(f[schluessel]);
    const weg = elem('button', 'm-knopf', 'Remove');
    weg.disabled = aus;
    weg.addEventListener('click', (e) => { e.stopPropagation(); filmAendern({ [schluessel]: null }, true); });
    z.append(a, elem('small', null, f[schluessel].split(/[\\/]/).pop()), weg);
  } else z.append(elem('span', null, leer), elem('small', null, 'wav, mp3, flac, ogg, m4a'));
  z.addEventListener('click', async (e) => {
    if (aus || e.target.closest('button, audio')) return;
    const p = await window.api.studioWaehle('audio');
    if (p) filmAendern({ [schluessel]: p }, true);
  });
  return z;
}

function filmMachen(f) {
  fz.lauf.set(f.id, { text: 'Starting…', prozent: 0 });
  f.status = 'laeuft';
  window.api.filmMachen(f.id);
  zeichneStudio();
}

// ---------- Rechte Seite: Fortschritt, fertiger Film, Szenen ----------
function filmRechts(box) {
  const f = fz.film;
  if (!f) {
    const l = elem('div', 's-buehne');
    const t = elem('div', 'chat-leer');
    t.append(elem('b', null, 'Film maker'), elem('span', null, 'Describe a topic – the Studio plans the scenes, makes pictures and videos, adds a narrator, music and subtitles, and cuts everything into one film.'));
    l.appendChild(t);
    box.appendChild(l);
    return;
  }
  const aus = filmLaeuft(f);
  const lauf = fz.lauf.get(f.id);
  if (aus) {
    const k = elem('div', 'f-lauf');
    k.dataset.id = f.id;
    const kopf = elem('div', 'f-lauf-kopf');
    kopf.append(elem('b', null, (lauf && lauf.text) || 'Working…'), elem('small', null, lauf && lauf.teil ? lauf.teil : ''));
    const bal = elem('div', 's-balken');
    const i = elem('i'); i.style.width = ((lauf && lauf.prozent) || 0) + '%';
    bal.appendChild(i);
    k.append(kopf, bal, sicherKnopf('Cancel', 'filmab:' + f.id, (b) => { b.disabled = true; b.textContent = 'Cancelling…'; window.api.filmAbbrechen(f.id); }));
    box.appendChild(k);
  } else if (f.datei && f.status === 'fertig') {
    const k = elem('div', 'f-ergebnis');
    const v = elem('video');
    v.controls = true; v.preload = 'metadata'; v.src = dateiUrl(f.datei) + '#t=1'; // erstes Bild ist schwarz (Einblenden)
    k.appendChild(v);
    const a = elem('div', 's-aktionen');
    const ordner = elem('button', 'm-knopf', 'Show in folder');
    ordner.addEventListener('click', () => window.api.studioZeigen(f.datei));
    a.appendChild(ordner);
    k.appendChild(a);
    box.appendChild(k);
  } else if (f.fehler) {
    const k = elem('div', 'f-lauf');
    k.append(elem('b', 's-fehler', 'Something went wrong'), elem('small', null, f.fehler));
    box.appendChild(k);
  }

  const liste = elem('div', 'f-szenen');
  f.szenen.forEach((s, i) => liste.appendChild(szeneElem(f, s, i, aus)));
  if (!aus && f.szenen.length < 30) {
    const plus = elem('button', 'f-plus', '+ Add scene');
    plus.addEventListener('click', () => {
      const szenen = [...f.szenen, { nr: Date.now(), bild: '', bewegung: '', text: '' }];
      filmAendern({ szenen }, true);
    });
    liste.appendChild(plus);
  }
  box.appendChild(liste);
}

function szeneElem(f, s, i, aus) {
  const k = elem('div', 'f-szene');
  const bild = elem('div', 'f-bild');
  if (s.videoDatei) { const v = elem('video'); v.src = dateiUrl(s.videoDatei); v.muted = true; v.loop = true; v.autoplay = true; bild.appendChild(v); }
  else if (s.bildDatei) { const im = elem('img'); im.src = dateiUrl(s.bildDatei); bild.appendChild(im); }
  else bild.appendChild(elem('span', null, String(i + 1)));
  if (f.format === 'hoch') bild.classList.add('hoch');
  const rechts = elem('div', 'f-text');
  const kopf = elem('div', 'f-szene-kopf');
  kopf.appendChild(elem('b', null, `Scene ${i + 1}`));
  const marken = elem('small', null, [s.bildDatei && 'picture ✓', s.videoDatei && 'video ✓', f.stimme && s.text && s.sprachDatei && 'voice ✓'].filter(Boolean).join('  ·  '));
  kopf.appendChild(marken);
  if (!aus) {
    const zug = (d) => {
      const szenen = [...f.szenen];
      const [x] = szenen.splice(i, 1);
      szenen.splice(i + d, 0, x);
      filmAendern({ szenen }, true);
    };
    const hoch = elem('button', 'f-mini', '↑'); hoch.title = 'Move up'; hoch.disabled = i === 0; hoch.addEventListener('click', () => zug(-1));
    const runter = elem('button', 'f-mini', '↓'); runter.title = 'Move down'; runter.disabled = i === f.szenen.length - 1; runter.addEventListener('click', () => zug(1));
    const weg = elem('button', 'f-mini', '✕'); weg.title = 'Remove scene'; weg.disabled = f.szenen.length < 2;
    weg.addEventListener('click', () => filmAendern({ szenen: f.szenen.filter((_, j) => j !== i) }, true));
    kopf.append(hoch, runter, weg);
  }
  rechts.appendChild(kopf);
  const textfeld = (schluessel, name, platz, zeilen) => {
    const t = elem('textarea');
    t.rows = zeilen; t.value = s[schluessel] || ''; t.placeholder = platz; t.disabled = aus; t.spellcheck = false;
    t.dataset.k = `f-${schluessel}-${s.nr}`;
    t.addEventListener('input', () => {
      s[schluessel] = t.value;
      filmAendern({ szenen: f.szenen.map((x) => ({ nr: x.nr, bild: x.bild, bewegung: x.bewegung, text: x.text })) });
    });
    const l = elem('label', 'f-zeile');
    l.append(elem('span', null, name), t);
    return l;
  };
  rechts.append(textfeld('bild', 'Picture', 'What the scene shows (English works best)', 2), textfeld('bewegung', 'Motion', 'What moves, camera movement', 1));
  if (f.stimme) rechts.appendChild(textfeld('text', 'Narrator', 'What the narrator says', 1));
  k.append(bild, rechts);
  return k;
}

// ---------- Ereignisse ----------
window.api.onFilm(async (p) => {
  const alt = fz.lauf.get(p.id) || {};
  if (p.fertig) {
    fz.lauf.delete(p.id);
    if (p.fehler && p.fehler !== 'cancelled') hinweis('Film: ' + p.fehler);
    else if (!p.fehler) hinweis('Your film is ready');
    if (fz.film && fz.film.id === p.id) fz.film = await window.api.filmLaden(p.id).catch(() => fz.film);
    await ladeFilmListe();
    if (ansicht === 'studio' && sz.bereich === 'film') zeichneStudio();
    return;
  }
  fz.lauf.set(p.id, { ...alt, text: p.text || alt.text, prozent: p.prozent != null ? p.prozent : alt.prozent, szene: p.szene, teil: p.text !== alt.text ? '' : alt.teil });
  if (ansicht !== 'studio' || sz.bereich !== 'film' || !fz.film || fz.film.id !== p.id) return;
  // neuer Schritt: fertige Szene zeigen (Vorschaubild), sonst nur den Balken bewegen
  if (p.text !== alt.text) { fz.film = await window.api.filmLaden(p.id).catch(() => fz.film); zeichneStudio(); } else filmBalken(p.id);
});
function filmBalken(id) {
  const k = document.querySelector(`.f-lauf[data-id="${id}"]`);
  const l = fz.lauf.get(id);
  if (!k || !l) return;
  k.querySelector('.f-lauf-kopf b').textContent = l.text || 'Working…';
  k.querySelector('.f-lauf-kopf small').textContent = l.teil || '';
  k.querySelector('.s-balken i').style.width = (l.prozent || 0) + '%';
}
// Fortschritt des einzelnen Studio-Auftrags (Bild/Video/Stimme) einer Szene
function filmStudioEreignis(p) {
  const m = /^auftrag:film(f\d+)_/.exec(p.vorgang || '');
  if (!m || p.fertig) return;
  const l = fz.lauf.get(m[1]);
  if (!l) return;
  l.teil = p.wartet ? 'waiting for the GPU…' : p.prozent != null ? `${p.text || 'Generating'} · ${p.prozent} %` : p.text || '';
  filmBalken(m[1]);
}
