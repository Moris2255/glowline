// Glowline: minimales Terminal fuer lokale KI-Modelle (Claude Code, Codex, OpenCode)
// mit Live-Leiste unten (tok/s, Prefill, erstes Token, Kontext, VRAM).
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, screen, shell, protocol, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const { StatsProxy, teileModell, istWolke } = require('./proxy');
const konten = require('./konten');
const studio = require('./studio');
const agenten = require('./agenten');
const einrichtung = require('./einrichtung');
const erstellen = require('./erstellen');
const dateien = require('./dateien');
const link = require('./link');
const update = require('./update');
const nacht = require('./nacht');
const hoeren = require('./hoeren');
const terminal = require('./terminal');
const film = require('./film');
const statistik = require('./statistik');
// eigene App "Glowline Link" (gleicher Code, eigener Installer): nutzt die Modelle eines PCs im Heimnetz
const LINK_APP = !!require('./package.json').glowlineLink || !!(process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_LINKAPP);
const autoChat = require('./auto');
const { Readable } = require('stream');

const HOME = os.homedir();

// Standardwerte. Aenderbar in %APPDATA%\Glowline\config.json
const STANDARD = {
  port: LINK_APP ? 3462 : 3460, // Glowline Link hat einen eigenen Port, falls beide auf einem Rechner laufen
  backends: { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' },
  defaultBackend: 'ollama',
  defaultModel: '', // leer = erstes geladenes bzw. verfuegbares Modell
  defaultTool: 'claude',
  startMit: '', // was beim Start aufgeht: '' = zuletzt benutzt, sonst Werkzeug-ID, 'cowork' oder 'studio'
  startFenster: '', // wie das Fenster startet: vollbild | gross (maximiert) | normal | minimiert ('' = vollbild, bzw. alt startVollbild)
  updates: 'auto', // auto = im Hintergrund laden + beim Beenden installieren | fragen = nur Bescheid sagen | aus
  beimSchliessen: 'beenden', // X oben rechts: beenden | minimieren | tray (laeuft im Infobereich weiter)
  lastDir: HOME,
  ohneDenken: [], // Modelle ohne "Denken"-Unterstuetzung
  favoriten: [], // Modell-IDs fuer das kleine Modellmenue
  downloadZiel: 'ollama', // wohin Hugging-Face-Downloads gehen: ollama | lmstudio
  lmstudioModelsDir: '', // leer = Standardordner von LM Studio
  fontSize: 14,
  // Vergleichsmodell fuer die Anzeige "Saved" (USD pro Mio. Tokens), in der App per Klick auf "Saved" waehlbar
  preisModell: 'sonnet',
  preise: { name: 'Claude Sonnet', eingabe: 3, cache: 0.3, ausgabe: 15 },
  tokens: null, // gezaehlte Tokens { neu, cache, ausgabe }
  gespartAlt: 0, // Betrag aus Versionen vor 1.7 (damals direkt in $ gezaehlt)
  claude: {
    settings: '', // optional: eigene Claude-Code-Einstellungsdatei (JSON)
    systemPromptFile: '', // optional: Datei mit Zusatzregeln fuer den System-Prompt
    skipPermissions: false, // true = --dangerously-skip-permissions
    hideStatusLine: true,
    env: {
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100k',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16000',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: '1800000',
      CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '1800000',
      API_TIMEOUT_MS: '3600000',
    },
  },
};

let cfg, cfgPfad, win, proxy;
const ptys = new Map();
let naechsteId = 1;

function mische(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? mische(a[k], v) : v;
  }
  return o;
}

function ladeConfig() {
  cfgPfad = path.join(app.getPath('userData'), 'config.json');
  let eigen = {};
  try { eigen = JSON.parse(fs.readFileSync(cfgPfad, 'utf8')); } catch {}
  cfg = mische(STANDARD, eigen);
  speichereConfig();
}

function speichereConfig() {
  try { fs.mkdirSync(path.dirname(cfgPfad), { recursive: true }); fs.writeFileSync(cfgPfad, JSON.stringify(cfg, null, 2)); } catch {}
}

// ---------- Backends ----------
async function holeJson(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(opt.zeit || 4000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function modellListe(mitWolke) {
  const aus = { ollama: { online: false, models: [] }, lmstudio: { online: false, models: [] }, wolke: {} };
  const wolke = mitWolke ? konten.wolkenListe().catch(() => ({})) : Promise.resolve({});
  aus.lmstudio.ordner = fs.existsSync(path.dirname(lmModellOrdner())) ? lmModellOrdner() : null;
  const O = cfg.backends.ollama, L = cfg.backends.lmstudio;
  await Promise.all([
    (async () => {
      try {
        const [tags, ps] = await Promise.all([holeJson(O + '/api/tags'), holeJson(O + '/api/ps')]);
        const geladen = new Map((ps.models || []).map((m) => [m.name, m]));
        aus.ollama.online = true;
        aus.ollama.models = (tags.models || []).map((m) => {
          const g = geladen.get(m.name);
          return {
            id: 'ollama,' + m.name, name: m.name, size: m.size,
            params: m.details && m.details.parameter_size, quant: m.details && m.details.quantization_level,
            loaded: !!g, vram: g ? g.size_vram : 0, ctx: g ? g.context_length : null,
          };
        });
      } catch {}
    })(),
    (async () => {
      const lm = (await lmModelle(L)) || ((await lmPortSuchen()) ? await lmModelle(cfg.backends.lmstudio) : null);
      if (lm) Object.assign(aus.lmstudio, { online: true, models: lm });
    })(),
  ]);
  const la = process.env.LOCALAPPDATA || '';
  aus.ollama.installiert = aus.ollama.online || await ollamaInstalliert();
  aus.lmstudio.installiert = aus.lmstudio.online || (!(process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_LM_FEHLT) && (fs.existsSync(path.join(HOME, '.lmstudio')) || fs.existsSync(path.join(la, 'Programs', 'LM Studio'))));
  aus.wolke = await wolke;
  return aus;
}

// "qwen3.5:9b-64k" -> 64 (Kontext in Tausend Tokens), sonst null
function kontextAusName(name) {
  const m = /[-:](\d{2,3})k$/i.exec(String(name || ''));
  return m && +m[1] >= 8 ? +m[1] : null;
}

async function ollamaInstalliert() {
  if (process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_OLLAMA_FEHLT) return false; // Test: PC ohne Ollama
  return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')) || !!(await findeProgramm('ollama', await frischerPfad()));
}

async function lmModelle(L) {
  try {
    const r = await holeJson(L + '/api/v0/models', { zeit: 2500 });
    // nur Sprachmodelle (keine Embeddings, keine Sprach-/Audio-Erweiterungen)
    return (r.data || []).filter((m) => m.type !== 'embeddings' && m.publisher !== 'model-extension-pack').map((m) => ({
      id: 'lmstudio,' + m.id, name: m.id, quant: m.quantization, params: m.arch,
      loaded: m.state === 'loaded', ctx: m.loaded_context_length || m.max_context_length || null,
    }));
  } catch {
    try {
      const r = await holeJson(L + '/v1/models', { zeit: 2500 });
      return (r.data || []).map((m) => ({ id: 'lmstudio,' + m.id, name: m.id, loaded: false }));
    } catch { return null; }
  }
}

// ---------- Chat (eingebaut, ueber den Mess-Proxy -> Leiste misst mit) ----------
const chats = new Map();
// Modell-Id -> Backend; Cloud-Abos (nur im Werkzeug) und belegte Grafikkarte abfangen
function chatZiel(modellId) {
  const { backend, model } = teileModell(String(modellId || ''));
  const b = backend || 'ollama';
  const w = konten.WOLKEN[b];
  if (!model) throw new Error('No model selected');
  if (w && w.nurWerkzeug) throw new Error(`${w.name} works only inside ${WERKZEUG[w.nurWerkzeug]}. For chat, add an API key under Models → Accounts or pick a local model.`);
  if (!w && studio.beschaeftigt().gpu) throw new Error('Studio is using the graphics card right now. Local chat works again when the job is done – cloud models work anytime.');
  return { b, w, model };
}

// aus: wohin die Antwort geht (Fenster oder Terminal); ordner: Standardordner fuer Dateien (Terminal: aktueller Ordner)
async function chatSenden({ id, model: modellId, system, nachrichten, medien, anhang, erzwinge, letztesMedium, auto: istAuto, bildFrage, vorigeRolle, rolle: vorgabeRolle, letzteDatei, datei: dateiErzwingen, ordner: standardOrdner }, aus = (p) => sende('chat', p)) {
  const ac = new AbortController();
  chats.set(id, ac);
  const melde = (p) => aus({ id, ...p });
  let autoRolle = null;
  try {
    const msgs = (Array.isArray(nachrichten) ? nachrichten : []).filter((m) => m && /^(user|assistant)$/.test(m.role)).map((m) => ({ role: m.role, content: String(m.content) }));
    const frageText = msgs.length ? msgs[msgs.length - 1].content : '';
    // Auto: Glowline sucht das Modell selbst aus (sortiert und schreibt Prompts mit dem schnellen Modell)
    const rollen = istAuto ? await autoChat.rollen() : null;
    if (rollen) modellId = rollen.schnell.id || modellId;
    if (istAuto && !modellId) throw new Error('No model installed yet – open Models → Express setup or download one.');
    let { b, w, model } = chatZiel(modellId);
    // lokales Modell: der Studio-Motor gibt vorher den Grafikspeicher frei
    if (!w) await Promise.race([studio.frei(), new Promise((ok) => setTimeout(ok, 1500))]);
    // Auto: Frage zu einem Bild ("was ist darauf?") geht ans Sehen-Modell statt ans Studio
    let bild = null;
    if (istAuto) {
      if (anhang && !autoChat.BILD_TUN.test(frageText)) bild = anhang;
      else if (!anhang && bildFrage && !erstellen.WORTE.test(frageText)) bild = bildFrage;
      else if (!anhang && letztesMedium && letztesMedium.bild && autoChat.BILD_FRAGE.test(frageText)) bild = letztesMedium.bild;
    }
    // "Erstelle auf meinem Desktop eine HTML-Datei mit …": das Coder-Modell schreibt, Glowline speichert
    let datei = null;
    if (!bild && !(erzwinge && erzwinge.art) && (dateiErzwingen || dateien.WORTE.test(frageText) || (eigeneDatei(letzteDatei) && !erstellen.WORTE.test(frageText)))) {
      datei = await dateien.pruefe({
        text: frageText, letzteDatei: eigeneDatei(letzteDatei), erzwinge: !!dateiErzwingen, standard: typeof standardOrdner === 'string' ? standardOrdner : null,
        frage: (sys, m, n) => erstellen.frage(String(modellId), sys, m, n, ac.signal),
      });
    }
    // "Erstelle mir ein Bild von …": dann macht das Studio die Arbeit statt einer Textantwort
    if (!datei && medien && !bild && (await erstellen.versuche({ modell: String(modellId), nachrichten: msgs, ac, melde, anhang, erzwinge, letztesMedium }))) return;
    let ohneDenken = false;
    if (istAuto) {
      if (anhang && !bild) bild = anhang; // das Studio wollte nichts damit machen: dann eben anschauen
      // /think, /code, /fast oder /thinking on geben die Rolle vor
      const rolle = bild ? 'sehen' : datei ? 'coder' : autoChat.ROLLEN.includes(vorgabeRolle) ? vorgabeRolle : autoChat.rolleFuer(frageText, vorigeRolle);
      autoRolle = rolle;
      if (bild && !rollen.sehen.id) {
        melde({ rolle, text: 'To look at images, Auto needs a vision model – download one under Models → Download (e.g. qwen3-vl or llama3.2-vision), or pick one for “Vision” under Models → Cowork.', fertig: true });
        return;
      }
      modellId = rollen[rolle].id || modellId;
      ({ b, w, model } = chatZiel(modellId));
      system = [system, autoChat.SYSTEM[rolle]].filter(Boolean).join('\n\n');
      // schnelle Antworten ohne Denkphase (nur Ollama-Modelle, die Denken koennen – sonst gibt es einen Fehler)
      const caps = autoChat.faehigkeiten(modellId);
      ohneDenken = rolle === 'schnell' && b === 'ollama' && !!caps && caps.includes('thinking');
      melde({ rolle, modell: modellId, ...(bild ? { bild } : {}) });
    }
    if (datei) {
      system = [system, dateien.SYSTEM(datei.bearbeite && path.basename(datei.bearbeite))].filter(Boolean).join('\n\n');
      // Aenderung: aktuellen Inhalt mitschicken, damit das Modell die ganze neue Datei schreiben kann
      if (datei.bearbeite) {
        const alt = fs.readFileSync(datei.bearbeite, 'utf8').slice(0, 200000);
        msgs[msgs.length - 1].content += `\n\nCurrent content of ${path.basename(datei.bearbeite)}:\n\`\`\`\n${alt}\n\`\`\``;
      }
      melde({ datei: { status: erstellen.deutsch(frageText) ? 'Schreibt die Datei…' : 'Writing the file…', ordner: datei.name } });
    }
    if (bild) {
      if (!(typeof bild === 'string' && (studio.inAusgabe(bild) || freigegeben.has(path.resolve(bild))) && fs.existsSync(bild))) throw new Error('Image not found');
      const daten = fs.readFileSync(bild).toString('base64');
      const typ = /\.png$/i.test(bild) ? 'image/png' : /\.webp$/i.test(bild) ? 'image/webp' : 'image/jpeg';
      const letzte = msgs[msgs.length - 1];
      letzte.content = w && w.format === 'anthropic'
        ? [{ type: 'image', source: { type: 'base64', media_type: typ, data: daten } }, { type: 'text', text: letzte.content }]
        : [{ type: 'text', text: letzte.content }, { type: 'image_url', image_url: { url: `data:${typ};base64,${daten}` } }];
    }
    const anthropic = w && w.format === 'anthropic';
    const url = `http://127.0.0.1:${cfg.port}/s/chat/${b}` + (anthropic ? '/v1/messages' : '/v1/chat/completions');
    const body = anthropic
      ? { model, max_tokens: datei ? 32000 : 8192, stream: true, ...(system ? { system } : {}), messages: msgs }
      : { model, stream: true, stream_options: { include_usage: true }, ...(ohneDenken ? { reasoning_effort: 'none' } : {}), messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs] };
    const r = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer glowline', 'x-api-key': 'glowline', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      let m = t;
      try { const j = JSON.parse(t); m = (j.error && (j.error.message || j.error)) || j.message || t; } catch {}
      throw new Error(String(m).slice(0, 400) || 'HTTP ' + r.status);
    }
    const dec = new TextDecoder();
    let puffer = '', text = '', denken = '', zuletzt = 0;
    // manche Modelle schreiben ihr Denken als <think>...</think> in den Text
    const trenne = () => {
      const m = /^\s*<think>([\s\S]*?)(?:<\/think>\s*([\s\S]*))?$/.exec(text);
      return m ? { text: m[2] || '', denken: denken + m[1] } : { text, denken };
    };
    for await (const stueck of r.body) {
      puffer += dec.decode(stueck, { stream: true });
      let i;
      while ((i = puffer.indexOf('\n')) >= 0) {
        const z = puffer.slice(0, i).trim();
        puffer = puffer.slice(i + 1);
        if (!z.startsWith('data:')) continue;
        const roh = z.slice(5).trim();
        if (roh === '[DONE]') continue;
        let d;
        try { d = JSON.parse(roh); } catch { continue; }
        if (anthropic) {
          if (d.type === 'content_block_delta' && d.delta) { text += d.delta.text || ''; denken += d.delta.thinking || ''; }
          if (d.type === 'error') throw new Error((d.error && d.error.message) || 'error');
        } else if (Array.isArray(d.choices) && d.choices[0]) {
          const dl = d.choices[0].delta || {};
          text += dl.content || '';
          denken += dl.reasoning_content || dl.reasoning || '';
        }
      }
      if (Date.now() - zuletzt > 60) {
        zuletzt = Date.now();
        // Datei: statt des Codes nur zeigen, wie weit sie ist
        if (datei) { const t = trenne(); melde({ datei: { status: t.text.length ? `${erstellen.deutsch(frageText) ? 'Schreibt' : 'Writing'} · ${Math.max(1, Math.round(t.text.length / 1024))} KB` : erstellen.deutsch(frageText) ? 'Denkt nach…' : 'Thinking…' } }); } else melde(trenne());
      }
    }
    if (datei) {
      const t = trenne();
      const l = dateien.lese(t.text, frageText);
      if (!l.dateien.length) { melde({ ...t, fertig: true, datei: null }); return; } // keine Datei geschrieben: normale Antwort zeigen
      const eigene = new Set(cfg.erstellteDateien || []);
      const gespeichert = dateien.speichere(datei.ordner, l.dateien, eigene, datei.bearbeite);
      cfg.erstellteDateien = [...gespeichert.map((g) => g.pfad.toLowerCase()), ...(cfg.erstellteDateien || [])].filter((p, i, a) => a.indexOf(p) === i).slice(0, 300);
      speichereConfig();
      const de = erstellen.deutsch(frageText);
      const text = l.hinweis || (datei.bearbeite ? (de ? 'Erledigt – die Datei ist aktualisiert.' : 'Done – the file is updated.') : de ? 'Fertig – die Datei liegt bereit.' : 'Done – your file is ready.');
      melde({ text, denken: t.denken, fertig: true, datei: { status: null, ordner: datei.name, geaendert: !!datei.bearbeite, dateien: gespeichert } });
      return;
    }
    melde({ ...trenne(), fertig: true });
  } catch (e) {
    // Auto: sagen, welches Modell nicht wollte – und wo man ein anderes waehlt
    melde({ fertig: true, fehler: ac.signal.aborted ? 'stopped' : e.message + (autoRolle ? ` – the ${autoChat.NAME[autoRolle]} model failed. You can pick another one above the chat.` : '') });
  } finally {
    chats.delete(id);
  }
}

// LM Studio weicht auf einen anderen Port aus, wenn 1234 belegt ist. Dann die naechsten Ports durchprobieren
// (nur auf diesem PC, kurze Zeitgrenze) und die gefundene Adresse merken.
let lmSuchZeit = 0;
async function lmPortSuchen() {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(cfg.backends.lmstudio);
  // Test: nie echte Programme auf dem PC anfragen
  if (process.env.GLOWLINE_TEST || !m || Date.now() - lmSuchZeit < 10000) return false;
  lmSuchZeit = Date.now();
  const basis = +m[2] === 1234 ? 1234 : +m[2];
  const ports = [1234, 1235, 1236, 1237, 1238, 1239, 1240, basis].filter((p, i, a) => p !== +m[2] && a.indexOf(p) === i);
  const treffer = await Promise.all(ports.map((p) => holeJson(`http://127.0.0.1:${p}/api/v0/models`, { zeit: 600 })
    .then((r) => (Array.isArray(r.data) && r.data.every((x) => 'compatibility_type' in x || 'state' in x) ? p : null)).catch(() => null)));
  const port = treffer.find(Boolean);
  if (!port) return false;
  cfg.backends.lmstudio = `http://127.0.0.1:${port}`;
  speichereConfig();
  return true;
}

// LM-Studio-Server starten (Knopf im Modellfenster)
async function lmServerStarten() {
  await lms(['server', 'start']);
  for (let i = 0; i < 20; i++) {
    lmSuchZeit = 0;
    if ((await lmModelle(cfg.backends.lmstudio)) || (await lmPortSuchen())) { statusSchleife.lms = true; return true; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function lms(args) {
  const exe = path.join(HOME, '.lmstudio', 'bin', 'lms.exe');
  return new Promise((ok) => execFile(fs.existsSync(exe) ? exe : 'lms', args, { timeout: 300000 }, (e, so, se) => ok(e ? (se || e.message) : 'ok')));
}

async function modellLaden(id, laden) {
  const { backend, model } = teileModell(id);
  if (istWolke(backend)) return 'ok';
  if (backend === 'lmstudio') return lms(laden ? ['load', model, '-y'] : ['unload', model]);
  const r = await fetch(cfg.backends.ollama + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: laden ? '30m' : 0 }),
  });
  await r.text();
  return r.ok ? 'ok' : 'HTTP ' + r.status;
}

// Statuszeile: GPU + geladene Modelle, alle 2 s
let gpuZaehler = 0;
let gpuWert = null, gpuProzess = null, gpuFehler = 0;
function gpuStarten() {
  if (gpuProzess || gpuFehler > 3) return;
  try {
    gpuProzess = spawn('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu,power.draw', '--format=csv,noheader,nounits', '-lms', '2000'], { windowsHide: true });
  } catch { gpuFehler++; return; }
  let puffer = '';
  gpuProzess.stdout.on('data', (d) => {
    puffer += d;
    const zeilen = puffer.split(/\r?\n/);
    puffer = zeilen.pop();
    const z = zeilen.filter(Boolean).pop();
    if (!z) return;
    const [name, used, total, util, power] = z.split(',').map((x) => x.trim());
    if (+total) gpuWert = { name, used: +used, total: +total, util: +util, power: parseFloat(power) };
  });
  gpuProzess.on('error', () => { gpuFehler = 99; gpuProzess = null; });
  gpuProzess.on('exit', () => { gpuProzess = null; gpuFehler++; });
}
function gpu() {
  if (LINK_APP) return link.fernGpu();
  gpuStarten();
  return Promise.resolve(gpuWert);
}

async function statusSchleife() {
  const [g, geladen] = await Promise.all([
    gpu(),
    holeJson(cfg.backends.ollama + '/api/ps', { zeit: 1500 }).then((r) => r.models || []).catch(() => null),
  ]);
  let lmsOnline = false;
  if (gpuZaehler++ % 5 === 0) {
    lmsOnline = await holeJson(cfg.backends.lmstudio + '/v1/models', { zeit: 800 }).then(() => true).catch(() => false);
    if (!lmsOnline && (await lmPortSuchen())) lmsOnline = true;
    statusSchleife.lms = lmsOnline;
  }
  statusSchleife.geladen = (geladen || []).map((m) => ({ name: m.name, ctx: m.context_length }));
  if (win && !win.isDestroyed()) {
    win.webContents.send('status', {
      gpu: g,
      ollama: geladen !== null,
      lmstudio: !!statusSchleife.lms,
      loaded: (geladen || []).map((m) => ({ name: m.name, vram: m.size_vram, ctx: m.context_length })),
    });
  }
  setTimeout(statusSchleife, win && !win.isDestroyed() && (win.isMinimized() || !win.isVisible()) ? 8000 : 2000);
}

// ---------- Terminals ----------
function sauberesEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|ELECTRON_|CODEX_OSS_|OPENCODE_CONFIG)/.test(k) || /^npm_/i.test(k)) continue;
    e[k] = v;
  }
  e.TERM = 'xterm-256color';
  e.COLORTERM = 'truecolor';
  return e;
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell-Zitat

