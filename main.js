// Glowline: minimales Terminal fuer lokale KI-Modelle (Claude Code, Codex, OpenCode)
// mit Live-Leiste unten (tok/s, Prefill, erstes Token, Kontext, VRAM).
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('@lydell/node-pty');
const { StatsProxy, teileModell } = require('./proxy');

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
  fontSize: 14,
  // Geschaetzte Claude-API-Preise (USD pro Mio. Tokens) fuer die Anzeige "Gespart"
  preise: { eingabe: 3.75, cache: 0.3, ausgabe: 15 },
  gespart: 0,
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

async function modellListe() {
  const aus = { ollama: { online: false, models: [] }, lmstudio: { online: false, models: [] } };
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
      try {
        const r = await holeJson(L + '/api/v0/models', { zeit: 2500 });
        aus.lmstudio.online = true;
        aus.lmstudio.models = (r.data || []).filter((m) => m.type !== 'embeddings').map((m) => ({
          id: 'lmstudio,' + m.id, name: m.id, quant: m.quantization, params: m.arch,
          loaded: m.state === 'loaded', ctx: m.loaded_context_length || m.max_context_length || null,
        }));
      } catch {
        try {
          const r = await holeJson(L + '/v1/models', { zeit: 2500 });
          aus.lmstudio.online = true;
          aus.lmstudio.models = (r.data || []).map((m) => ({ id: 'lmstudio,' + m.id, name: m.id, loaded: false }));
        } catch {}
      }
    })(),
  ]);
  return aus;
}

function lms(args) {
  const exe = path.join(HOME, '.lmstudio', 'bin', 'lms.exe');
  return new Promise((ok) => execFile(fs.existsSync(exe) ? exe : 'lms', args, { timeout: 300000 }, (e, so, se) => ok(e ? (se || e.message) : 'ok')));
}

async function modellLaden(id, laden) {
  const { backend, model } = teileModell(id);
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
function gpu() {
  return new Promise((ok) => execFile('nvidia-smi',
    ['--query-gpu=name,memory.used,memory.total,utilization.gpu,power.draw', '--format=csv,noheader,nounits'],
    { timeout: 3000, windowsHide: true },
    (e, so) => {
      if (e || !so) return ok(null);
      const [name, used, total, util, power] = so.split('\n')[0].split(',').map((s) => s.trim());
      ok({ name, used: +used, total: +total, util: +util, power: parseFloat(power) });
    }));
}

async function statusSchleife() {
  const [g, geladen] = await Promise.all([
    gpu(),
    holeJson(cfg.backends.ollama + '/api/ps', { zeit: 1500 }).then((r) => r.models || []).catch(() => null),
  ]);
  let lmsOnline = false;
  if (gpuZaehler++ % 5 === 0) {
    lmsOnline = await holeJson(cfg.backends.lmstudio + '/v1/models', { zeit: 800 }).then(() => true).catch(() => false);
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
  setTimeout(statusSchleife, 2000);
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

async function baueBefehl(tool, modellId, tab) {
  const { backend, model } = teileModell(modellId || cfg.defaultModel);
  const basis = `http://127.0.0.1:${cfg.port}/s/${tab}/${backend || 'auto'}`;
  const env = sauberesEnv();
  let zeile = null;

  if (tool === 'claude') {
    Object.assign(env, cfg.claude.env, { ANTHROPIC_BASE_URL: basis, ANTHROPIC_AUTH_TOKEN: 'glowline' });
    const a = ['claude.cmd'];
    // Eigene Einstellungsdatei: optionale Nutzer-Einstellungen + leere Statuszeile (die Werte zeigt ja Glowline unten an)
    let einst = {};
    try { einst = JSON.parse(fs.readFileSync(cfg.claude.settings, 'utf8')); } catch {}
    if (cfg.claude.hideStatusLine) einst.statusLine = { type: 'command', command: 'node -e ""', padding: 0 };
    const einstPfad = path.join(app.getPath('userData'), 'claude-settings.json');
    fs.writeFileSync(einstPfad, JSON.stringify(einst, null, 2));
    a.push('--settings', q(einstPfad));
    if (cfg.claude.systemPromptFile && fs.existsSync(cfg.claude.systemPromptFile)) a.push('--append-system-prompt-file', q(cfg.claude.systemPromptFile));
    if (cfg.claude.skipPermissions) a.push('--dangerously-skip-permissions');
    a.push('--model', q((backend || 'ollama') + ',' + model));
    zeile = '& ' + a.join(' ');
  } else if (tool === 'codex') {
    env.CODEX_OSS_BASE_URL = basis + '/v1';
    zeile = `& codex --oss --local-provider ${backend === 'lmstudio' ? 'lmstudio' : 'ollama'} -m ${q(model)}`;
  } else if (tool === 'opencode') {
    const liste = await modellListe();
    const modelle = {};
    for (const m of [...liste.ollama.models, ...liste.lmstudio.models]) {
      modelle[m.name] = { name: m.name, limit: { context: m.ctx || 128000, output: 16000 } };
    }
    modelle[model] = modelle[model] || { name: model, limit: { context: 128000, output: 16000 } };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        glowline: {
          npm: '@ai-sdk/openai-compatible', name: 'Glowline',
          options: { baseURL: basis + '/v1', apiKey: 'glowline' }, models: modelle,
        },
      },
      model: 'glowline/' + model,
    });
    // --standalone: eigener Server, sonst nimmt OpenCode 2 den Hintergrund-Dienst ohne unsere Einstellungen
    zeile = '& opencode.cmd --standalone';
  }

  const args = zeile ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', zeile] : ['-NoLogo'];
  return { file: 'powershell.exe', args, env };
}

function sende(kanal, ...a) {
  if (win && !win.isDestroyed()) win.webContents.send(kanal, ...a);
}

ipcMain.handle('pty:spawn', async (_e, o) => {
  const id = naechsteId++;
  const tab = 't' + id;
  const cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : HOME;
  const { file, args, env } = await baueBefehl(o.tool, o.model, tab);
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
  return { id, tab, cwd };
});
ipcMain.on('pty:write', (_e, id, d) => { const p = ptys.get(id); if (p) p.write(d); });
ipcMain.on('pty:resize', (_e, id, c, r) => { const p = ptys.get(id); if (p && c > 0 && r > 0) try { p.resize(c, r); } catch {} });
ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch {} ptys.delete(id); } });

ipcMain.handle('models:list', () => modellListe());
ipcMain.handle('models:load', (_e, id, laden) => modellLaden(id, laden));
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:set', (_e, patch) => { cfg = mische(cfg, patch); speichereConfig(); return cfg; });
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
    proxy.on('stat', (s) => sende('stat', s));
    try { await proxy.listen(cfg.port); } catch (e) {
      dialog.showErrorBox('Glowline', `Port ${cfg.port} is already in use (${e.code}). Set a different "port" in config.json.`);
    }
    fenster();
    statusSchleife();
    if (process.env.GLOWLINE_TEST) testLauf(process.env.GLOWLINE_TEST);
  });
  app.on('window-all-closed', () => {
    for (const p of ptys.values()) try { p.kill(); } catch {}
    app.quit();
  });
}
