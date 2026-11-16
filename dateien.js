// Cowork legt Dateien auf dem PC an: "Erstelle auf meinem Desktop eine HTML-Datei mit einem kleinen Spiel".
// Das Coder-Modell schreibt den Inhalt, Glowline speichert ihn (nur im eigenen Benutzerordner, nichts wird ausgefuehrt).
const fs = require('fs');
const path = require('path');
const os = require('os');

// nur wenn so etwas in der Nachricht steht, fragen wir ueberhaupt nach
const WORTE = /(datei|\bfiles?\b|\.(html?|css|js|ts|py|txt|md|json|csv|xml|svg|java|cpp|cs|go|rs|php|sh|lua|ini|yaml|yml)\b|desktop|schreibtisch|speicher|\bsave\b|\blege? .{0,60}\ban\b|ordner|folder|dokumente|documents|downloads)/i;
const PRUEFEN = `Does the user's LAST message ask you to create, write or save a file on their computer (for example "make an HTML file on my desktop with a game", "save this as a Python file")? Questions ABOUT files, or wanting code shown in the chat only, are not. Answer with exactly one word: yes or no.`;
const FOLGE = (name) => `The assistant just created the file "${name}" on the user's computer. Does the user's message ask for a change or fix to that file (for example "make it faster", "add a score", "the button doesn't work")? Answer with exactly one word: yes or no.`;
const NICHT_FOLGE = /^(was|wie|warum|wieso|weshalb|wer|wo|wann|welche\w*|what|how|why|who|where|when|which)\b|danke|thanks|thank you|witz|joke|[üu]bersetz|translate/i;

const ORDNER = [
  [/desktop|schreibtisch/i, 'desktop', 'Desktop'],
  [/dokumente|documents/i, 'documents', 'Documents'],
  [/downloads?\b/i, 'downloads', 'Downloads'],
  [/\bbilder\b|\bpictures\b/i, 'pictures', 'Pictures'],
  [/\bmusik\b|\bmusic\b/i, 'music', 'Music'],
  [/(in|im|to|into) (den |dem |my |meine[nm]? )?(videos?-?ordner|videos\b)/i, 'videos', 'Videos'],
];
// Dateien, die Windows beim Doppelklick ausfuehrt, bekommen .txt dran
const GESPERRT = /\.(exe|com|scr|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|jse|wsf|wsh|hta|lnk|reg|pif|cpl|inf|scf|url|dll|sys)$/i;
const RESERVIERT = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
// diese Dateien kann man gefahrlos "oeffnen" (Browser/Editor/Bildbetrachter) – Skripte nur im Ordner zeigen
const ANSEHEN = /\.(html?|txt|md|json|csv|xml|svg|css|png|jpe?g|webp|gif|log|ini|yaml|yml)$/i;
const ENDUNG = { html: 'html', htm: 'html', python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', css: 'css', json: 'json', markdown: 'md', md: 'md', text: 'txt', txt: 'txt', plaintext: 'txt', svg: 'svg', xml: 'xml', csv: 'csv', java: 'java', cpp: 'cpp', 'c++': 'cpp', c: 'c', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', php: 'php', bash: 'sh', sh: 'sh', lua: 'lua', yaml: 'yml', yml: 'yml', ini: 'ini' };
const MAX = 2 * 1024 * 1024;

const SYSTEM = (bearbeite) => `You can save files on the user's computer – Glowline writes them for you. Answer in exactly this format:
FILE: <file name with extension>
\`\`\`<language>
<the complete file content>
\`\`\`
Rules:
- Write the COMPLETE, working file. No placeholders, no "...", no "rest stays the same".
- A web page, app or browser game goes into ONE .html file with the CSS and JavaScript inside.
- Short lowercase file name with dashes, e.g. jump-game.html.
- Only if several files are really needed: repeat FILE: and the code block for each (at most 5).
- After the code block(s) write ONE short sentence in the user's language on how to use it. Nothing before FILE:.
- Glowline saves the file automatically – never tell the user to save or copy it.` +
  (bearbeite ? `\nYou are changing the existing file "${bearbeite}". Keep the same FILE name and output the whole new file with the change applied.` : '');

const zuHause = () => path.resolve(os.homedir());
// nur im eigenen Benutzerordner, nicht in AppData oder versteckten Ordnern (.ssh usw.)
function erlaubterOrt(p) {
  const r = path.resolve(p);
  const h = zuHause();
  if (r.toLowerCase() !== h.toLowerCase() && !r.toLowerCase().startsWith(h.toLowerCase() + path.sep)) return false;
  return !path.relative(h, r).split(path.sep).some((t) => /^appdata$/i.test(t) || t.startsWith('.'));
}