// ---------- Installierte Programme finden ----------
// PATH frisch aus der Registry: so findet Glowline auch Programme, die erst nach dem Start installiert wurden
function regPfad(schluessel) {
  return new Promise((ok) => execFile('reg.exe', ['query', schluessel, '/v', 'Path'], { windowsHide: true, timeout: 3000 }, (e, so) => {
    const m = /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(String(so || ''));
    ok(m ? m[1].trim().replace(/%([^%]+)%/g, (x, n) => process.env[n] ?? x) : '');
  }));
}
async function frischerPfad() {
  const [sys, nutzer] = await Promise.all([regPfad('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), regPfad('HKCU\\Environment')]);
  const gesehen = new Set();
  // Test: PC ohne Node.js nachspielen
  const ohneNode = process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_OHNE_NODE ? (p) => !/nodejs|node_modules|[\\/]npm$|[\\/]node$|\.local[\\/]bin/i.test(p) || WERKZEUG_ORDNER().includes(p) : () => true;
  return [...sys.split(';'), ...nutzer.split(';'), ...(process.env.PATH || '').split(';'), ...WERKZEUG_ORDNER().filter((o) => fs.existsSync(o))].filter(ohneNode)
    .map((p) => p.trim()).filter((p) => p && !gesehen.has(p.toLowerCase()) && gesehen.add(p.toLowerCase())).join(';');
}
function mitPfad(env, pfad) {
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.Path = pfad;
  return env;
}
// .exe/.cmd bevorzugt (eine .ps1 kann an der Ausfuehrungsrichtlinie scheitern)
function findeProgramm(name, pfad) {
  if ((process.env.GLOWLINE_TEST_FEHLT || '').split(',').includes(name)) return Promise.resolve(null);
  return new Promise((ok) => execFile('where.exe', [name], { windowsHide: true, timeout: 5000, env: mitPfad({ ...process.env }, pfad) }, (e, so) => {
    const pfade = String(so || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    ok(pfade.find((p) => /\.(exe|cmd)$/i.test(p)) || pfade.find((p) => /\.ps1$/i.test(p)) || null);
  }));
}
async function werkzeugeInstalliert() {
  const pfad = await frischerPfad();
  const r = {};
  await Promise.all(Object.keys(INSTALL).map(async (t) => { r[t] = !!(await findeProgramm(INSTALL[t].exe || t, pfad)); }));
  return r;
}
// npm: Paket fuer "npm install -g", ps: offizielles Installationsskript des Herstellers
const INSTALL = {
  claude: { name: 'Claude Code', ps: 'https://claude.ai/install.ps1' },
  codex: { name: 'Codex', npm: '@openai/codex' },
  opencode: { name: 'OpenCode', npm: 'opencode-ai' },
  // konto: meldet sich selbst an und nutzt seine eigenen Modelle (Glowline startet es nur im Ordner)
  antigravity: { name: 'Antigravity', exe: 'agy', ps: 'https://antigravity.google/cli/install.ps1', konto: true },
  gemini: { name: 'Gemini CLI', npm: '@google/gemini-cli', konto: true },
  qwen: { name: 'Qwen Code', npm: '@qwen-code/qwen-code' },
  copilot: { name: 'GitHub Copilot', npm: '@github/copilot', konto: true },
  droid: { name: 'Droid', ps: 'https://app.factory.ai/cli/windows', konto: true },
  cline: { name: 'Cline', npm: 'cline', konto: true },
};
const WERKZEUG = { ...Object.fromEntries(Object.entries(INSTALL).map(([k, v]) => [k, v.name])), shell: 'PowerShell' };
function meldung(env, zeilen) {
  const text = ['', ...zeilen, ''].map((t, i) => `Write-Host ${q(t)}${i === 1 ? ' -ForegroundColor Yellow' : i > 1 && t ? ' -ForegroundColor DarkGray' : ''}`).join('; ');
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', text], env };
}
// Ordner, in denen installierte Werkzeuge landen (auch wenn der PATH sie noch nicht kennt)
const NODE_ORDNER = () => path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Glowline', 'node');
const WERKZEUG_ORDNER = () => [NODE_ORDNER(), path.join(process.env.APPDATA || '', 'npm'), path.join(HOME, '.local', 'bin')];
const FERTIG_MARKE = '[glowline:installed]';
// Fehlendes Werkzeug: Glowline installiert es selbst im Terminal – bei Bedarf mit eigenem Node.js
// (ohne Admin-Rechte, nach %LOCALAPPDATA%\Glowline\node). Danach startet das Werkzeug von allein.
function installSkript(tool) {
  const i = INSTALL[tool];
  const s = (t) => "'" + String(t).replace(/'/g, "''") + "'";
  const z = [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    // Ordner dauerhaft in den Benutzer-PATH, damit das Werkzeug auch in anderen Terminals geht
    'function Add-UserPath($dir) {',
    "  $alt = [Environment]::GetEnvironmentVariable('Path', 'User')",
    process.env.GLOWLINE_TEST ? '  # Test: Benutzer-PATH bleibt unberuehrt' : "  if (-not (($alt -split ';') -contains $dir)) { [Environment]::SetEnvironmentVariable('Path', (($alt.TrimEnd(';') + ';' + $dir).TrimStart(';')), 'User') }",
    "  if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = $dir + ';' + $env:Path }",
    '}',
    "Write-Host ''",
    `Write-Host ${s(`  Installing ${i.name} - Glowline does everything, just wait a moment.`)} -ForegroundColor Yellow`,
    "Write-Host ''",
  ];
  if (i.npm) {
    z.push(
      `$nodeDir = ${s(NODE_ORDNER())}`,
      "if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {",
      "  if (-not (Test-Path (Join-Path $nodeDir 'npm.cmd'))) {",
      "    Write-Host '  Node.js is missing - downloading it (about 35 MB) ...' -ForegroundColor DarkGray",
      "    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }",
      "    try {",
      // erst in eine Variable: PowerShell 5.1 reicht die Liste sonst als ein einziges Objekt weiter
      "      $liste = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 60 -UseBasicParsing",
      "      $v = ($liste | Where-Object { $_.lts } | Select-Object -First 1).version",
      "      if (-not ($v -match '^v\\d+\\.\\d+\\.\\d+$')) { throw 'could not find the current Node.js version' }",
      "      $name = \"node-$v-win-$arch\"",
      "      $zip = Join-Path $env:TEMP \"$name.zip\"",
      "      $tmp = Join-Path $env:TEMP \"glowline-$name\"",
      "      Invoke-WebRequest \"https://nodejs.org/dist/$v/$name.zip\" -OutFile $zip -UseBasicParsing -TimeoutSec 900",
      "      New-Item -ItemType Directory -Force $tmp | Out-Null",
      "      tar.exe -xf $zip -C $tmp",
      "      if (-not (Test-Path (Join-Path $tmp $name))) { Expand-Archive $zip $tmp -Force }",
      "      New-Item -ItemType Directory -Force (Split-Path $nodeDir) | Out-Null",
      "      if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }",
      "      Move-Item (Join-Path $tmp $name) $nodeDir",
      "      Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue",
      "      Write-Host \"  Node.js $v is ready.\" -ForegroundColor DarkGray",
      "    } catch { Write-Host ('  Could not download Node.js: ' + $_.Exception.Message) -ForegroundColor Red; return }",
      "  }",
      "  Add-UserPath $nodeDir",
      "}",
      "Add-UserPath (Join-Path $env:APPDATA 'npm')",
      `npm install -g ${s(i.npm)}`,
      '$ok = ($LASTEXITCODE -eq 0)',
    );
  } else {
    z.push(
      `try { & ([scriptblock]::Create((Invoke-RestMethod ${s(i.ps)} -UseBasicParsing))); $ok = $true } catch { Write-Host ('  ' + $_.Exception.Message) -ForegroundColor Red; $ok = $false }`,
      "Add-UserPath (Join-Path $env:USERPROFILE '.local\\bin')",
    );
  }
  z.push(
    `if ($ok -and (Get-Command ${s(i.exe || tool)} -ErrorAction SilentlyContinue)) {`,
    `  Write-Host ''; Write-Host ${s(`  ${i.name} is installed - starting it ...`)} -ForegroundColor Green; Write-Host ${s(FERTIG_MARKE)}`,
    '} else {',
    `  Write-Host ''; Write-Host ${s(`  The install did not finish (see above). Check your internet and choose ${i.name} again in the tool menu to retry.`)} -ForegroundColor Red`,
    '}',
  );
  const datei = path.join(app.getPath('userData'), `install-${tool}.ps1`);
  fs.writeFileSync(datei, '﻿' + z.join('\r\n'), 'utf8');
  return datei;
}
// dasselbe unsichtbar (Express-Einrichtung): meldet die letzte Zeile als Status, wirft bei Fehler
async function werkzeugInstallieren(tool, ac, status) {
  if (!INSTALL[tool]) throw new Error('unknown tool');
  const env = mitPfad(sauberesEnv(), await frischerPfad());
  const datei = installSkript(tool);
  let aus = '';
  const code = await new Promise((ok, fehler) => {
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', datei], { windowsHide: true, env });
    const zeile = (x) => {
      aus = (aus + x).slice(-4000);
      const z = String(x).split(/\r?\n/).map((t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter((t) => t && !t.startsWith('[glowline')).pop();
      if (z) status(z.slice(0, 120));
    };
    p.stdout.on('data', zeile);
    p.stderr.on('data', zeile);
    const weg = () => { try { execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {}); } catch {} };
    ac.signal.addEventListener('abort', weg, { once: true });
    p.on('error', fehler);
    p.on('close', (c) => { ac.signal.removeEventListener('abort', weg); ok(c); });
  });
  if (ac.signal.aborted) throw new Error('cancelled');
  if (!aus.includes(FERTIG_MARKE)) {
    const grund = aus.split(/\r?\n/).map((t) => t.trim()).filter((t) => /error|could not|failed/i.test(t) && !/did not finish|^npm error (A complete log|$)/i.test(t)).slice(0, 2).join(' ');
    throw new Error((grund || `${INSTALL[tool].name} could not be installed (code ${code})`).slice(0, 200));
  }
}

// Hat der Nutzer in Claude Code selbst eine Statuszeile eingerichtet (~/.claude/settings.json)?
function nutzerStatuszeile() {
  const ordner = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  try { return !!JSON.parse(fs.readFileSync(path.join(ordner, 'settings.json'), 'utf8')).statusLine; } catch { return false; }
}

async function baueBefehl(tool, modellId, tab) {
  const { backend, model } = teileModell(modellId || cfg.defaultModel || '');
  const basis = `http://127.0.0.1:${cfg.port}/s/${tab}/${backend || 'auto'}`;
  const pfad = await frischerPfad();
  const env = mitPfad(sauberesEnv(), pfad);
  let zeile = null;
  let exe = null;
  if (INSTALL[tool]) {
    exe = await findeProgramm(INSTALL[tool].exe || tool, pfad);
    if (!exe) return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', installSkript(tool)], env, fehlt: tool };
    if (INSTALL[tool].konto) {
      const args = ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& ${q(exe)}`];
      if (/\.ps1$/i.test(exe)) args.splice(2, 0, '-ExecutionPolicy', 'Bypass');
      return { file: 'powershell.exe', args, env };
    }
  }

  const wolke = istWolke(backend) ? konten.WOLKEN[backend] : null;
  if (wolke) {
    const passt = {
      claude: ['abo', 'anthropic'], codex: ['chatgpt', 'openai'],
      opencode: Object.keys(konten.WOLKEN).filter((k) => !konten.WOLKEN[k].nurWerkzeug),
      qwen: Object.keys(konten.WOLKEN).filter((k) => konten.WOLKEN[k].format === 'openai'),
    }[tool];
    if (passt && !passt.includes(backend)) {
      const wo = wolke.nurWerkzeug ? WERKZEUG[wolke.nurWerkzeug] : wolke.format === 'openai' ? 'OpenCode, Qwen Code or Chat' : 'OpenCode or Chat';
      return meldung(env, [`${wolke.name} models work in ${wo}, not in ${WERKZEUG[tool]}.`, 'Pick another model (bottom right) or switch the tool.']);
    }
  }

  const mitStudio = studio.status().eingerichtet; // Agenten bekommen die Studio-Werkzeuge (MCP)
  if (tool === 'claude') {
    if (!wolke) {
      Object.assign(env, cfg.claude.env, { ANTHROPIC_BASE_URL: basis, ANTHROPIC_AUTH_TOKEN: 'glowline' });
      // Modell mit festem Kontext im Namen (z. B. "qwen3.5:9b-64k"): Claude Code nicht mehr schicken lassen, als passt
      const k = kontextAusName(model);
      if (k && k < 128) Object.assign(env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(k * 1000), CLAUDE_CODE_AUTO_COMPACT_WINDOW: Math.floor(k * 0.78) + 'k' });
    }
    // Abo: Claude Code meldet sich selbst an, der Proxy misst nur mit. API-Schluessel: setzt der Proxy ein.
    else if (backend === 'abo') env.ANTHROPIC_BASE_URL = basis;
    else Object.assign(env, { ANTHROPIC_BASE_URL: basis, ANTHROPIC_AUTH_TOKEN: 'glowline' });
    const a = [q(exe)];
    // Eigene Einstellungsdatei: optionale Nutzer-Einstellungen, ohne Statuszeile (die Werte zeigt ja Glowline unten an).
    // Keine leere Statuszeile drueber legen: auch eine leere kostet eine ganze Zeile unter der Eingabe. Und die
    // Nutzer-Einstellungen nicht abschalten (--setting-sources): dann fehlen seine CLAUDE.md und Skills.
    // Hat der Nutzer selbst eine Statuszeile eingerichtet, blendet nur disableAllHooks sie ganz aus (Zeile weg,
    // Eingabe rutscht nach unten) – kostet in Glowline seine Hooks, CLAUDE.md und Skills bleiben.
    let einst = {};
    try { einst = JSON.parse(fs.readFileSync(cfg.claude.settings, 'utf8')); } catch {}
    if (cfg.claude.hideStatusLine) {
      delete einst.statusLine;
      if (einst.disableAllHooks === undefined && nutzerStatuszeile()) einst.disableAllHooks = true;
    }
    if (einst.spinnerTipsEnabled === undefined) einst.spinnerTipsEnabled = false; // weniger Text unter der Eingabe
    const einstPfad = path.join(app.getPath('userData'), 'claude-settings.json');
    fs.writeFileSync(einstPfad, JSON.stringify(einst, null, 2));
    a.push('--settings', q(einstPfad));
    if (mitStudio) {
      const mcpPfad = path.join(app.getPath('userData'), 'claude-mcp.json');
      fs.writeFileSync(mcpPfad, JSON.stringify({ mcpServers: { 'glowline-studio': { type: 'http', url: agenten.url() } } }, null, 2));
      a.push('--mcp-config', q(mcpPfad));
    }
    if (cfg.claude.systemPromptFile && fs.existsSync(cfg.claude.systemPromptFile)) a.push('--append-system-prompt-file', q(cfg.claude.systemPromptFile));
    if (cfg.claude.skipPermissions) a.push('--dangerously-skip-permissions');
    a.push('--model', q(wolke ? model : (backend || 'ollama') + ',' + model));
    zeile = '& ' + a.join(' ');
  } else if (tool === 'codex' && backend === 'chatgpt') {
    zeile = `& ${q(exe)}`; // eigenes ChatGPT-Login und Standardmodell von Codex
  } else if (tool === 'codex' && wolke) {
    // OpenAI-API ueber den Proxy: der setzt den Schluessel ein und misst
    env.GLOWLINE_KEY = 'glowline';
    const anbieter = `model_providers.glowline={ name = "Glowline", base_url = "${basis}/v1", env_key = "GLOWLINE_KEY", wire_api = "responses" }`;
    zeile = `& ${q(exe)} -c ${q('model_provider="glowline"')} -c ${q(anbieter)} -m ${q(model)}`;
  } else if (tool === 'codex') {
    env.CODEX_OSS_BASE_URL = basis + '/v1';
    zeile = `& ${q(exe)} --oss --local-provider ${backend === 'lmstudio' ? 'lmstudio' : 'ollama'} -m ${q(model)}`;
  } else if (tool === 'opencode') {
    const liste = await modellListe();
    const modelle = {};
    for (const m of [...liste.ollama.models, ...liste.lmstudio.models]) {
      modelle[m.name] = { name: m.name, limit: { context: m.ctx || (kontextAusName(m.name) || 128) * 1000, output: 16000 } };
    }
    const provider = {
      glowline: {
        npm: '@ai-sdk/openai-compatible', name: 'Glowline',
        options: { baseURL: (wolke ? `http://127.0.0.1:${cfg.port}/s/${tab}/auto` : basis) + '/v1', apiKey: 'glowline' }, models: modelle,
      },
    };
    let gewaehlt = 'glowline/' + model;
    if (wolke) {
      // Cloud-Anbieter ueber den Proxy (Schluessel setzt der Proxy ein)
      provider['g-' + backend] = {
        npm: wolke.format === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible', name: wolke.name,
        options: { baseURL: basis + '/v1', apiKey: 'glowline' }, models: { [model]: { name: model } },
      };
      gewaehlt = `g-${backend}/${model}`;
    } else modelle[model] = modelle[model] || { name: model, limit: { context: 128000, output: 16000 } };
    const oc = { $schema: 'https://opencode.ai/config.json', provider, model: gewaehlt };
    // timeout gilt auch fuer Werkzeug-Aufrufe (Videos dauern Minuten)
    if (mitStudio) oc.mcp = { 'glowline-studio': { type: 'remote', url: agenten.url(), enabled: true, timeout: 1800000 } };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
    // --standalone: eigener Server, sonst nimmt OpenCode 2 den Hintergrund-Dienst ohne unsere Einstellungen
    zeile = `& ${q(exe)} --standalone`;
  } else if (tool === 'qwen') {
    // Qwen Code spricht OpenAI-Format: lokale Modelle und Cloud-Schluessel laufen ueber den Proxy
    const a = [q(exe), '--openai-base-url', q(basis + '/v1'), '--openai-api-key', 'glowline', '-m', q(model)];
    if (mitStudio) {
      const mcpPfad = path.join(app.getPath('userData'), 'qwen-mcp.json');
      fs.writeFileSync(mcpPfad, JSON.stringify({ mcpServers: { 'glowline-studio': { httpUrl: agenten.url(), timeout: 1800000 } } }, null, 2));
      a.push('--mcp-config', q(mcpPfad));
    }
    zeile = '& ' + a.join(' ');
  }

  if (tool === 'codex' && zeile && mitStudio) zeile += ` -c ${q(`mcp_servers.glowline_studio.url="${agenten.url()}"`)} -c mcp_servers.glowline_studio.tool_timeout_sec=1800`;
  const args = zeile ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', zeile] : ['-NoLogo'];
  if (exe && /\.ps1$/i.test(exe)) args.splice(2, 0, '-ExecutionPolicy', 'Bypass');
  return { file: 'powershell.exe', args, env };
}

// ---------- Hugging Face + Downloads ----------
// Ziele: Ollama laedt selbst ("hf.co/<repo>:<quant>"), fuer LM Studio legt Glowline die GGUF-Datei in dessen Modellordner.
const HF = 'https://huggingface.co';
const hfKopf = () => { const k = konten.schluessel('huggingface'); return k ? { authorization: 'Bearer ' + k } : {}; };
const QUANT = /(?:^|[-_.])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32)(?:-\d{5}-of-\d{5})?\.gguf$/i;
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const downloads = new Map(); // key -> AbortController

function lmModellOrdner() {
  if (cfg.lmstudioModelsDir) return cfg.lmstudioModelsDir;
  let home = path.join(HOME, '.lmstudio');
  try { const p = fs.readFileSync(path.join(HOME, '.lmstudio-home-pointer'), 'utf8').trim(); if (p) home = p; } catch {}
  return path.join(home, 'models');
}

async function hfSuche(q) {
  const r = await holeJson(`${HF}/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=30`, { zeit: 12000, headers: hfKopf() });
  return r.map((m) => ({ repo: m.id || m.modelId, downloads: m.downloads || 0 }));
}

// Alle Quantisierungen eines Repos mit Groesse und Dateien (mehrteilige Dateien werden zusammengezaehlt)
async function hfDateien(repo) {
  if (!REPO.test(repo)) throw new Error('invalid repo');
  const r = await holeJson(`${HF}/api/models/${repo}/tree/main?recursive=true`, { zeit: 15000, headers: hfKopf() });
  const quants = new Map();
  for (const f of r) {
    if (f.type !== 'file' || !/\.gguf$/i.test(f.path) || /mmproj/i.test(f.path)) continue;
    const m = QUANT.exec(f.path.split('/').pop());
    if (!m) continue;
    const q = m[1].toUpperCase();
    const e = quants.get(q) || { quant: q, size: 0, files: [] };
    // nur Teile derselben aufgeteilten Datei (-00001-of-00003) gehoeren zusammen, sonst gilt die erste Datei
    const teil = (p) => /-\d{5}-of-\d{5}\.gguf$/i.test(p);
    if (e.files.length && !(teil(f.path) && teil(e.files[0]))) continue;
    e.size += (f.lfs && f.lfs.size) || f.size || 0;
    e.files.push(f.path);
    quants.set(q, e);
  }
  const ordner = path.join(lmModellOrdner(), ...repo.split('/'));
  return [...quants.values()]
    .map((e) => ({ ...e, lmstudio: e.files.every((p) => fs.existsSync(path.join(ordner, path.basename(p)))) }))
    .sort((a, b) => a.size - b.size);
}

async function herunterladen(d) {
  const { key, ziel, repo, quant } = d || {};
  if (!key || downloads.has(key)) return;
  const ac = new AbortController();
  downloads.set(key, ac);
  const melde = (o) => sende('download', { key, ...o });
  try {
    // Cowork "Use recommended": nur Modelle aus der Empfehlungsliste, direkt aus der Ollama-Bibliothek
    if (ziel === 'bibliothek') {
      const erlaubt = Object.keys(einrichtung.STUFEN).flatMap((st) => Object.values(empfehlungFuer(st)).map((e) => e.name));
      if (!erlaubt.includes(repo)) throw new Error('invalid model');
      await ollamaHolen(repo, ac, melde);
      melde({ status: 'success', fertig: true });
      return;
    }
    if (!REPO.test(repo) || !/^[\w-]+$/.test(quant)) throw new Error('invalid model');
    if (ziel === 'ollama') await ollamaHolen(`hf.co/${repo}:${quant}`, ac, melde);
    else if (ziel === 'lmstudio' && LINK_APP) throw new Error('In Glowline Link, models are stored on your PC – set the download target to Ollama');
    else if (ziel === 'lmstudio') await dateienHolen(repo, d.files, d.total, path.join(lmModellOrdner(), ...repo.split('/')), ac, melde);
    else throw new Error('unknown target');
    melde({ status: 'success', fertig: true });
  } catch (e) {
    melde({ status: 'error', fertig: true, fehler: ac.signal.aborted ? 'cancelled' : e.message });
  } finally {
    downloads.delete(key);
  }
}

async function ollamaHolen(name, ac, melde) {
  const r = await fetch(cfg.backends.ollama + '/api/pull', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }), signal: ac.signal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let puffer = '', zuletzt = 0;
  for await (const stueck of r.body) {
    puffer += dec.decode(stueck, { stream: true });
    let i;
    while ((i = puffer.indexOf('\n')) >= 0) {
      const zeile = puffer.slice(0, i).trim();
      puffer = puffer.slice(i + 1);
      if (!zeile) continue;
      const d = JSON.parse(zeile);
      if (d.error) throw new Error(d.error);
      if (Date.now() - zuletzt > 250) {
        zuletzt = Date.now();
        melde({ status: d.status, completed: d.completed || 0, total: d.total || 0 });
      }
    }
  }
}

// GGUF-Dateien direkt von Hugging Face in einen Ordner laden (erst als .part, dann umbenennen)
async function dateienHolen(repo, dateien, gesamt, ordner, ac, melde) {
  if (!Array.isArray(dateien) || !dateien.length || dateien.some((p) => typeof p !== 'string' || !/\.gguf$/i.test(p) || p.includes('..'))) throw new Error('invalid files');
  fs.mkdirSync(ordner, { recursive: true });
  let fertig = 0, zuletzt = 0;
  try {
    for (const p of dateien) {
      const ziel = path.join(ordner, path.basename(p));
      if (fs.existsSync(ziel)) { fertig += fs.statSync(ziel).size; continue; }
      const teil = ziel + '.part';
      const r = await fetch(`${HF}/${repo}/resolve/main/${p.split('/').map(encodeURIComponent).join('/')}`, { signal: ac.signal, headers: hfKopf() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ws = fs.createWriteStream(teil);
      try {
        for await (const stueck of r.body) {
          fertig += stueck.length;
          if (!ws.write(stueck)) await new Promise((ok) => ws.once('drain', ok));
          if (Date.now() - zuletzt > 250) {
            zuletzt = Date.now();
            melde({ status: 'downloading', completed: fertig, total: gesamt || 0 });
          }
        }
        await new Promise((ok, nein) => ws.end((e) => (e ? nein(e) : ok())));
      } catch (e) {
        ws.destroy();
        if (!ws.closed) await new Promise((ok) => ws.once('close', ok));
        fs.rmSync(teil, { force: true });
        throw e;
      }
      fs.renameSync(teil, ziel);
    }
  } finally {
    // leere Ordner nach Abbruch wieder wegraeumen
    for (const o of [ordner, path.dirname(ordner)]) try { fs.rmdirSync(o); } catch {}
  }
}

// Vor Bild/Video/Stimme: Sprachmodelle aus dem Grafikspeicher nehmen (8 GB reichen sonst nicht fuer beides)
async function vramFrei() {
  const r = await holeJson(cfg.backends.ollama + '/api/ps', { zeit: 1500 }).catch(() => null);
  const weg = ((r && r.models) || []).map((m) => modellLaden('ollama,' + m.name, false).catch(() => {}));
  const lm = statusSchleife.lms ? await lmModelle(cfg.backends.lmstudio).catch(() => null) : null;
  for (const m of lm || []) if (m.loaded) weg.push(modellLaden(m.id, false).catch(() => {}));
  await Promise.all(weg);
}

// glowline://datei?f=<Pfad>: nur Studio-Ergebnisse und Dateien, die man selbst ausgewaehlt hat
const freigegeben = new Set();
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
function dateiProtokoll() {
  protocol.handle('glowline', (req) => {
    const f = path.resolve(new URL(req.url).searchParams.get('f') || '.');
    const typ = MIME[path.extname(f).toLowerCase()];
    if (!(studio.inAusgabe(f) || freigegeben.has(f) || film.inOrdner(f)) || !typ || !fs.existsSync(f)) return new Response('not found', { status: 404 });
    const groesse = fs.statSync(f).size;
    const r = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (r && groesse) {
      const start = r[1] ? Math.min(+r[1], groesse - 1) : 0, ende = r[2] ? Math.min(+r[2], groesse - 1) : groesse - 1;
      return new Response(Readable.toWeb(fs.createReadStream(f, { start, end: ende })), {
        status: 206, headers: { 'content-type': typ, 'content-range': `bytes ${start}-${ende}/${groesse}`, 'accept-ranges': 'bytes', 'content-length': String(ende - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(f)), { headers: { 'content-type': typ, 'content-length': String(groesse), 'accept-ranges': 'bytes' } });
  });
}
protocol.registerSchemesAsPrivileged([{ scheme: 'glowline', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

const sendeHoerer = new Set(); // z. B. das Terminal (Studio-Fortschritt)
function sende(kanal, ...a) {
  if (win && !win.isDestroyed()) win.webContents.send(kanal, ...a);
  for (const h of sendeHoerer) { try { h(kanal, a[0]); } catch {} }
  if (kanal === 'studio') link.studioEreignis(a[0]); // Fortschritt von Link-Auftraegen an den Laptop
}

ipcMain.handle('pty:spawn', async (_e, o) => {
  const id = naechsteId++;
  const tab = 't' + id;
  const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : HOME;
  const { file, args, env, fehlt } = await baueBefehl(o.tool, o.model, tab);
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols || 120, rows: o.rows || 30, cwd, env, useConpty: true });
  // Ausgabe buendeln, damit schnelle Modelle das Fenster nicht mit IPC fluten
  let puffer = '', geplant = false, ende = '';
  p.onData((d) => {
    // Werkzeug wurde eben installiert: Oberflaeche startet es neu
    if (fehlt) { ende = (ende + d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-300); if (ende.includes(FERTIG_MARKE)) { ende = ''; setTimeout(() => sende('werkzeug:installiert', id, fehlt), 400); } }
    puffer += d;
    if (geplant) return;
    geplant = true;
    setTimeout(() => { sende('pty:data', id, puffer); puffer = ''; geplant = false; }, 8);
  });
  p.onExit(({ exitCode }) => { ptys.delete(id); setTimeout(() => sende('pty:exit', id, exitCode), 20); });
  ptys.set(id, p);
  if (o.model) cfg.defaultModel = o.model;
  if (o.tool && o.tool !== 'shell') cfg.defaultTool = o.tool;
  if (o.cwd) cfg.lastDir = cwd;
  speichereConfig();
  return { id, tab, cwd, fehlt };
});
ipcMain.on('pty:write', (_e, id, d) => { const p = ptys.get(id); if (p) p.write(d); });
ipcMain.on('pty:resize', (_e, id, c, r) => { const p = ptys.get(id); if (p && c > 0 && r > 0) try { p.resize(c, r); } catch {} });
// ganzen Baum beenden: manche Werkzeuge (z. B. Cline) laufen sonst nach dem Wechsel im Hintergrund weiter
function ptyWeg(p) {
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
  try { p.kill(); } catch {}
}
ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); if (p) { ptys.delete(id); ptyWeg(p); } });

ipcMain.handle('models:list', () => modellListe(true));
ipcMain.handle('tools:check', () => werkzeugeInstalliert());
ipcMain.handle('konten:status', () => konten.status());
ipcMain.handle('konten:setzen', (_e, id, wert) => { konten.setzeSchluessel(id, wert); return konten.status(); });
ipcMain.on('link:oeffnen', (_e, url) => { if (/^https:\/\/[\w.-]+\//.test(String(url))) shell.openExternal(url); });
ipcMain.on('chat:senden', (_e, a) => chatSenden({ ...a, ordner: null }));
ipcMain.handle('auto:rollen', async (_e, neu) => ({ rollen: await autoChat.rollen(!!neu), namen: autoChat.NAME }));
ipcMain.handle('auto:setzen', (_e, rolle, id) => {
  if (!autoChat.ROLLEN.includes(rolle)) return;
  cfg.autoRollen = { ...(cfg.autoRollen || {}), [rolle]: typeof id === 'string' ? id : '' };
  speichereConfig();
  autoChat.vergiss();
});
// Empfohlenes Modell je Rolle passend zum PC (gleiche Stufen wie die Express-Einrichtung)
const SEHEN_STUFE = { schnell: ['qwen3-vl:4b', 3.3], mittel: ['qwen3-vl:8b', 6.1], stark: ['qwen3-vl:30b', 19.6] };
function empfehlungFuer(stufe) {
  const st = einrichtung.STUFEN[stufe] || einrichtung.STUFEN.schnell;
  const h = einrichtung.HELFER.normal, c = st.coder.normal, dk = st.denker.normal, v = SEHEN_STUFE[stufe] || SEHEN_STUFE.schnell;
  return {
    schnell: { name: h[0], gb: h[1], variante: einrichtung.varianteVon(h) },
    coder: { name: c[0], gb: c[1], variante: einrichtung.varianteVon(c) },
    denker: { name: dk[0], gb: dk[1], variante: einrichtung.varianteVon(dk) },
    sehen: { name: v[0], gb: v[1] },
  };
}
ipcMain.handle('auto:empfehlung', async () => {
  const sys = await einrichtung.system();
  const tags = await fetch(cfg.backends.ollama + '/api/tags', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
  const namen = new Set(((tags && tags.models) || []).map((m) => m.name));
  const da = (n) => n && (namen.has(n) ? n : namen.has(n + ':latest') ? n + ':latest' : null);
  const rollen = {};
  for (const [r, e] of Object.entries(empfehlungFuer(sys.empfohlen))) {
    const vorhanden = da(e.variante) || da(e.name);
    rollen[r] = { name: e.name, gb: e.gb, id: vorhanden ? 'ollama,' + vorhanden : null };
  }
  return {
    stufe: (einrichtung.STUFEN[sys.empfohlen] || {}).name || '', ollama: !!tags,
    pc: [sys.gpu ? `${sys.gpu.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')} ${Math.round(sys.gpu.vram)} GB` : 'no NVIDIA GPU', `${Math.round(sys.ram)} GB RAM`].join(' · '),
    rollen,
  };
});
// "Saved costs" fuer Bilder, Videos und Stimme: jedes lokal erzeugte Ergebnis zaehlen (Cloud-Auftraege kosten ja wirklich)
const studioAuftragEcht = studio.auftrag;
studio.auftrag = async (a, ...rest) => {
  const r = await studioAuftragEcht(a, ...rest);
  try {
    const m = studio.KATALOG[a && a.modell];
    const n = r && !r.fehler && Array.isArray(r.dateien) ? r.dateien.length : 0;
    if (m && !m.wolke && n) {
      statistik.medien(m.art, n);
      const z = { bild: 0, videoSek: 0, zeichen: 0, ...(cfg.medienZaehler || {}) };
      if (m.art === 'bild') z.bild += n;
      else if (m.art === 'video') z.videoSek += Math.max(1, Math.min(10, +a.sekunden || 5));
      else if (m.art === 'stimme') z.zeichen += String(a.prompt || '').length;
      cfg.medienZaehler = z;
      speichereConfig();
      sende('kosten', z);
    }
  } catch {}
  return r;
};
ipcMain.on('chat:stopp', (_e, id) => { const ac = chats.get(id); if (ac) ac.abort(); });
ipcMain.handle('lmstudio:start', () => lmServerStarten());

// Installer von Ollama / LM Studio per Knopf in den Downloads-Ordner (abgebrochene Downloads machen weiter)
const INSTALLER = {
  ollama: { url: 'https://ollama.com/download/OllamaSetup.exe', datei: 'OllamaSetup.exe' },
  lmstudio: { url: 'https://lmstudio.ai/download/latest/win32/x64', datei: 'LM-Studio-Setup.exe' },
};
const installer = new Map(); // id -> { geladen, gesamt, datei, fertig, fehler, ac }
function installerStand(id) {
  const s = installer.get(id);
  return s ? { id, geladen: s.geladen, gesamt: s.gesamt, datei: s.datei ? path.basename(s.datei) : null, fertig: !!s.fertig, fehler: s.fehler || null, laeuft: !!s.ac } : { id };
}
async function installerHolen(id) {
  const q = INSTALLER[id];
  if (!q || (installer.get(id) || {}).ac) return installerStand(id);
  const ac = new AbortController();
  const s = { geladen: 0, gesamt: 0, ac };
  installer.set(id, s);
  const melde = () => sende('installer', installerStand(id));
  melde();
  let zuletzt = 0;
  try {
    const test = process.env.GLOWLINE_TEST;
    const url = test && process.env.GLOWLINE_TEST_INSTALLER ? process.env.GLOWLINE_TEST_INSTALLER + '/' + id : q.url;
    // erst nachschauen, wie die Datei heisst (LM Studio leitet auf die aktuelle Version weiter)
    const kopf = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'Glowline' } });
    if (!kopf.ok) throw new Error(`Download failed (HTTP ${kopf.status})`);
    const name = path.basename(new URL(kopf.url).pathname);
    s.datei = path.join(test || app.getPath('downloads'), /^[\w.-]+\.exe$/i.test(name) ? name : q.datei);
    s.gesamt = +kopf.headers.get('content-length') || 0;
    let da = 0;
    try { da = fs.statSync(s.datei).size; } catch {}
    // liegt schon komplett im Ordner: nicht nochmal laden
    if (!da || (s.gesamt && da !== s.gesamt)) {
      await studio.ladeDatei(url, s.datei, ac, (g, t) => {
        s.geladen = g;
        if (t) s.gesamt = t;
        if (Date.now() - zuletzt > 400) { zuletzt = Date.now(); melde(); }
      }, { 'user-agent': 'Glowline' });
    }
    s.geladen = s.gesamt;
    s.fertig = true;
  } catch (e) {
    s.fehler = ac.signal.aborted ? 'Cancelled' : `Download failed – ${String((e && e.message) || e).slice(0, 160)}`;
  }
  s.ac = null;
  melde();
  return installerStand(id);
}
// Express-Einrichtung, wenn winget fehlt oder scheitert: Ollama-Setup selbst laden und still installieren
// (installiert sich fuer den aktuellen Nutzer, ohne Adminrechte)
async function ollamaStillInstallieren(ac, status) {
  const stopp = () => { const s = installer.get('ollama'); if (s && s.ac) s.ac.abort(); };
  ac.signal.addEventListener('abort', stopp, { once: true });
  const t = setInterval(() => {
    const s = installer.get('ollama');
    if (s && s.gesamt) status(`Downloading Ollama · ${(s.geladen / 1e9).toFixed(1)} of ${(s.gesamt / 1e9).toFixed(1)} GB`, Math.min(99, Math.round((s.geladen / s.gesamt) * 100)));
  }, 500);
  let st;
  try { st = await installerHolen('ollama'); } finally { clearInterval(t); ac.signal.removeEventListener('abort', stopp); }
  if (ac.signal.aborted) throw new Error('cancelled');
  if (!st.fertig) throw new Error(st.fehler || 'Download failed');
  status('Installing Ollama…', null);
  const datei = installer.get('ollama').datei;
  await new Promise((ok) => {
    const p = spawn(datei, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], { windowsHide: true });
    const weg = () => { try { p.kill(); } catch {} };
    ac.signal.addEventListener('abort', weg, { once: true });
    p.on('error', ok);
    p.on('close', () => { ac.signal.removeEventListener('abort', weg); ok(); });
  });
}
ipcMain.handle('installer:holen', (_e, id) => installerHolen(id));
// ---------- Glowline Link ----------
ipcMain.handle('link:stand', async () => (LINK_APP ? { app: true, ...(await link.laptopStand()) } : { app: false, ...link.stand() }));
ipcMain.handle('link:teilen', (_e, an) => (LINK_APP ? null : link.teilen(!!an)));
ipcMain.handle('link:neu', () => (LINK_APP ? null : link.neuKoppeln()));
ipcMain.handle('link:suchen', () => link.suchen());
ipcMain.handle('link:koppeln', async (_e, host, code) => {
  if (!LINK_APP) throw new Error('only in Glowline Link');
  const v = await link.koppeln(host, code);
  sende('config', cfg);
  return v;
});
ipcMain.handle('link:wecken', () => (LINK_APP ? link.wecken() : false));
// PC: mit Windows starten (unsichtbar im Infobereich), damit ein Laptop ihn aufwecken und gleich benutzen kann
function autostart(an) {
  if (LINK_APP) return false;
  if (typeof an === 'boolean' && !process.env.GLOWLINE_TEST) app.setLoginItemSettings({ openAtLogin: an, path: process.execPath, args: ['--tray'] });
  if (typeof an === 'boolean' && process.env.GLOWLINE_TEST) cfg.testAutostart = an;
  return process.env.GLOWLINE_TEST ? !!cfg.testAutostart : app.getLoginItemSettings({ path: process.execPath, args: ['--tray'] }).openAtLogin;
}
ipcMain.handle('link:autostart', (_e, an) => autostart(an));
ipcMain.handle('link:trennen', () => { if (LINK_APP) { link.trennen(); sende('config', cfg); } return true; });
ipcMain.handle('installer:stand', (_e, id) => installerStand(id));
// Auto-Update (update.js)
// Nacht-Warteschlange (nacht.js)
// Stats-Seite (statistik.js)
ipcMain.handle('statistik:stand', () => statistik.stand());
ipcMain.on('statistik:zaehle', (_e, x) => statistik.zaehle(x));
// Spracheingabe (hoeren.js, Parakeet auf dem Prozessor) – auch in Glowline Link
ipcMain.handle('hoeren:stand', () => hoeren.stand());
ipcMain.handle('hoeren:holen', (_e, id) => hoeren.holen(id));
ipcMain.handle('hoeren:entfernen', () => hoeren.entfernen());
ipcMain.handle('hoeren:schreiben', (_e, wav) => hoeren.schreiben(wav));
ipcMain.on('hoeren:abbrechen', () => hoeren.abbrechen());
// Filmemacher (nur auf dem PC: braucht die eigene Grafikkarte)
const nurPc = () => { if (LINK_APP) throw new Error('The film maker runs on your PC'); };
ipcMain.handle('film:liste', () => (LINK_APP ? [] : film.liste()));
ipcMain.handle('film:laden', (_e, id) => (LINK_APP ? null : film.lade(String(id))));
ipcMain.handle('film:bedarf', (_e, id) => (LINK_APP ? [] : film.bedarf(id ? String(id) : null)));
ipcMain.handle('film:planen', (_e, o) => { nurPc(); return film.planen(o || {}); });
ipcMain.handle('film:aendern', (_e, id, neu) => { nurPc(); return film.aendern(String(id), neu); });
ipcMain.handle('film:loeschen', (_e, id) => { nurPc(); return film.loeschen(String(id)); });
ipcMain.on('film:machen', (_e, id) => { if (!LINK_APP) film.machen(String(id)); });
ipcMain.on('film:abbrechen', (_e, id) => { if (!LINK_APP) film.abbrechen(String(id)); });
ipcMain.handle('film:nacht', (_e, id) => {
  nurPc();
  const f = film.lade(String(id));
  if (!f) throw new Error('Film not found');
  return nacht.dazu({ film: f.id }, { titel: f.titel });
});
ipcMain.handle('nacht:stand', () => (LINK_APP ? null : nacht.stand()));
ipcMain.handle('nacht:dazu', (_e, a) => { if (LINK_APP) throw new Error('The night queue runs on your PC'); return nacht.dazu(a); });
ipcMain.handle('nacht:weg', (_e, nr) => nacht.weg(String(nr)));
ipcMain.handle('nacht:aufraeumen', () => nacht.aufraeumen());
ipcMain.handle('nacht:zeiten', (_e, s, e) => nacht.zeiten(s, e));
ipcMain.handle('nacht:jetzt', () => nacht.jetztStarten());
ipcMain.handle('nacht:stopp', () => nacht.stoppen());
ipcMain.handle('update:stand', () => update.stand());
ipcMain.handle('update:pruefen', () => update.pruefen().catch((e) => ({ ...update.stand(), fehler: String((e && e.message) || e) })));
ipcMain.handle('update:jetzt', () => update.jetzt());
ipcMain.on('installer:abbrechen', (_e, id) => { if (id === 'update') return update.abbrechen(); const s = installer.get(id); if (s && s.ac) s.ac.abort(); });
ipcMain.on('installer:oeffnen', (_e, id) => { const s = installer.get(id); if (s && s.fertig) shell.openPath(s.datei); });
ipcMain.on('installer:zeigen', (_e, id) => { const s = installer.get(id); if (s && s.datei) shell.showItemInFolder(fs.existsSync(s.datei) ? s.datei : path.dirname(s.datei)); });
ipcMain.handle('models:load', (_e, id, laden) => modellLaden(id, laden));
ipcMain.on('download:start', (_e, d) => herunterladen(d));
ipcMain.on('download:cancel', (_e, key) => { const ac = downloads.get(key); if (ac) ac.abort(); });
ipcMain.handle('hf:search', (_e, q) => hfSuche(q));
ipcMain.handle('hf:files', (_e, repo) => hfDateien(repo));
ipcMain.handle('studio:status', async () => { if (studio.frisch) await studio.frisch(true); return studio.status(); });
ipcMain.on('studio:einrichten', () => studio.einrichten());
ipcMain.on('studio:modell', (_e, id) => studio.modellHolen(id));
ipcMain.on('studio:abbrechen', (_e, v) => studio.abbrechen(v));
ipcMain.on('studio:auftrag', (_e, a) => studio.auftrag({ ...a, id: 'ui' + String(a.id || Date.now()), vonAgent: false }, vramFrei));
ipcMain.handle('studio:galerie', () => studio.galerie());
ipcMain.handle('studio:waehle', async (_e, art) => {
  const filter = art === 'audio' ? [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }]
    : art === 'bildvideo' ? [{ name: 'Images and videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm'] }]
      : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filter });
  if (r.canceled) return null;
  freigegeben.add(path.resolve(r.filePaths[0]));
  return r.filePaths[0];
});
ipcMain.on('studio:freigeben', (_e, f) => { if (typeof f === 'string' && /\.(png|jpe?g|webp|mp4|webm|wav|mp3|flac|ogg|m4a)$/i.test(f)) freigegeben.add(path.resolve(f)); });
// von Cowork erstellte Dateien: oeffnen (nur ansehbare Typen, Skripte nie ausfuehren) und im Ordner zeigen
const eigeneDatei = (f) => (typeof f === 'string' && (cfg.erstellteDateien || []).includes(path.resolve(f).toLowerCase()) && fs.existsSync(f) ? path.resolve(f) : null);
ipcMain.on('datei:oeffnen', (_e, f) => { const p = eigeneDatei(f); if (p && dateien.ANSEHEN.test(p)) shell.openPath(p); });
ipcMain.on('datei:zeigen', (_e, f) => { const p = eigeneDatei(f); if (p) shell.showItemInFolder(p); });
ipcMain.on('studio:zeigen', (_e, f) => { if (f && studio.inAusgabe(f)) shell.showItemInFolder(f); else if (!f) { fs.mkdirSync(studio.P().ausgabe, { recursive: true }); shell.openPath(studio.P().ausgabe); } });
ipcMain.handle('studio:wegwerfen', async (_e, f) => { if (!studio.inAusgabe(f)) return false; await shell.trashItem(f); return true; });
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('einrichtung:system', () => einrichtung.system(true));
ipcMain.handle('einrichtung:plan', (_e, wahl) => einrichtung.plan(wahl));
ipcMain.handle('einrichtung:start', (_e, wahl) => einrichtung.starten(wahl));
ipcMain.handle('einrichtung:stand', () => einrichtung.stand());
ipcMain.on('einrichtung:abbrechen', () => einrichtung.abbrechen());
ipcMain.handle('config:set', (_e, patch) => { Object.assign(cfg, mische(cfg, patch)); speichereConfig(); return cfg; });
ipcMain.handle('dir:pick', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: start || cfg.lastDir, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.on('clip:write', (_e, t) => clipboard.writeText(t));
ipcMain.on('win:title', (_e, t) => { if (win) win.setTitle(t); });

// ---------- Fenster ----------
// Oberflaeche passend zum Bildschirm vergroessern: auf grossen Bildschirmen mit 100 % Skalierung
// wirkt 13-px-Schrift sonst winzig (1920 px breit -> 115 %, Laptop -> 100 %)
function zoomAuto() {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  return Math.min(1.3, Math.max(1, Math.round((wa.width / 1650) * 20) / 20));
}
const zoomJetzt = () => (typeof cfg.zoom === 'number' ? cfg.zoom : zoomAuto());
function setzeZoom() {
  if (!win || win.isDestroyed()) return;
  const z = zoomJetzt();
  win.webContents.setZoomFactor(z);
  // Fensterknoepfe oben rechts gleich hoch wie die (mitgewachsene) Titelzeile
  try { win.setTitleBarOverlay({ color: '#0e0e0e', symbolColor: '#cfccc7', height: Math.round(36 * z) }); } catch {}
}

// ---------- Fenster: Startart, Schliessen, Infobereich ----------
let wirklichBeenden = false, tray = null;
function startFenster() {
  // gerade nach einem Update neu gestartet: so wieder aufgehen, wie das Fenster vorher war
  const nu = cfg.nachUpdate;
  if (nu) {
    delete cfg.nachUpdate; speichereConfig();
    if (Date.now() - (nu.zeit || 0) < 10 * 60 * 1000 && ['vollbild', 'gross', 'normal', 'minimiert', 'tray'].includes(nu.art)) { startFenster.grenzen = nu.grenzen; return nu.art; }
  }
  if (['vollbild', 'gross', 'normal', 'minimiert'].includes(cfg.startFenster)) return cfg.startFenster;
  return cfg.startVollbild === false ? 'gross' : 'vollbild';
}
// vor dem Neustart fuers Update: Fensterzustand merken (startFenster nimmt ihn beim naechsten Start)
function merkeFensterFuerUpdate() {
  const da = win && !win.isDestroyed();
  const art = !da || !win.isVisible() ? 'tray' : win.isMinimized() ? 'minimiert' : win.isFullScreen() ? 'vollbild' : win.isMaximized() ? 'gross' : 'normal';
  cfg.nachUpdate = { zeit: Date.now(), art, grenzen: da ? win.getNormalBounds() : null };
  speichereConfig();
}
function normalGroesse() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = Math.round(wa.width * 0.72), h = Math.round(wa.height * 0.78);
  return { x: wa.x + Math.round((wa.width - b) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: b, height: h };
}
function zeigeFenster() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
function trayAnlegen() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'build', 'icon.ico'));
  tray.setToolTip(LINK_APP ? 'Glowline Link' : 'Glowline');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ' + (LINK_APP ? 'Glowline Link' : 'Glowline'), click: zeigeFenster },
    { type: 'separator' },
    { label: 'Quit', click: () => { wirklichBeenden = true; app.quit(); } },
  ]));
  tray.on('click', zeigeFenster);
}
function inDenTray() {
  trayAnlegen();
  if (win.isFullScreen()) { win.once('leave-full-screen', () => win.hide()); win.setFullScreen(false); } else win.hide();
  if (!cfg.trayHinweis) {
    cfg.trayHinweis = true;
    speichereConfig();
    try { tray.displayBalloon({ title: 'Glowline keeps running', content: 'Click the icon to open it again. Right-click → Quit to close it for real.' }); } catch {}
  }
}

