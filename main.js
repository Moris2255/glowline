// Glowline: minimales Terminal fuer lokale KI-Modelle (Claude Code, Codex, OpenCode)
// mit Live-Leiste unten (tok/s, Prefill, erstes Token, Kontext, VRAM).
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const { StatsProxy, teileModell, istWolke } = require('./proxy');
const konten = require('./konten');

const HOME = os.homedir();

// Standardwerte. Aenderbar in %APPDATA%\Glowline\config.json
const STANDARD = {
  port: 3460,
  backends: { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' },
  defaultBackend: 'ollama',
  defaultModel: '', // leer = erstes geladenes bzw. verfuegbares Modell
  defaultTool: 'claude',
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
  aus.ollama.installiert = aus.ollama.online || fs.existsSync(path.join(la, 'Programs', 'Ollama', 'ollama.exe'))
    || !!(await findeProgramm('ollama', await frischerPfad()));
  aus.lmstudio.installiert = aus.lmstudio.online || fs.existsSync(path.join(HOME, '.lmstudio')) || fs.existsSync(path.join(la, 'Programs', 'LM Studio'));
  aus.wolke = await wolke;
  return aus;
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
async function chatSenden({ id, model: modellId, system, nachrichten }) {
  const ac = new AbortController();
  chats.set(id, ac);
  const melde = (p) => sende('chat', { id, ...p });
  try {
    const { backend, model } = teileModell(String(modellId || ''));
    const b = backend || 'ollama';
    const w = konten.WOLKEN[b];
    if (!model) throw new Error('No model selected');
    if (w && w.nurWerkzeug) throw new Error(`${w.name} works only inside ${WERKZEUG[w.nurWerkzeug]}. For chat, add an API key under Models → Accounts or pick a local model.`);
    const msgs = (Array.isArray(nachrichten) ? nachrichten : []).filter((m) => m && /^(user|assistant)$/.test(m.role)).map((m) => ({ role: m.role, content: String(m.content) }));
    const anthropic = w && w.format === 'anthropic';
    const url = `http://127.0.0.1:${cfg.port}/s/chat/${b}` + (anthropic ? '/v1/messages' : '/v1/chat/completions');
    const body = anthropic
      ? { model, max_tokens: 8192, stream: true, ...(system ? { system } : {}), messages: msgs }
      : { model, stream: true, stream_options: { include_usage: true }, messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs] };
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
      if (Date.now() - zuletzt > 60) { zuletzt = Date.now(); melde(trenne()); }
    }
    melde({ ...trenne(), fertig: true });
  } catch (e) {
    melde({ fertig: true, fehler: ac.signal.aborted ? 'stopped' : e.message });
  } finally {
    chats.delete(id);
  }
}

// LM Studio weicht auf einen anderen Port aus, wenn 1234 belegt ist. Dann die naechsten Ports durchprobieren
// (nur auf diesem PC, kurze Zeitgrenze) und die gefundene Adresse merken.
let lmSuchZeit = 0;
async function lmPortSuchen() {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(cfg.backends.lmstudio);
  if (!m || Date.now() - lmSuchZeit < 10000) return false;
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
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|ELECTRON_|CODEX_OSS_|OPENCODE_CONFIG)/.test(k)) continue;
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
  return [...sys.split(';'), ...nutzer.split(';'), ...(process.env.PATH || '').split(';')]
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
  await Promise.all(Object.keys(INSTALL).map(async (t) => { r[t] = !!(await findeProgramm(t, pfad)); }));
  return r;
}
const INSTALL = {
  claude: { name: 'Claude Code', befehl: 'irm https://claude.ai/install.ps1 | iex' },
  codex: { name: 'Codex', befehl: 'npm install -g @openai/codex', node: true },
  opencode: { name: 'OpenCode', befehl: 'npm install -g opencode-ai', node: true },
};
const WERKZEUG = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', shell: 'PowerShell' };
function meldung(env, zeilen) {
  const text = ['', ...zeilen, ''].map((t, i) => `Write-Host ${q(t)}${i === 1 ? ' -ForegroundColor Yellow' : i > 1 && t ? ' -ForegroundColor DarkGray' : ''}`).join('; ');
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', text], env };
}
function installHinweis(tool) {
  const i = INSTALL[tool];
  const zeile = (text, farbe) => `Write-Host ${q(text)}${farbe ? ' -ForegroundColor ' + farbe : ''}`;
  return [
    zeile(''),
    zeile(`${i.name} is not installed on this PC.`, 'Yellow'),
    zeile('Install it right here by pasting this command:'),
    zeile(''),
    zeile('    ' + i.befehl, 'White'),
    zeile(''),
    i.node ? zeile('(this needs Node.js – get it at https://nodejs.org)', 'DarkGray') : null,
    zeile(`When it is done, choose ${i.name} again in the tool menu (bottom right).`, 'DarkGray'),
    zeile(''),
  ].filter(Boolean).join('; ');
}

