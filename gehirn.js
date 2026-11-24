// Obsidian-Vault ("Gehirn") fuer Cowork und die Agenten: suchen, lesen, schreiben – ohne Nachfrage.
// Damit trotzdem nichts verloren geht: vor jedem Ueberschreiben, Aendern, Verschieben oder Loeschen legt Glowline
// die alte Fassung in eine Sicherung (30 Tage), geloeschte Notizen landen im .trash des Vaults (wie in Obsidian).
// Suche ohne extra Modell: BM25 ueber Abschnitte der Notizen (schnell, offline, Deutsch + Englisch).
const fs = require('fs');
const path = require('path');
const os = require('os');

let d = null; // { cfg, userData }
function init(x) { d = x; aufraeumen(); }

// ---------- Vaults ----------
// Obsidian merkt sich alle Vaults in %APPDATA%\obsidian\obsidian.json – der zuletzt offene kommt zuerst
function vaults() {
  let roh = {};
  try { roh = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json'), 'utf8')).vaults || {}; } catch {}
  return Object.entries(roh)
    .map(([id, v]) => ({ id, pfad: v && v.path, offen: !!(v && v.open), ts: (v && v.ts) || 0 }))
    .filter((v) => typeof v.pfad === 'string' && fs.existsSync(v.pfad))
    .map((v) => ({ ...v, name: path.basename(v.pfad) }))
    .sort((a, b) => b.offen - a.offen || b.ts - a.ts);
}
// cfg.obsidian: 'auto' (der zuletzt offene Vault) | 'aus' | Ordnerpfad
function aktiv() {
  const w = d ? d.cfg().obsidian : 'aus';
  if (w === 'aus') return null;
  if (w && w !== 'auto') return fs.existsSync(w) ? { pfad: path.resolve(w), name: path.basename(w) } : null;
  const v = vaults()[0];
  return v ? { pfad: path.resolve(v.pfad), name: v.name } : null;
}
function oeffnenUrl(rel) {
  const v = aktiv();
  return v ? `obsidian://open?vault=${encodeURIComponent(v.name)}&file=${encodeURIComponent(rel.replace(/\.md$/i, ''))}` : null;
}

// ---------- Pfade ----------
const relPfad = (v, abs) => path.relative(v.pfad, abs).split(path.sep).join('/');
// nur Notizen im Vault, nichts in versteckten Ordnern (.obsidian, .trash, .git)
function pfad(rel, { md = true } = {}) {
  const v = aktiv();
  if (!v) throw new Error('No Obsidian vault connected – choose one in Glowline (tool menu → Customize → Obsidian).');
  let r = String(rel || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r) throw new Error('Path is empty');
  if (md && !/\.md$/i.test(r)) r += '.md';
  const abs = path.resolve(v.pfad, r);
  if (abs !== v.pfad && !abs.startsWith(v.pfad + path.sep)) throw new Error('Path is outside the vault');
  if (path.relative(v.pfad, abs).split(path.sep).some((t) => t.startsWith('.'))) throw new Error('Hidden folders (.obsidian, .trash …) are off limits');
  return { v, abs, rel: relPfad(v, abs) };
}
function alleNotizen(v) {
  const aus = [];
  const geh = (ordner, tiefe) => {
    if (tiefe > 12 || aus.length >= 5000) return;
    let e = [];
    try { e = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (x.name.startsWith('.') || x.name === 'node_modules') continue;
      const p = path.join(ordner, x.name);
      if (x.isDirectory()) geh(p, tiefe + 1);
      else if (/\.md$/i.test(x.name)) aus.push(p);
    }
  };
  geh(v.pfad, 0);
  return aus;
}

// ---------- Sicherung ----------
const sicherungsOrdner = () => path.join(d.userData, 'gehirn-sicherung');
function sichere(v, abs) {
  if (!fs.existsSync(abs)) return;
  const tag = new Date().toISOString().slice(0, 10);
  let ziel = path.join(sicherungsOrdner(), v.name, tag, path.relative(v.pfad, abs));
  if (fs.existsSync(ziel)) ziel = ziel.replace(/\.md$/i, '') + '.' + new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '.md';
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  fs.copyFileSync(abs, ziel);
}
function aufraeumen() {
  const grenze = Date.now() - 30 * 864e5;
  try {
    for (const v of fs.readdirSync(sicherungsOrdner())) {
      for (const tag of fs.readdirSync(path.join(sicherungsOrdner(), v))) {
        if (/^\d{4}-\d\d-\d\d$/.test(tag) && new Date(tag).getTime() < grenze) fs.rmSync(path.join(sicherungsOrdner(), v, tag), { recursive: true, force: true });
      }
    }
  } catch {}
}

// ---------- Suche (BM25 ueber Abschnitte) ----------
const STOPP = new Set(('der die das den dem des ein eine einen einem einer und oder aber ist sind war wie was wer wo wann warum ich du er sie es wir ihr mir mich dir dich mein dein sein kann koennen soll mit fuer von zu im in am an auf aus bei nach ueber unter nicht noch auch nur schon mal dann wenn als so da hat habe haben wird werden gibt man bitte mach mache machen sag sage erklaer erklaere ' +
  'the a an and or but is are was were be been to of in on at for with from by as it its this that these those i you he she we they me my your what which who how why when where can could should would will do does did not no yes please make tell explain about into than then there here just also').split(' '));
function woerter(t) {
  return String(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ungen|ung|en|er|es|e|s|n)$/, '') : w));
}
function abschnitte(text) {
  const teile = [];
  let kopf = '', puffer = [];
  const weg = () => {
    const t = puffer.join('\n').trim();
    // lange Abschnitte in Stuecke von ~1200 Zeichen (an Absaetzen)
    let s = '';
    for (const absatz of t.split(/\n\s*\n/)) {
      if (s && s.length + absatz.length > 1200) { teile.push({ kopf, text: s }); s = ''; }
      s += (s ? '\n\n' : '') + absatz;
    }
    if (s.trim()) teile.push({ kopf, text: s });
    puffer = [];
  };
  for (const z of String(text).replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const h = /^#{1,6}\s+(.*)/.exec(z);
    if (h) { weg(); kopf = h[1].trim(); }
    puffer.push(z);
  }
  weg();
  return teile;
}
const idx = { vault: null, dateien: new Map(), df: new Map(), anzahl: 0, schnitt: 1, stand: 0 };
function aktualisiere(zwingen) {
  const v = aktiv();
  if (!v) return null;
  if (idx.vault !== v.pfad) Object.assign(idx, { vault: v.pfad, dateien: new Map(), stand: 0 });
  if (!zwingen && Date.now() - idx.stand < 15000) return v;
  const gesehen = new Set();
  let geaendert = false;
  for (const abs of alleNotizen(v)) {
    gesehen.add(abs);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const alt = idx.dateien.get(abs);
    if (alt && alt.mtime === st.mtimeMs) continue;
    if (st.size > 1e6) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const titel = path.basename(abs, '.md');
    const tw = woerter(titel);
    const stuecke = abschnitte(text).map((a) => {
      const w = [...tw, ...tw, ...woerter(a.kopf), ...woerter(a.text)];
      const tf = new Map();
      for (const x of w) tf.set(x, (tf.get(x) || 0) + 1);
      return { kopf: a.kopf, text: a.text, tf, laenge: w.length };
    });
    idx.dateien.set(abs, { mtime: st.mtimeMs, rel: relPfad(v, abs), titel, stuecke, links: [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()) });
    geaendert = true;
  }
  for (const abs of [...idx.dateien.keys()]) if (!gesehen.has(abs)) { idx.dateien.delete(abs); geaendert = true; }
  if (geaendert) {
    idx.df = new Map();
    let summe = 0;
    idx.anzahl = 0;
    for (const f of idx.dateien.values()) {
      for (const s of f.stuecke) {
        idx.anzahl++;
        summe += s.laenge;
        for (const w of s.tf.keys()) idx.df.set(w, (idx.df.get(w) || 0) + 1);
      }
    }
    idx.schnitt = summe / Math.max(1, idx.anzahl);
  }
  idx.stand = Date.now();
  return v;
}
// beste Notizen zu einem Text: [{ rel, titel, kopf, text, punkte, treffer }]
function suche(frage, n = 5) {
  if (!aktualisiere()) return [];
  const q = [...new Set(woerter(frage))].slice(0, 40);
  if (!q.length) return [];
  const idf = (w) => { const df = idx.df.get(w) || 0; return Math.log(1 + (idx.anzahl - df + 0.5) / (df + 0.5)); };
  const beste = new Map(); // datei -> bester Abschnitt
  for (const f of idx.dateien.values()) {
    for (const s of f.stuecke) {
      let p = 0, treffer = 0;
      for (const w of q) {
        const tf = s.tf.get(w);
        if (!tf) continue;
        treffer++;
        p += idf(w) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * s.laenge / idx.schnitt));
      }
      if (!treffer) continue;
      const b = beste.get(f.rel);
      if (!b || p > b.punkte) beste.set(f.rel, { rel: f.rel, titel: f.titel, kopf: s.kopf, text: s.text, punkte: p, treffer, von: q.length });
    }
  }
  return [...beste.values()].sort((a, b) => b.punkte - a.punkte).slice(0, n);
}
// fuer Cowork: passende Notizen als Zusatz fuer den System-Prompt (nur wenn sie wirklich passen)
function kontext(frage) {
  const v = aktiv();
  if (!v || String(frage).trim().length < 8) return null;
  // passt, wenn genug Punkte (grosse Vaults) oder in kleinen Vaults die meisten Suchwoerter vorkommen
  const r = suche(frage, 3).filter((x) => (x.punkte >= 4 || (idx.anzahl < 60 && x.treffer / x.von >= 0.6)) && x.treffer >= Math.min(2, x.von));
  if (!r.length) return null;
  // nur Notizen, die fast so gut passen wie die beste
  const r2 = r.filter((x) => x.punkte >= r[0].punkte * 0.6);
  let platz = 7000;
  const teile = [];
  for (const x of r2) {
    const t = x.text.slice(0, Math.min(2500, platz));
    platz -= t.length;
    teile.push(`### [[${x.titel}]]${x.kopf && x.kopf !== x.titel ? ' › ' + x.kopf : ''}\n${t}`);
    if (platz < 300) break;
  }
  return {
    text: `Notes from the user's Obsidian vault "${v.name}" (their own knowledge base). Use them when they fit the question, prefer them over general knowledge, and name the note as [[Title]] when you use it. Ignore them if they don't fit.\n\n${teile.join('\n\n')}`,
    notizen: r2.slice(0, teile.length).map((x) => ({ rel: x.rel, titel: x.titel })),
  };
}