function fenster() {
  // Startet fast bildschirmfuellend: nur ein schmaler Rand rundherum, damit die runden Ecken sichtbar bleiben
  const RAND = 10;
  const wa = screen.getPrimaryDisplay().workArea;
  const test = !!process.env.GLOWLINE_TEST;
  win = new BrowserWindow({
    x: test ? 0 : wa.x + RAND, y: test ? 0 : wa.y + RAND,
    width: test ? +(process.env.GLOWLINE_TEST_B || 1900) : wa.width - 2 * RAND, height: test ? +(process.env.GLOWLINE_TEST_H || 1012) : wa.height - 2 * RAND,
    minWidth: 640, minHeight: 360,
    show: false,
    backgroundColor: '#0e0e0e',
    title: LINK_APP ? 'Glowline Link' : 'Glowline',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    roundedCorners: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e0e', symbolColor: '#cfccc7', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      offscreen: !!process.env.GLOWLINE_TEST,
    },
  });
  Menu.setApplicationMenu(null);
  // Fenster bleibt immer Glowline: eine daneben fallen gelassene Datei oder ein Link ersetzt sonst die ganze App
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Testmodus: Fenster ausserhalb des Bildschirms, ohne Fokus und ohne Taskleiste
  if (process.env.GLOWLINE_TEST) win.webContents.on('paint', (_e, _d, bild) => { win.letztesBild = bild; });
  else win.once('ready-to-show', () => {
    // mit Windows gestartet: unsichtbar im Infobereich (Link-Teilen laeuft trotzdem)
    if (process.argv.includes('--tray')) { trayAnlegen(); return; }
    const art = startFenster(), grenzen = startFenster.grenzen;
    if (grenzen) win.setBounds(grenzen); // nach einem Update: wieder an derselben Stelle
    if (art === 'tray') { trayAnlegen(); return; }
    if (art === 'normal') { win.setBounds(grenzen || normalGroesse()); win.show(); }
    else if (art === 'gross') { win.maximize(); win.show(); }
    else if (art === 'minimiert') win.minimize();
    else { win.show(); win.setFullScreen(true); }
  });
  // X oben rechts: je nach Einstellung beenden, minimieren oder im Infobereich weiterlaufen
  win.on('close', (e) => {
    if (wirklichBeenden || (test && !process.env.GLOWLINE_TEST_FENSTER)) return;
    if (cfg.beimSchliessen === 'minimieren') { e.preventDefault(); win.minimize(); }
    else if (cfg.beimSchliessen === 'tray') { e.preventDefault(); inDenTray(); }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), test ? { query: { test: '1' } } : undefined);
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F12') win.webContents.toggleDevTools();
    // F11 = Vollbild wie im Windows Terminal (Titelzeile verschwindet, nur Terminal + Leiste)
    if (i.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    // Strg + / Strg - / Strg 0: Oberflaeche groesser, kleiner, automatisch
    if (i.control && !i.alt && ['+', '=', '-', '0'].includes(i.key)) {
      e.preventDefault();
      const z = i.key === '0' ? null : Math.round(Math.min(1.6, Math.max(0.8, zoomJetzt() + (i.key === '-' ? -0.05 : 0.05))) * 100) / 100;
      cfg.zoom = z;
      speichereConfig();
      setzeZoom();
      sende('zoom', Math.round(zoomJetzt() * 100));
    }
  });
  win.webContents.on('did-finish-load', setzeZoom);
  win.on('moved', () => { if (!cfg.zoom) setzeZoom(); });
  // Schliessen aus Versehen: nachfragen, solange im Studio etwas laeuft
  win.on('close', (e) => {
    if (process.env.GLOWLINE_TEST || (!wirklichBeenden && ['minimieren', 'tray'].includes(cfg.beimSchliessen))) return; // laeuft ja weiter
    const b = studio.beschaeftigt();
    const ein = einrichtung.laeuft();
    const inst = [...installer.values()].some((x) => x.ac);
    if (!b.auftraege && !b.laden && !ein && !inst) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Keep open', 'Close anyway'], defaultId: 0, cancelId: 0, noLink: true,
      message: b.auftraege ? 'Studio is still generating' : ein ? 'The setup is still installing' : b.laden ? 'A Studio download is still running' : 'An installer is still downloading',
      detail: b.auftraege ? 'Closing Glowline cancels the running job.' : ein ? 'You can open the setup again later (Models → Express setup), finished parts are kept.' : 'You can resume the download later, it continues where it stopped.',
    });
    if (r === 0) { e.preventDefault(); wirklichBeenden = false; }
  });
  win.on('enter-full-screen', () => sende('vollbild', true));
  win.on('leave-full-screen', () => sende('vollbild', false));
}

