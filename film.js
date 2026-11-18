// Filmemacher: Thema -> Drehbuch (Chat-Modell) -> pro Szene Bild, Video, Sprecher (Studio) -> Schnitt (schnitt.py) -> ein MP4.
// Jede Szene merkt sich ihre fertigen Dateien: nach Abbruch, Absturz oder Nachtende geht es dort weiter, wo es aufgehoert hat.
// Ein Film liegt in <ordner>/<id>/film.json, die Zwischendateien daneben. Der fertige Film kommt in die Studio-Galerie.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const LAENGEN = [30, 60, 90];
const SZENE_S = 5;
const MASS = { quer: { bild: [1280, 704], video: [1280, 704] }, hoch: { bild: [704, 1280], video: [704, 1280] } }; // Bild gleich im Videoformat: nichts wird beim Animieren abgeschnitten
const SPRACHE = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', tr: 'Turkish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese' };
const NEGATIV = 'blurry, low quality, distorted face, extra limbs, text, watermark, static, flicker';

const FEHLT = { studio: 'the Studio', bild: 'an image model (Studio → Images)', video: 'the video model (Studio → Video)', stimme: 'the voice (Studio → Voice)', referenz: 'FLUX.2 klein for the character picture (Studio → Images)' };

let d = null; // { ordner, ausgabe(), studio, frage, rollen, sende, vramFrei, test, verschieben }
const laeuft = new Map(); // id -> { ac, teil, proz }
const eigene = new Set(); // selbst gewaehlte Sprachprobe/Musik der Filme (Vorschau auch nach einem Neustart)
const merkeEigene = (f) => { for (const k of ['probe', 'musik', 'figurBild']) if (typeof f[k] === 'string' && f[k]) eigene.add(path.resolve(f[k])); };

function init(x) {
  d = x;
  fs.mkdirSync(d.ordner, { recursive: true });
  // nach einem Absturz: "laeuft" gibt es nicht mehr
  for (const f of alle()) {
    merkeEigene(f);
    if (f.status === 'laeuft' || f.status === 'wartet') { f.status = f.datei ? 'fertig' : 'entwurf'; speichere(f); }
  }
}