// Zielordner: genannter Pfad, bekannter Ordner (Desktop, Dokumente …) oder der Desktop
function ordnerFuer(text, holePfad) {
  const m = /\b[a-z]:\\[^\n"'<>|*?]*/i.exec(text);
  if (m) {
    let p = m[0].replace(/[\s.,;:!)]+$/, '');
    // "C:\Users\x\Projekte\Spiel erstelle eine Datei" -> den laengsten vorhandenen Ordner nehmen
    while (p.length > 3 && !(fs.existsSync(p) && fs.statSync(p).isDirectory())) p = p.replace(/[\s\\][^\s\\]*$/, '');
    if (p.length > 3 && erlaubterOrt(p)) return { ordner: path.resolve(p), name: path.basename(p) };
  }
  for (const [re, art, name] of ORDNER) if (re.test(text)) return { ordner: holePfad(art), name };
  return { ordner: holePfad('desktop'), name: 'Desktop' };
}

// Ist das ein Datei-Auftrag? -> { ordner, name, bearbeite } oder null
let holePfad = (art) => path.join(zuHause(), art === 'desktop' ? 'Desktop' : art);
function init(f) { holePfad = f; } // Electron: app.getPath (kennt auch den OneDrive-Desktop)

// kleine Modelle antworten gern auf Deutsch ("Ja. Ich kann …") oder reden los: darum Eindeutiges per Regel
const TUN = /\b(erstell|mach|schreib|leg|speicher|sicher|programmier|bau|generier|erzeug|create|make|write|save|build|generate|put|store|code)\w*/i;
const DATEI = /(datei|dokument|\bfiles?\b|\.(html?|css|js|ts|py|txt|md|json|csv|xml|svg|java|cpp|cs|go|rs|php|sh|lua|ini|ya?ml)\b|\b(auf|in|an) (den |dem |meinen |meinem |meine |die )?(desktop|schreibtisch|dokumente|downloads)\b|\b(on|to|in|into) (my |the )?(desktop|documents|downloads)\b)/i;
const FRAGE = /^(was|wie|warum|wieso|weshalb|wer|wo|wann|welche\w*|what|how|why|who|where|when|which|erkl[äa]r\w*|explain)\b/i;
const AENDERN = /\b(mach|[äa]nder|f[üu]g|setz|füge|entfern|l[öo]sch|tausch|ersetz|verbesser|fix|repar|make|change|add|remove|replace|improve|turn|set|use)\w*|\b(schneller|langsamer|gr[öo]ßer|kleiner|bunter|faster|slower|bigger|smaller|rot|blau|gr[üu]n|gelb|schwarz|wei[ßs]|red|blue|green|yellow|black|white)\b/i;
const jaNein = (a) => /^\W*(yes|ja)\b/i.test(a);
const frageText = (t) => `Message: "${t}"\nAnswer with yes or no only.`;

async function pruefe({ text, letzteDatei, frage, erzwinge }) {
  if (erzwinge) return { ...ordnerFuer(text, holePfad), bearbeite: null };
  if (WORTE.test(text)) {
    const klar = TUN.test(text) && DATEI.test(text) && !FRAGE.test(text.trim());
    if (klar || jaNein(await frage(PRUEFEN, [{ role: 'user', content: frageText(text) }], 4).catch(() => ''))) {
      // "aender die Datei auf dem Desktop": wenn kein neuer Ort genannt ist, die letzte Datei bearbeiten
      const neu = /\b(neue|new|another|noch eine|zweite|second)\b/i.test(text);
      const genannt = /\b[a-z]:\\/i.test(text) || ORDNER.some(([re]) => re.test(text));
      if (letzteDatei && !neu && !genannt && /\b(die|diese|the|this|that|meine|my)\s+(datei|file)\b/i.test(text)) return { ordner: path.dirname(letzteDatei), name: path.basename(path.dirname(letzteDatei)), bearbeite: letzteDatei };
      return { ...ordnerFuer(text, holePfad), bearbeite: null };
    }
    if (!letzteDatei) return null;
  }
  if (letzteDatei && fs.existsSync(letzteDatei) && !NICHT_FOLGE.test(text.trim())) {
    // "mach den Ball rot", "füg einen Highscore hinzu": klare Aenderungswuensche direkt, sonst das Modell fragen
    const klar = AENDERN.test(text) && /\b(es|das|den|die|dem|der|ihn|hinzu|dazu|it|the|this|its)\b/i.test(text) && !FRAGE.test(text.trim());
    if (klar || jaNein(await frage(FOLGE(path.basename(letzteDatei)), [{ role: 'user', content: frageText(text) }], 4).catch(() => ''))) return { ordner: path.dirname(letzteDatei), name: path.basename(path.dirname(letzteDatei)), bearbeite: letzteDatei };
  }
  return null;
}