// Test: Studio-Auftraege aus dem Chat nur vorspielen (ohne Grafikkarte); Ergebnis = vorhandene Datei aus der Galerie
function chatStudioAttrappe() {
  const ende = { bild: /\.png$/i, upscale: /\.png$/i, video: /\.mp4$/i, stimme: /\.wav$/i };
  return {
    ...studio,
    status: () => {
      const s = studio.status();
      for (const m of Object.values(s.modelle)) m.da = !(process.env.GLOWLINE_TEST_ATTRAPPE === 'ohnevideo' && m.art === 'video');
      return { ...s, eingerichtet: true };
    },
    auftrag: async (a) => {
      const art = studio.KATALOG[a.modell].art;
      const kopf = { vorgang: 'auftrag:' + a.id, art, modell: a.modell, prompt: a.prompt || '', vonChat: true, vonFilm: !!a.vonFilm };
      console.log('ATTRAPPE', JSON.stringify({ ...a, prompt: String(a.prompt || '').slice(0, 140) }));
      for (const p of [0, 40, 80]) {
        sende('studio', { ...kopf, prozent: p, text: 'Generating' });
        await new Promise((ok) => setTimeout(ok, 500));
      }
      const g = studio.galerie().map((x) => x.datei);
      const f = g.find((x) => ende[art].test(x)) || g[0]; // kein Beispiel dieser Art: irgendeine Datei
      const r = f ? { dateien: [f] } : { fehler: 'no sample file' };
      sende('studio', { ...kopf, fertig: true, ...r });
      return r;
    },
  };
}