const gueltig = (id) => typeof id === 'string' && /^f\d{6,20}$/.test(id);
const ordnerVon = (id) => path.join(d.ordner, id);
function lade(id) {
  if (!gueltig(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ordnerVon(id), 'film.json'), 'utf8')); } catch { return null; }
}
function speichere(f) {
  fs.mkdirSync(ordnerVon(f.id), { recursive: true });
  const z = path.join(ordnerVon(f.id), 'film.json');
  fs.writeFileSync(z + '.tmp', JSON.stringify(f, null, 1));
  fs.renameSync(z + '.tmp', z);
}
function alle() {
  let l = [];
  try { l = fs.readdirSync(d.ordner).filter(gueltig); } catch {}
  return l.map(lade).filter(Boolean).sort((a, b) => b.zeit - a.zeit);
}
const da = (f) => !!f && fs.existsSync(f);
// was der Bildschirm braucht (mit "fertig"-Haken pro Szene)
function sicht(f) {
  if (!f) return null;
  return {
    ...f,
    laeuft: laeuft.has(f.id),
    szenen: f.szenen.map((s) => ({ ...s, bildDatei: da(s.bildDatei) ? s.bildDatei : null, videoDatei: da(s.videoDatei) ? s.videoDatei : null, sprachDatei: da(s.sprachDatei) ? s.sprachDatei : null })),
    datei: da(f.datei) ? f.datei : null,
    figurBild: da(f.figurBild) ? f.figurBild : null,
  };
}
const liste = () => alle().map((f) => ({ id: f.id, titel: f.titel, status: f.status, laenge: f.szenen.length * SZENE_S, format: f.format, zeit: f.zeit, datei: da(f.datei) ? f.datei : null, laeuft: laeuft.has(f.id) }));
const melde = (f, x) => d.sende('film', { id: f.id, status: f.status, ...x });
// nur Dateien, die zu einem Film gehoeren (fuer glowline://datei)
const inOrdner = (datei) => {
  if (typeof datei !== 'string' || !datei || !d) return false;
  if (eigene.has(path.resolve(datei))) return true;
  const r = path.relative(d.ordner, path.resolve(datei));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

// ---------- Drehbuch ----------
const DREHBUCH = (n, sprache) => `You are the director of a short AI-generated film. Plan a film about the user's topic.
The film has exactly ${n} scenes, each exactly 5 seconds long. Answer with one JSON object only – no markdown, no comments:
{"title": "...", "character": "...", "style": "...", "scenes": [{"image": "...", "motion": "...", "narration": "..."}]}
Rules:
- title: a short, catchy film title in ${SPRACHE[sprache] || 'English'}.
- character: the look of the main character in English, 15-30 words: who or what it is, age, body, clothing, colors, one distinctive detail. Every scene must show the SAME character, so be concrete. Use "" if the film has no main character (for example a nature or city film).
- style: the visual style in English, 8-15 words, the same for the whole film (for example "cinematic photo, golden hour light, shallow depth of field" or "3D animated movie style, soft colors, cute").
- image: English, 25-45 words. The first frame of the scene: setting, what the character is doing, shot size (wide shot, close-up …). Call the main character by a short name like "the hamster", never repeat the full character description. No text, letters or logos.
- motion: English, 10-25 words. What moves during the 5 seconds: one clear action and one camera movement (slow push-in, pan left, tracking shot …).
- narration: what the narrator says in ${SPRACHE[sprache] || 'English'}, 6-14 words, one or two natural spoken sentences. Numbers as words, no emojis.
- Together the narrations tell one story with a clear beginning, a surprise or turning point, and a satisfying ending. Vary the shots: wide, medium, close-up.`;

function ausJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/```(json)?/gi, '');
  const a = t.indexOf('{'), e = t.lastIndexOf('}');
  if (a < 0 || e <= a) return null;
  try { return JSON.parse(t.slice(a, e + 1)); } catch {}
  // kleine Modelle: haengende Kommas oder Zeilenumbrueche in Strings
  try { return JSON.parse(t.slice(a, e + 1).replace(/,\s*([}\]])/g, '$1').replace(/[\r\n]+/g, ' ')); } catch { return null; }
}
const text = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);

function ausPlan(j, n) {
  if (!j || typeof j !== 'object') return null;
  const roh = Array.isArray(j.scenes) ? j.scenes : Array.isArray(j.szenen) ? j.szenen : null;
  if (!roh) return null;
  const szenen = roh.filter((s) => s && typeof s === 'object').slice(0, n).map((s) => ({
    bild: text(s.image || s.bild || s.prompt, 600), bewegung: text(s.motion || s.bewegung, 400), text: text(s.narration || s.text || s.sprecher, 400),
  })).filter((s) => s.bild);
  if (szenen.length < Math.max(2, Math.ceil(n / 2))) return null;
  return { titel: text(j.title || j.titel, 80) || 'My film', figur: text(j.character || j.figur, 500), stil: text(j.style || j.stil, 300), szenen };
}

async function planen(o) {
  const laenge = LAENGEN.includes(+o.laenge) ? +o.laenge : 60;
  const n = laenge / SZENE_S;
  const sprache = SPRACHE[o.sprache] ? o.sprache : 'en';
  const thema = text(o.thema, 2000);
  if (!thema) throw new Error('Describe what the film is about');
  let modell = String(o.modell || '');
  if (!modell && d.rollen) { const r = await d.rollen().catch(() => null); modell = (r && ((r.denker && r.denker.id) || (r.schnell && r.schnell.id))) || ''; }
  if (!modell && !(d.test && process.env.GLOWLINE_TEST_FILM_ANTWORT)) throw new Error('Pick a chat model first (bottom right)');
  const ac = new AbortController();
  const uhr = setTimeout(() => ac.abort(), 300000);
  if (o.signal) o.signal.addEventListener('abort', () => ac.abort(), { once: true });
  const system = DREHBUCH(n, sprache);
  const msgs = [{ role: 'user', content: 'Topic: ' + thema }];
  let plan = null, antwort = '';
  try {
    for (let versuch = 0; versuch < 2 && !plan; versuch++) {
      // Test: Antwort des Sprachmodells aus einer Datei
      if (d.test && process.env.GLOWLINE_TEST_FILM_ANTWORT) antwort = fs.readFileSync(process.env.GLOWLINE_TEST_FILM_ANTWORT, 'utf8');
      else antwort = await d.frage(modell, system, versuch ? [...msgs, { role: 'assistant', content: antwort.slice(0, 4000) }, { role: 'user', content: 'That was not valid JSON with ' + n + ' scenes. Answer again with the JSON object only.' }] : msgs, 220 * n + 400, ac.signal);
      plan = ausPlan(ausJson(antwort), n);
    }
  } finally { clearTimeout(uhr); }
  if (!plan) throw new Error(ac.signal.aborted ? 'The chat model took too long' : 'The chat model did not write a usable script – try again or pick a bigger model');
  const f = {
    id: 'f' + Date.now(), zeit: Date.now(), thema, laenge, sprache, format: o.format === 'hoch' ? 'hoch' : 'quer',
    ...plan, seed: Math.floor(Math.random() * 1e9),
    stimme: true, probe: null, erlaubt: false, figurBild: null, musik: null, musikLaut: 0.35, untertitel: true,
    status: 'entwurf', fehler: null, datei: null,
  };
  f.szenen = f.szenen.map((s, i) => ({ nr: f.zeit + i + 1, ...s, bildDatei: null, videoDatei: null, sprachDatei: null }));
  speichere(f);
  return sicht(f);
}

// ---------- Aendern ----------
// Geaenderte Texte machen die passenden Zwischendateien ungueltig (Bild -> auch Video)
function aendern(id, neu) {
  const f = lade(id);
  if (!f || laeuft.has(id) || !neu || typeof neu !== 'object') return sicht(f);
  const weg = (s, was) => { for (const k of was) { if (s[k]) fs.rmSync(s[k], { force: true }); s[k] = null; } };
  const alleBilder = (neu.figur != null && text(neu.figur, 500) !== f.figur) || (neu.stil != null && text(neu.stil, 300) !== f.stil) || (neu.format && neu.format !== f.format);
  if (neu.titel != null) f.titel = text(neu.titel, 80) || f.titel;
  if (neu.figur != null) f.figur = text(neu.figur, 500);
  if (neu.stil != null) f.stil = text(neu.stil, 300);
  if (neu.format === 'quer' || neu.format === 'hoch') f.format = neu.format;
  if (alleBilder) for (const s of f.szenen) weg(s, ['bildDatei', 'videoDatei']);
  if (SPRACHE[neu.sprache] && neu.sprache !== f.sprache) { f.sprache = neu.sprache; for (const s of f.szenen) weg(s, ['sprachDatei']); }
  for (const k of ['stimme', 'untertitel', 'erlaubt']) if (typeof neu[k] === 'boolean') f[k] = neu[k];
  if (neu.probe !== undefined && neu.probe !== f.probe) {
    if (neu.probe === null || (d.erlaubt && d.erlaubt(neu.probe))) { f.probe = neu.probe; f.erlaubt = false; for (const s of f.szenen) weg(s, ['sprachDatei']); }
  }
  if (neu.musik !== undefined && (neu.musik === null || (d.erlaubt && d.erlaubt(neu.musik)))) f.musik = neu.musik;
  // Bild der Hauptfigur: alle Bilder (und Videos) passen danach nicht mehr
  if (neu.figurBild !== undefined && (neu.figurBild || null) !== (f.figurBild || null) && (neu.figurBild === null || (d.erlaubt && d.erlaubt(neu.figurBild) && /\.(png|jpe?g|webp)$/i.test(neu.figurBild)))) {
    f.figurBild = neu.figurBild;
    for (const s of f.szenen) weg(s, ['bildDatei', 'videoDatei']);
  }
  if (Number.isFinite(+neu.musikLaut) && neu.musikLaut !== null) f.musikLaut = Math.min(1, Math.max(0, +neu.musikLaut));
  if (Array.isArray(neu.szenen)) {
    const alt = f.szenen;
    f.szenen = neu.szenen.slice(0, 30).filter((s) => s && typeof s === 'object').map((s) => {
      // vorhandene Szene (gleiche nr) behalten, sonst neu
      const a = alt.find((x) => x.nr && x.nr === s.nr) || null;
      const n = { nr: (a && a.nr) || s.nr || Date.now() + Math.random(), bild: text(s.bild, 600), bewegung: text(s.bewegung, 400), text: text(s.text, 400), bildDatei: null, videoDatei: null, sprachDatei: null };
      if (a) {
        n.bildDatei = n.bild === a.bild ? a.bildDatei : null;
        n.videoDatei = n.bildDatei && n.bewegung === a.bewegung ? a.videoDatei : null;
        n.sprachDatei = n.text === a.text ? a.sprachDatei : null;
        for (const k of ['bildDatei', 'videoDatei', 'sprachDatei']) if (a[k] && a[k] !== n[k]) fs.rmSync(a[k], { force: true });
      }
      return n;
    });
    for (const a of alt) if (!f.szenen.some((s) => s.nr === a.nr)) for (const k of ['bildDatei', 'videoDatei', 'sprachDatei']) if (a[k]) fs.rmSync(a[k], { force: true });
  }
  // neu wuerfeln: alle Bilder (und damit Videos) nochmal
  if (neu.neuWuerfeln) { f.seed = Math.floor(Math.random() * 1e9); for (const s of f.szenen) weg(s, ['bildDatei', 'videoDatei']); }
  if (f.status === 'fertig' || f.status === 'fehler') { f.status = 'entwurf'; f.fehler = null; }
  merkeEigene(f);
  speichere(f);
  return sicht(f);
}
// alte Szenen haben noch keine nr (Plan von planen()): einmal vergeben
function nummern(f) { let g = false; f.szenen.forEach((s, i) => { if (!s.nr) { s.nr = f.zeit + i + 1; g = true; } }); return g; }

function loeschen(id) {
  if (!gueltig(id) || laeuft.has(id)) return false;
  fs.rmSync(ordnerVon(id), { recursive: true, force: true });
  return true;
}

// ---------- Machen ----------
function modellFuer(st, art, wunsch) {
  const l = Object.values(st.modelle || {}).filter((m) => m.art === art && m.da && !m.wolke);
  return l.find((m) => m.id === wunsch) || (art === 'bild' && (l.find((m) => m.id === 'z-image') || l.find((m) => m.id === 'flux2-klein'))) || l[0] || null;
}
// was fuer einen Film noch fehlt (Modelle)
function bedarf(f) {
  const st = d.studio.status();
  const std = d.cfg ? d.cfg().studioStandard || {} : {};
  const fehlt = [];
  if (!st.eingerichtet) fehlt.push('studio');
  const m = { bild: modellFuer(st, 'bild', std.bild), video: modellFuer(st, 'video', std.video), stimme: modellFuer(st, 'stimme', std.stimme) };
  // mit Bild der Hauptfigur: nur ein Bildmodell, das Referenzbilder versteht (FLUX.2 klein)
  if (f && da(f.figurBild)) {
    m.bild = Object.values(st.modelle || {}).find((x) => x.art === 'bild' && x.da && !x.wolke && x.referenz) || null;
    if (!m.bild) fehlt.push('referenz');
  } else if (!m.bild) fehlt.push('bild');
  if (!m.video) fehlt.push('video');
  if ((!f || f.stimme) && !m.stimme) fehlt.push('stimme');
  return { fehlt, m };
}

// Datei aus der Studio-Ausgabe in den Filmordner holen (Test-Attrappe: nur kopieren, das sind echte Galerie-Dateien)
function uebernehme(f, quelle, name) {
  const ziel = path.join(ordnerVon(f.id), name + '_' + Date.now() + path.extname(quelle).toLowerCase());
  if (d.verschieben) {
    try { fs.renameSync(quelle, ziel); return ziel; } catch {}
    fs.copyFileSync(quelle, ziel);
    fs.rmSync(quelle, { force: true });
  } else fs.copyFileSync(quelle, ziel);
  return ziel;
}

const bildPrompt = (f, s) => [s.bild, da(f.figurBild) ? `The main character is exactly the character from the reference image – same face, body, clothing and colors${f.figur ? ` (${f.figur})` : ''}.` : f.figur && `Main character: ${f.figur}.`, f.stil && `Style: ${f.stil}.`].filter(Boolean).join(' ');
const videoPrompt = (f, s) => [s.bild, s.bewegung, f.figur && `The main character: ${f.figur}.`, f.stil].filter(Boolean).join(' ');

// o.wennNoetig (Nacht-Warteschlange): ein schon fertiger, seitdem unveraenderter Film wird nicht nochmal geschnitten
async function machen(id, o = {}) {
  const f = lade(id);
  if (!f) return { fehler: 'Film not found' };
  if (laeuft.has(id)) return { fehler: 'This film is already being made' };
  if (o.wennNoetig && f.status === 'fertig' && da(f.datei)) return { dateien: [f.datei] };
  nummern(f);
  const { fehlt, m } = bedarf(f);
  const nein = (fehler) => { melde(f, { fertig: true, fehler }); return { fehler }; };
  if (fehlt.length) return nein('Set up first: ' + fehlt.map((x) => FEHLT[x]).join(', '));
  if (f.stimme && f.probe && !f.erlaubt) return nein('Confirm the voice permission first');
  if (!f.szenen.length) return nein('The film has no scenes');
  const ac = new AbortController();
  const lauf = { ac, teil: null, proz: null };
  laeuft.set(id, lauf);
  f.status = 'laeuft';
  f.fehler = null;
  speichere(f);
  const n = f.szenen.length;
  const mass = MASS[f.format] || MASS.quer;
  const sprechen = f.stimme ? f.szenen.filter((s) => s.text).length : 0;
  const gesamt = n * 2 + sprechen + 2; // Bilder, Videos, Sprecher, Schnitt zaehlt doppelt
  let erledigt = 0;
  const schritt = (txt, szene) => melde(f, { text: txt, szene, prozent: Math.round((erledigt / gesamt) * 100) });
  const auftrag = async (a, nr) => {
    if (ac.signal.aborted) throw new Error('cancelled');
    const jid = `film${id}_${nr}_${Date.now()}`;
    lauf.teil = 'auftrag:' + jid;
    const r = await d.studio.auftrag({ ...a, id: jid, vonFilm: true }, d.vramFrei);
    lauf.teil = null;
    if (r.fehler) throw new Error(r.fehler);
    if (!r.dateien || !r.dateien[0]) throw new Error('The Studio saved no file');
    return r.dateien[0];
  };
  try {
    // erst alle Bilder, dann alle Videos, dann die Stimme: so laedt die Grafikkarte jedes Modell nur einmal
    for (const [i, s] of f.szenen.entries()) {
      if (!da(s.bildDatei)) {
        schritt(`Scene ${i + 1} of ${n}: image`, i);
        const datei = await auftrag({ modell: m.bild.id, prompt: bildPrompt(f, s), breite: mass.bild[0], hoehe: mass.bild[1], seed: String(f.seed), bildDatei: da(f.figurBild) ? f.figurBild : undefined }, 'b' + i);
        s.bildDatei = uebernehme(f, datei, `szene${i + 1}_bild`);
        s.videoDatei = null;
        speichere(f);
      }
      erledigt++;
    }
    for (const [i, s] of f.szenen.entries()) {
      if (!da(s.videoDatei)) {
        schritt(`Scene ${i + 1} of ${n}: video`, i);
        const datei = await auftrag({ modell: m.video.id, prompt: videoPrompt(f, s), negativ: NEGATIV, breite: mass.video[0], hoehe: mass.video[1], sekunden: SZENE_S, bildDatei: s.bildDatei }, 'v' + i);
        s.videoDatei = uebernehme(f, datei, `szene${i + 1}_video`);
        speichere(f);
      }
      erledigt++;
    }
    if (f.stimme) {
      for (const [i, s] of f.szenen.entries()) {
        if (!s.text) continue;
        if (!da(s.sprachDatei)) {
          schritt(`Scene ${i + 1} of ${n}: narrator`, i);
          const datei = await auftrag({ modell: m.stimme.id, prompt: s.text, sprache: f.sprache, bildDatei: f.probe || undefined, ausdruck: 0.5 }, 's' + i);
          s.sprachDatei = uebernehme(f, datei, `szene${i + 1}_sprecher`);
          speichere(f);
        }
        erledigt++;
      }
    }
    schritt('Editing the film', null);
    f.datei = await schneiden(f, lauf, (p) => melde(f, { text: 'Editing the film', prozent: Math.round(((erledigt + (2 * p) / 100) / gesamt) * 100) }));
    f.status = 'fertig';
    speichere(f);
    melde(f, { fertig: true, prozent: 100, datei: f.datei });
    return { dateien: [f.datei] };
  } catch (e) {
    const abbruch = ac.signal.aborted || /cancel/i.test(String(e && e.message));
    f.status = abbruch ? 'entwurf' : 'fehler';
    f.fehler = abbruch ? null : String((e && e.message) || e).slice(0, 300);
    speichere(f);
    melde(f, { fertig: true, fehler: abbruch ? 'cancelled' : f.fehler });
    return { fehler: abbruch ? 'cancelled' : f.fehler };
  } finally {
    laeuft.delete(id);
  }
}

function schnittSkript() {
  return path.join(__dirname, 'schnitt.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}
const sauberName = (t) => String(t || 'Film').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'Film';

function schneiden(f, lauf, fortschritt) {
  const mass = MASS[f.format] || MASS.quer;
  const ziel = d.test ? path.join(ordnerVon(f.id), 'film.mp4') : path.join(d.ausgabe(), 'Filme', `${sauberName(f.titel)}_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.mp4`);
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  const schrift = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeuib.ttf');
  const auftrag = {
    ausgabe: ziel, breite: mass.video[0], hoehe: mass.video[1], fps: 24, uebergang: 0.4,
    musik: da(f.musik) ? f.musik : null, musikLaut: f.stimme ? f.musikLaut : Math.min(1, f.musikLaut * 2),
    untertitel: !!(f.untertitel && f.stimme), schrift: da(schrift) ? schrift : null,
    szenen: f.szenen.map((s) => ({ video: s.videoDatei, sprache: f.stimme && da(s.sprachDatei) ? s.sprachDatei : null, text: f.stimme ? s.text : '' })),
  };
  const aj = path.join(ordnerVon(f.id), 'schnitt.json');
  fs.writeFileSync(aj, JSON.stringify(auftrag));
  return new Promise((ok, nein) => {
    if (lauf.ac.signal.aborted) { nein(new Error('cancelled')); return; }
    const py = d.python();
    if (!da(py)) { nein(new Error('The Studio engine is not set up')); return; }
    const p = spawn(py, ['-I', schnittSkript(), aj], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    lauf.proz = p;
    let rest = '', err = '', ergebnis = null;
    p.stdout.on('data', (x) => {
      rest += x;
      const z = rest.split(/\r?\n/);
      rest = z.pop();
      for (const l of z) {
        const m = /^P (\d+)/.exec(l);
        if (m) fortschritt(+m[1]);
        else if (l.startsWith('{')) { try { ergebnis = JSON.parse(l); } catch {} }
      }
    });
    p.stderr.on('data', (x) => { err = (err + x).slice(-1500); });
    const stopp = () => { try { p.kill(); } catch {} };
    lauf.ac.signal.addEventListener('abort', stopp, { once: true });
    p.on('error', (e) => nein(e));
    p.on('exit', (c) => {
      lauf.proz = null;
      lauf.ac.signal.removeEventListener('abort', stopp);
      fs.rmSync(ziel + '.part.mp4', { force: true });
      if (lauf.ac.signal.aborted) return nein(new Error('cancelled'));
      if (c === 0 && ergebnis && da(ergebnis.datei)) return ok(ergebnis.datei);
      const zeile = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'exit ' + c;
      nein(new Error('Editing failed: ' + zeile.slice(0, 200)));
    });
  });
}

function abbrechen(id) {
  const l = laeuft.get(id);
  if (!l) return;
  l.ac.abort();
  if (l.teil) d.studio.abbrechen(l.teil);
  if (l.proz) try { l.proz.kill(); } catch {}
}
function stoppen() { for (const id of laeuft.keys()) abbrechen(id); }

module.exports = { init, planen, aendern, loeschen, machen, abbrechen, stoppen, laeuftGerade: (id) => laeuft.has(String(id)), lade: (id) => sicht(lade(id)), liste, bedarf: (id) => bedarf(lade(id)).fehlt, inOrdner, ausPlan, ausJson, LAENGEN, SZENE_S };