async function baueBefehl(tool, modellId, tab) {
  const { backend, model } = teileModell(modellId || cfg.defaultModel || '');
  const basis = `http://127.0.0.1:${cfg.port}/s/${tab}/${backend || 'auto'}`;
  const pfad = await frischerPfad();
  const env = mitPfad(sauberesEnv(), pfad);
  let zeile = null;
  let exe = null;
  if (INSTALL[tool]) {
    exe = await findeProgramm(tool, pfad);
    if (!exe) return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', installHinweis(tool)], env, fehlt: tool };
  }

  const wolke = istWolke(backend) ? konten.WOLKEN[backend] : null;
  if (wolke) {
    const passt = { claude: ['abo', 'anthropic'], codex: ['chatgpt', 'openai'], opencode: ['anthropic', 'openai', 'openrouter', 'gemini'] }[tool];
    if (passt && !passt.includes(backend)) {
      const wo = wolke.nurWerkzeug ? WERKZEUG[wolke.nurWerkzeug] : 'OpenCode or Chat';
      return meldung(env, [`${wolke.name} models work in ${wo}, not in ${WERKZEUG[tool]}.`, 'Pick another model (bottom right) or switch the tool.']);
    }
  }

  if (tool === 'claude') {
    if (!wolke) Object.assign(env, cfg.claude.env, { ANTHROPIC_BASE_URL: basis, ANTHROPIC_AUTH_TOKEN: 'glowline' });
    // Abo: Claude Code meldet sich selbst an, der Proxy misst nur mit. API-Schluessel: setzt der Proxy ein.
    else if (backend === 'abo') env.ANTHROPIC_BASE_URL = basis;
    else Object.assign(env, { ANTHROPIC_BASE_URL: basis, ANTHROPIC_AUTH_TOKEN: 'glowline' });
    const a = [q(exe)];
    // Eigene Einstellungsdatei: optionale Nutzer-Einstellungen + leere Statuszeile (die Werte zeigt ja Glowline unten an)
    let einst = {};
    try { einst = JSON.parse(fs.readFileSync(cfg.claude.settings, 'utf8')); } catch {}
    if (cfg.claude.hideStatusLine) einst.statusLine = { type: 'command', command: 'node -e ""', padding: 0 };
    if (einst.spinnerTipsEnabled === undefined) einst.spinnerTipsEnabled = false; // weniger Text unter der Eingabe
    const einstPfad = path.join(app.getPath('userData'), 'claude-settings.json');
    fs.writeFileSync(einstPfad, JSON.stringify(einst, null, 2));
    a.push('--settings', q(einstPfad));
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
      modelle[m.name] = { name: m.name, limit: { context: m.ctx || 128000, output: 16000 } };
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
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider, model: gewaehlt });
    // --standalone: eigener Server, sonst nimmt OpenCode 2 den Hintergrund-Dienst ohne unsere Einstellungen
    zeile = `& ${q(exe)} --standalone`;
  }

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
    if (!REPO.test(repo) || !/^[\w-]+$/.test(quant)) throw new Error('invalid model');
    if (ziel === 'ollama') await ollamaHolen(`hf.co/${repo}:${quant}`, ac, melde);
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

function sende(kanal, ...a) {
  if (win && !win.isDestroyed()) win.webContents.send(kanal, ...a);
}