// Unsichtbarer Selbsttest: GLOWLINE_TEST=<Ordner fuer Bilder>, Fenster bleibt verborgen
async function testLauf(ordner) {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const bild = async (name) => { win.webContents.invalidate(); await warte(300); if (win.letztesBild) fs.writeFileSync(path.join(ordner, name + '.png'), win.letztesBild.toPNG()); };
  // warten, bis die Oberflaeche wirklich geladen ist (gebaute .exe startet beim ersten Mal langsamer)
  for (let i = 0; i < 60 && !(await js('!!window.glowlineBereit').catch(() => false)); i++) await warte(500);
  await warte(1000);
  await bild('1-start');
  if (process.env.GLOWLINE_TEST_NUR === 'studio') {
    // GLOWLINE_TEST_STUDIO=bild,upscale,video,stimme: welche Auftraege wirklich laufen sollen
    const was = String(process.env.GLOWLINE_TEST_STUDIO || '').split(',').filter(Boolean);
    // GLOWLINE_TEST_GROESSE=1280x720: kleineres Fenster (z. B. Laptop) pruefen
    if (process.env.GLOWLINE_TEST_GROESSE) { const [b, h] = process.env.GLOWLINE_TEST_GROESSE.split('x').map(Number); win.setContentSize(b, h); await warte(800); }
    const warteAuftrag = async (max) => {
      for (let i = 0; i < max * 2; i++) {
        const l = await js(`(() => { const l = laufenderAuftrag(); return l ? JSON.stringify({ f: !!l.fertig, t: l.text, p: l.prozent, e: l.fehler || null, d: l.dateien || null, z: l.dauer || null }) : 'null'; })()`);
        const o = JSON.parse(l);
        if (o && o.f) return o;
        if (i % 20 === 0) console.log('  ...', l);
        await warte(500);
      }
      return 'TIMEOUT';
    };
    for (const b of ['bild', 'video', 'upscale', 'stimme']) {
      await js(`zeigeStudio('${b}')`);
      await warte(1500);
      await bild('s-' + b);
      console.log('BEREICH', b, await js(`[...document.querySelectorAll('.s-modell')].map((m) => m.querySelector('b').textContent + ' [' + (m.querySelector('.s-m-status, .m-knopf') || {}).textContent + ']').join(' | ') + ' | Knopf: ' + (document.querySelector('#studio-los') ? document.querySelector('#studio-los').title || 'bereit' : document.querySelector('.s-einrichten b') && 'EINRICHTEN')`));
    }
    console.log('MENUE', await js(`(document.querySelector('#tool-chip').click(), [...document.querySelectorAll('#tools [data-studio] b')].map((x) => x.textContent).join(' | '))`));
    await warte(600);
    await bild('s-menue');
    await js(`schliesseMenues()`);
    if (process.env.GLOWLINE_TEST_MODELL) {
      await js(`zeigeStudio('bild'); setzeChatModell(${JSON.stringify(process.env.GLOWLINE_TEST_MODELL)}); sz.felder.bild.prompt = 'ein Leuchtturm im Sturm bei Nacht'; zeichneStudio(); document.querySelector('.s-verbessern').click()`);
      for (let i = 0; i < 120 && (await js('!!sz.verbessern')); i++) await warte(500);
      console.log('VERBESSERT', (await js('sz.felder.bild.prompt')).slice(0, 300));
      await bild('s-verbessert');
    }
    if (was.includes('bild')) {
      const t0 = Date.now();
      await js(`zeigeStudio('bild'); sz.felder.bild.prompt = sz.felder.bild.prompt.length > 40 ? sz.felder.bild.prompt : 'A lighthouse on a cliff in a storm at night, huge waves, dramatic light beam, cinematic photo'; sz.felder.bild.format = 1; zeichneStudio(); starte()`);
      await warte(3000);
      await bild('s-bild-laeuft');
      const r = await warteAuftrag(600);
      console.log('BILD', JSON.stringify(r), Math.round((Date.now() - t0) / 1000) + 's');
      await warte(1500);
      await bild('s-bild-fertig');
      // gleich nochmal: Motor ist jetzt warm
      const t1 = Date.now();
      await js(`starte()`);
      console.log('BILD2', JSON.stringify(await warteAuftrag(300)), Math.round((Date.now() - t1) / 1000) + 's');
    }
    if (was.includes('upscale')) {
      await js(`(() => { const g = sz.galerie.find((x) => x.datei.includes(String.fromCharCode(92) + 'bild' + String.fromCharCode(92))); sz.felder.upscale.bild = g ? g.datei : null; })(); zeigeStudio('upscale')`);
      await warte(1000);
      await js(`starte()`);
      console.log('UPSCALE', JSON.stringify(await warteAuftrag(300)));
      await warte(1500);
      await bild('s-upscale-fertig');
    }
    if (was.includes('video')) {
      const t0 = Date.now();
      await js(`zeigeStudio('video'); sz.felder.video.prompt = 'A red fox runs through deep snow at sunset, slow tracking shot, golden light, cinematic'; sz.felder.video.format = 3; sz.felder.video.sekunden = 2; zeichneStudio(); starte()`);
      await warte(5000);
      await bild('s-video-laeuft');
      console.log('VIDEO', JSON.stringify(await warteAuftrag(1800)), Math.round((Date.now() - t0) / 1000) + 's');
      await warte(2500);
      await bild('s-video-fertig');
    }
    if (was.includes('stimme')) {
      await js(`zeigeStudio('stimme'); sz.felder.stimme.prompt = 'Hallo! Das ist ein kurzer Test der neuen Stimme in Glowline.'; zeichneStudio(); starte()`);
      console.log('STIMME', JSON.stringify(await warteAuftrag(1200)));
      await warte(1500);
      await bild('s-stimme-fertig');
    }
    if (was.includes('menue')) {
      // Menue aus dem Terminal heraus: Gruppen zu; dann Workspace aufklappen
      await js(`zeigeTerminal(); document.querySelector('#tool-chip').click()`);
      await warte(600);
      await bild('m-zu');
      await js(`document.querySelectorAll('#tools [data-modus]').length`);
      await warte(400);
      await bild('m-workspace');
      console.log('MENUE2', await js(`[...document.querySelectorAll('#tools > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.querySelector('b').textContent).join(' | ')`));
      await js(`schliesseMenues()`);
      // gespielter laufender Auftrag: Verbessern-Knopf gesperrt, danach wieder frei
      console.log('VERBESSERN', await js(`(() => { zeigeStudio('bild'); sz.auftraege.set('auftrag:test', { vorgang: 'auftrag:test', fertig: false }); zeichneStudio(); const a = document.querySelector('.s-verbessern').disabled; sz.auftraege.get('auftrag:test').fertig = true; zeichneStudio(); return 'laeuft=' + a + ' danach=' + document.querySelector('.s-verbessern').disabled; })()`));
    }
    if (was.includes('format')) {
      // Klick neben die Format-Knoepfe darf das Format nicht aendern
      await js(`zeigeStudio('bild')`);
      await warte(1200);
      console.log('FORMAT', await js(`(() => { sz.felder.bild.format = 1; zeichneStudio(); const box = document.querySelector('.s-formate'); const r = box.getBoundingClientRect(); const ziel = document.elementFromPoint(r.right + 30, r.top + r.height / 2); ziel.click(); box.parentElement.click(); const z = [...document.querySelectorAll('.s-feld')].map((x) => x.tagName.toLowerCase() + ':' + x.firstChild.textContent).join(' '); return 'format=' + sz.felder.bild.format + ' | ' + z; })()`));
    }
    if (was.includes('loeschen')) {
      // "Sure?" bleibt stehen, waehrend nebenbei ein Modell laedt (Video-Bereich, Karte nicht sichtbar)
      await js(`zeigeStudio('bild')`);
      await warte(1200);
      await js(`sz.auswahl = { datei: sz.galerie.find((g) => /\.png$/.test(g.datei)).datei }; zeichneStudio(); [...document.querySelectorAll('.s-buehne .m-knopf')].find((b) => b.textContent === 'Delete').click()`);
      for (const pr of [11, 12, 13]) { win.webContents.send('studio', { vorgang: 'modell:z-image', prozent: pr }); await warte(300); }
      const a1 = await js(`[...document.querySelectorAll('.s-buehne .m-knopf')].map((b) => b.textContent).join(',')`);
      await js(`zeichneStudio()`);
      const a2 = await js(`[...document.querySelectorAll('.s-buehne .m-knopf')].map((b) => b.textContent).join(',')`);
      await warte(4500);
      const a3 = await js(`[...document.querySelectorAll('.s-buehne .m-knopf')].map((b) => b.textContent).join(',')`);
      console.log('LOESCHEN', a1, '|', a2, '|', a3);
      // Laengen-Regler im Video-Bereich: Download-Fortschritt darf ihn nicht neu bauen
      await js(`zeigeStudio('video')`);
      await warte(1200);
      await js(`document.querySelector('#studio-links input[type=range]').merker = 1`);
      for (const pr of [14, 15, 16]) { win.webContents.send('studio', { vorgang: 'modell:z-image', prozent: pr }); await warte(300); }
      console.log('REGLER', await js(`document.querySelector('#studio-links input[type=range]').merker === 1 ? 'bleibt' : 'NEU GEBAUT'`));
      win.webContents.send('studio', { vorgang: 'modell:z-image', fertig: true, fehler: 'cancelled' });
      await warte(500);
    }
    if (was.includes('sicher')) {
      // Cancel braucht zwei Klicks (gespielter Auftrag, nichts laeuft wirklich)
      await js(`zeigeStudio('bild')`);
      await warte(1200);
      console.log('STANDARD', await js(`document.querySelector('.s-formate .an').textContent`));
      await js(`window.__abgebrochen = []; const alt = window.api.studioAbbrechen; window.api.studioAbbrechen = (v) => window.__abgebrochen.push(v); window.__altAbbrechen = alt; sz.auftraege.set('auftrag:spiel', { vorgang: 'auftrag:spiel', art: 'bild', text: 'Generating', prozent: 30, start: Date.now() }); sz.auswahl = { vorgang: 'auftrag:spiel' }; zeichneStudio()`).catch((e) => console.log('ERR', e.message));
      const klick = () => js(`(() => { const b = document.querySelector('.s-lauf .m-knopf'); b.click(); return b.textContent + '/' + window.__abgebrochen.length; })()`);
      const k1 = await klick();
      await bild('s-cancel-sicher');
      const k2 = await klick();
      console.log('CANCEL', k1, k2);
      await js(`sz.auftraege.delete('auftrag:spiel'); sz.auswahl = null; zeichneStudio()`);
    }
    if (was.includes('expressknopf')) {
      await js(`oeffneBib('meine')`);
      await warte(1500);
      await bild('k-bib');
      await js(`document.querySelector('#bib-express').click()`);
      await warte(2500);
      const sicht = () => js(`[!document.querySelector('#bib').classList.contains('versteckt'), !document.querySelector('#einrichtung').classList.contains('versteckt'), cfg.einrichtung || '-'].join(',')`);
      console.log('KNOPF offen', await sicht());
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await warte(800);
      console.log('KNOPF esc', await sicht());
    }
    if (was.includes('ohneollama')) {
      await js(`zeigeEinrichtung()`);
      await warte(2500);
      console.log('OHNE START', await js(`[...document.querySelectorAll('.ein-chip')].map((c) => c.textContent).join(' / ')`));
      await js(`document.querySelector('.ein-wahl .ein-karte').click()`);
      await warte(2500);
      for (const t of ['bild', 'video', 'stimme', 'upscale']) { await js(`document.querySelector('[data-teil=${t}]').click()`); await warte(700); }
      console.log('OHNE ZEILEN', await js(`[...document.querySelectorAll('#ein-inhalt .ein-zeile')].map((z) => z.querySelector('b').textContent + ' = ' + z.querySelector('.ein-gb').textContent).join(' | ') + ' || ' + document.querySelector('.ein-summe').textContent`));
      await bild('o-express');
      await js(`document.querySelector('#ein-los').click()`);
      for (let i = 0; i < 60; i++) { await warte(1000); if (await js(`!!(ein.stand && ein.stand.fertig)`)) break; }
      console.log('OHNE FERTIG', await js(`JSON.stringify(ein.stand.schritte.map((x) => x.titel + ':' + x.status + (x.fehler ? '(' + x.fehler + ')' : ''))) + ' | ' + document.querySelector('#ein-lauf-summe').textContent + ' | retry=' + !document.querySelector('#ein-nochmal').classList.contains('versteckt') + ' | cfg=' + cfg.einrichtung + ',' + cfg.defaultModel`));
      console.log('OHNE INSTALLER', await js(`[...document.querySelectorAll('#ein-inhalt .inst')].map((z) => z.textContent).join(' | ') || 'keiner'`));
      await bild('o-fertig');
    }
    if (was.includes('befehlecht')) {
      await js(`zeigeWorkspace('auto'); chat.verlaeufe.auto = []; chat.fest = ''; zeichneChat()`);
      for (const t of ['/code what is 2+2? answer in one line', 'frag lfm3: sag hallo in einem wort']) {
        await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`);
        for (let i = 0; i < 240 && (await js('!!chat.laeuft')); i++) await warte(500);
        console.log('ECHT', t, '->', await js(`JSON.stringify((() => { const n = verlauf().slice(-1)[0]; return { rolle: n.rolle || '', modell: n.modell, text: String(n.content || n.fehler).slice(0, 80) }; })())`), '| user:', await js(`verlauf().slice(-2)[0].content`));
      }
    }
    if (was.includes('kosten')) {
      // Saved costs: Tabs je Bereich, Studio-Zaehler kommen vom Hauptprozess
      await js(`zeigeTerminal(); cfg.kosten = { coding: { modell: 'sonnet', preis: { name: 'Claude Sonnet', eingabe: 3, cache: 0.3, ausgabe: 15 }, tokens: { neu: 1000000, cache: 0, ausgabe: 100000 } } }; zeichneLeiste()`);
      win.webContents.send('kosten', { bild: 5, videoSek: 20, zeichen: 3000 });
      await warte(400);
      await js(`document.querySelector('#f-gespart').click()`);
      await warte(400);
      console.log('KOSTEN TABS', await js(`[...document.querySelectorAll('#p-tabs button')].map((b) => b.textContent).join(',')`), '| gesamt', await js(`document.querySelector('#p-gesamt').textContent`));
      for (const t of ['coding', 'denken', 'chat', 'bild', 'video', 'stimme']) {
        await js(`kostenTab = '${t}'; zeichnePreise()`);
        await warte(200);
        if (t === 'bild') await bild('kosten-bild');
        console.log('KOSTEN', t, await js(`document.querySelector('#p-titel').textContent + ' | ' + [...document.querySelectorAll('#p-liste b')].map((b) => b.textContent).join(',') + ' | ' + document.querySelector('#p-summe').textContent`));
      }
      // eigener Preis fuer Video
      await js(`kostenTab = 'video'; zeichnePreise(); const i = document.querySelector('#p-je'); i.value = '0.5'; i.dispatchEvent(new Event('input'))`);
      console.log('KOSTEN EIGEN', await js(`document.querySelector('#p-summe').textContent + ' | ' + document.querySelector('#p-gesamt').textContent + ' | leiste ' + document.querySelector('#gespart').textContent`));
      await bild('kosten-video');
    }
    if (was.includes('cowork')) {
      // Cowork = ein Knopf, Ordner in der Leiste, Rollen im Modellfenster, festes/genanntes Modell
      await js(`zeigeTerminal(); zeichneLeiste()`);
      await warte(500);
      console.log('CW ORDNER', await js(`getComputedStyle(document.querySelector('#ordner-chip')).display + ' ' + document.querySelector('#ordner-name').textContent`));
      await js(`document.querySelector('#tool-chip').click()`);
      await warte(500);
      await bild('cw-menue');
      console.log('CW MENUE', await js(`[...document.querySelectorAll('#tools > button:not(.unter):not(.aus) b, #tools > .klapp b')].map((b) => b.textContent).join(' | ')`));
      await js(`document.querySelector('#tools [data-modus]').click()`);
      await warte(800);
      console.log('CW CHAT', await js(`'modi=' + document.querySelector('#chat-modi').classList.contains('versteckt') + ' rollen=' + document.querySelector('#chat-rollen').classList.contains('versteckt') + ' ordner=' + getComputedStyle(document.querySelector('#ordner-chip')).display + ' titel=' + document.querySelector('#titel-text').textContent`));
      await bild('cw-chat');
      await js(`document.querySelector('#chat-modelle').click()`);
      await warte(2500);
      await bild('cw-modelle');
      console.log('CW ROLLEN', await js(`[...document.querySelectorAll('#auto-rollen .rolle')].map((r) => r.querySelector('b').textContent + '=' + r.querySelector('select').selectedOptions[0].textContent).join(' | ')`));
      console.log('CW GENANNT', await js(`['frag gemma: was ist 2+2', 'ask kat-coder to fix this', 'mach das mit dem Bild', 'mit python', 'hallo'].map((t) => t + ' -> ' + (genanntesModell(t) || '-')).join(' | ')`));
      await js(`schliesseBib(); setzeChatModell(${JSON.stringify(process.env.GLOWLINE_TEST_MODELL || 'lfm3:1.7b')})`);
      await warte(500);
      await bild('cw-fest');
      console.log('CW FEST', await js(`document.querySelector('#chat-rollen').textContent + ' | ' + document.querySelector('#chat-text').placeholder`));
      await js(`[...document.querySelectorAll('#chat-rollen button')][0].click()`);
      await warte(300);
      console.log('CW ZURUECK', await js(`chat.fest + '|' + document.querySelector('#chat-rollen').classList.contains('versteckt')`));
      // Befehle
      const tippe = (t) => js(`(() => { const x = document.querySelector('#chat-text'); x.focus(); x.value = ${JSON.stringify('X')}.replace('X', ${JSON.stringify(t)}); x.dispatchEvent(new Event('input')); })()`);
      await tippe('/');
      await warte(300);
      console.log('CW VORSCHLAG /', await js(`document.querySelectorAll('#chat-befehle button').length + ' sichtbar=' + !document.querySelector('#chat-befehle').classList.contains('versteckt')`));
      await tippe('/th');
      await warte(300);
      await bild('cw-befehle');
      console.log('CW VORSCHLAG /th', await js(`[...document.querySelectorAll('#chat-befehle b')].map((b) => b.textContent).join(',')`));
      for (const t of ['/help', '/goal learn Python basics', '/thinking on', '/model gemma', '/auto', '/xyz']) {
        await tippe(t);
        await js(`sendeChat()`);
        await warte(400);
        console.log('CW BEFEHL', t, '->', await js(`(document.querySelector('#chat-rollen').textContent || '-') + ' | fest=' + chat.fest + ' denken=' + chat.immerDenken + ' ziel=' + chat.ziel + ' | letzte=' + ((verlauf().slice(-1)[0] || {}).content || '').slice(0, 60).split(String.fromCharCode(10)).join(' ')`));
      }
      await bild('cw-status');
      await js(`document.querySelector('#chat-modelle').click()`);
      await warte(3500);
      await bild('cw-empfehlung');
      console.log('CW EMPF', await js(`document.querySelector('.rollen-pc') ? document.querySelector('.rollen-pc').textContent : '-'`), '||', await js(`[...document.querySelectorAll('#auto-rollen .rolle')].map((r) => r.querySelector('b').textContent + ': ' + ((r.querySelector('.rolle-empf') || {}).textContent || '-') + ' ' + ((r.querySelector('.rolle-empf-name') || {}).textContent || '')).join(' | ')`));
    }
    if (was.includes('profi')) {
      // Advanced-Modus: Schalter, Felder je Bereich, Werte landen im Auftrag (Auftrag wird nur abgefangen)
      await js(`zeigeStudio('video'); cfg.studioProfi = false; zeichneStudio()`);
      await warte(800);
      console.log('PROFI AUS', await js(`!!document.querySelector('.s-profi') + ' felder=' + document.querySelectorAll('.s-profi-felder input').length`));
      await js(`document.querySelector('.s-profi input').click()`);
      await warte(500);
      await bild('p-video');
      console.log('PROFI VIDEO', await js(`[...document.querySelectorAll('.s-profi-felder label')].map((l) => l.querySelector('span').textContent + '=' + l.querySelector('input').placeholder).join(' | ')`));
      for (const b of ['bild', 'upscale', 'stimme']) {
        await js(`zeigeStudio('${b}')`);
        await warte(600);
        console.log('PROFI', b, await js(`[...document.querySelectorAll('.s-profi-felder label span')].map((x) => x.textContent).join(', ') || 'keine'`));
      }
      await bild('p-upscale');
      // Werte eintragen und den Auftrag ansehen statt starten
      const echtAuftrag = studio.auftrag;
      let gefangen = null;
      studio.auftrag = (x) => { gefangen = x; return Promise.resolve({ fehler: 'cancelled' }); };
      await js(`zeigeStudio('video'); sz.felder.video.prompt = 'test'; zeichneStudio(); const s = (k, v) => { const i = document.querySelector('[data-k="profi-' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input')); }; s('sekunden', 8); s('schritte', 99); s('fps', 16); document.querySelector('#studio-los').click()`);
      await warte(500);
      studio.auftrag = echtAuftrag;
      console.log('PROFI AUFTRAG', JSON.stringify(gefangen));
      console.log('PROFI WF', JSON.stringify((() => { const wf = studio.workflowTest({ modell: 'wan22-5b', prompt: 'x', breite: 1280, hoehe: 704, sekunden: 8, schritte: 99, fps: 16, cfg: 'abc' }); return { length: wf[6].inputs.length, steps: wf[8].inputs.steps, cfg: wf[8].inputs.cfg, fps: wf[10].inputs.fps }; })()));
    }
    if (was.includes('videoupscale')) {
      // echtes Video aus der Galerie hochskalieren (Grafikkarte!)
      const v = process.env.GLOWLINE_TEST_VIDEO ? { datei: process.env.GLOWLINE_TEST_VIDEO } : studio.galerie().find((x) => /\.mp4$/i.test(x.datei) && !/[\\/]upscale[\\/]/.test(x.datei));
      if (process.env.GLOWLINE_TEST_VIDEO) freigegeben.add(path.resolve(v.datei));
      console.log('VUP QUELLE', v && v.datei.split(/[\\/]/).pop());
      await js(`zeigeStudio('video'); sz.auswahl = { datei: ${JSON.stringify(v ? v.datei : '')} }; zeichneStudio()`);
      await warte(1200);
      console.log('VUP KNOEPFE', await js(`[...document.querySelectorAll('.s-aktionen button')].map((b) => b.textContent).join(',')`));
      await js(`[...document.querySelectorAll('.s-aktionen button')].find((b) => b.textContent === 'Upscale →').click()`);
      await warte(1200);
      await bild('v-upscale-feld');
      console.log('VUP FELD', await js(`document.querySelector('.s-datei video') ? 'video da' : 'kein video'`), await js(`(document.querySelector('#studio-los') || {}).textContent`));
      const t0 = Date.now();
      const r = await studio.auftrag({ id: 'vup' + Date.now(), modell: 'esrgan-x4', bildDatei: v.datei }, vramFrei);
      console.log('VUP ERGEBNIS', JSON.stringify(r), ((Date.now() - t0) / 1000).toFixed(0) + 's');
    }
    if (was.includes('anpassen')) {
      // Werkzeug-Menue anpassen: nur Codex + Claude Code, Codex zuerst; ueberlebt einen Neustart
      const sichtbar = () => js(`[...document.querySelectorAll('#tools > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.querySelector('b').textContent).join(' | ')`);
      await js(`zeigeTerminal(); document.querySelector('#tool-chip').click()`);
      await warte(500);
      console.log('ANP START', await sichtbar());
      await js(`document.querySelector('#tools-anpassen-knopf').click()`);
      await warte(400);
      await bild('t-anpassen');
      console.log('ANP LISTE', await js(`[...document.querySelectorAll('.anp-zeile span')].map((x) => x.textContent).join(' | ')`));
      for (const name of ['OpenCode', 'Antigravity', 'More agents', 'Cowork', 'Studio']) await js(`[...document.querySelectorAll('.anp-zeile')].find((z) => z.querySelector('span').textContent === ${JSON.stringify(name)}).querySelector('input').click()`);
      await js(`[...document.querySelectorAll('.anp-zeile')].find((z) => z.querySelector('span').textContent === 'Codex').querySelectorAll('button')[0].click()`);
      await warte(300);
      await bild('t-angepasst');
      await js(`[...document.querySelectorAll('.tools-fuss button')].find((b) => b.textContent === 'Done').click()`);
      await warte(300);
      console.log('ANP DANACH', await sichtbar());
      await bild('t-menue-neu');
      await js('location.reload()');
      await warte(4000);
      await js(`document.querySelector('#tool-chip').click()`);
      await warte(500);
      console.log('ANP NEUSTART', await sichtbar());
      await js(`document.querySelector('#tools-anpassen-knopf').click(); [...document.querySelectorAll('.tools-fuss button')].find((b) => b.textContent === 'Reset').click(); [...document.querySelectorAll('.tools-fuss button')].find((b) => b.textContent === 'Done').click()`);
      console.log('ANP RESET', await sichtbar());
      await js(`schliesseMenues()`);
    }
    if (was.includes('auto')) {
      // Auto-Chat: Rollen anzeigen, je Nachricht das passende Modell (Studio wird mit GLOWLINE_TEST_ATTRAPPE vorgespielt)
      const letzte = () => js(`(() => { const v = verlauf(); const n = v[v.length - 1]; return JSON.stringify({ rolle: n.rolle, modell: n.modell, text: String(n.fehler || n.content || '').replace(/[ \\n]+/g, ' ').slice(0, 110), denken: !!n.denken, art: n.medien && n.medien.art }); })()`);
      const fertig = async () => { for (let i = 0; i < 240; i++) { await warte(500); if (await js('!chat.laeuft')) break; } await warte(300); return letzte(); };
      const sag = async (t) => { await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`); return fertig(); };
      console.log('AUTO SELBST', JSON.stringify(Object.fromEntries(Object.entries(await autoChat.rollen(true)).map(([k, v]) => [k, v.id]))));
      await js(`zeigeWorkspace('auto')`);
      await warte(2500);
      console.log('AUTO LEISTE', await js(`[...document.querySelectorAll('#chat-rollen .rolle')].map((r) => r.querySelector('span').textContent + '=' + r.querySelector('select').selectedOptions[0].textContent).join(' | ')`));
      console.log('AUTO MENUE', await js(`(document.querySelector('#tool-chip').click(), [...document.querySelectorAll('#tools [data-modus] b, #tools [data-studio] b')].map((x) => x.textContent).join(' | '))`));
      await js(`schliesseMenues()`);
      await bild('a-leer');
      console.log('AUTO HALLO', await sag('Hi, wie geht es dir?'));
      console.log('AUTO CSS', await sag('Wie mache ich in CSS ein div mittig?'));
      console.log('AUTO NACHFRAGE', await sag('und wenn es nur waagerecht sein soll?'));
      console.log('AUTO MATHE', await sag('Löse: 2x + 7 = 3x - 5'));
      console.log('AUTO DANKE', await sag('danke!'));
      await bild('a-text');
      await js(`chat.anhang = ${JSON.stringify((studio.galerie().find((x) => /\.png$/i.test(x.datei)) || {}).datei || '')}; zeichneAnhang()`);
      console.log('AUTO SEHEN', await sag('Was ist auf dem Bild?'));
      console.log('AUTO SEHEN2', await sag('Welche Farben kommen darin vor?'));
      console.log('AUTO BILD', await sag('Erstelle ein Bild von einem Hund am Strand'));
      await bild('a-ende');
      console.log('AUTO LEISTE MODELL', await js(`document.querySelector('#modell-name').textContent`));
      const vorher = await js('verlauf().length');
      await js('location.reload()');
      await warte(4000);
      console.log('AUTO NACH NEUSTART', await js(`chat.modus + ' ' + (chat.verlaeufe.auto || []).length`), 'vorher', vorher);
      await js(`zeigeWorkspace()`);
      await warte(1500);
      await bild('a-neustart');
    }
    if (was.includes('datei')) {
      // Cowork legt Dateien an (gegen den Ollama-Nachbau, config.json im Testordner zeigt auf ihn)
      const ziel = process.env.GLOWLINE_TEST_DATEIORDNER;
      const letzte = () => js(`(() => { const n = verlauf()[verlauf().length - 1]; return JSON.stringify({ rolle: n.rolle, text: String(n.fehler || n.content || '').slice(0, 90), datei: n.datei && { ordner: n.datei.ordner, geaendert: n.datei.geaendert, dateien: (n.datei.dateien || []).map((f) => f.name + ' ' + f.groesse) } }); })()`);
      const sag = async (t, befehl) => {
        await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`);
        let zwischen = null;
        for (let i = 0; i < 120; i++) { await warte(100); if (!zwischen) zwischen = await js(`(() => { const n = chat.antwort; return n && n.datei && n.datei.status ? n.datei.status : null; })()`); if (await js('!chat.laeuft')) break; }
        await warte(300);
        return (zwischen ? '[unterwegs: ' + zwischen + '] ' : '') + (await letzte());
      };
      await js(`zeigeWorkspace('auto')`);
      await warte(2500);
      console.log('DATEI FRAGE', await sag('Was ist eine HTML-Datei?'));
      console.log('DATEI NEU', await sag(`Erstelle in ${ziel} eine HTML-Datei mit einem kleinen Hüpfspiel`));
      console.log('DATEI INHALT', fs.readFileSync(path.join(ziel, 'hopser-spiel.html'), 'utf8').includes('background:black'));
      await bild('d-neu');
      console.log('DATEI AENDERN', await sag('mach den Hintergrund blau'));
      console.log('DATEI INHALT2', fs.readFileSync(path.join(ziel, 'hopser-spiel.html'), 'utf8').includes('background:blue'), fs.readdirSync(ziel).join(','));
      console.log('DATEI BEFEHL', await sag(`/file zwei dateien in ${ziel}`));
      console.log('DATEI ORDNER', fs.readdirSync(ziel).join(','), fs.existsSync(path.join(ziel, 'notizen', 'liste.md')));
      console.log('DATEI KNOEPFE', await js(`[...document.querySelectorAll('.datei-zeile')].map((z) => z.querySelector('b').textContent + ':' + [...z.querySelectorAll('button')].map((b) => b.textContent).join('/')).join(' | ')`));
      console.log('DATEI MODELL SIEHT', await js(`JSON.stringify(verlauf().filter((n) => !n.lokal).map(fuerModell).slice(-1)[0].content.slice(0, 120))`));
      // fremde Datei wird nie ueberschrieben, Oeffnen nur fuer eigene
      console.log('DATEI EIGENE', JSON.stringify(cfg.erstellteDateien.map((p) => path.basename(p))), eigeneDatei(path.join(ziel, 'hopser-spiel.html')) ? 'eigen' : 'fremd', eigeneDatei('C:\\Windows\\win.ini') ? 'FEHLER' : 'win.ini fremd');
      await bild('d-ende');
    }
    if (was.includes('ansicht')) {
      // alle Ansichten fotografieren (Groessen-Check)
      await js(`zeigeTerminal()`); await warte(800); await bild('a-terminal');
      await js(`document.querySelector('#tool-chip').click()`); await warte(500); await bild('a-tools'); await js(`schliesseMenues()`);
      await js(`document.querySelector('#modell-chip').click()`); await warte(500); await bild('a-modelle'); await js(`schliesseMenues()`);
      await js(`starteSitzung({ modus: 'auto' })`).catch(() => {}); await warte(1500); await bild('a-chat');
      for (const t of ['meine', 'laden', 'konten', 'cowork']) { await js(`oeffneBib('${t}')`).catch((e) => console.log('BIB', e.message)); await warte(1000); await bild('a-bib-' + t); }
      await js(`schliesseBib()`).catch(() => {});
      // Downloads-Tab mit nachgestellten Eintraegen
      await js(`downloads.set('ollama|test/Qwen3-8B-GGUF|Q4_K_M', { ziel: 'ollama', repo: 'test/Qwen3-8B-GGUF', quant: 'Q4_K_M', status: 'pulling', completed: 2.1e9, total: 5.0e9 });
        sz.laden.set('modell:test', { prozent: 37, text: 'model.safetensors' });
        ein.stand = { fertig: false, schritte: [{ titel: 'Claude Code', info: 'Anthropic coding agent', status: 'fertig' }, { titel: 'Codex', info: 'OpenAI coding agent', status: 'laeuft', text: 'added 12 packages', prozent: 0 }, { titel: 'Coder', info: 'qwen3.5:9b', status: 'wartet', gb: 6.6 }] };
        dlAktualisieren(); oeffneBib('downloads'); 1`);
      await warte(1500); await bild('a-bib-downloads');
      console.log('DL', await js(`[...document.querySelectorAll('.dl-zeile')].map((z) => z.querySelector('b').textContent + ' [' + z.querySelector('.dl-stand').textContent + ']').join(' | ') + ' | chip: ' + document.querySelector('#dl-chip-text').textContent`));
      await js(`downloads.clear(); sz.laden.clear(); ein.stand = null; schliesseBib(); dlAktualisieren(); 1`);
      await warte(1000);
      console.log('DL NACHHER', await js(`document.querySelector('#dl-chip').className`));
      // Leiste: kommen Download- und Update-Knopf dazu, bleibt der Modell-Knopf ganz zu sehen (dafuer fallen Werte weg)
      {
        win.unmaximize();
        const [b0, h0] = win.getSize();
        const erg = [];
        for (const b of [1900, 1300, 1000, 700]) {
          win.setSize(b, h0); await warte(500);
          await js(`$('#update-chip').classList.remove('versteckt'); $('#update-text').textContent = 'Restart to update (9.9.9)'; $('#dl-chip').classList.remove('versteckt'); $('#dl-chip-text').textContent = '2 downloads · 45%'; 1`);
          await warte(400);
          erg.push(b + ':' + await js(`(() => { const w = $('#leiste .werte').getBoundingClientRect(), m = $('#modell-chip').getBoundingClientRect(); return (m.right <= w.right + 1 && m.width > 60 ? 'ok' : 'ab' + Math.round(m.right - w.right)) + '/' + document.querySelectorAll('#leiste .eng-weg').length; })()`));
          if (b === 1300) await bild('a-leiste-eng');
        }
        await js(`$('#update-chip').classList.add('versteckt'); $('#dl-chip').classList.add('versteckt'); 1`);
        win.setSize(b0, h0); await warte(600);
        const zurueck = await js(`document.querySelectorAll('#leiste .eng-weg').length`);
        console.log('ANSICHT LEISTE', erg.every((x) => x.includes(':ok')) && zurueck === 0 ? 'ok' : 'FEHLT', erg.join(' '), 'danach weg=' + zurueck);
      }
      await js(`zeigeEinrichtung()`); await warte(5000); await bild('a-ein-start');
      await js(`ein.seite = 'express'; zeichneEinrichtung()`); await warte(800); await bild('a-ein-express');
      await js(`document.querySelector('#ein-inhalt').scrollTop = 9999`); await warte(300); await bild('a-ein-express2');
      await js(`schliesseEinrichtung()`);
      console.log('ANSICHT fertig', await js(`window.innerWidth + 'x' + window.innerHeight`));
    }
    if (was.includes('start')) {
      // Start-App + Vollbild-Schalter
      for (const st of ['cowork', 'studio', 'codex', '']) {
        await js(`cfg.startMit = '${st}'; startAnsicht(); 1`); await warte(1500);
        console.log('START', st || 'zuletzt', '->', await js(`ansicht + ' ' + (sitzung ? sitzung.tool : '-')`));
      }
      // Claude Code: eigene Statuszeile des Nutzers ausblenden (disableAllHooks), sonst nichts abschalten
      {
        const alt = process.env.CLAUDE_CONFIG_DIR, ordner = path.join(app.getPath('userData'), 'cc-test');
        fs.mkdirSync(ordner, { recursive: true });
        process.env.CLAUDE_CONFIG_DIR = ordner;
        const datei = path.join(app.getPath('userData'), 'claude-settings.json');
        const liesEinst = async () => { fs.rmSync(datei, { force: true }); const b = await baueBefehl('claude', 'ollama,fake-coder:7b', 'tx'); return b.fehlt || !fs.existsSync(datei) ? null : JSON.parse(fs.readFileSync(datei, 'utf8')); };
        fs.writeFileSync(path.join(ordner, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo x' } }));
        const mit = await liesEinst();
        fs.writeFileSync(path.join(ordner, 'settings.json'), '{}');
        const ohne = await liesEinst();
        if (alt === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = alt;
        console.log('START CLAUDE STATUSZEILE', !mit ? 'kein claude' : mit.disableAllHooks === true && !mit.statusLine && ohne.disableAllHooks === undefined ? 'ok' : 'FEHLT ' + JSON.stringify([mit, ohne]));
      }
      // letzte Terminal-Zeile immer gleich weit ueber der Leiste, egal wie hoch das Fenster ist
      win.unmaximize();
      for (const h of [700, 733, 761, 790]) {
        win.setSize(1100, h); await warte(600);
        console.log('START ABSTAND', h, await js(`(() => { const s = term.element.querySelector('.xterm-screen').getBoundingClientRect(), t = $('#terms').getBoundingClientRect(); return 'unten ' + Math.round(t.bottom - s.bottom) + 'px | Zelle ' + term._core._renderService.dimensions.css.cell.height.toFixed(1) + ' | oben ' + term.element.style.paddingTop + ' | Zeilen ' + term.rows; })()`));
      }
      await bild('start-terminal');
      await js(`zeigeTerminal(); document.querySelector('#tool-chip').click(); document.querySelector('#tools-anpassen-knopf').click(); 1`); await warte(600); await bild('start-anpassen');
      console.log('START MENUE', await js(`[...document.querySelectorAll('#tools-anpassen .anp-zeile span')].slice(0, 4).map((x) => x.textContent).join(' | ') + ' | fenster=' + document.querySelectorAll('#tools-anpassen select')[1].value + ' | schliessen=' + document.querySelectorAll('#tools-anpassen select')[3].value`));
      await js(`schliesseMenues()`);
    }
    if (was.includes('stats')) {
      await js(`oeffneBib('stats')`); await warte(1500); await bild('st-stats');
      console.log('STATS', await js(`[...document.querySelectorAll('.stats-karte')].map((k) => k.children[0].textContent + '=' + k.children[1].textContent).join(' | ')`));
      console.log('STATS HEAT', await js(`document.querySelectorAll('.stats-heat i').length + ' Felder, ' + document.querySelectorAll('.stats-heat i.s4').length + ' s4, monate ' + [...document.querySelectorAll('.stats-monate span')].filter((x) => x.textContent).length`));
      await js(`schliesseBib()`);
    }
    if (was.includes('terminal')) {
      // Terminal-Version (gl): Server + echtes Terminal im eingebauten Fenster, Tasten werden getippt
      const tj = path.join(app.getPath('userData'), 'terminal.json');
      const k = fs.existsSync(tj) ? JSON.parse(fs.readFileSync(tj, 'utf8')) : null;
      console.log('TERMINAL JSON', k ? Object.keys(k).join(',') : 'fehlt');
      const ohne = await fetch(`http://127.0.0.1:${k.port}/info`).then((r) => r.status).catch((e) => e.message);
      const mit = await fetch(`http://127.0.0.1:${k.port}/info`, { headers: { 'x-glowline': k.schluessel } }).then((r) => r.json()).catch((e) => ({ fehler: e.message }));
      console.log('TERMINAL API', 'ohne Schluessel=' + ohne, '| version=' + mit.version, '| modelle=' + (mit.modelle || []).length);
      console.log('TERMINAL CMD', JSON.stringify(terminal.cmdDatei('C:/Pro gramm/Glowline.exe', 'C:/x/cli.js', 'C:/a%b/terminal.json')));
      await js(`zeigeTerminal(); starteSitzung({ tool: 'shell', cwd: ${JSON.stringify(ordner)} })`); await warte(3000);
      const id = await js('sitzung.id');
      const p = ptys.get(id);
      let roh = '', gesamt = '';
      p.onData((x) => { roh += x; gesamt += x; });
      const tippe = async (t, ms = 600) => { p.write(t); await warte(ms); };
      const sauber = () => roh.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const cli = cliPfad();
      console.log('TERMINAL CLI DA', fs.existsSync(cli));
      // wie nach der Installation: gl.cmd im bin-Ordner (GLOWLINE_TEST_CLI_DIREKT=1: ohne cmd dazwischen)
      fs.writeFileSync(path.join(ordner, 'gl.cmd'), terminal.cmdDatei(process.execPath, cli, tj));
      const start = process.env.GLOWLINE_TEST_CLI_DIREKT ? `$env:ELECTRON_RUN_AS_NODE=1; & '${process.execPath}' '${cli}' --api '${tj}'` : `& '${path.join(ordner, 'gl.cmd')}'`;
      await tippe(`$env:GLOWLINE_CLI_LOG='${path.join(ordner, 'cli.log')}'; ${start}\r`, 5000);
      await bild('t-start');
      console.log('TERMINAL KOPF', /╭─/.test(sauber()) && /Glowline \d/.test(sauber()) && !/Glow-/.test(sauber()) && /help for all commands/.test(sauber()) ? 'ok' : 'FEHLT', '| eingabe=' + /Ask anything/.test(sauber()));
      // ganz schmal: Kopf ohne Glim und Rahmen, danach wieder mit Glim
      {
        const [c0, r0] = [p.cols, p.rows];
        roh = '';
        p.resize(40, 24); await warte(2500); await bild('t-schmal');
        // nur der Neuaufbau in der schmalen Breite zaehlt (davor wiederholt Windows kurz das alte Bild)
        const schmal = sauber().slice(Math.max(0, sauber().lastIndexOf('Glowline ')));
        roh = '';
        p.resize(c0, r0); await warte(2500);
        console.log('TERMINAL SCHMAL', /Glowline \d/.test(schmal) && !/[▀▄]/.test(schmal) && /[▀▄]/.test(sauber()) ? 'ok' : 'FEHLT: ' + [/Glowline \d/.test(schmal), !/[▀▄]/.test(schmal), /[▀▄]/.test(sauber())].join(' ') + ' ' + (schmal.match(/.{0,40}[▀▄].{0,40}/) || [''])[0]);
      }
      // Leertaste halten = sprechen: Glowline nimmt auf (im Test ein Testton), der erkannte Text landet in der Eingabe
      {
        const altText = process.env.GLOWLINE_TEST_HOEREN_TEXT;
        process.env.GLOWLINE_TEST_HOEREN_TEXT = 'Hallo aus dem Mikrofon';
        // wie Windows: ein Leerzeichen, nach einer halben Sekunde ~30 pro Sekunde, bis die Taste oben ist
        const halten = async (n, mitte) => { p.write(' '); await warte(500); for (let i = 0; i < n; i++) { p.write(' '); await warte(33); if (i === 20 && mitte) await mitte(); } };
        roh = '';
        await tippe('Hi', 300);
        let hoert = false;
        await halten(40, async () => { hoert = /Listening/.test(sauber()); await bild('t-sprechen'); });
        await warte(2500); await bild('t-sprechen2');
        const nach = sauber();
        console.log('TERMINAL SPRECHEN', hoert && /Hi Hallo aus dem Mikrofon/.test(nach) && !/Hi {2,}/.test(nach.slice(nach.lastIndexOf('Hi Hallo'))) ? 'ok' : 'FEHLT: hoert=' + hoert + ' ' + nach.replace(/\s+/g, ' ').slice(-300));
        // normal getippte Leerzeichen bleiben Leerzeichen
        await tippe('\x15', 300);
        roh = '';
        for (const z of ['a', ' ', 'b', ' ', 'c', ' ', ' ', 'd']) { p.write(z); await warte(90); }
        await warte(800);
        console.log('TERMINAL LEERZEICHEN', /a b c  d/.test(sauber()) && !/Listening|Starting the microphone/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-200));
        // Esc beim Sprechen: nichts eintragen, bis zum Loslassen keine neue Aufnahme
        await tippe('\x15', 300);
        roh = '';
        await halten(40, async () => { p.write('\x1b'); await warte(150); });
        await warte(1500);
        const weg = sauber();
        console.log('TERMINAL SPRECHEN ESC', /Recording cancelled/.test(weg) && !/Hallo aus dem Mikrofon/.test(weg) ? 'ok' : 'FEHLT: ' + weg.replace(/\s+/g, ' ').slice(-200));
        await tippe('\x15', 300);
        if (altText === undefined) delete process.env.GLOWLINE_TEST_HOEREN_TEXT; else process.env.GLOWLINE_TEST_HOEREN_TEXT = altText;
      }
      await tippe('Hallo, wer bist du?', 400); await bild('t-tippen');
      await tippe('\r', 7000); await bild('t-antwort');
      console.log('TERMINAL ANTWORT', /●/.test(sauber()) ? 'ok' : 'FEHLT', '| stat=' + /⎿/.test(sauber()));
      // Leiste unten: Werte wie im Fenster
      console.log('TERMINAL LEISTE', ['First token', 'Prefill', 'Prompt', 'Output', 'Turn', 'GPU power', 'VRAM', 'Saved costs', ' on Ollama'].every((x) => sauber().includes(x)) && /\d+\.\ds/.test(sauber()) && /\d+ tok/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-300));
      await tippe('/', 700); await bild('t-befehle');
      console.log('TERMINAL BEFEHLE', /\/help/.test(sauber()) && /\/think/.test(sauber()) ? 'ok' : 'FEHLT');
      await tippe('im', 500); await bild('t-befehle2');
      console.log('TERMINAL BEFEHLE GEFILTERT', /\/image/.test(sauber()) ? 'ok' : 'FEHLT');
      await tippe('\x7f\x7f\x7f', 300);
      await tippe('Zeig mir Markdown\r', 2500); await bild('t-markdown');
      console.log('TERMINAL MARKDOWN', ['Überschrift', '•', '╭─ python', '│ def hallo', 'Zitat'].map((x) => x + '=' + sauber().includes(x)).join(' '));
      roh = '';
      await tippe('/image a lighthouse at sunset\r', 9000); await bild('t-bild');
      console.log('TERMINAL BILD', /Image ready/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-300), '| vorschau=' + (roh.match(/▀/g) || []).length);
      roh = '';
      await tippe('/model\r', 2000); await bild('t-modelle');
      console.log('TERMINAL MODELLE', /Models/.test(sauber()) ? 'ok' : 'FEHLT');
      // /usage, /stats, /effort (mit ein paar gezaehlten Werten)
      statistik.zaehle({ tokens: 12000, ausgabe: 3000, dollar: 0.42, model: 'ollama,fake-coder:7b' });
      statistik.medien('bild', 2);
      roh = '';
      await tippe('/usage\r', 1200); await bild('t-usage');
      console.log('TERMINAL USAGE', /Usage/.test(sauber()) && /This chat/.test(sauber()) && /0\.42 \$/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-200));
      roh = '';
      await tippe('/stats\r', 1200); await bild('t-stats');
      console.log('TERMINAL STATS', /Stats/.test(sauber()) && /■/.test(sauber()) && /Favourite models .*fake-coder:7b \d+%/.test(sauber()) && /Studio \d+ images?/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-200));
      roh = '';
      await tippe('/effort high\r', 800);
      await tippe('/effort\r', 800);
      console.log('TERMINAL EFFORT', /› high/.test(sauber()) && /Effort high – every message goes to the reasoning model/.test(sauber()) ? 'ok' : 'FEHLT: high=' + /› high/.test(sauber()) + ' denken=' + /always thinking/.test(sauber()) + ' ' + sauber().replace(/[─\s]+/g, ' ').slice(-400));
      await tippe('/effort medium\r', 600);
      console.log('TERMINAL GESPART', /Saved costs/.test(gesamt.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) ? 'ok' : 'FEHLT');
      roh = '';
      await tippe('/autostart on\r', 1200); await bild('t-autostart');
      console.log('TERMINAL AUTOSTART', /starts with Windows/.test(sauber()) && cfg.testAutostart === true ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-200));
      await tippe('/autostart off\r', 1000);
      console.log('TERMINAL AUTOSTART AUS', cfg.testAutostart === false ? 'ok' : 'FEHLT');
      // Fenster kleiner ziehen: das Terminal-Programm muss es selbst merken (Electron meldet es nicht zuverlaessig)
      const logDatei = path.join(ordner, 'cli.log');
      const alt = [p.cols, p.rows];
      p.resize(100, 24); await warte(2500); await bild('t-klein');
      const logText = fs.existsSync(logDatei) ? fs.readFileSync(logDatei, 'utf8') : '';
      console.log('TERMINAL GROESSE', /neuAufbauen 100 24/.test(logText) ? 'ok' : 'FEHLT', '| start=' + ((/fenster (\d+ \d+)/.exec(logText) || [])[1]) + ' pty=' + alt.join('x'));
      p.resize(alt[0], alt[1]); await warte(2000);
      await tippe('/help\r', 1200); await bild('t-hilfe');
      roh = '';
      await tippe('Schreib eine sehr lange Geschichte\r', 2500); await bild('t-strom'); await tippe('\x1b', 1500); await bild('t-stopp');
      console.log('TERMINAL STOP', /Stopped|⎿/.test(sauber()) ? 'ok' : 'FEHLT', /Stopped/.test(sauber()) ? '(gestoppt)' : '(war schon fertig)');
      roh = '';
      await tippe('\x03', 300); await tippe('\x03', 1500); await bild('t-ende');
      console.log('TERMINAL ENDE', /Bye/.test(sauber()) ? 'ok' : 'FEHLT');
      // /update und /update now gegen ein nachgebautes GitHub (gl schliesst sich danach)
      {
        const inhalt = Buffer.alloc(2e6, 5), sha = require('crypto').createHash('sha256').update(inhalt).digest('hex');
        const srv = require('http').createServer((q, r) => {
          if (q.url === '/latest') return r.end(JSON.stringify({ tag_name: 'v9.9.9', body: '# Glowline 9.9.9\n\n## Neue Sachen\n\n- x\n\n## Download', assets: [{ name: 'Glowline-Setup-9.9.9.exe', size: inhalt.length, digest: 'sha256:' + sha, browser_download_url: `http://127.0.0.1:${srv.address().port}/dl` }] }));
          if (q.url === '/dl') { r.setHeader('content-length', inhalt.length); return r.end(inhalt); }
          r.statusCode = 404; r.end();
        });
        await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
        const vorher = process.env.GLOWLINE_TEST_UPDATE;
        process.env.GLOWLINE_TEST_UPDATE = `http://127.0.0.1:${srv.address().port}`;
        roh = '';
        await tippe(`${start}\r`, 6000); await bild('t-update-hinweis');
        console.log('TERMINAL UPDATE HINWEIS', /New update available: 9\.9\.9/.test(sauber()) ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-300));
        roh = '';
        await tippe('/update\r', 5000); await bild('t-update');
        console.log('TERMINAL UPDATE', /Updating to Glowline 9\.9\.9/.test(sauber()) && /Neue Sachen/.test(sauber()) && /Installing Glowline 9\.9\.9/.test(sauber()) && /type gl again/.test(sauber()) && update.stand().bereit ? 'ok' : 'FEHLT: ' + sauber().replace(/\s+/g, ' ').slice(-300));
        await warte(2000);
        if (vorher === undefined) delete process.env.GLOWLINE_TEST_UPDATE; else process.env.GLOWLINE_TEST_UPDATE = vorher;
        srv.close();
      }
      fs.writeFileSync(path.join(ordner, 'terminal.txt'), roh);
    }
    if (was.includes('sprache')) {
      // Spracheingabe: Einrichten (Fake-Server GLOWLINE_TEST_HOEREN_URL), Aufnahme (Testton statt Mikrofon), Text landet im Ziel
      await js(`zeigeWorkspace('auto')`); await warte(1200);
      console.log('SPRACHE STAND', JSON.stringify(await js(`window.api.hoerenStand()`)));
      await js(`document.querySelector('#chat-mic').click()`); await warte(700); await bild('h-einrichten');
      console.log('SPRACHE POPUP', await js(`document.querySelector('#hoeren-pop').classList.contains('versteckt') ? 'zu' : document.querySelector('#hoeren-pop').innerText.split(String.fromCharCode(10)).filter(Boolean).join(' | ')`));
      await js(`document.querySelector('.hp-karte[data-id="parakeet"]').click()`); await warte(4000); await bild('h-geladen');
      console.log('SPRACHE NACH LADEN', JSON.stringify(await js(`window.api.hoerenStand()`)), '|', await js(`document.querySelector('#hoeren-pop').classList.contains('versteckt') ? 'pop zu' : 'pop offen'`));
      await js(`document.querySelector('#chat-text').value = 'Hallo,'; document.querySelector('#chat-mic').click()`); await warte(1600); await bild('h-aufnahme');
      console.log('SPRACHE AUFNAHME', await js(`document.querySelector('#chat-mic').className + ' | pegel=' + (hz.aufnahme ? hz.aufnahme.pegel.toFixed(3) : '-')`));
      await js(`document.querySelector('#chat-mic').click()`); await warte(1500);
      console.log('SPRACHE TEXT', JSON.stringify(await js(`document.querySelector('#chat-text').value`)), '|', await js(`document.querySelector('#chat-mic').className`));
      // Strg+Shift+Leertaste startet, Esc bricht ab
      await js(`document.querySelector('#chat-text').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true })); 1`); await warte(1000);
      console.log('SPRACHE TASTE', await js(`hz.aufnahme ? 'nimmt auf' : 'aus'`));
      await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await warte(500);
      console.log('SPRACHE ESC', await js(`(hz.aufnahme ? 'nimmt noch' : 'abgebrochen') + ' | ' + JSON.stringify(document.querySelector('#chat-text').value)`));
      console.log('SPRACHE ANDERSWO', await js(`zeigeTerminal(); 1`) && await warte(800) || await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true })); hz.aufnahme ? 'nimmt (falsch)' : 'nichts (richtig)'`), await js(`document.querySelectorAll('.mic').length + ' Mikro-Knopf'`));
      // Menue-Zeile + Sprache
      await js(`zeigeTerminal(); document.querySelector('#tool-chip').click(); document.querySelector('#tools-anpassen-knopf').click(); 1`); await warte(600); await bild('h-menue');
      console.log('SPRACHE MENUE', await js(`[...document.querySelectorAll('#tools-anpassen .anp-zeile')].map((z) => z.innerText.split(String.fromCharCode(10)).join(' ')).filter((t) => /Voice|Speech/.test(t)).join(' | ')`));
      await js(`schliesseMenues()`);
      console.log('SPRACHE ZU KURZ', JSON.stringify(await js(`window.api.hoerenSchreiben(new Uint8Array(10))`)));
      // Ersteinrichtung laedt die Spracheingabe mit (hier nur sie, vom Test-Server)
      {
        hoeren.entfernen();
        const aus = { teile: { coder: false, denker: false, helfer: false, bild: false, video: false, stimme: false, upscale: false }, werkzeuge: { claude: false, codex: false, opencode: false } };
        const plan1 = await einrichtung.plan(aus);
        await einrichtung.starten(aus);
        for (let i = 0; i < 60 && !einrichtung.stand().fertig; i++) await warte(500);
        const st = einrichtung.stand();
        console.log('SPRACHE EINRICHTUNG', plan1.schritte.map((s) => s.titel + ':' + s.gb).join(',') === 'Voice input:0.68' && st.schritte.every((s) => s.status === 'fertig') && hoeren.stand().bereit ? 'ok' : 'FEHLT ' + JSON.stringify([plan1.schritte.map((s) => s.titel), st.schritte.map((s) => s.titel + ':' + s.status + (s.fehler || ''))]));
      }
    }
    if (was.includes('nacht')) {
      await js(`zeigeStudio('bild')`); await warte(1500);
      await js(`sz.felder.bild.prompt = 'a tree at night'; zeichneStudio(); document.querySelector('#studio-nacht').click()`); await warte(800);
      await js(`sz.felder.bild.prompt = 'a cat on the moon'; zeichneStudio(); document.querySelector('#studio-nacht').click()`); await warte(800);
      await bild('n-nacht');
      console.log('NACHT', await js(`document.querySelector('#s-nacht').innerText.split(String.fromCharCode(10)).filter(Boolean).join(' | ')`));
      await js(`[...document.querySelectorAll('.s-nacht-fuss button')].find((b) => b.textContent === 'Start now').click()`); await warte(6000);
      await bild('n-nacht-fertig');
      console.log('NACHT FERTIG', await js(`document.querySelector('#s-nacht').innerText.split(String.fromCharCode(10)).filter(Boolean).join(' | ')`));
      const st = JSON.parse(await js(`JSON.stringify(nachtStand.liste.map((e) => e.status))`));
      console.log('NACHT STATUS', st.join(','));
      await js(`[...document.querySelectorAll('.s-nacht-fuss button')].find((b) => b.textContent === 'Clear done').click()`); await warte(500);
      console.log('NACHT LEER', await js(`document.querySelector('#s-nacht').children.length`));
    }
    if (was.includes('film')) {
      // Filmemacher mit Attrappe: Drehbuch (GLOWLINE_TEST_FILM_ANTWORT), Szenen bearbeiten, Film machen, Abbruch, Nacht, Loeschen
      const zeile = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText ? document.querySelector(${JSON.stringify(sel)}).innerText.split(String.fromCharCode(10)).filter(Boolean).join(' | ').slice(0, 400) : '-'`);
      await js(`zeigeStudio('film')`); await warte(1500); await bild('f-leer');
      console.log('FILM TABS', await js(`[...document.querySelectorAll('#studio-tabs button')].map((b) => b.textContent + (b.classList.contains('an') ? '*' : '')).join(',')`));
      console.log('FILM LEER', await zeile('#studio-links'));
      await js(`(() => { const t = document.querySelector('[data-k="f-thema"]'); t.value = 'Ein Hamster baut eine Rakete, weil der Mond wie Käse aussieht'; t.dispatchEvent(new Event('input')); })()`);
      await js(`[...document.querySelectorAll('#studio-links .s-formate button')].find((b) => b.textContent === '30 s').click()`); await warte(300);
      await js(`document.querySelector('#film-planen').click()`); await warte(2500); await bild('f-plan');
      const id = await js(`fz.film && fz.film.id`);
      console.log('FILM PLAN', id, await js(`fz.film ? fz.film.titel + ' | ' + fz.film.szenen.length + ' Szenen | figur=' + fz.film.figur.slice(0, 40) + ' | bedarf=' + fz.bedarf.join(',') : 'kein Film'`));
      console.log('FILM LINKS', await zeile('#studio-links'));
      // Szene 1: Sprechertext aendern (wird nach 0,6 s gespeichert)
      await js(`(() => { const t = document.querySelector('[data-k^="f-text-"]'); t.focus(); t.value = 'Neuer Text für Szene eins.'; t.dispatchEvent(new Event('input')); })()`); await warte(1200);
      console.log('FILM GESPEICHERT', JSON.stringify(film.lade(id).szenen[0].text), 'fokus=' + await js(`document.activeElement && document.activeElement.dataset.k`));
      // Szene 2 nach oben, letzte weg, eine dazu
      await js(`document.querySelectorAll('.f-szene')[1].querySelector('.f-mini').click()`); await warte(800);
      console.log('FILM HOCH', film.lade(id).szenen.map((x) => x.text.slice(0, 12)).join(' / '));
      await js(`[...document.querySelectorAll('.f-szene')].pop().querySelectorAll('.f-mini')[2].click()`); await warte(800);
      await js(`document.querySelector('.f-plus').click()`); await warte(800);
      console.log('FILM ANZAHL', film.lade(id).szenen.length, 'leer=' + film.lade(id).szenen.filter((x) => !x.bild).length);
      // leere neue Szene wieder weg (ohne Bildtext geht kein Bild)
      await js(`[...document.querySelectorAll('.f-szene')].pop().querySelectorAll('.f-mini')[2].click()`); await warte(800);
      // Film machen
      const fertig = async (max) => { for (let i = 0; i < max; i++) { const f = film.lade(id); if (f.status !== 'laeuft') return f; await warte(1000); } return film.lade(id); };
      await js(`document.querySelector('#film-los').click()`); await warte(2500); await bild('f-lauf');
      console.log('FILM LAUF', await zeile('.f-lauf'));
      let f = await fertig(240);
      await warte(1500); await bild('f-fertig');
      console.log('FILM FERTIG', f.status, f.fehler || '', f.datei && fs.existsSync(f.datei) ? path.basename(f.datei) + ' ' + Math.round(fs.statSync(f.datei).size / 1024) + ' KB' : 'keine Datei', '| srt=' + (f.datei && fs.existsSync(f.datei.replace(/\.mp4$/, '.srt'))));
      console.log('FILM SZENEN', f.szenen.map((x) => [x.bildDatei, x.videoDatei, x.sprachDatei].map((y) => (y && fs.existsSync(y) ? 'x' : '-')).join('')).join(' '));
      console.log('FILM RECHTS', await js(`!!document.querySelector('.f-ergebnis video') + ' knopf=' + (document.querySelector('#film-los') || {}).textContent`));
      // Text aendern: nur dieser Sprecher wird neu gemacht
      await js(`(() => { const t = document.querySelectorAll('[data-k^="f-text-"]')[2]; t.value = 'Ein ganz neuer Satz.'; t.dispatchEvent(new Event('input')); })()`); await warte(1200);
      console.log('FILM UNGUELTIG', film.lade(id).szenen.map((x) => (x.sprachDatei ? 'x' : '-')).join(''), film.lade(id).status);
      // Abbruch mitten drin – vorher Text tippen und SOFORT starten: der Text darf nicht verloren gehen
      await js(`(() => { const t = document.querySelectorAll('[data-k^="f-text-"]')[1]; t.value = 'Gleich gestartet.'; t.dispatchEvent(new Event('input')); document.querySelector('#film-los').click(); })()`); await warte(800);
      console.log('FILM SOFORT', JSON.stringify(film.lade(id).szenen[1].text));
      await js(`(() => { const b = document.querySelector('.f-lauf .m-knopf'); b.click(); b.click(); })()`); await warte(2500);
      f = film.lade(id);
      console.log('FILM ABBRUCH', f.status, f.fehler || '-', 'laeuft=' + await js(`filmLaeuft(fz.film)`));
      // Nacht-Warteschlange
      await js(`[...document.querySelectorAll('.s-nacht-dazu')].pop().click()`); await warte(800);
      console.log('FILM NACHT', JSON.stringify(nacht.stand().liste.map((e) => e.art + ':' + e.status + ':' + e.prompt)));
      await js(`[...document.querySelectorAll('.s-nacht-fuss button')].find((b) => b.textContent === 'Start now').click()`); await warte(1500);
      for (let i = 0; i < 120 && nacht.stand().laeuft; i++) await warte(1000);
      f = film.lade(id);
      console.log('FILM NACHT FERTIG', JSON.stringify(nacht.stand().liste.map((e) => e.art + ':' + e.status)), f.status, f.szenen.map((x) => (x.sprachDatei ? 'x' : '-')).join(''));
      // schon fertiger Film nochmal in die Nacht: kein neuer Schnitt, gleiche Datei
      const vorher = fs.statSync(f.datei).mtimeMs;
      nacht.aufraeumen(); nacht.dazu({ film: id }, { titel: f.titel }); nacht.jetztStarten();
      for (let i = 0; i < 30 && (nacht.stand().laeuft || nacht.stand().liste.some((e) => e.status === 'wartet')); i++) await warte(500);
      console.log('FILM NACHT DOPPELT', JSON.stringify(nacht.stand().liste.map((e) => e.art + ':' + e.status)), fs.statSync(film.lade(id).datei).mtimeMs === vorher ? 'gleiche Datei' : 'NEU GESCHNITTEN');
      // Chat-Knopf
      console.log('FILM CHAT', await js(`chatMedienElem({ medien: { art: 'film', film: ${JSON.stringify(id)} } }).innerText`));
      // Format wechseln macht alle Bilder ungueltig
      await js(`[...document.querySelectorAll('#studio-links .s-formate button')].find((b) => b.textContent.startsWith('9:16')).click()`); await warte(1000); await bild('f-hoch');
      console.log('FILM HOCHFORMAT', film.lade(id).format, film.lade(id).szenen.map((x) => (x.bildDatei ? 'x' : '-') + (x.videoDatei ? 'x' : '-')).join(' '));
      // Loeschen
      await js(`(() => { const b = [...document.querySelectorAll('.f-leiste .m-knopf')].find((x) => x.textContent === 'Delete film'); b.click(); b.click(); })()`); await warte(1200);
      console.log('FILM GELOESCHT', !fs.existsSync(path.join(process.env.GLOWLINE_TEST, 'filme', id)), await js(`fz.film === null`), await js(`fz.liste.length`));
    }
    if (was.includes('filmchat')) {
      // Cowork: "erstelle einen 30 Sekunden Film ueber …" schreibt das Drehbuch (Ollama-Nachbau), Lieblingsfilm-Frage bleibt Chat
      const letzte = () => js(`(() => { const n = verlauf()[verlauf().length - 1]; return JSON.stringify({ text: String(n.fehler || n.content || '').split(String.fromCharCode(10)).join(' / ').slice(0, 260), medien: n.medien || null }); })()`);
      const sag = async (t) => {
        await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`);
        for (let i = 0; i < 150; i++) { await warte(100); if (await js('!chat.laeuft')) break; }
        await warte(300);
        return letzte();
      };
      await js(`zeigeWorkspace('auto')`); await warte(2500);
      console.log('FILMCHAT FRAGE', await sag('Was ist dein Lieblingsfilm?'));
      console.log('FILMCHAT FILM', await sag('Erstelle einen 30 Sekunden Film über einen Hamster, der zum Mond fliegt'));
      await bild('fc-chat');
      console.log('FILMCHAT KNOPF', await js(`[...document.querySelectorAll('#chat-verlauf .n-medien button')].map((b) => b.textContent).join(',')`));
      await js(`[...document.querySelectorAll('#chat-verlauf .n-medien button')].pop().click()`); await warte(2000); await bild('fc-studio');
      console.log('FILMCHAT STUDIO', await js(`ansicht + ' ' + sz.bereich + ' ' + (fz.film ? fz.film.titel + ' ' + fz.film.szenen.length + ' ' + fz.film.sprache + ' ' + fz.film.laenge : '-')`));
    }
    if (was.includes('update')) {
      // Fake-GitHub (GLOWLINE_TEST_UPDATE): pruefen, Chip, laden + Pruefsumme, "installieren"
      const p = await update.pruefen().catch((e) => ({ fehler: e.message }));
      console.log('UPDATE PRUEFEN', 'neu=' + p.neu, 'version=' + p.version, 'fehler=' + p.fehler);
      await warte(400);
      console.log('UPDATE CHIP', await js(`(document.querySelector('#update-chip').classList.contains('versteckt') ? 'versteckt' : 'da') + ' | ' + document.querySelector('#update-text').textContent`));
      await bild('u-popup');
      console.log('UPDATE POPUP', await js(`(document.querySelector('#update-pop').classList.contains('versteckt') ? 'zu' : 'offen') + ' | ' + document.querySelector('#up-titel').textContent`));
      await js(`document.querySelector('#up-spaeter').click()`);
      const l = await update.laden();
      console.log('UPDATE LADEN', 'bereit=' + l.bereit, 'geladen=' + l.geladen + '/' + l.gesamt, 'fehler=' + l.fehler);
      await warte(400);
      console.log('UPDATE CHIP2', await js(`document.querySelector('#update-text').textContent`));
      // Neustart nach dem Update: Fensterzustand gemerkt und beim naechsten Start genau einmal benutzt
      if (l.bereit) {
        await update.jetzt();
        const nu = cfg.nachUpdate && cfg.nachUpdate.art, a1 = startFenster(), a2 = startFenster();
        cfg.nachUpdate = { zeit: 0, art: 'tray' };
        const alt = startFenster();
        console.log('UPDATE FENSTER', nu && a1 === nu && a2 === alt && !cfg.nachUpdate && alt !== 'tray' ? 'ok' : 'FEHLT', nu, a1, a2, alt);
        delete startFenster.grenzen;
      }
      console.log('UPDATE VERGLEICH', update.neuer('4.5.10', '4.5.9'), update.neuer('4.5.2', '4.5.2'), update.neuer('v4.6.0', '4.5.9'), update.neuer('4.4.9', '4.5.0'));
      update.beimBeenden();
    }
    if (was.includes('fenster')) {
      // X-Knopf: minimieren bzw. in den Infobereich (ohne Sprechblase)
      cfg.trayHinweis = true;
      cfg.beimSchliessen = 'minimieren'; win.close(); await warte(800);
      console.log('FENSTER minimieren', 'zerstoert=' + win.isDestroyed(), 'minimiert=' + win.isMinimized());
      zeigeFenster(); await warte(800);
      cfg.beimSchliessen = 'tray'; win.close(); await warte(800);
      console.log('FENSTER tray', 'zerstoert=' + win.isDestroyed(), 'sichtbar=' + win.isVisible(), 'tray=' + !!tray);
      zeigeFenster(); await warte(800);
      console.log('FENSTER zurueck', 'sichtbar=' + win.isVisible(), 'minimiert=' + win.isMinimized());
      cfg.beimSchliessen = 'beenden';
      console.log('FENSTER start', startFenster(), JSON.stringify(normalGroesse()));
      if (tray) { tray.destroy(); tray = null; }
    }
    if (was.includes('link')) {
      // Glowline Link: am PC teilen (Code), in der Link-App mit diesem PC koppeln (GLOWLINE_TEST_LINKAPP=1)
      if (!LINK_APP) {
        await js(`zeigeLink()`); await warte(800); await bild('l-pc-aus');
        await js(`document.querySelector('#link-teilen').click()`); await warte(1500); await bild('l-pc-an');
        console.log('LINK PC', await js(`JSON.stringify(lk.stand)`), await js(`document.querySelector('.link-code b').textContent`));
        if (process.env.GLOWLINE_TEST_LINK_AUS) { await js(`document.querySelector('#link-teilen').click()`); await warte(800); }
        console.log('LINK PC AUTOSTART', await js(`!!document.querySelector('#link-autostart')`), await js(`window.api.linkAutostart(true)`), await js(`window.api.linkAutostart(false)`));
        console.log('LINK PC ENDE', await js(`String(lk.stand.teilen)`));
        if (process.env.GLOWLINE_TEST_LINK_WARTE) { await warte(+process.env.GLOWLINE_TEST_LINK_WARTE * 1000); await js(`zeigeLink()`); await warte(1000); await bild('l-pc-gekoppelt'); console.log('LINK PC GERAETE', await js(`JSON.stringify(lk.stand.geraete)`)); }
        await js(`schliesseLink()`);
      } else {
        console.log('LINK APP', await js(`document.body.classList.contains('link-app') + ' ' + getComputedStyle(document.querySelector('#bib-express')).display + ' ' + document.title`));
        await js(`zeigeLink()`); await warte(3500); await bild('l-app-suche');
        console.log('LINK FUNDE', await js(`JSON.stringify(lk.funde)`));
        await js(`document.querySelector('#link-code').value = '000000'; document.querySelector('#link-los').click(); 1`); await warte(1500);
        console.log('LINK FALSCH', await js(`String(lk.fehler)`)); await bild('l-app-falsch');
        await js(`document.querySelector('#link-host').value = '127.0.0.1'; document.querySelector('#link-code').value = ${JSON.stringify(process.env.GLOWLINE_TEST_LINKCODE || '')}; document.querySelector('#link-los').click(); 1`);
        await warte(3000); await bild('l-app-verbunden');
        console.log('LINK OK', await js(`JSON.stringify(lk.stand)`), await js(`cfg.backends.ollama.replace(/[0-9a-f]{48}/, '<s>') + ' | ' + alleModelle().map((m) => m.id).join(',') + ' | ' + cfg.defaultModel`));
        await js(`schliesseLink()`); await warte(2500);
        console.log('LINK FERN-GPU', JSON.stringify(await link.fernGpu()));
        console.log('LINK GPU', await js(`document.querySelector('#vram').textContent`));
        await bild('l-app-haupt');
        // Studio vom PC: Status, Auftrag ueber das Tor (PC laeuft mit Attrappe)
        await js(`zeigeStudio('bild')`); await warte(2500); await bild('l-app-studio');
        console.log('LINK STUDIO', await js(`JSON.stringify({ fern: sz.st.fern, offline: sz.st.offline, eingerichtet: sz.st.eingerichtet, modelle: Object.values(sz.st.modelle).filter((m) => m.da).length })`));
        const r = await studio.auftrag({ id: 'lt' + Date.now(), modell: 'z-image', prompt: 'test tree' });
        console.log('LINK STUDIO AUFTRAG', r.fehler || r.dateien.map((f) => path.relative(studio.P().ausgabe, f)).join(','));
        await js(`zeigeLink()`); await warte(1500); await bild('l-app-wecken');
        console.log('LINK WECKEN', await js(`String(lk.stand.wecken) + ' ' + !!document.querySelector('#link-wecken')`));
        await js(`schliesseLink()`);
      }
    }
    if (was.includes('installieren')) {
      // fehlendes Werkzeug selbst installieren – in einem Sandkasten (eigene LOCALAPPDATA/APPDATA/USERPROFILE, ohne Node.js im PATH)
      // mit dem kleinen npm-Paket "cowsay" als Platzhalter-Werkzeug
      const kiste = path.join(ordner, 'kiste');
      for (const [k, u] of [['LOCALAPPDATA', 'local'], ['APPDATA', 'roaming'], ['USERPROFILE', 'profil']]) { process.env[k] = path.join(kiste, u); fs.mkdirSync(process.env[k], { recursive: true }); }
      INSTALL.cowsay = { name: 'Cowsay', npm: 'cowsay', konto: true };
      console.log('INST VORHER', !!(await findeProgramm('npm', await frischerPfad())), 'npm im Sandkasten-PATH');
      await js(`WERKZEUG_NAME.cowsay = 'Cowsay'; zeigeTerminal(); starteSitzung({ tool: 'cowsay' })`);
      const start = Date.now();
      let neu = null;
      for (let i = 0; i < 600; i++) {
        await warte(1000);
        neu = await js(`sitzung && sitzung.tool + ' ' + sitzung.id`);
        if (i === 20) await bild('i-laeuft');
        const text = await js(`(() => { const b = term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + ' '; return t.replace(/ +/g, ' '); })()`);
        if (i % 15 === 0) console.log('  ...', text.slice(-160));
        if (/did not finish|Could not download/.test(text)) { console.log('INST FEHLER', text.slice(-600)); break; }
        if (await js(`!!window.cowsayNeu`)) break;
        if (i === 0) await js(`window.cowsayErst = sitzung.id; window.api.onWerkzeugInstalliert(() => { window.cowsayNeu = true; }); 1`);
      }
      await warte(3000);
      console.log('INST DAUER', Math.round((Date.now() - start) / 1000), 's | sitzung', neu, '->', await js(`sitzung.tool + ' ' + sitzung.id + ' neu=' + (sitzung.id !== window.cowsayErst)`));
      console.log('INST NODE', fs.existsSync(path.join(NODE_ORDNER(), 'node.exe')), fs.existsSync(path.join(NODE_ORDNER(), 'cowsay.cmd')), await findeProgramm('cowsay', await frischerPfad()));
      await bild('i-ende');
      // dasselbe unsichtbar wie in der Express-Einrichtung
      const meldungen = [];
      const t2 = Date.now();
      try { await werkzeugInstallieren('cowsay', new AbortController(), (t) => meldungen.push(t)); console.log('INST STILL ok', Math.round((Date.now() - t2) / 1000), 's |', meldungen.slice(-3).join(' / ')); } catch (e) { console.log('INST STILL FEHLER', e.message, meldungen.slice(-5)); }
      INSTALL.kaputt = { name: 'Kaputt', npm: 'glowline-gibt-es-nicht-xyz-123' };
      try { await werkzeugInstallieren('kaputt', new AbortController(), () => {}); console.log('INST KAPUTT ok?!'); } catch (e) { console.log('INST KAPUTT Fehler wie erwartet:', e.message); }
    }
    if (was.includes('dateiecht')) {
      // echtes Coder-Modell schreibt ein Spiel auf den Desktop, danach eine Aenderung; Datei unsichtbar laden und auf JS-Fehler pruefen
      const sag = async (t) => {
        const start = Date.now();
        await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`);
        for (let i = 0; i < 1200; i++) { await warte(1000); if (i % 30 === 0) console.log('  ...', await js(`(() => { const n = chat.antwort; return n ? (n.rolle || '') + ' ' + (n.datei ? n.datei.status : '') : 'fertig'; })()`)); if (await js('!chat.laeuft')) break; }
        await warte(500);
        return Math.round((Date.now() - start) / 1000) + ' s ' + (await js(`(() => { const n = verlauf()[verlauf().length - 1]; return JSON.stringify({ rolle: n.rolle, modell: n.modell, text: String(n.fehler || n.content || '').slice(0, 200), datei: n.datei && (n.datei.dateien || []).map((f) => f.pfad + ' ' + f.groesse) }); })()`));
      };
      const pruefeSeite = async (datei) => {
        const w = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
        const fehler = [];
        w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) fehler.push(String(e.message).slice(0, 150)); });
        let bildDa = null;
        w.webContents.on('paint', (_e, _d, b) => { bildDa = b; });
        await w.loadFile(datei).catch((e) => fehler.push('laden: ' + e.message));
        await warte(2500);
        await w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        await w.webContents.sendInputEvent({ type: 'mouseDown', x: 450, y: 350, button: 'left', clickCount: 1 });
        await warte(1500);
        if (bildDa) fs.writeFileSync(path.join(ordner, 'spiel-' + path.basename(datei) + '.png'), bildDa.toPNG());
        w.destroy();
        return fehler.length ? 'JS-FEHLER: ' + fehler.join(' || ') : 'keine JS-Fehler';
      };
      await js(`zeigeWorkspace('auto')`);
      await warte(2500);
      const neu = await sag('Erstelle auf meinem Desktop eine HTML-Datei mit einem kleinen Spiel: ein Ball hüpft mit Leertaste oder Klick durch Lücken zwischen Wänden, mit Punktezähler und Neustart.');
      console.log('ECHT NEU', neu);
      const p1 = (/"([A-Z]:\\\\[^"]+?\.html) \d+/.exec(neu) || [])[1];
      const pfad = p1 && p1.replace(/\\\\/g, '\\');
      if (pfad && fs.existsSync(pfad)) {
        console.log('ECHT SEITE', await pruefeSeite(pfad));
        await bild('de-neu');
        console.log('ECHT AENDERN', await sag('mach den Ball rot und das Spiel etwas langsamer'));
        console.log('ECHT SEITE2', await pruefeSeite(pfad), fs.statSync(pfad).size, 'Bytes');
      }
      await bild('de-ende');
    }
    if (was.includes('chatecht') || was.includes('chatohnestudio')) {
      // echter Studio-Auftrag aus dem Chat (bzw. Studio nicht eingerichtet: GLOWLINE_STUDIO = leerer Ordner)
      await js(`zeigeWorkspace('chat'); cfg.chatModel = 'ollama,lfm3:1.7b'; zeichneChat(); document.querySelector('#chat-text').value = 'Erstelle mir ein Bild von einem Leuchtturm bei Sonnenuntergang'; sendeChat()`);
      for (let i = 0; i < 240; i++) { await warte(1000); if (i === 12) await bild('e-laeuft'); if (await js('!chat.laeuft')) break; }
      await warte(1500);
      console.log('ECHT', await js(`(() => { const v = verlauf(); const n = v[v.length - 1]; return JSON.stringify({ text: n.fehler || n.content, medien: n.medien && { ...n.medien, prompt: String(n.medien.prompt || '').slice(0, 100) } }); })()`));
      console.log('ECHT BILD', await js(`(() => { const i = document.querySelector('#chat-verlauf .n-medien img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'kein Bild'; })()`));
      await bild('e-ergebnis');
      if (was.includes('chatohnestudio')) {
        await js(`document.querySelector('#chat-verlauf .n-medien .m-knopf').click()`);
        await warte(2500);
        console.log('ECHT STUDIOSEITE', await js(`document.querySelector('#studio').innerText.replace(/\s+/g, ' ').slice(0, 300)`));
        await bild('e-studioseite');
      }
    }
    if (was.includes('chatstudio')) {
      // "Chat fuer alles": echtes kleines Sprachmodell entscheidet, Studio wird vorgespielt (GLOWLINE_TEST_ATTRAPPE)
      const letzte = () => js(`(() => { const v = verlauf(); const n = v[v.length - 1]; const m = n.medien || {}; return JSON.stringify({ text: String(n.fehler || n.content || '').slice(0, 90), art: m.art, prompt: String(m.prompt || '').slice(0, 120), datei: m.dateien && m.dateien[0] ? m.dateien[0].split(/[\\\\/]/).pop() : undefined, fehlt: m.fehlt, quelle: m.quelle ? m.quelle.split(/[\\\\/]/).pop() : undefined }); })()`);
      const fertig = async () => { for (let i = 0; i < 120; i++) { await warte(500); if (await js('!chat.laeuft')) break; } await warte(300); return letzte(); };
      const sag = async (t) => { await js(`document.querySelector('#chat-text').value = ${JSON.stringify(t)}; sendeChat()`); return fertig(); };
      const knopf = async (name) => { await js(`[...document.querySelectorAll('#chat-verlauf .n-fuss button')].filter((b) => b.textContent === ${JSON.stringify(name)}).pop().click()`); return fertig(); };
      await js(`zeigeWorkspace('chat'); cfg.chatModel = ${JSON.stringify(process.env.GLOWLINE_TEST_CHATMODELL || 'ollama,lfm3:1.7b')}; zeichneChat()`);
      await warte(800);
      await bild('c-leer');
      if (process.env.GLOWLINE_TEST_ATTRAPPE === 'ohnevideo') {
        console.log('CS OHNEVIDEO', await sag('Mach ein Video von Wellen am Strand'), '| knopf:', await js(`(document.querySelector('#chat-verlauf .n-medien .m-knopf') || {}).textContent`));
        await bild('c-ohnevideo');
      } else {
        await js(`document.querySelector('#chat-text').value = 'Erstelle mir ein Bild von einem Baum im Herbst'; sendeChat()`);
        await warte(2200);
        await bild('c-laeuft');
        console.log('CS BILD', await fertig());
        await bild('c-bild');
        console.log('CS FOLGE', await sag('mach den Himmel lila'));
        console.log('CS GROESSER', await sag('mach den Baum größer'));
        console.log('CS WITZ', await sag('Erzähl mir einen Witz'));
        console.log('CS FRAGE', await sag('Was ist ein gutes Bildformat für Instagram?'));
        console.log('CS ANIMIEREN', await knopf('Animate'));
        console.log('CS STIMME', await sag('Lies mir vor: Guten Morgen, heute wird ein schöner Tag'));
        console.log('CS TIKTOK', await sag('Mach ein TikTok Video von einer tanzenden Katze'));
        console.log('CS UPSCALE', await knopf('Upscale 4×'));
        // angehaengtes Bild hochskalieren
        await js(`chat.anhang = ${JSON.stringify((studio.galerie().find((x) => /\.png$/i.test(x.datei)) || {}).datei || '')}; zeichneAnhang()`);
        await warte(400);
        await bild('c-anhang');
        console.log('CS ANHANG', await sag('skalier das bitte hoch'));
        await bild('c-ende');
        console.log('CS ATTRAPPE-LOG oben, Nachrichten:', await js('verlauf().length'));
      }
    }
    if (was.includes('installer')) {
      // Installer-Knoepfe im Modellfenster (Ollama + LM Studio "fehlen", Nachbau-Server liefert die Dateien)
      const zeile = (id) => js(`(document.querySelector('#b-liste [data-inst=${id}]') || {}).textContent || 'kein Knopf'`);
      const klick = (id, n) => js(`document.querySelectorAll('#b-liste [data-inst=${id}] button')[${n}].click()`);
      await js(`oeffneBib('meine')`);
      await warte(3000);
      console.log('INST START', await zeile('ollama'), '||', await zeile('lmstudio'));
      await bild('i-start');
      await klick('ollama', 0);
      await warte(1500);
      console.log('INST LAEUFT', await zeile('ollama'));
      await bild('i-laeuft');
      await klick('ollama', 1);
      await warte(1000);
      console.log('INST ABBRUCH', await zeile('ollama'), '| reste:', fs.readdirSync(ordner).filter((f) => /setup|\.part/i.test(f)).join(',') || '-');
      await klick('ollama', 0);
      await klick('lmstudio', 0);
      for (let i = 0; i < 60; i++) { await warte(1000); if (await js(`document.querySelectorAll('#b-liste .inst button:not(.versteckt)').length === 4 && ![...document.querySelectorAll('#b-liste .inst button')].some((b) => b.disabled)`)) break; }
      // Liste neu zeichnen: der Stand muss erhalten bleiben
      await js(`zeichneMeine()`);
      await warte(800);
      console.log('INST FERTIG', await zeile('ollama'), '||', await zeile('lmstudio'), '| dateien:', fs.readdirSync(ordner).filter((f) => /\.exe|\.part/i.test(f)).map((f) => f + '=' + fs.statSync(path.join(ordner, f)).size).join(','));
      await bild('i-fertig');
      // nochmal holen: liegt schon da, darf nicht neu laden
      const vorher = fs.statSync(path.join(ordner, 'OllamaSetup.exe')).mtimeMs;
      console.log('INST NOCHMAL', JSON.stringify(await js(`window.api.installerHolen('ollama')`)), 'neu geladen:', fs.statSync(path.join(ordner, 'OllamaSetup.exe')).mtimeMs !== vorher);
    }
    if (was.includes('einrichtung')) {
      // Einrichtungs-Assistent gegen den Ollama-Nachbau (config.json im Testordner zeigt auf ihn)
      const ein = (code) => js(code);
      const zeilen = () => ein(`[...document.querySelectorAll('#ein-inhalt .ein-zeile')].map((z) => (z.querySelector('input') ? (z.querySelector('input').checked ? '[x] ' : '[ ] ') : '') + z.querySelector('b').textContent + ' ' + z.querySelector('small').textContent + ' = ' + z.querySelector('.ein-gb').textContent).join(' | ')`);
      const summe = () => ein(`(document.querySelector('.ein-summe') || {}).textContent + ' | los=' + (document.querySelector('#ein-los') ? (document.querySelector('#ein-los').disabled ? 'aus' : 'an') : '-')`);
      await ein(`zeigeEinrichtung()`);
      await warte(2500);
      console.log('EIN START', await ein(`document.querySelector('#ein-titel').textContent + ' | ' + [...document.querySelectorAll('.ein-chip')].map((c) => c.textContent).join(' / ') + ' | karten=' + document.querySelectorAll('.ein-karte').length`));
      await bild('e-start');
      await ein(`document.querySelector('.ein-wahl .ein-karte').click()`);
      await warte(2500);
      console.log('EIN STUFE', await ein(`[...document.querySelectorAll('.ein-stufe')].map((k) => (k.classList.contains('an') ? '*' : '') + k.querySelector('b').textContent + (k.querySelector('em') ? '(empf)' : '')).join(' | ')`));
      console.log('EIN ZEILEN', await zeilen());
      console.log('EIN SUMME', await summe());
      await bild('e-express');
      for (const st of ['schnell', 'stark']) {
        await ein(`document.querySelector('[data-stufe=${st}]').click()`);
        await warte(1500);
        console.log('EIN', st.toUpperCase(), await summe(), '||', await zeilen());
      }
      await ein(`document.querySelector('.ein-frei input').click()`);
      await warte(1500);
      console.log('EIN FREI', await zeilen());
      await ein(`document.querySelector('.ein-frei input').click(); document.querySelector('[data-stufe=mittel]').click()`);
      await warte(1500);
      // fuer den Testlauf: nur Sprachmodelle + Upscaling (klein, echter Download)
      for (const t of ['bild', 'video', 'stimme']) { await ein(`document.querySelector('[data-teil=${t}]').click()`); await warte(700); }
      console.log('EIN AUSWAHL', await summe(), '||', await zeilen());
      await bild('e-auswahl');
      await ein(`document.querySelector('#ein-los').click()`);
      for (let i = 0; i < 120; i++) {
        await warte(1000);
        const st = await ein(`JSON.stringify(ein.stand && { f: ein.stand.fertig, s: ein.stand.schritte.map((x) => x.titel + ':' + x.status + (x.fehler ? '(' + x.fehler + ')' : '')) })`);
        if (i === 2) { console.log('EIN LAUF', st); await bild('e-lauf'); }
        if (JSON.parse(st).f) { console.log('EIN FERTIG', st); break; }
      }
      await bild('e-fertig');
      console.log('EIN CFG', await ein(`cfg.defaultModel + ' | ' + cfg.chatModel + ' | ' + cfg.einrichtung + ' | ' + document.querySelector('#ein-lauf-summe').textContent`));
      console.log('EIN NOCHMAL', await ein(`(async () => { document.querySelector('#ein-fertig').click(); await zeigeEinrichtung(); await new Promise((ok) => setTimeout(ok, 2000)); document.querySelector('.ein-wahl .ein-karte').click(); await new Promise((ok) => setTimeout(ok, 2000)); return document.querySelector('.ein-summe').textContent + ' | los=' + document.querySelector('#ein-los').textContent; })()`));
      // Abbruch: Denker neu (frei-Variante), Nachbau laedt langsam (GLOWLINE_TEST_LANGSAM)
      if (process.env.GLOWLINE_TEST_ABBRUCH) {
        await ein(`document.querySelector('.ein-frei input').click()`);
        await warte(1500);
        await ein(`document.querySelector('#ein-los').click()`);
        await warte(3000);
        await ein(`document.querySelector('#ein-abbrechen').click()`);
        console.log('EIN SICHER', await ein(`document.querySelector('#ein-abbrechen').textContent`));
        await warte(600);
        await ein(`document.querySelector('#ein-abbrechen').click()`);
        await warte(2500);
        console.log('EIN ABBRUCH', await ein(`JSON.stringify({ f: ein.stand.fertig, a: ein.stand.abgebrochen, s: ein.stand.schritte.map((x) => x.titel + ':' + x.status) }) + ' | ' + document.querySelector('#ein-lauf-summe').textContent + ' | retry=' + !document.querySelector('#ein-nochmal').classList.contains('versteckt')`));
      }
    }
    if (was.includes('werkzeuge')) {
      // jedes Werkzeug einmal starten (leerer Testordner) und den Terminal-Text lesen
      const ziel = path.join(process.env.GLOWLINE_TEST, 'ordner');
      fs.mkdirSync(ziel, { recursive: true });
      for (const t of (process.env.GLOWLINE_TEST_TOOLS || 'antigravity,gemini,qwen,copilot,droid,cline').split(',')) {
        await js(`zeigeTerminal(); starteSitzung({ tool: '${t}', cwd: ${JSON.stringify(ziel)} })`);
        await warte(9000);
        const text = await js(`(() => { const b = term.buffer.active, z = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i).translateToString(true).trim(); if (l) z.push(l); } return z.slice(-6).join(' / ').slice(0, 300); })()`);
        console.log('TOOL', t, '|', await js(`document.querySelector('#modell-name').textContent + ' | ' + document.querySelector('#modell-info').textContent`), '|', text);
        await bild('t-' + t);
      }
      await js(`if (sitzung && !sitzung.beendet) window.api.kill(sitzung.id)`);
      await js(`document.querySelector('#tool-chip').click()`);
      await warte(1500);
      await js(`document.querySelector('[data-klapp=agenten]').click()`);
      await warte(500);
      console.log('MENUE3', await js(`[...document.querySelectorAll('#tools > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => (b.querySelector('b') || b).textContent + (b.classList.contains('fehlt') ? '(fehlt)' : '')).join(' | ')`));
      await bild('t-menue');
    }
    if (was.includes('higgs')) {
      // Cloud-Video gegen den Higgsfield-Nachbau (GLOWLINE_TEST_HIGGS)
      await js(`window.api.kontoSetzen('higgsfield', 'testid:testsecret')`);
      await js(`zeigeStudio('video')`);
      await warte(1500);
      console.log('HIGGS KARTEN', await js(`[...document.querySelectorAll('#studio-links .s-modell')].map((k) => k.querySelector('b').textContent + ': ' + (k.querySelector('.s-m-status, .m-knopf') || {}).textContent).join(' | ')`));
      const lauf = async (modell, prompt, mitBild, sek) => {
        await js(`sz.felder.video.modell = '${modell}'; sz.felder.video.prompt = ${JSON.stringify(prompt)}; sz.felder.video.bild = ${mitBild ? `sz.galerie.find((g) => /png$/.test(g.datei)).datei` : 'null'}; sz.felder.video.sekunden = ${sek}; sz.felder.video.format = 1; zeichneStudio(); starte()`);
        await warte(300);
        const gpu = studio.beschaeftigt();
        const r = await warteAuftrag(90);
        return `gpu=${gpu.gpu} alle=${gpu.auftraege} -> ` + JSON.stringify({ e: r.e, d: r.d && r.d[0].split(/[\\/]/).slice(-2).join('/'), t: r.t });
      };
      console.log('HIGGS UI', await js(`(() => { sz.felder.video.modell = 'hf-wan3'; zeichneStudio(); const r = document.querySelector('#studio-links input[type=range]'); return [document.querySelector('#studio-los').textContent, 'range ' + r.min + '-' + r.max, 'avoid=' + !!document.querySelector('[data-k=negativ]'), 'ton=' + !!document.querySelector('.s-erlaubt input'), 'verbessern=' + !document.querySelector('.s-verbessern').disabled].join(' | '); })()`));
      await bild('s-higgs-felder');
      console.log('HIGGS T2V', await lauf('hf-wan3', 'A fox in the snow', false, 20));
      await bild('s-higgs-fertig');
      console.log('HIGGS I2V', await lauf('hf-seedance2', 'The neon sign flickers', true, 1));
      console.log('HIGGS FAIL', await lauf('hf-wan3', 'please fail', false, 5));
      console.log('HIGGS NSFW', await lauf('hf-wan3', 'nsfw thing', false, 5));
      console.log('HIGGS GELD', await lauf('hf-wan3', 'broke', false, 5));
      // Abbruch in der Warteschlange
      await js(`sz.felder.video.modell = 'hf-wan3'; sz.felder.video.prompt = 'cancel me'; sz.felder.video.bild = null; zeichneStudio(); starte()`);
      await warte(1200);
      await js(`(() => { const b = document.querySelector('.s-lauf .m-knopf'); b.click(); b.click(); })()`);
      const ab = await warteAuftrag(30);
      console.log('HIGGS CANCEL', JSON.stringify({ e: ab.e }));
      await js(`window.api.kontoSetzen('higgsfield', 'falsch:schluessel')`);
      console.log('HIGGS KEY', await lauf('hf-wan3', 'A fox', false, 5));
      await js(`window.api.kontoSetzen('higgsfield', '')`);
      await js(`ladeStudio()`);
      await warte(1500);
      console.log('HIGGS OHNE KEY', await js(`[...document.querySelectorAll('#studio-links .s-modell')].map((k) => k.querySelector('b').textContent + ': ' + (k.querySelector('.s-m-status, .m-knopf') || {}).textContent).join(' | ') + ' | gewaehlt=' + aktivesModell('video').id`));
    }
    if (was.includes('vorschau')) {
      // waehrend ein (gespielter) Auftrag laeuft, ein fertiges Bild ansehen: die Vorschau darf nicht neu gebaut werden
      await js(`zeigeStudio('bild')`);
      await warte(1200);
      await js(`sz.auftraege.set('auftrag:spiel2', { vorgang: 'auftrag:spiel2', art: 'bild', text: 'Generating', prozent: 10, start: Date.now() }); sz.auswahl = { datei: sz.galerie.find((g) => /png$/.test(g.datei)).datei }; zeichneStudio(); document.querySelector('#studio-rechts .s-buehne img').merker = 1`);
      for (const pr of [20, 30, 40]) { win.webContents.send('studio', { vorgang: 'auftrag:spiel2', art: 'bild', text: 'Generating', prozent: pr }); await warte(300); }
      console.log('VORSCHAU', await js(`(() => { const i = document.querySelector('#studio-rechts .s-buehne img'); const t = document.querySelector('#studio-rechts .s-kachel.lauf span'); return (i && i.merker === 1 ? 'bleibt' : 'NEU GEBAUT') + ' kachel=' + (t && t.textContent); })()`));
      win.webContents.send('studio', { vorgang: 'auftrag:spiel3', art: 'bild', text: 'Waiting', wartet: true });
      await warte(400);
      console.log('NEUE KACHEL', await js(`document.querySelectorAll('#studio-rechts .s-kachel.lauf').length`));
      await js(`sz.auftraege.delete('auftrag:spiel2'); sz.auftraege.delete('auftrag:spiel3'); sz.auswahl = null; zeichneStudio()`);
    }
    if (was.includes('navi')) {
      await js(`location.href = 'https://example.com/'; window.open('https://example.com/')`).catch(() => {});
      await warte(1500);
      console.log('NAVI', await js(`location.protocol + ' ' + !!document.querySelector('#studio')`));
    }
    if (was.includes('zimage')) {
      const t0 = Date.now();
      await js(`zeigeStudio('bild'); sz.felder.bild.modell = 'z-image'; sz.felder.bild.prompt = 'A neon sign that says GLOWLINE on a rainy brick wall at night, photo'; sz.felder.bild.format = 1; zeichneStudio(); starte()`);
      console.log('ZIMAGE', JSON.stringify(await warteAuftrag(600)), Math.round((Date.now() - t0) / 1000) + 's');
      await warte(1500);
      await bild('s-zimage');
      await js(`sz.felder.bild.modell = ''`);
    }
    if (was.includes('animieren')) {
      // Bild zu Video: neuestes Bild als Startbild, kurz und klein
      const t0 = Date.now();
      await js(`(() => { const g = sz.galerie.find((x) => x.datei.includes(String.fromCharCode(92) + 'bild' + String.fromCharCode(92))); sz.felder.video.bild = g.datei; window.api.studioFreigeben(g.datei); })(); zeigeStudio('video'); sz.felder.video.prompt = 'Rain falls, the neon sign flickers, slow camera push in'; sz.felder.video.format = 3; sz.felder.video.sekunden = 2; zeichneStudio(); starte()`);
      await warte(4000);
      await bild('s-animieren-laeuft');
      console.log('ANIMIEREN', JSON.stringify(await warteAuftrag(1200)), Math.round((Date.now() - t0) / 1000) + 's');
      await warte(2000);
      await bild('s-animieren');
    }
    if (was.includes('klonen')) {
      // Stimme klonen: die zuletzt erzeugte Sprachaufnahme dient als Probe
      const t0 = Date.now();
      await js(`(() => { const g = sz.galerie.find((x) => /\\.wav$/i.test(x.datei)); sz.felder.stimme.probe = g.datei; sz.felder.stimme.erlaubt = true; })(); zeigeStudio('stimme'); sz.felder.stimme.prompt = 'Und jetzt spricht die geklonte Stimme einen zweiten Satz.'; zeichneStudio(); starte()`);
      console.log('KLONEN', JSON.stringify(await warteAuftrag(1200)), Math.round((Date.now() - t0) / 1000) + 's');
      await warte(1500);
      await bild('s-klonen');
    }
    if (was.includes('laden')) {
      // gespielter Download: Karte zeigt Fortschritt, Eingabefelder werden dabei nicht neu gebaut
      await js(`zeigeStudio('bild')`);
      await warte(1200);
      await js(`sz.laden.set('modell:z-image', { prozent: 0 }); zeichneStudio(); document.querySelector('#studio-links textarea').merker = 1`);
      for (const pr of [10, 42]) { win.webContents.send('studio', { vorgang: 'modell:z-image', prozent: pr }); await warte(400); }
      console.log('LADEN', await js(`JSON.stringify({ balken: document.querySelector('.s-modell[data-m="z-image"] .s-balken i').style.width, text: document.querySelector('.s-modell[data-m="z-image"] .s-m-laden small').textContent, feldBleibt: document.querySelector('#studio-links textarea').merker === 1 })`));
      await bild('s-laden');
      win.webContents.send('studio', { vorgang: 'modell:z-image', fertig: true, fehler: 'cancelled' });
      await warte(800);
    }
    if (was.includes('abbruch')) {
      // 1) Abbrechen, waehrend der Motor startet  2) Abbrechen mitten im Generieren
      studio.stoppen();
      await js(`zeigeStudio('video'); sz.felder.video.prompt = 'A paper boat on a rainy street, close-up'; sz.felder.video.format = 3; sz.felder.video.sekunden = 2; zeichneStudio(); starte()`);
      await warte(2500);
      const t0 = Date.now();
      await js(`document.querySelector('.s-lauf .m-knopf').click(); document.querySelector('.s-lauf .m-knopf').click()`);
      await warte(150);
      await bild('s-abbruch-knopf');
      console.log('ABBRUCH-START', JSON.stringify(await warteAuftrag(30)), (Date.now() - t0) + 'ms');
      await warte(800);
      await bild('s-abbruch-start');
      await js(`starte()`);
      for (let i = 0; i < 600 && !(await js('(laufenderAuftrag() || {}).prozent > 0')); i++) await warte(500);
      const t1 = Date.now();
      await js(`document.querySelector('.s-lauf .m-knopf').click(); document.querySelector('.s-lauf .m-knopf').click()`);
      console.log('ABBRUCH-GENERIEREN', JSON.stringify(await warteAuftrag(60)), (Date.now() - t1) + 'ms');
      for (let i = 0; i < 20; i++) {
        const q = await fetch('http://127.0.0.1:8189/queue').then((r) => r.json()).catch(() => null);
        if (q && !q.queue_running.length && !q.queue_pending.length) { console.log('ENGINE-LEER nach', i * 500, 'ms'); break; }
        await warte(500);
      }
      await bild('s-abbruch-generieren');
    }
    console.log('GALERIE', await js('sz.galerie.length'));
    app.quit();
    return;
  }
  if (process.env.GLOWLINE_TEST_NUR === 'workspace') {
    const fertig = async () => { for (let i = 0; i < 180 && (await js('!!chat.laeuft')); i++) await warte(500); };
    const letzte = () => js(`(() => { const v = verlauf(); const a = v[v.length - 1]; return (a.fehler ? 'FEHLER ' + a.fehler : a.content).slice(0, 260).split(String.fromCharCode(10)).join(' / '); })()`);
    await js(`zeigeWorkspace('chat'); setzeChatModell(${JSON.stringify(process.env.GLOWLINE_TEST_MODELL || '')})`);
    await js(`document.querySelector('#chat-text').value = 'Answer in exactly five words: what is Glowline good for?'; sendeChat()`);
    await warte(1500);
    await bild('w1-chat-laeuft');
    await fertig();
    console.log('CHAT', await letzte(), '|', await js(`document.querySelector('#tps').textContent + ' tok/s | ' + document.querySelector('#tool-name').textContent + ' | ' + document.querySelector('#modell-name').textContent`));
    await bild('w2-chat');
    await js(`chat.modus = 'video'; zeichneChat(); document.querySelector('#chat-text').value = 'ein Fuchs rennt bei Sonnenuntergang durch den Schnee'; sendeChat()`);
    await fertig();
    console.log('VIDEO', await letzte());
    console.log('CODE', await js(`!!document.querySelector('#chat-verlauf .code pre')`));
    await bild('w3-video');
    await js(`setzeChatModell('abo,sonnet'); chat.modus = 'chat'; zeichneChat(); document.querySelector('#chat-text').value = 'hi'; sendeChat()`);
    await fertig();
    console.log('ABO IM CHAT', await letzte());
    await js(`document.querySelector('#tool-chip').click()`);
    await warte(1500);
    await bild('w4-menue');
    console.log('MENUE', await js(`[...document.querySelectorAll('#tools .m-gruppe, #tools button b')].map((x) => x.textContent).join(' | ')`));
    await js(`schliesseMenues(); oeffneBib('konten')`);
    await warte(3000);
    await bild('w5-konten');
    console.log('KONTEN', await js(`[...document.querySelectorAll('.konto')].map((k) => k.querySelector('b').textContent + ': ' + k.querySelector('.k-status').textContent).join(' | ')`));
    await js(`zeigeTab('meine')`);
    await warte(4000);
    await bild('w6-meine');
    console.log('GRUPPEN', await js(`[...document.querySelectorAll('#b-liste .m-gruppe')].map((g) => g.textContent).join(' | ')`));
    await js(`schliesseBib(); zeigeWorkspace('chat'); setzeChatModell(${JSON.stringify(process.env.GLOWLINE_TEST_MODELL || '')}); document.querySelector('#modell-chip').click()`);
    await warte(1500);
    await bild('w7-chat-modell');
    app.quit();
    return;
  }
  if (process.env.GLOWLINE_TEST_NUR === 'installation') {
    await js(`starteSitzung({ cwd: ${JSON.stringify(ordner)} })`);
    await warte(4000);
    console.log('OHNE SERVER', await js('sitzung && sitzung.beendet'));
    await bild('2-ohne-server');
    await js(`document.querySelector('#tool-chip').click()`);
    await warte(2500);
    console.log('MENUE', await js(`[...document.querySelectorAll('#tools [data-tool]')].map((b) => b.dataset.tool + ': ' + b.querySelector('small').textContent).join(' | ')`));
    await bild('3-werkzeuge');
    await js(`schliesseMenues(); starteSitzung({ tool: 'opencode', cwd: ${JSON.stringify(ordner)} })`);
    await warte(5000);
    await bild('4-fehlt');
    await js(`oeffneBib('laden')`);
    await warte(2500);
    console.log('ZIELE', await js(`[...document.querySelectorAll('.ziel small')].map((x) => x.textContent).join(' | ')`));
    await bild('5-ziele');
    app.quit();
    return;
  }
  const modell = process.env.GLOWLINE_TEST_MODELL || null; // null = Standardmodell
  await js(`starteSitzung({ tool: 'claude', model: ${JSON.stringify(modell)}, cwd: ${JSON.stringify(ordner)} })`);
  await warte(12000);
  await bild('2-claude');
  const tippe = (t) => js(`window.api.write(sitzung.id, ${JSON.stringify(t)})`);
  await tippe('\x1b[B'); // Ordner vertrauen (falls gefragt)
  await warte(400);
  await tippe('\r');
  await warte(8000);
  await tippe('Schreib ein kurzes Gedicht ueber Grafikkarten, 8 Zeilen.');
  await warte(600);
  await tippe('\r');
  await warte(+(process.env.GLOWLINE_TEST_WARTEN || 6000));
  await bild('3-laeuft');
  await warte(30000);
  await bild('4-fertig');
  await js(`document.querySelector('#modell-chip').click()`);
  await warte(1500);
  await bild('5-modelle');
  await js(`document.querySelector('#tool-chip').click()`);
  await warte(800);
  await bild('6-werkzeuge');
  await js(`document.querySelector('#tool-chip').click()`);
  win.setFullScreen(true);
  await warte(1500);
  await bild('7-vollbild');
  win.setFullScreen(false);
  // Gleichzeitige Anfragen nachstellen: Hauptantwort laeuft weiter, kleine Nebenanfrage endet vorher
  const tab = await js('sitzung.kennung');
  const t0 = Date.now();
  const st = (o) => sende('stat', { tab, backend: 'ollama', model: 'test', ...o });
  st({ phase: 'start', id: 900001, t0 });
  st({ phase: 'start', id: 900002, t0: t0 + 50 });
  await warte(300);
  st({ phase: 'erstes', id: 900001, ttft: 0.3 });
  st({ phase: 'lauf', id: 900001, tokens: 120, tps: 77.7 });
  st({ phase: 'ende', id: 900002, status: 'ok', eingabe: 500, ausgabe: 3, ttft: 0.2, tps: null, neu: 500, prefill: 2500 });
  await warte(600);
  await bild('8-parallel');
  console.log('PARALLEL', await js(`document.querySelector('#tps').textContent + ' | ' + document.querySelector('#leiste').className`));
  st({ phase: 'ende', id: 900001, status: 'ok', eingabe: 48000, ausgabe: 400, ttft: 0.3, tps: 77.7, neu: 1200, prefill: 4000 });
  await warte(600);
  console.log('ENDE', await js(`document.querySelector('#tps').textContent + ' | ' + document.querySelector('#runde').textContent + ' | ' + document.querySelector('#spitze-text').textContent`));
  // Vergleichsmodell fuer "Saved": Opus waehlen, dann eigene Preise
  const gesp = () => js(`document.querySelector('#l-gespart').textContent + ' = ' + document.querySelector('#gespart').textContent + ' (' + document.querySelector('#f-gespart').title.slice(0, 70) + ')'`);
  console.log('PREIS SONNET', await gesp());
  await js(`document.querySelector('#f-gespart').click()`);
  await warte(500);
  await js(`[...document.querySelectorAll('.p-modell')].find((b) => b.textContent.startsWith('Claude Opus')).click()`);
  await warte(300);
  await bild('8b-preise');
  console.log('PREIS OPUS', await gesp(), '|', await js(`document.querySelector('#p-summe').textContent`));
  await js(`(() => { const n = document.querySelector('#p-name'); n.value = 'Mein Modell'; n.dispatchEvent(new Event('input'));
    const a = document.querySelector('#p-ausgabe'); a.value = '100'; a.dispatchEvent(new Event('input')); })()`);
  await warte(300);
  console.log('PREIS EIGEN', await gesp(), '|', await js(`[...document.querySelectorAll('.p-modell.an')].map((b) => b.textContent).join()`));
  await js(`[...document.querySelectorAll('.p-modell')][0].click(); schliesseMenues()`);
  // Modellfenster: Favorit setzen, Favoriten-Menue, Download nach LM Studio (Testordner) und Ollama (abbrechen)
  await js(`oeffneBib('meine')`);
  await warte(2500);
  await js(`document.querySelector('#b-liste .m-zeile .m-stern').click()`);
  await warte(300);
  await js(`(() => { const z = [...document.querySelectorAll('#b-liste .m-zeile')].find((x) => x.title.startsWith('lmstudio,')); if (z) z.querySelector('.m-stern').click(); })()`);
  await warte(500);
  await bild('9-alle-modelle');
  await js(`schliesseBib(); document.querySelector('#modell-chip').click()`);
  await warte(1500);
  console.log('FAVORITEN', await js(`document.querySelectorAll('#m-liste .m-zeile').length + ' | ' + [...document.querySelectorAll('#m-liste .m-gruppe')].map((g) => g.textContent).join(', ')`));
  await bild('10-favoriten');
  const lmTest = path.join(ordner, 'lmstudio-models');
  await js(`window.api.setConfig({ lmstudioModelsDir: ${JSON.stringify(lmTest)} }).then((c) => Object.assign(cfg, c))`);
  await js(`oeffneBib('laden')`);
  await warte(2000);
  await js(`[...document.querySelectorAll('.ziel')].find((b) => b.textContent.startsWith('LM Studio')).click()`);
  await js(`const i = document.querySelector('#hf-suche'); i.value = 'qwen3 0.6b'; i.dispatchEvent(new Event('input'))`);
  await warte(5000);
  await js(`[...document.querySelectorAll('#hf-treffer .m-zeile')].find((z) => z.querySelector('.m-name').textContent === 'unsloth/Qwen3-0.6B-GGUF').click()`);
  await warte(4000);
  await bild('11-download-lmstudio');
  await js(`document.querySelector('#hf-details .quant .m-knopf:not(:disabled)').click()`);
  await warte(3000);
  await bild('12-laeuft');
  for (let i = 0; i < 120 && (await js('downloads.size')); i++) await warte(1000);
  const lmDateien = fs.existsSync(lmTest) ? fs.readdirSync(lmTest, { recursive: true }).join(', ') : 'nichts';
  console.log('LMSTUDIO', lmDateien, '|', await js(`document.querySelector('#hinweis').textContent + ' | ' + document.querySelector('#hf-details .quant .m-knopf').textContent`));
  await bild('13-lmstudio-fertig');
  await js(`[...document.querySelectorAll('.ziel')].find((b) => b.textContent.startsWith('Ollama')).click()`);
  await warte(500);
  await js(`[...document.querySelectorAll('#hf-details .quant')].find((z) => z.querySelector('b').textContent === 'Q4_K_M').querySelector('.m-knopf').click()`);
  await warte(6000);
  console.log('OLLAMA', await js(`[...document.querySelectorAll('.dl .m-info')].map((x) => x.textContent).join(' | ')`));
  await bild('14-ollama');
  await js(`document.querySelector('.dl .m-knopf').click()`);
  await warte(2000);
  console.log('NACH ABBRUCH', await js(`downloads.size + ' | ' + document.querySelector('#hinweis').textContent`));
  app.quit();
}