// Dateiname aus dem Modell saeubern: hoechstens 2 Unterordner, keine Laufwerke, kein "..", keine gesperrten Endungen
function sauber(name, sprache, inhalt) {
  const teile = String(name || '').split(/[\\/]+/).filter((t) => !/^[a-z]:$/i.test(t)).map((t) => t.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 80))
    .filter((t) => t && t !== '.' && t !== '..').slice(-3).map((t) => (RESERVIERT.test(t) ? '_' + t : t));
  let datei = teile.pop() || '';
  if (!/\.[a-z0-9]{1,6}$/i.test(datei)) {
    const e = /^\s*(<!doctype html|<html)/i.test(inhalt) ? 'html' : ENDUNG[String(sprache || '').toLowerCase()] || 'txt';
    datei = (datei || (e === 'html' ? 'index' : 'glowline-datei')) + '.' + e;
  }
  if (GESPERRT.test(datei)) datei += '.txt';
  return [...teile, datei].join(path.sep);
}

// Antwort des Modells -> [{ name, inhalt }] + der Satz danach
function lese(antwort, wunsch) {
  const t = String(antwort || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const marken = [...t.matchAll(/(?:^|\n)[ \t>*#_-]*FILE\**\s*:\s*\**\s*`?([^\n`*]+?)`?\s*\**\s*\n/gi)];
  const dateien = [];
  let ende = 0;
  const block = (ab, bisZumLetzten) => {
    const auf = /```([^\n`]*)\n/g;
    auf.lastIndex = ab;
    const a = auf.exec(t);
    if (!a) return null;
    // eine Datei: bis zum letzten ``` (falls im Inhalt selbst ``` vorkommt), sonst bis zum naechsten
    const zu = bisZumLetzten ? t.lastIndexOf('\n```') : t.indexOf('\n```', a.index + a[0].length - 1);
    if (zu < a.index + a[0].length - 1) return null;
    return { sprache: a[1].trim(), inhalt: t.slice(a.index + a[0].length, zu + 1), ende: t.indexOf('\n', zu + 4) < 0 ? t.length : t.indexOf('\n', zu + 4) };
  };
  for (let i = 0; i < marken.length && dateien.length < 5; i++) {
    const b = block(marken[i].index + marken[i][0].length, marken.length === 1);
    if (!b) continue;
    dateien.push({ name: marken[i][1].trim(), sprache: b.sprache, inhalt: b.inhalt });
    ende = Math.max(ende, b.ende);
  }
  if (!dateien.length) {
    const b = block(0, true);
    if (b) { dateien.push({ name: '', sprache: b.sprache, inhalt: b.inhalt }); ende = b.ende; }
  }
  // im Wunsch genannter Dateiname ("als spiel.html") gilt bei einer Datei
  const genannt = /(?:^|[\s"'„(])([\w-][\w.-]{0,60}\.(html?|css|js|ts|py|txt|md|json|csv|xml|svg|java|cpp|cs|go|rs|php|sh|lua|ini|ya?ml))\b/i.exec(wunsch || '');
  if (dateien.length === 1 && genannt) dateien[0].name = genannt[1].trim();
  const rest = t.slice(ende).replace(/```[\s\S]*$/, '').trim().split('\n').filter(Boolean).slice(0, 3).join('\n');
  return { dateien: dateien.map((d) => ({ name: sauber(d.name, d.sprache, d.inhalt), inhalt: d.inhalt })), hinweis: rest.slice(0, 400) };
}

// speichern: fremde Dateien nie ueberschreiben ("name (2).html"), eigene (von Glowline erstellte) schon
function speichere(ordner, dateien, eigene, bearbeite) {
  if (!erlaubterOrt(ordner)) throw new Error('Glowline only saves files inside your user folder (Desktop, Documents …).');
  const basis = path.resolve(ordner);
  const aus = [];
  for (const d of dateien) {
    if (Buffer.byteLength(d.inhalt) > MAX) throw new Error(`${d.name} is too big (over 2 MB)`);
    let ziel = path.resolve(basis, d.name);
    const aendern = !!bearbeite && dateien.length === 1;
    if (aendern) ziel = path.resolve(bearbeite); // Aenderung: dieselbe Datei
    if (!ziel.startsWith(basis + path.sep) || !erlaubterOrt(ziel)) throw new Error('invalid file name');
    if (!aendern && fs.existsSync(ziel) && !eigene.has(ziel.toLowerCase())) {
      const { dir, name, ext } = path.parse(ziel);
      let i = 2;
      while (fs.existsSync(path.join(dir, `${name} (${i})${ext}`))) i++;
      ziel = path.join(dir, `${name} (${i})${ext}`);
    }
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    fs.writeFileSync(ziel, d.inhalt.replace(/^\uFEFF/, ''), 'utf8');
    aus.push({ pfad: ziel, name: path.relative(basis, ziel), groesse: fs.statSync(ziel).size });
  }
  return aus;
}

module.exports = { init, WORTE, SYSTEM, ANSEHEN, pruefe, lese, speichere, sauber, ordnerFuer, erlaubterOrt };