// ---------- Lesen und Schreiben ----------
function lese(rel) {
  const { abs, rel: r } = pfad(rel);
  if (!fs.existsSync(abs)) {
    // nur der Name? dann irgendwo im Vault suchen (wie [[Link]] in Obsidian)
    aktualisiere();
    const name = path.basename(String(rel), '.md').toLowerCase();
    const f = [...idx.dateien.values()].find((x) => x.titel.toLowerCase() === name);
    if (f) return { rel: f.rel, text: fs.readFileSync(path.join(aktiv().pfad, f.rel), 'utf8') };
    throw new Error(`Note not found: ${r}`);
  }
  return { rel: r, text: fs.readFileSync(abs, 'utf8') };
}
function liste(ordner = '') {
  const v = aktiv();
  if (!v) throw new Error('No Obsidian vault connected');
  const basis = ordner ? pfad(ordner, { md: false }).abs : v.pfad;
  const aus = alleNotizen(v).filter((a) => a === basis || a.startsWith(basis + path.sep)).map((a) => relPfad(v, a)).sort();
  return { vault: v.name, notizen: aus };
}
function fertig() { idx.stand = 0; }
function schreibe(rel, inhalt, ueberschreiben = true) {
  const { v, abs, rel: r } = pfad(rel);
  const da = fs.existsSync(abs);
  if (da && !ueberschreiben) throw new Error(`${r} already exists`);
  if (da) sichere(v, abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(inhalt));
  fertig();
  return { rel: r, neu: !da };
}
function anhaengen(rel, text) {
  const { v, abs, rel: r } = pfad(rel);
  if (fs.existsSync(abs)) sichere(v, abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const alt = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  fs.writeFileSync(abs, alt + (alt && !alt.endsWith('\n') ? '\n' : '') + String(text));
  fertig();
  return { rel: r };
}
function ersetze(rel, alt, neu) {
  const { v, abs, rel: r } = pfad(rel);
  if (!fs.existsSync(abs)) throw new Error(`Note not found: ${r}`);
  const text = fs.readFileSync(abs, 'utf8');
  const n = alt ? text.split(String(alt)).length - 1 : 0;
  if (n !== 1) throw new Error(n ? `The text occurs ${n} times in ${r} – include more context so it is unique` : `The text was not found in ${r} – read the note first and copy the text exactly`);
  sichere(v, abs);
  fs.writeFileSync(abs, text.replace(String(alt), () => String(neu)));
  fertig();
  return { rel: r };
}
// Verschieben/Umbenennen: [[Links]] auf den alten Namen ziehen mit (wie Obsidian selbst)
function verschiebe(von, nach) {
  const a = pfad(von), b = pfad(nach);
  if (!fs.existsSync(a.abs)) throw new Error(`Note not found: ${a.rel}`);
  if (fs.existsSync(b.abs)) throw new Error(`${b.rel} already exists`);
  sichere(a.v, a.abs);
  fs.mkdirSync(path.dirname(b.abs), { recursive: true });
  fs.renameSync(a.abs, b.abs);
  const altName = path.basename(a.abs, '.md'), neuName = path.basename(b.abs, '.md');
  let links = 0;
  if (altName !== neuName) {
    const re = new RegExp(`\\[\\[${altName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\]|#])`, 'g');
    for (const f of alleNotizen(a.v)) {
      let t;
      try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!re.test(t)) continue;
      re.lastIndex = 0;
      sichere(a.v, f);
      fs.writeFileSync(f, t.replace(re, '[[' + neuName));
      links++;
    }
  }
  fertig();
  return { von: a.rel, nach: b.rel, links };
}
// Loeschen = in den Papierkorb des Vaults (.trash), wie "In Obsidian-Papierkorb verschieben"
function loesche(rel) {
  const { v, abs, rel: r } = pfad(rel);
  if (!fs.existsSync(abs)) throw new Error(`Note not found: ${r}`);
  sichere(v, abs);
  const muell = path.join(v.pfad, '.trash');
  fs.mkdirSync(muell, { recursive: true });
  let ziel = path.join(muell, path.basename(abs));
  if (fs.existsSync(ziel)) ziel = ziel.replace(/\.md$/i, '') + ' ' + Date.now() + '.md';
  fs.renameSync(abs, ziel);
  fertig();
  return { rel: r };
}
function links(rel) {
  const { rel: r } = pfad(rel);
  aktualisiere(true);
  const f = [...idx.dateien.values()].find((x) => x.rel === r);
  if (!f) throw new Error(`Note not found: ${r}`);
  const name = f.titel.toLowerCase();
  return { rel: r, ausgehend: [...new Set(f.links)], eingehend: [...idx.dateien.values()].filter((x) => x.links.some((l) => path.basename(l).toLowerCase() === name)).map((x) => x.rel) };
}
// Antwort aus Cowork als Notiz speichern (Ordner "Glowline")
function speichereAntwort(titel, text, modell) {
  const name = String(titel || 'Glowline note').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Glowline note';
  let rel = `Glowline/${name}.md`;
  for (let i = 2; fs.existsSync(pfad(rel).abs); i++) rel = `Glowline/${name} ${i}.md`;
  const kopf = `---\ncreated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\nsource: Glowline${modell ? '\nmodel: ' + JSON.stringify(String(modell)) : ''}\n---\n\n`;
  return schreibe(rel, kopf + String(text).trim() + '\n', false);
}

module.exports = { init, vaults, aktiv, oeffnenUrl, suche, kontext, lese, liste, schreibe, anhaengen, ersetze, verschiebe, loesche, links, speichereAntwort, aktualisiere, woerter };