// ---------- Terminal (gl / glowline) ----------
// kleine Vorschau fuer das Terminal: Bild (oder Video-Vorschaubild von Windows) auf hoechstens b x h Pixel
async function terminalVorschau(f, b, h) {
  let bild = null;
  try {
    bild = /\.(png|jpe?g|webp)$/i.test(f) ? nativeImage.createFromPath(f)
      : /\.(mp4|webm)$/i.test(f) ? await nativeImage.createThumbnailFromPath(f, { width: 512, height: 512 }) : null;
  } catch { bild = null; }
  if (!bild || bild.isEmpty()) return null;
  const g = bild.getSize();
  const s = Math.min(b / g.width, h / g.height, 1);
  const k = bild.resize({ width: Math.max(1, Math.round(g.width * s)), height: Math.max(1, Math.round(g.height * s)), quality: 'good' });
  const kg = k.getSize();
  const bgra = k.toBitmap();
  const rgb = Buffer.alloc(kg.width * kg.height * 3);
  for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) { rgb[j] = bgra[i + 2]; rgb[j + 1] = bgra[i + 1]; rgb[j + 2] = bgra[i]; }
  return { b: kg.width, h: kg.height, px: rgb.toString('base64') };
}
// das Terminal-Programm liegt ausserhalb von app.asar (asarUnpack), damit es jedes Programm lesen kann
const cliPfad = () => path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'cli', 'glowline-cli.js');
const terminalErlaubt = (f) => typeof f === 'string' && !!f && (studio.inAusgabe(f) || freigegeben.has(path.resolve(f))) && fs.existsSync(f);
function terminalStarten() {
  terminal.init({
    chatSenden, chatStopp: (id) => { const ac = chats.get(id); if (ac) ac.abort(); },
    hoerer: sendeHoerer, proxy: () => proxy, gpu: () => gpu(), modelle: () => modellListe(true), cfg: () => cfg,
    erlaubt: terminalErlaubt, freigeben: (f) => freigegeben.add(path.resolve(f)), vorschau: terminalVorschau,
    kopieren: (t) => clipboard.writeText(t), autostart, statistik: () => statistik.stand(),
    geladen: () => statusSchleife.geladen || [], update,
    // Code im Glowline-Fenster ausfuehren (Spracheingabe fuer gl: das Fenster hat das Mikrofon), zeigen = Fenster nach vorn
    fensterJs: async (code) => {
      if (!win || win.isDestroyed()) return { fehler: 'The Glowline window is not ready yet' };
      try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { fehler: String((e && e.message) || e).slice(0, 200) }; }
    },
    zeigen: zeigeFenster,
    // "Saved costs" genau wie unten im Fenster; ohne Fenster die Summe der Stats-Seite
    gespart: async () => {
      try { if (win && !win.isDestroyed()) return +(await win.webContents.executeJavaScript('gespartJetzt()')) || 0; } catch {}
      return Object.values(statistik.stand().tage || {}).reduce((a, t) => a + (t.dollar || 0), 0);
    },
    oeffnen: (f, zeigen) => {
      const p = terminalErlaubt(f) ? path.resolve(f) : eigeneDatei(f);
      if (!p) return false;
      if (zeigen) shell.showItemInFolder(p);
      else if (terminalErlaubt(f) || dateien.ANSEHEN.test(p)) shell.openPath(p); // Skripte nie ausfuehren
      else shell.showItemInFolder(p);
      return true;
    },
    version: app.getVersion(), datei: path.join(app.getPath('userData'), 'terminal.json'), test: !!process.env.GLOWLINE_TEST,
  });
  terminal.starte().catch((e) => console.error('terminal', e));
  // gl / glowline einrichten: nur die installierte App (nicht beim Entwickeln, nie im Test)
  if (!app.isPackaged || process.env.GLOWLINE_TEST) return;
  setTimeout(() => {
    terminal.installiere({
      bin: path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Glowline', 'bin'),
      exe: process.execPath,
      cli: cliPfad(),
      dokumente: app.getPath('documents'),
    }).catch((e) => console.error('terminal install', e));
  }, 8000);
}