ipcMain.handle('pty:spawn', async (_e, o) => {
  const id = naechsteId++;
  const tab = 't' + id;
  const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : HOME;
  const { file, args, env, fehlt } = await baueBefehl(o.tool, o.model, tab);
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols || 120, rows: o.rows || 30, cwd, env, useConpty: true });
  // Ausgabe buendeln, damit schnelle Modelle das Fenster nicht mit IPC fluten
  let puffer = '', geplant = false;
  p.onData((d) => {
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
ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch {} ptys.delete(id); } });

ipcMain.handle('models:list', () => modellListe(true));
ipcMain.handle('tools:check', () => werkzeugeInstalliert());
ipcMain.handle('konten:status', () => konten.status());
ipcMain.handle('konten:setzen', (_e, id, wert) => { konten.setzeSchluessel(id, wert); return konten.status(); });
ipcMain.on('link:oeffnen', (_e, url) => { if (/^https:\/\/[\w.-]+\//.test(String(url))) shell.openExternal(url); });
ipcMain.on('chat:senden', (_e, a) => chatSenden(a));
ipcMain.on('chat:stopp', (_e, id) => { const ac = chats.get(id); if (ac) ac.abort(); });
ipcMain.handle('lmstudio:start', () => lmServerStarten());
ipcMain.handle('models:load', (_e, id, laden) => modellLaden(id, laden));
ipcMain.on('download:start', (_e, d) => herunterladen(d));
ipcMain.on('download:cancel', (_e, key) => { const ac = downloads.get(key); if (ac) ac.abort(); });
ipcMain.handle('hf:search', (_e, q) => hfSuche(q));
ipcMain.handle('hf:files', (_e, repo) => hfDateien(repo));
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:set', (_e, patch) => { Object.assign(cfg, mische(cfg, patch)); speichereConfig(); return cfg; });
ipcMain.handle('dir:pick', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: start || cfg.lastDir, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.on('clip:write', (_e, t) => clipboard.writeText(t));
ipcMain.on('win:title', (_e, t) => { if (win) win.setTitle(t); });

// ---------- Fenster ----------
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
    backgroundColor: '#0c0d0f',
    title: 'Glowline',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    roundedCorners: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d0f', symbolColor: '#c9cbcf', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      offscreen: !!process.env.GLOWLINE_TEST,
    },
  });
  Menu.setApplicationMenu(null);
  // Testmodus: Fenster ausserhalb des Bildschirms, ohne Fokus und ohne Taskleiste
  if (process.env.GLOWLINE_TEST) win.webContents.on('paint', (_e, _d, bild) => { win.letztesBild = bild; });
  else win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), test ? { query: { test: '1' } } : undefined);
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F12') win.webContents.toggleDevTools();
    // F11 = Vollbild wie im Windows Terminal (Titelzeile verschwindet, nur Terminal + Leiste)
    if (i.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  win.on('enter-full-screen', () => sende('vollbild', true));
  win.on('leave-full-screen', () => sende('vollbild', false));
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

// Testmodus: eigener Datenordner, damit er weder die offene Glowline noch die config.json beruehrt
if (process.env.GLOWLINE_TEST) app.setPath('userData', path.join(process.env.GLOWLINE_TEST, 'daten'));

if (!process.env.GLOWLINE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.setAppUserModelId('Glowline');
  app.whenReady().then(async () => {
    ladeConfig();
    proxy = new StatsProxy(cfg);
    proxy.wolke = konten.ziel;
    proxy.on('stat', (s) => sende('stat', s));
    try { await proxy.listen(cfg.port); } catch (e) {
      dialog.showErrorBox('Glowline', `Port ${cfg.port} is already in use (${e.code}). Set a different "port" in config.json.`);
    }
    fenster();
    statusSchleife();
    if (process.env.GLOWLINE_TEST) {
      win.webContents.on('console-message', (_e, lvl, msg, zeile, quelle) => { if (lvl >= 2) console.log('RENDERER', msg, path.basename(String(quelle)) + ':' + zeile); });
      testLauf(process.env.GLOWLINE_TEST);
    }
  });
  app.on('window-all-closed', () => {
    for (const p of ptys.values()) try { p.kill(); } catch {}
    if (gpuProzess) try { gpuProzess.kill(); } catch {}
    app.quit();
  });
}