// Testmodus: eigener Datenordner, damit er weder die offene Glowline noch die config.json beruehrt
if (process.env.GLOWLINE_TEST) app.setPath('userData', path.join(process.env.GLOWLINE_TEST, 'daten'));

if (!process.env.GLOWLINE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => zeigeFenster());
  app.on('before-quit', () => { wirklichBeenden = true; });
  // fertig geladenes Update beim Beenden still installieren (Einstellung "auto")
  app.on('will-quit', () => { statistik.jetztSpeichern(); update.beimBeenden(); terminal.stoppe(); });
  app.setAppUserModelId('Glowline');
  app.whenReady().then(async () => {
    ladeConfig();
    statistik.init(path.dirname(cfgPfad));
    update.init({
      version: app.getVersion(), link: LINK_APP, cfg: () => cfg, sende, ladeDatei: studio.ladeDatei, test: !!process.env.GLOWLINE_TEST,
      ordner: process.env.GLOWLINE_TEST ? path.join(process.env.GLOWLINE_TEST, 'update') : path.join(app.getPath('userData'), 'update'),
      beenden: () => { wirklichBeenden = true; app.quit(); }, vorNeustart: merkeFensterFuerUpdate,
    });
    hoeren.init({
      cfg: () => cfg, sende, ladeDatei: studio.ladeDatei, test: !!process.env.GLOWLINE_TEST,
      ordner: process.env.GLOWLINE_TEST ? path.join(process.env.GLOWLINE_TEST, 'hoeren') : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Glowline', 'hoeren'),
    });
    link.init({ cfg: () => cfg, speichere: speichereConfig, version: app.getVersion(), gpu: () => gpu(), sende, vramFrei });
    if (LINK_APP) link.umleiten();
    else if (cfg.link && cfg.link.teilen) link.teilen(true);
    proxy = new StatsProxy(cfg);
    proxy.wolke = konten.ziel;
    proxy.on('stat', (s) => sende('stat', s));
    try { await proxy.listen(cfg.port); } catch (e) {
      dialog.showErrorBox('Glowline', `Port ${cfg.port} is already in use (${e.code}). Set a different "port" in config.json.`);
    }
    studio.init(process.env.GLOWLINE_STUDIO || cfg.studioOrdner || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Glowline', 'studio'),
      (k, x) => { sende(k, x); if (k === 'studio') einrichtung.studioEreignis(x); }, (id) => konten.schluessel(id));
    // PC: Link-Laptops duerfen das Studio benutzen; Laptop (Glowline Link): Studio-Auftraege gehen an den PC
    link.setzeStudio(process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_ATTRAPPE ? chatStudioAttrappe() : studio);
    if (LINK_APP) require('./fernstudio')(studio, link, sende);
    else {
      const attrappe = !!(process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_ATTRAPPE);
      const studioFuerFilm = attrappe ? chatStudioAttrappe() : studio;
      film.init({
        ordner: process.env.GLOWLINE_TEST ? path.join(process.env.GLOWLINE_TEST, 'filme') : path.join(studio.P().basis, 'filme'),
        ausgabe: () => studio.P().ausgabe, python: () => (process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_PY) || studio.P().py,
        studio: studioFuerFilm, vramFrei, sende, cfg: () => cfg, test: !!process.env.GLOWLINE_TEST, verschieben: !attrappe,
        frage: (m, sys, msgs, max, signal) => erstellen.frage(m, sys, msgs, max, signal), rollen: () => autoChat.rollen(),
        erlaubt: (f) => typeof f === 'string' && (studio.inAusgabe(f) || freigegeben.has(path.resolve(f))) && fs.existsSync(f),
      });
      nacht.init({ cfg: () => cfg, speichere: speichereConfig, studio: studioFuerFilm, film, vramFrei, sende, test: !!process.env.GLOWLINE_TEST });
    }
    erstellen.init({
      cfg: () => cfg, teileModell, konten, vramFrei,
      studio: process.env.GLOWLINE_TEST && process.env.GLOWLINE_TEST_ATTRAPPE ? chatStudioAttrappe() : studio,
      erlaubt: (f) => typeof f === 'string' && (studio.inAusgabe(f) || freigegeben.has(path.resolve(f))) && fs.existsSync(f),
      film: LINK_APP ? null : film,
    });
    autoChat.init({ cfg: () => cfg });
    einrichtung.init({
      cfg: () => cfg, sende, studio, ollamaHolen, ollamaInstalliert,
      werkzeugeInstalliert, werkzeugInstallieren, werkzeugName: (t) => (INSTALL[t] || {}).name,
      ollamaStillInstallieren, hoeren,
      setzeConfig: (neu) => { Object.assign(cfg, neu); speichereConfig(); sende('config', cfg); },
    });
    dateien.init((art) => app.getPath(art));
    dateiProtokoll();
    terminalStarten();
    if (!LINK_APP) agenten.starten(studio, vramFrei, app.getVersion());
    fenster();
    statusSchleife();
    if (process.env.GLOWLINE_TEST) {
      win.webContents.on('console-message', (_e, lvl, msg, zeile, quelle) => { if (lvl >= 2) console.log('RENDERER', msg, path.basename(String(quelle)) + ':' + zeile); });
      testLauf(process.env.GLOWLINE_TEST);
    }
  });
  // auch bei app.quit() (dann kommt kein window-all-closed): Studio-Motor nicht weiterlaufen lassen
  app.on('will-quit', () => { for (const p of ptys.values()) ptyWeg(p); ptys.clear(); film.stoppen(); studio.stoppen(); });
  app.on('window-all-closed', () => {
    for (const p of ptys.values()) ptyWeg(p);
    ptys.clear();
    if (gpuProzess) try { gpuProzess.kill(); } catch {}
    studio.stoppen();
    app.quit();
  });
}
