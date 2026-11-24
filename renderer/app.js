'use strict';
// Glowline: ein Terminal + die Leiste. Werkzeug/Modell/Ordner wechseln startet die Sitzung neu.
const $ = (s) => document.querySelector(s);
const zahl = (n, d = 0) => (n == null || !isFinite(n) ? '–' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kurz = (n) => (n == null ? '–' : n >= 1000 ? zahl(n / 1000, n >= 10000 ? 0 : 1) + 'k' : String(n));
const WERKZEUG_NAME = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity',
  gemini: 'Gemini CLI', qwen: 'Qwen Code', copilot: 'GitHub Copilot', droid: 'Droid', cline: 'Cline', shell: 'PowerShell',
};
// Werkzeuge mit eigenem Konto: waehlen ihr Modell selbst (Glowline startet sie nur im Ordner)
const KONTO = { antigravity: 'Google account', gemini: 'Google account', copilot: 'GitHub account', droid: 'Factory account', cline: 'Cline account' };
const MEHR_AGENTEN = ['gemini', 'qwen', 'copilot', 'droid', 'cline'];
const TESTMODUS = new URLSearchParams(location.search).has('test');

// Lesbarer Modellname: "hf.co/mradermacher/Foo-8B-abliterated-i1-GGUF:i1-Q4_K_M" -> "Foo-8B-abliterated" + Ersteller "mradermacher".
// Die Quantisierung steht ohnehin in der Info daneben, der volle Name im Tooltip.
const QUANT_TAG = /^(i1-)?(UD-)?(I?Q\d[\w]*|F16|BF16|F32)$|^latest$/i;
function anzeigeName(voll) {
  let n = String(voll || '').replace(/^(ollama|lmstudio|abo|chatgpt|anthropic|openai|openrouter|gemini|deepseek|groq|mistral|xai),/, ''), quelle = '', tag = '';
  const hf = /^hf\.co\/([^/]+)\/(.+)$/i.exec(n);
  if (hf) [, quelle, n] = hf;
  const i = n.lastIndexOf(':');
  if (i > 0) { tag = n.slice(i + 1); n = n.slice(0, i); }
  if (!hf) { const ns = /^(.+)\/([^/]+)$/.exec(n); if (ns) [, quelle, n] = ns; }
  n = n.replace(/\.gguf$/i, '').replace(/[-_.]gguf$/i, '').replace(/[-_.]i1$/i, '');
  if (tag && !QUANT_TAG.test(tag)) n += ':' + tag;
  return { name: n || voll, quelle };
}

let cfg = {};
let ansicht = 'terminal'; // terminal | chat | studio
// ARTEX ist noch gesperrt, bis es einmal echt getestet ist (dann ARTEX_FREI = true). Shift+Klick oeffnet es trotzdem.
const ARTEX_FREI = false;
const imChat = () => ansicht === 'chat' || ansicht === 'studio'; // Studio nutzt das Chat-Modell fuer den Prompt-Helfer
const BACKEND_NAME = { ollama: 'Ollama', lmstudio: 'LM Studio', abo: 'Claude subscription', chatgpt: 'ChatGPT account', anthropic: 'Anthropic API', openai: 'OpenAI API', openrouter: 'OpenRouter', gemini: 'Google Gemini', deepseek: 'DeepSeek', groq: 'Groq', mistral: 'Mistral', xai: 'xAI' };
const backendVon = (id) => (/^([a-z]+),/.exec(id || '') || [])[1] || 'ollama';
const istWolkeId = (id) => /^(abo|chatgpt|anthropic|openai|openrouter|gemini|deepseek|groq|mistral|xai),/.test(id || '');
const aktiveKennung = () => (imChat() ? 'chat' : sitzung && sitzung.kennung);
let liste = null; // Modell-Liste
let status = { loaded: [] };
let sitzung = null; // { id, kennung, tool, model, cwd, beendet }
let aufgabe = null; // Arbeitsgedaechtnis: Kennung der Aufgabe (gleich bei Modellwechsel, neu bei neuem Ordner)
let neueEingabe = false; // Enter gedrueckt -> naechste Anfrage startet einen neuen Turn
const stats = new Map(); // Kennung -> Messwerte

const THEMA = {
  background: '#0e0e0e', foreground: '#e8e6e3', cursor: '#ffffff', cursorAccent: '#0e0e0e',
  selectionBackground: '#ffffff33',
  black: '#1f1f1e', red: '#ef5f58', green: '#5fd39a', yellow: '#e8b04a', blue: '#6aa5f8', magenta: '#c792ea', cyan: '#5fc9d6', white: '#e6e7e9',
  brightBlack: '#6b6f76', brightRed: '#ff8178', brightGreen: '#7fe3b2', brightYellow: '#f5c870', brightBlue: '#8fbcff', brightMagenta: '#ddb0ff', brightCyan: '#8be0ea', brightWhite: '#ffffff',
};

// ---------------- Terminal ----------------
const term = new Terminal({
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: 14, lineHeight: 1.15, cursorBlink: true, allowProposedApi: true,
  scrollback: 20000, theme: THEMA, windowsPty: { backend: 'conpty' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = '11';
const el = document.createElement('div');
el.className = 'term';
$('#terms').appendChild(el);
term.open(el);
requestAnimationFrame(() => { try { fit.fit(); } catch {} }); // nochmal, sobald die Zeilenhoehe gemessen ist
try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}
// Die letzte Zeile sitzt immer gleich weit ueber der Leiste: den Rest (Fensterhoehe passt nie genau auf Zeilen)
// nach oben schieben statt unten frei zu lassen. Unten bleibt eine halbe Zeile, so weit wie Eingabe-Linie -> Modus-Zeile.
const fitRoh = fit.fit.bind(fit);
fit.fit = () => {
  // Abstaende als Padding am .xterm-Element – das zieht das Fit-Addon selbst ab
  const x = term.element, zelle = term._core?._renderService?.dimensions?.css?.cell?.height || 0;
  if (!x) return fitRoh();
  const unten = zelle ? Math.max(0, Math.round(zelle / 2) - 6) : 0;
  x.style.paddingTop = '0px';
  x.style.paddingBottom = unten + 'px';
  fitRoh();
  const schirm = x.querySelector('.xterm-screen');
  if (!schirm || !zelle) return;
  const rest = el.clientHeight - unten - schirm.getBoundingClientRect().height;
  x.style.paddingTop = Math.max(0, Math.floor(rest)) + 'px';
};

term.onData((d) => {
  if (!sitzung) return;
  if (sitzung.beendet) { if (d === '\r') starteSitzung({}); return; }
  if (d.includes('\r')) neueEingabe = true;
  window.api.write(sitzung.id, d);
});
term.onResize(({ cols, rows }) => { if (sitzung && !sitzung.beendet) window.api.resize(sitzung.id, cols, rows); });
new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe($('#terms'));

window.api.onData((id, d) => { if (sitzung && sitzung.id === id) term.write(d); });
// fehlendes Werkzeug ist fertig installiert: gleich damit weitermachen
window.api.onWerkzeugInstalliert((id, tool) => {
  if (!sitzung || sitzung.id !== id) return;
  hinweis(WERKZEUG_NAME[tool] + ' is installed – starting it');
  starteSitzung({ tool });
});
window.api.onExit((id, code) => {
  if (!sitzung || sitzung.id !== id) return;
  sitzung.beendet = true;
  term.write(`\r\n\x1b[90m[${WERKZEUG_NAME[sitzung.tool]} exited${code ? ' (code ' + code + ')' : ''} – press Enter to restart]\x1b[0m\r\n`);
});

async function starteSitzung(neu) {
  const tool = neu.tool || (sitzung && sitzung.tool) || cfg.defaultTool || 'claude';
  const ohneModell = tool === 'shell' || !!KONTO[tool];
  const model = ohneModell ? null : neu.model || (sitzung && sitzung.model) || cfg.defaultModel || (await standardModell());
  const cwd = neu.cwd || (sitzung && sitzung.cwd) || cfg.lastDir;
  // ohne Modell: Hinweis zum Modell-Server - ausser das Werkzeug fehlt, dann zeigt das Terminal die Installationshilfe
  if (!model && !ohneModell && (await window.api.tools().catch(() => ({})))[tool] !== false) {
    if (sitzung && !sitzung.beendet) window.api.kill(sitzung.id);
    sitzung = { id: null, kennung: null, tool, model: null, cwd, beendet: true };
    term.reset();
    term.write(keinModellText());
    zeichneLeiste();
    return;
  }
  if (sitzung && !sitzung.beendet) window.api.kill(sitzung.id);
  // Arbeitsgedaechtnis: gleiche Aufgabe, solange der Ordner bleibt (Modell- oder Werkzeugwechsel, Neustart) – neuer Ordner = neue Aufgabe
  if (!aufgabe || !sitzung || cwd !== sitzung.cwd) {
    if (aufgabe) window.api.gedaechtnisLoeschen(aufgabe);
    aufgabe = crypto.randomUUID().replace(/-/g, '');
    zeigeGedaechtnis('');
  }
  term.reset();
  try { fit.fit(); } catch {}
  const r = await window.api.spawn({ tool, model, cwd, cols: term.cols, rows: term.rows, aufgabe });
  sitzung = { id: r.id, kennung: r.tab, tool, model, cwd: r.cwd, beendet: false };
  if (r.fehlt) hinweis('Installing ' + WERKZEUG_NAME[r.fehlt] + ' – it starts by itself when done');
  if (tool !== 'shell') { cfg.defaultTool = tool; if (model) cfg.defaultModel = model; }
  cfg.lastDir = r.cwd;
  const ordner = r.cwd.replace(/^C:\\Users\\[^\\]+/i, '~');
  $('#titel-text').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = WERKZEUG_NAME[tool];
  $('#titel-text').append(b, '  ·  ' + ordner);
  window.api.setTitle(`Glowline · ${WERKZEUG_NAME[tool]} · ${r.cwd}`);
  term.focus();
  zeichneLeiste();
}
window.starteSitzung = starteSitzung;

// Erklaerung, warum kein Modell da ist: nichts installiert, nicht gestartet oder noch keine Modelle
function keinModellText() {
  const o = (liste && liste.ollama) || {}, l = (liste && liste.lmstudio) || {};
  const grau = (t) => '\x1b[90m' + t + '\x1b[0m\r\n', gelb = (t) => '\x1b[33m' + t + '\x1b[0m\r\n';
  if (o.online || l.online) {
    return gelb('No models yet.') + grau(`${o.online ? 'Ollama' : 'LM Studio'} is running but has no models. Click the model button (bottom right) →`)
      + grau('“All models & downloads” → Download to get one (or Express setup for a ready-made set), then press Enter here.');
  }
  if (o.installiert || l.installiert) {
    const name = o.installiert ? 'Ollama' : 'LM Studio';
    return gelb(`${name} is installed but not running.`)
      + grau(name === 'LM Studio'
        ? 'Click the model button (bottom right) → “All models & downloads” → “Start LM Studio server”, then press Enter here.'
        : 'Start Ollama, then press Enter here.');
  }
  return gelb('Glowline needs a local model server, and none is installed.')
    + grau('Easiest: Models (bottom right) → “All models & downloads” → Express setup installs everything for you.')
    + grau('Or install one of these yourself (both are free), start it, then press Enter here:')
    + grau('  • Ollama     https://ollama.com/download')
    + grau('  • LM Studio  https://lmstudio.ai')
    + grau('PowerShell works without one: pick it in the tool menu (bottom right).');
}

// Erstes geladenes Modell, sonst das erste verfuegbare
async function standardModell() {
  liste = await window.api.models().catch(() => liste);
  if (!liste) return null;
  const alle = [...liste.ollama.models, ...liste.lmstudio.models];
  const m = alle.find((x) => x.loaded) || alle[0];
  return m ? m.id : null;
}

function hinweis(text) {
  const h = $('#hinweis');
  h.textContent = text;
  h.classList.remove('versteckt');
  clearTimeout(hinweis.t);
  hinweis.t = setTimeout(() => h.classList.add('versteckt'), 2600);
}

// ---------------- Tastatur ----------------
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')) {
    cfg.fontSize = e.key === '0' ? 14 : Math.min(28, Math.max(9, (cfg.fontSize || 14) + (e.key === '-' ? -1 : 1)));
    term.options.fontSize = cfg.fontSize;
    try { fit.fit(); } catch {}
    window.api.setConfig({ fontSize: cfg.fontSize });
    return false;
  }
  // Kopieren: Strg+C mit Markierung oder Strg+Shift+C
  if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
    if (term.hasSelection()) { window.api.clipWrite(term.getSelection()); term.clearSelection(); }
    e.preventDefault();
    return false;
  }
  // Einfuegen: Text direkt, sonst (z. B. Bild) Strg+V an das Programm weitergeben
  if (e.ctrlKey && k === 'v') {
    e.preventDefault();
    window.api.clipRead().then((t) => { if (t) term.paste(t); else if (sitzung) window.api.write(sitzung.id, '\x16'); });
    return false;
  }
  // Shift+Enter = neue Zeile in Claude Code / Codex
  if (e.shiftKey && e.key === 'Enter') { if (sitzung && !sitzung.beendet) window.api.write(sitzung.id, '\x1b\r'); e.preventDefault(); return false; }
  return true;
});

el.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (term.hasSelection()) { window.api.clipWrite(term.getSelection()); term.clearSelection(); }
  else { const t = await window.api.clipRead(); if (t) term.paste(t); }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#link').classList.contains('versteckt')) { schliesseLink(); e.preventDefault(); }
  else if (!$('#einrichtung').classList.contains('versteckt')) { if (ein.seite === 'lauf') $('#ein-fertig').click(); else schliesseEinrichtung(); e.preventDefault(); }
  else if (document.querySelector('.menue:not(.versteckt)')) { schliesseMenues(); e.preventDefault(); }
  else if (!$('#bib').classList.contains('versteckt')) { schliesseBib(); e.preventDefault(); }
});

// ---------------- Menues ----------------
function schliesseMenues() {
  for (const m of document.querySelectorAll('.menue')) m.classList.add('versteckt');
  for (const c of document.querySelectorAll('.chip')) c.classList.remove('offen');
  fokus();
}
function fokus() { if (ansicht === 'chat') $('#chat-text').focus(); else if (ansicht === 'terminal') term.focus(); }
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menue') && !e.target.closest('.chip') && !e.target.closest('#f-gespart')) {
    if (document.querySelector('.menue:not(.versteckt)')) schliesseMenues();
  }
});

// Werkzeug-Menue anpassen: Reihenfolge und welche Eintraege man sieht (cfg.menue)
const MENUE_TEILE = {
  claude: '#tools > [data-tool="claude"]', codex: '#tools > [data-tool="codex"]', opencode: '#tools > [data-tool="opencode"]',
  antigravity: '#tools > [data-tool="antigravity"]', mehr: '#tools > [data-klapp="agenten"], #tools > [data-g="agenten"]',
  cowork: '#tools > [data-modus]', studio: '#tools > [data-studio]',
};
const MENUE_NAME = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', mehr: 'More agents', cowork: 'Cowork', studio: 'Studio' };
function menueReihenfolge() {
  const r = ((cfg.menue && cfg.menue.reihenfolge) || []).filter((id, i, a) => MENUE_TEILE[id] && a.indexOf(id) === i);
  for (const id of Object.keys(MENUE_TEILE)) if (!r.includes(id)) r.push(id);
  return r;
}
function ordneMenue() {
  const tools = $('#tools'), anker = $('#tools .tools-fuss');
  const aus = new Set((cfg.menue && cfg.menue.aus) || []);
  for (const id of menueReihenfolge()) {
    for (const e of [...document.querySelectorAll(MENUE_TEILE[id])]) { tools.insertBefore(e, anker); e.classList.toggle('aus', aus.has(id)); }
  }
}
function setzeMenue(neu) {
  cfg.menue = { reihenfolge: menueReihenfolge(), aus: (cfg.menue && cfg.menue.aus) || [], ...neu };
  window.api.setConfig({ menue: cfg.menue });
  ordneMenue();
  zeichneAnpassen();
}
// Was beim Start aufgeht (cfg.startMit) – '' = das zuletzt benutzte Werkzeug
const START_WAHL = [['', 'Last used'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['antigravity', 'Antigravity'], ['cowork', 'Cowork'], ['studio', 'Studio'], ['artex', 'ARTEX']].filter((x) => x[0] !== 'artex' || ARTEX_FREI);
function startAnsicht() {
  const s = cfg.startMit || '';
  if (s === 'cowork') return zeigeWorkspace('auto');
  if (s === 'studio') return zeigeStudio();
  if (s === 'artex' && ARTEX_FREI) return zeigeArtex();
  if (ansicht !== 'terminal') zeigeTerminal();
  return starteSitzung(WERKZEUG_NAME[s] ? { tool: s } : {});
}
function zeichneAnpassen() {
  const box = $('#tools-anpassen');
  box.innerHTML = '';
  box.appendChild(elem('div', 'm-gruppe', 'When Glowline starts'));
  const start = elem('label', 'anp-zeile anp-start');
  const wahl = elem('select');
  for (const [id, name] of START_WAHL) { const o = elem('option', null, name); o.value = id; wahl.appendChild(o); }
  wahl.value = cfg.startMit || '';
  wahl.addEventListener('change', () => { cfg.startMit = wahl.value; window.api.setConfig({ startMit: wahl.value }); hinweis('On start: ' + START_WAHL.find((x) => x[0] === wahl.value)[1]); });
  start.append(elem('span', null, 'Open'), wahl);
  box.appendChild(start);
  const auswahlZeile = (titel, schluessel, optionen, jetzt, info) => {
    const z = elem('label', 'anp-zeile anp-start');
    const w = elem('select');
    for (const [id, name] of optionen) { const o = elem('option', null, name); o.value = id; w.appendChild(o); }
    w.value = jetzt;
    w.addEventListener('change', () => { cfg[schluessel] = w.value; window.api.setConfig({ [schluessel]: w.value }); hinweis(info(optionen.find((x) => x[0] === w.value)[1])); });
    z.append(elem('span', null, titel), w);
    box.appendChild(z);
  };
  auswahlZeile('Window', 'startFenster', [['vollbild', 'Full screen'], ['gross', 'Maximized'], ['normal', 'Window'], ['minimiert', 'Minimized']],
    ['vollbild', 'gross', 'normal', 'minimiert'].includes(cfg.startFenster) ? cfg.startFenster : cfg.startVollbild === false ? 'gross' : 'vollbild',
    (n) => 'Glowline starts: ' + n + ' (F11 switches full screen)');
  auswahlZeile('Memory', 'arbeitsgedaechtnis', [['256k', 'Note + 256k archive'], ['512k', 'Note + 512k archive'], ['1m', 'Note + 1M archive'], ['notiz', 'Note only'], ['aus', 'Off']],
    cfg.arbeitsgedaechtnis === 'aus' || cfg.arbeitsgedaechtnis === false ? 'aus' : ['notiz', '256k', '512k', '1m'].includes(cfg.arbeitsgedaechtnis) ? cfg.arbeitsgedaechtnis : '256k',
    (n) => n === 'Off' ? 'Working memory off (new sessions)' : n === 'Note only' ? 'Agents keep a short note for the current task (new sessions)'
      : `Agents keep a note and a searchable archive (${n.split(' ')[2]} tokens) for the current task – a virtual extension of their context (new sessions)`);
  auswahlZeile('Updates', 'updates', [['auto', 'Automatic'], ['fragen', 'Just tell me'], ['aus', 'Off']], cfg.updates || 'auto',
    (n) => 'Updates: ' + n + (n === 'Automatic' ? ' – downloads in the background, installs when you quit' : ''));
  const upd = elem('div', 'anp-zeile anp-update');
  const updText = elem('span', null, 'Version ' + (updStand ? updStand.version : '…'));
  const updK = elem('button', 'anp-knopf', 'Check now');
  updK.addEventListener('click', async () => {
    updK.disabled = true; updK.textContent = 'Checking…';
    const s = await window.api.updatePruefen();
    updK.disabled = false; updK.textContent = 'Check now';
    zeigeUpdate(s);
    hinweis(s.fehler ? s.fehler : s.neu ? 'Glowline ' + s.neu + ' is available – click “Update” bottom right' : 'You have the newest version (' + s.version + ')');
  });
  upd.append(updText, updK);
  box.appendChild(upd);
  hoerenMenueZeile(box);
  // Obsidian-Vault fuer Cowork und die Agenten (Liste kommt von Obsidian selbst)
  {
    const z = elem('label', 'anp-zeile anp-start');
    const w = elem('select');
    z.append(elem('span', null, 'Obsidian'), w);
    box.appendChild(z);
    window.api.gehirnVaults().then(({ vaults, aktiv }) => {
      const opt = [['auto', 'Auto' + (cfg.obsidian === 'auto' || !cfg.obsidian ? (aktiv ? ' · ' + aktiv.name : ' · no vault found') : '')], ...vaults.map((v) => [v.pfad, v.name]), ['aus', 'Off']];
      for (const [id, name] of opt) { const o = elem('option', null, name); o.value = id; w.appendChild(o); }
      w.value = opt.some((o) => o[0] === cfg.obsidian) ? cfg.obsidian : 'auto';
    });
    w.addEventListener('change', async () => {
      cfg.obsidian = w.value;
      await window.api.setConfig({ obsidian: w.value });
      gehirnPruefen();
      zeigeObsidian();
      const r = await window.api.gehirnVaults();
      hinweis(r.aktiv ? `Obsidian: “${r.aktiv.name}” – Cowork uses fitting notes, agents can read and change it (new sessions)` : 'Obsidian is off');
    });
  }
  auswahlZeile('Close (X)', 'beimSchliessen', [['beenden', 'Quit'], ['minimieren', 'Minimize'], ['tray', 'Keep running in tray']], cfg.beimSchliessen || 'beenden',
    (n) => 'Close button: ' + n);
  box.appendChild(elem('div', 'm-gruppe', 'Show, hide and sort the list'));
  const r = menueReihenfolge();
  const aus = new Set((cfg.menue && cfg.menue.aus) || []);
  r.forEach((id, i) => {
    const z = elem('label', 'anp-zeile');
    const c = elem('input');
    c.type = 'checkbox';
    c.checked = !aus.has(id);
    c.addEventListener('change', () => setzeMenue({ aus: c.checked ? [...aus].filter((x) => x !== id) : [...aus, id] }));
    const schieb = (d) => { const n = [...r]; [n[i], n[i + d]] = [n[i + d], n[i]]; setzeMenue({ reihenfolge: n }); };
    const hoch = elem('button', null, '↑');
    hoch.title = 'Move up';
    hoch.disabled = i === 0;
    hoch.addEventListener('click', (e) => { e.preventDefault(); schieb(-1); });
    const runter = elem('button', null, '↓');
    runter.title = 'Move down';
    runter.disabled = i === r.length - 1;
    runter.addEventListener('click', (e) => { e.preventDefault(); schieb(1); });
    z.append(c, elem('span', null, MENUE_NAME[id]), hoch, runter);
    box.appendChild(z);
  });
  const fuss = elem('div', 'm-fuss tools-fuss');
  const zurueck = elem('button', null, 'Reset');
  zurueck.addEventListener('click', () => setzeMenue({ reihenfolge: Object.keys(MENUE_TEILE), aus: [] }));
  const fertig = elem('button', 'an', 'Done');
  fertig.addEventListener('click', () => $('#tools').classList.remove('bearbeiten'));
  fuss.append(zurueck, fertig);
  box.appendChild(fuss);
}
$('#tools-anpassen-knopf').addEventListener('click', () => { zeichneAnpassen(); $('#tools').classList.add('bearbeiten'); });
ordneMenue();

$('#tool-chip').addEventListener('click', () => {
  const offen = !$('#tools').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  $('#tools').classList.remove('bearbeiten');
  ordneMenue();
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.classList.toggle('an', ansicht === 'terminal' && !!sitzung && b.dataset.tool === sitzung.tool);
  for (const b of document.querySelectorAll('#tools [data-modus]')) b.classList.toggle('an', ansicht === 'chat');
  for (const b of document.querySelectorAll('#tools [data-studio]')) b.classList.toggle('an', ansicht === 'studio' && (!b.dataset.studio || b.dataset.studio === sz.bereich));
  for (const b of document.querySelectorAll('#tools [data-artex]')) b.classList.toggle('an', ansicht === 'artex');
  // nur die Gruppe aufklappen, in der man gerade ist
  klappAuf = sitzung && MEHR_AGENTEN.includes(sitzung.tool) ? 'agenten' : null;
  zeigeKlapp();
  $('#tools').classList.remove('versteckt');
  $('#tool-chip').classList.add('offen');
  window.api.tools().then((da) => {
    for (const b of document.querySelectorAll('#tools [data-tool]')) {
      const fehlt = da[b.dataset.tool] === false;
      b.classList.toggle('fehlt', fehlt);
      const k = b.querySelector('small');
      k.dataset.text = k.dataset.text || k.textContent;
      k.textContent = fehlt ? 'not installed – click to install it automatically' : k.dataset.text;
    }
  });
});
let klappAuf = null;
function zeigeKlapp() {
  for (const k of document.querySelectorAll('#tools [data-klapp]')) {
    const g = k.dataset.klapp, auf = klappAuf === g;
    k.classList.toggle('auf', auf);
    // zugeklappt, aber man ist gerade darin: Haken an der Gruppe
    k.classList.toggle('an', !auf && !!document.querySelector(`#tools [data-g="${g}"].an`));
    for (const b of document.querySelectorAll(`#tools [data-g="${g}"]`)) b.classList.toggle('zu', !auf);
  }
}
for (const k of document.querySelectorAll('#tools [data-klapp]')) {
  k.addEventListener('click', () => { klappAuf = klappAuf === k.dataset.klapp ? null : k.dataset.klapp; zeigeKlapp(); });
}
for (const b of document.querySelectorAll('#tools [data-tool]')) {
  b.addEventListener('click', () => {
    schliesseMenues();
    const zurueck = ansicht !== 'terminal' && sitzung && !sitzung.beendet && sitzung.tool === b.dataset.tool;
    zeigeTerminal();
    if (!zurueck) starteSitzung({ tool: b.dataset.tool });
  });
}
for (const b of document.querySelectorAll('#tools [data-modus]')) {
  b.addEventListener('click', () => { schliesseMenues(); zeigeWorkspace(b.dataset.modus); });
}
for (const b of document.querySelectorAll('#tools [data-studio]')) {
  b.addEventListener('click', () => { schliesseMenues(); zeigeStudio(b.dataset.studio); });
}
for (const b of document.querySelectorAll('#tools [data-artex]')) {
  if (!ARTEX_FREI) { b.classList.add('gesperrt'); b.querySelector('small').textContent = 'coming soon – Shift+click to try it'; }
  b.addEventListener('click', (e) => {
    if (!ARTEX_FREI && !e.shiftKey) return hinweis('ARTEX comes with the next update – Shift+click to try it now');
    schliesseMenues(); zeigeArtex();
  });
}

// ---------------- ARTEX (eingebettetes Pentest-Werkzeug) ----------------
// ARTEX hat eine eigene Web-Oberflaeche auf localhost:8787. Diese Ansicht bettet sie per <webview> ein,
// startet ARTEX bei Bedarf und laedt die Seite erst, wenn der Port erreichbar ist.
const AX_LEER = 'data:text/html,%3Cbody%20style%3D%22background%3A%230e0e0e%22%3E%3C%2Fbody%3E';
let artexLaedt = false;
async function zeigeArtex() {
  ansicht = 'artex';
  document.body.dataset.ansicht = ansicht;
  el.classList.add('versteckt');
  $('#chat').classList.add('versteckt');
  $('#studio').classList.add('versteckt');
  $('#artex').classList.remove('versteckt');
  $('#titel-text').innerHTML = '';
  $('#titel-text').append(elem('b', null, 'ARTEX'), '  ·  autonomous pentest');
  zeichneLeiste();
  await artexAktualisiere();
}
window.zeigeArtex = zeigeArtex;

function artexText(s, kind) {
  const box = $('#ax-leer');
  box.innerHTML = '';
  const t = elem('div', 'ax-leer-text');
  for (const z of s.split('\n')) t.append(elem('p', null, z));
  box.appendChild(t);
  if (kind === 'ordner') {
    const k = elem('button', 'ax-knopf', 'Select ARTEX folder…');
    k.addEventListener('click', artexOrdnerWaehlen);
    box.appendChild(k);
  }
}

async function artexAktualisiere() {
  const view = $('#ax-view'), start = $('#ax-start'), stop = $('#ax-stop'), neu = $('#ax-neu'), status = $('#ax-status');
  const st = await window.api.artexStatus().catch(() => null);
  if (ansicht !== 'artex') return;
  if (!st || !st.installiert) {
    status.textContent = 'not found';
    start.classList.add('versteckt'); stop.classList.add('versteckt'); neu.classList.add('versteckt');
    view.classList.add('versteckt'); $('#ax-leer').classList.remove('versteckt');
    try { if (view.src && view.src !== AX_LEER) view.src = AX_LEER; } catch {}
    artexText('ARTEX was not found on this PC.\nPick the folder where ARTEX is installed (it has a pg and an app folder inside).', 'ordner');
    return;
  }
  if (st.laeuft) {
    status.textContent = st.unser ? 'running' : 'running (started outside Glowline)';
    start.classList.add('versteckt'); stop.classList.toggle('versteckt', !st.unser); neu.classList.remove('versteckt');
    $('#ax-leer').classList.add('versteckt'); view.classList.remove('versteckt');
    try { if (!/8787/.test(view.src || '')) view.src = st.url; } catch {}
  } else {
    status.textContent = artexLaedt ? 'starting…' : 'stopped';
    start.classList.toggle('versteckt', artexLaedt); stop.classList.add('versteckt'); neu.classList.add('versteckt');
    view.classList.add('versteckt'); $('#ax-leer').classList.remove('versteckt');
    try { if (view.src && view.src !== AX_LEER) view.src = AX_LEER; } catch {}
    artexText(artexLaedt ? 'Starting ARTEX and PostgreSQL…\nThis can take a few seconds.' : 'ARTEX is installed but not running.\nClick Start to launch PostgreSQL and ARTEX.');
  }
}

async function artexStarten() {
  if (artexLaedt) return;
  artexLaedt = true;
  await artexAktualisiere();
  const r = await window.api.artexStart().catch(() => ({ ok: false }));
  artexLaedt = false;
  if (!r.ok && r.grund === 'nicht-gefunden') hinweis('ARTEX folder not found');
  else if (!r.ok) hinweis('ARTEX did not come up – check the ARTEX logs');
  await artexAktualisiere();
}
async function artexStoppen() {
  await window.api.artexStop().catch(() => {});
  try { $('#ax-view').src = AX_LEER; } catch {}
  await artexAktualisiere();
}
async function artexOrdnerWaehlen() {
  const r = await window.api.artexOrdner().catch(() => ({ ok: false }));
  if (r.abgebrochen) return;
  if (!r.ok) return hinweis('That folder is not an ARTEX installation (no pg/app inside)');
  hinweis('ARTEX folder set');
  await artexAktualisiere();
}
$('#ax-start').addEventListener('click', artexStarten);
$('#ax-stop').addEventListener('click', artexStoppen);
$('#ax-neu').addEventListener('click', () => { const v = $('#ax-view'); try { v.reload(); } catch { v.src = v.src; } });
$('#ax-extern').addEventListener('click', () => window.api.artexExtern());
// Ordner-Knopf in der Leiste (nur im Terminal): zeigt den Arbeitsordner, Klick waehlt einen anderen
function zeigeOrdner() {
  const voll = String((sitzung ? sitzung.cwd : cfg && cfg.lastDir) || '');
  $('#ordner-name').textContent = voll.split(/[\\/]/).filter(Boolean).pop() || '–';
  $('#ordner-chip').title = (voll ? voll.replace(/^C:\\Users\\[^\\]+/i, '~') + ' – ' : '') + 'click to choose another folder (restarts the session)';
}
$('#ordner-chip').addEventListener('click', async () => {
  schliesseMenues();
  const p = await window.api.pickDir(sitzung ? sitzung.cwd : cfg.lastDir);
  if (p) starteSitzung({ cwd: p });
});

// Arbeitsgedaechtnis der Aufgabe: Knopf erscheint, sobald der Agent sich etwas gemerkt hat
const kTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'k';
function zeigeGedaechtnis(text, archiv) {
  const c = $('#gedaechtnis-chip');
  const mitArchiv = !!(archiv && archiv.eintraege);
  c.classList.toggle('versteckt', !text && !mitArchiv);
  const zeilen = text ? text.split('\n').filter((z) => z.trim()).length : 0;
  $('#gedaechtnis-name').textContent = 'Memory' + (zeilen ? ' · ' + zeilen : '') + (mitArchiv ? ' · ' + kTokens(archiv.belegt) : '');
  $('#gedaechtnis-text').textContent = text || '(no note yet)';
  // Archiv: wie voll der "virtuelle Kontext" ist
  const a = $('#gedaechtnis-archiv');
  a.classList.toggle('versteckt', !(archiv && archiv.max));
  if (archiv && archiv.max) {
    $('#gedaechtnis-archiv-text').textContent = `Archive · ${archiv.eintraege} ${archiv.eintraege === 1 ? 'entry' : 'entries'} · ${kTokens(archiv.belegt)} of ${kTokens(archiv.max)} tokens`;
    $('#gedaechtnis-archiv-balken').style.width = Math.min(100, (archiv.belegt / archiv.max) * 100) + '%';
  }
  if (!text && !mitArchiv) $('#gedaechtnis').classList.add('versteckt');
}
window.api.onGedaechtnis((s) => { if (s.id === aufgabe) zeigeGedaechtnis(s.text, s.archiv); });
$('#gedaechtnis-chip').addEventListener('click', async () => {
  const offen = !$('#gedaechtnis').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  const g = await window.api.gedaechtnisLesen(aufgabe);
  zeigeGedaechtnis(g.text, g.archiv);
  $('#gedaechtnis').classList.remove('versteckt');
  $('#gedaechtnis-chip').classList.add('offen');
});
$('#gedaechtnis-weg').addEventListener('click', () => {
  window.api.gedaechtnisLoeschen(aufgabe);
  schliesseMenues();
  hinweis('Memory erased – the agent starts this task from scratch');
});

// Obsidian-Schalter in der Leiste: an/aus mit einem Klick (nur sichtbar, wenn Obsidian einen Vault kennt)
async function zeigeObsidian() {
  let r;
  try { r = await window.api.gehirnVaults(); } catch { return; }
  const c = $('#obsidian-chip');
  c.classList.toggle('versteckt', !r.vaults.length && !r.aktiv);
  c.classList.toggle('aus', !r.aktiv);
  $('#obsidian-name').textContent = r.aktiv ? 'Obsidian' : 'Obsidian off';
  c.title = r.aktiv ? `Obsidian “${r.aktiv.name}” is on – Cowork uses fitting notes, agents can read and change it. Click to turn it off.` : 'Obsidian is off – click to turn it on';
  if (typeof gehirnAktiv !== 'undefined' && !!gehirnAktiv !== !!r.aktiv) {
    gehirnAktiv = r.aktiv;
    if (document.body.dataset.ansicht === 'chat') zeichneChat(); // "Save to Obsidian" ein-/ausblenden
  }
}
$('#obsidian-chip').addEventListener('click', async () => {
  schliesseMenues();
  const r = await window.api.gehirnSchalten();
  if (cfg) cfg.obsidian = r.obsidian;
  await zeigeObsidian();
  hinweis(r.aktiv ? `Obsidian on: “${r.aktiv.name}” – agents get it in their next session` : 'Obsidian off – Cowork and agents leave your vault alone');
});
zeigeObsidian();
window.addEventListener('focus', zeigeObsidian); // Vault in Obsidian neu angelegt? dann taucht der Knopf auf

// Kleines Menue an der Leiste: nur Favoriten + Knopf zum grossen Modellfenster
$('#modell-chip').addEventListener('click', async () => {
  const offen = !$('#modelle').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  $('#modelle').classList.remove('versteckt');
  $('#modell-chip').classList.add('offen');
  $('#m-fuss').textContent = sitzung && sitzung.tool === 'claude'
    ? 'Click a model to switch it right inside Claude Code (/model)'
    : 'Click a model to restart the session with it';
  zeichneFavoriten();
  liste = await window.api.models();
  zeichneFavoriten();
});
$('#m-alle').addEventListener('click', () => oeffneBib('meine'));

const sortiere = (a) => [...a].sort((x, y) => (y.loaded - x.loaded) || anzeigeName(x.name).name.localeCompare(anzeigeName(y.name).name, 'en', { sensitivity: 'base' }));
const fav = () => cfg.favoriten || [];
const wolkenModelle = () => (liste && liste.wolke ? Object.values(liste.wolke).flatMap((g) => g.models || []) : []);
const alleModelle = () => (liste ? [...liste.ollama.models, ...liste.lmstudio.models, ...wolkenModelle()] : []);
function modellAnzeige(id) {
  const m = istWolkeId(id) && alleModelle().find((x) => x.id === id);
  return m ? m.name : anzeigeName(id).name;
}
const aktuellesModell = () => (imChat() ? (ansicht === 'chat' && chat.modus === 'auto' && chat.autoModell) || cfg.chatModel || cfg.defaultModel : sitzung ? sitzung.model : cfg.defaultModel);
const gb = (b) => (b < 1e9 ? zahl(b / 1e6, 0) + ' MB' : zahl(b / 1e9, 1) + ' GB');
const bibOffen = () => !$('#bib').classList.contains('versteckt');
const elem = (tag, klasse, text) => { const e = document.createElement(tag); if (klasse) e.className = klasse; if (text != null) e.textContent = text; return e; };
const gruppe = (box, text) => box.appendChild(elem('div', 'm-gruppe', text));
const leer = (box, text) => box.appendChild(elem('div', 'm-leer', text));

function waehleModell(id) {
  schliesseMenues();
  $('#bib').classList.add('versteckt');
  if (imChat()) return setzeChatModell(id);
  if (sitzung && !sitzung.beendet && KONTO[sitzung.tool]) {
    // eigenes Konto: das Modell waehlt man im Werkzeug selbst; gemerkt wird es fuer die anderen
    cfg.defaultModel = id;
    window.api.setConfig({ defaultModel: id });
    hinweis(WERKZEUG_NAME[sitzung.tool] + ' uses its own models – switch them inside it (/model)');
    zeichneLeiste();
    return;
  }
  if (!sitzung || sitzung.beendet || sitzung.tool === 'shell') return starteSitzung({ model: id, tool: sitzung && sitzung.tool === 'shell' ? cfg.defaultTool : undefined });
  const gleicheQuelle = istWolkeId(id) ? backendVon(id) === backendVon(sitzung.model) : !istWolkeId(sitzung.model);
  if (sitzung.tool === 'claude' && gleicheQuelle) {
    // Claude Code kann das Modell im laufenden Gespraech wechseln
    window.api.write(sitzung.id, '/model ' + (istWolkeId(id) ? id.replace(/^[a-z]+,/, '') : id));
    setTimeout(() => window.api.write(sitzung.id, '\r'), 150);
    sitzung.model = id;
    cfg.defaultModel = id;
    window.api.setConfig({ defaultModel: id });
    hinweis('Switched model: ' + modellAnzeige(id));
    zeichneLeiste();
  } else {
    starteSitzung({ model: id });
  }
}

// alles neu zeichnen, was gerade sichtbar ist
function zeichneModelle() {
  if (!$('#modelle').classList.contains('versteckt')) zeichneFavoriten();
  if (bibOffen()) zeichneBib();
}

function zeichneFavoriten() {
  const box = $('#m-liste');
  if (!liste) { box.innerHTML = '<div class="m-leer">Loading models…</div>'; return; }
  box.innerHTML = '';
  const favs = sortiere(alleModelle().filter((m) => fav().includes(m.id)));
  // Favoriten nach Quelle getrennt zeigen (Ueberschrift nur, wenn mehrere Quellen vorkommen)
  const teile = Object.keys(BACKEND_NAME).map((b) => [BACKEND_NAME[b], favs.filter((m) => backendVon(m.id) === b)]).filter(([, l]) => l.length);
  for (const [name, l] of teile) {
    if (teile.length > 1) gruppe(box, name);
    for (const m of l) box.appendChild(modellZeile(m));
  }
  if (!favs.length) leer(box, 'No favorites yet. Open “All models” below and click ☆ next to the models you use most.');
}

function modellZeile(m) {
  const z = elem('div', 'm-zeile' + (m.id === aktuellesModell() ? ' aktuell' : ''));
  const info = [m.params, m.quant, m.size ? gb(m.size) : null].filter(Boolean).join(' · ');
  const vram = m.loaded && m.vram ? `${gb(m.vram)} VRAM${m.ctx ? ' · ' + kurz(m.ctx) + ' ctx' : ''}` : '';
  z.innerHTML = '<span class="punkt"></span><span class="m-name"></span><span class="m-info"></span><button class="m-stern"></button><button class="m-knopf"></button>';
  z.querySelector('.punkt').classList.toggle('an', !!m.loaded);
  const an = anzeigeName(m.name);
  const nm = z.querySelector('.m-name');
  nm.textContent = an.name;
  if (an.quelle) nm.appendChild(elem('span', 'm-quelle', an.quelle));
  z.querySelector('.m-info').textContent = m.wolke ? (m.ctx ? kurz(m.ctx) + ' ctx' : 'cloud') : vram || info;
  z.title = m.id + (info ? '\n' + info : '');
  if (m.wolke) { z.classList.add('wolke'); nm.textContent = m.name; }
  const istFav = fav().includes(m.id);
  const stern = z.querySelector('.m-stern');
  stern.textContent = istFav ? '★' : '☆';
  stern.classList.toggle('an', istFav);
  stern.title = istFav ? 'Remove from favorites' : 'Add to favorites';
  stern.addEventListener('click', (e) => {
    e.stopPropagation();
    const f = new Set(fav());
    if (f.has(m.id)) f.delete(m.id); else f.add(m.id);
    cfg.favoriten = [...f];
    window.api.setConfig({ favoriten: cfg.favoriten });
    zeichneModelle();
  });
  const knopf = z.querySelector('.m-knopf');
  if (m.wolke) knopf.remove();
  knopf.textContent = m.loaded ? 'Unload' : 'Load';
  knopf.addEventListener('click', async (e) => {
    e.stopPropagation();
    knopf.disabled = true;
    knopf.textContent = m.loaded ? 'unloading…' : 'loading…';
    await window.api.loadModel(m.id, !m.loaded);
    liste = await window.api.models();
    zeichneModelle();
  });
  z.addEventListener('click', () => waehleModell(m.id));
  return z;
}

// ---------------- Grosses Modellfenster ----------------
let bibTab = 'meine';

async function oeffneBib(tab) {
  schliesseMenues();
  $('#bib').classList.remove('versteckt');
  zeigeTab(tab || bibTab);
  liste = await window.api.models();
  if (bibOffen()) zeichneBib();
}
function schliesseBib() { $('#bib').classList.add('versteckt'); fokus(); }
function zeigeTab(tab) {
  bibTab = tab;
  for (const b of document.querySelectorAll('.bib-tabs button')) b.classList.toggle('an', b.dataset.tab === tab);
  $('#bib-meine').classList.toggle('versteckt', tab !== 'meine');
  $('#bib-laden').classList.toggle('versteckt', tab !== 'laden');
  $('#bib-konten').classList.toggle('versteckt', tab !== 'konten');
  $('#bib-cowork').classList.toggle('versteckt', tab !== 'cowork');
  $('#bib-dl').classList.toggle('versteckt', tab !== 'downloads');
  $('#bib-stats').classList.toggle('versteckt', tab !== 'stats');
  $('#bib-downloads').classList.toggle('versteckt', tab === 'downloads');
  zeichneBib();
  if (tab === 'meine' || tab === 'laden') (tab === 'meine' ? $('#b-suche') : $('#hf-suche')).focus();
}
function zeichneBib() {
  if (bibTab === 'meine') zeichneMeine(); else if (bibTab === 'konten') zeichneKonten(); else if (bibTab === 'cowork') zeichneAutoRollen(); else if (bibTab === 'downloads') { $('#dl-liste').dataset.schluessel = ''; zeichneDlSeite(); } else if (bibTab === 'stats') zeichneStats(); else zeichneLaden();
  zeichneDownloads();
}
for (const b of document.querySelectorAll('.bib-tabs button')) b.addEventListener('click', () => zeigeTab(b.dataset.tab));
$('#bib-zu').addEventListener('click', schliesseBib);
$('#bib').addEventListener('mousedown', (e) => { if (e.target.id === 'bib') schliesseBib(); });
$('#b-suche').addEventListener('input', zeichneMeine);
$('#b-neu').addEventListener('click', async () => { liste = null; zeichneMeine(); liste = await window.api.models(); zeichneMeine(); });

function zeichneMeine() {
  const box = $('#b-liste');
  const scroll = box.scrollTop;
  if (!liste) { box.innerHTML = '<div class="m-leer">Loading models…</div>'; return; }
  const such = $('#b-suche').value.trim().toLowerCase();
  box.innerHTML = '';
  for (const [name, g] of [['Ollama', liste.ollama], ['LM Studio', liste.lmstudio]]) {
    const geladen = g.models.filter((m) => m.loaded).length;
    gruppe(box, `${name} · ${g.online ? g.models.length + ' models' + (geladen ? `, ${geladen} loaded` : '') : 'offline'}`);
    const ms = sortiere(g.models.filter((m) => !such || m.name.toLowerCase().includes(such)));
    for (const m of ms) box.appendChild(modellZeile(m));
    if (!g.online && name === 'LM Studio' && g.installiert) box.appendChild(lmStartKnopf());
    else if (!g.online && !g.installiert) box.appendChild(installerKnopf(name === 'LM Studio' ? 'lmstudio' : 'ollama', `${name} is not installed.`));
    else if (!g.online) leer(box, 'Ollama is not running – start it.');
    else if (!ms.length) leer(box, such ? 'No match.' : 'No models yet – get some in the Download tab.');
  }
  const wolken = Object.entries(liste.wolke || {}).filter(([, g]) => g.verbunden);
  for (const [, g] of wolken) {
    gruppe(box, `${g.name} · ${g.fehler ? g.fehler : g.models.length + (g.models.length === 1 ? ' model' : ' models')}${g.nurWerkzeug ? ' · only in ' + WERKZEUG_NAME[g.nurWerkzeug] : ''}`);
    const ms = g.models.filter((m) => !such || (m.name + ' ' + m.model).toLowerCase().includes(such));
    for (const m of ms.slice(0, such ? 200 : 40)) box.appendChild(modellZeile(m));
    if (!such && ms.length > 40) leer(box, `${ms.length - 40} more – type in the filter above to find them.`);
    else if (!ms.length && !g.fehler) leer(box, 'No match.');
  }
  if (!wolken.length) {
    const z = elem('div', 'm-leer lm-start');
    z.append(elem('span', null, 'Use cloud models too: connect your Claude subscription, ChatGPT or API keys. '));
    const b = elem('button', 'm-knopf', 'Accounts');
    b.addEventListener('click', () => zeigeTab('konten'));
    z.appendChild(b);
    box.appendChild(z);
  }
  box.scrollTop = scroll;
}

// Installer von Ollama / LM Studio in den Downloads-Ordner laden und danach starten
function installerKnopf(id, text) {
  const z = elem('div', 'm-leer lm-start inst');
  z.dataset.inst = id;
  const t = elem('span', 'inst-text');
  const b = elem('button', 'm-knopf');
  const neben = elem('button', 'm-knopf');
  z.append(t, b, neben);
  let st = { id };
  z.zeichne = (s) => {
    st = s;
    neben.classList.toggle('versteckt', !s.laeuft && !s.fertig);
    b.disabled = !!s.laeuft;
    if (s.laeuft) {
      t.textContent = 'Downloading the installer… ';
      b.textContent = s.gesamt ? `${Math.floor((s.geladen / s.gesamt) * 100)} % · ${gb(s.geladen)} / ${gb(s.gesamt)}` : 'starting…';
      neben.textContent = 'Cancel';
    } else if (s.fertig) {
      t.textContent = `${s.datei} is in your Downloads. `;
      b.textContent = 'Run installer';
      neben.textContent = 'Show in folder';
    } else {
      t.textContent = s.fehler ? s.fehler + ' ' : text ? text + ' ' : '';
      b.textContent = s.fehler ? 'Try again' : 'Download installer';
    }
  };
  b.addEventListener('click', () => {
    if (st.fertig) { window.api.installerOeffnen(id); hinweis('Installer started – press ↻ when it is done'); } else window.api.installerHolen(id);
  });
  neben.addEventListener('click', () => (st.laeuft ? window.api.installerAbbrechen(id) : window.api.installerZeigen(id)));
  z.zeichne(st);
  window.api.installerStand(id).then((s) => z.zeichne(s));
  return z;
}
window.api.onInstaller((s) => document.querySelectorAll(`[data-inst="${s.id}"]`).forEach((z) => z.zeichne(s)));

// LM Studio installiert, aber sein Server laeuft nicht: per Knopf starten
function lmStartKnopf() {
  const z = elem('div', 'm-leer lm-start');
  z.append(elem('span', null, 'The LM Studio server is not running. '));
  const b = elem('button', 'm-knopf', 'Start LM Studio server');
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'starting…';
    const ok = await window.api.lmStart();
    hinweis(ok ? 'LM Studio server started' : 'Could not start the LM Studio server – open LM Studio → Developer → Start Server');
    liste = await window.api.models();
    zeichneModelle();
  });
  z.appendChild(b);
  return z;
}

// ---------------- Download von Hugging Face ----------------
// Ziele: wohin ein Modell geladen wird. Weitere Konnektoren kommen hier dazu.
const ZIELE = [
  {
    id: 'ollama', name: 'Ollama',
    bereit: () => !!(liste && liste.ollama.online),
    info: () => 'Ollama downloads and stores it',
    aus: () => (liste && liste.ollama.installiert ? 'Ollama is not running – start it first' : 'Not installed – get it at ollama.com'),
  },
  {
    id: 'lmstudio', name: 'LM Studio',
    bereit: () => !!(liste && liste.lmstudio.ordner),
    info: () => liste.lmstudio.ordner.replace(/^[A-Z]:\\Users\\[^\\]+/i, '~'),
    aus: () => 'Not installed – get it at lmstudio.ai',
  },
];
const zielId = () => (ZIELE.some((z) => z.id === cfg.downloadZiel) ? cfg.downloadZiel : 'ollama');
const zielName = (id) => (ZIELE.find((z) => z.id === id) || { name: id }).name;
let hf = { q: '', laedt: false, ergebnisse: null, fehler: null, repo: null, dateien: null };
let hfTimer = null;
const downloads = new Map(); // key -> { ziel, repo, quant, status, completed, total }
const fehlerText = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

$('#hf-suche').addEventListener('input', () => {
  const q = $('#hf-suche').value.trim();
  clearTimeout(hfTimer);
  if (q.length < 2) { hf = { ...hf, q: '', laedt: false, ergebnisse: null, fehler: null }; return zeichneLaden(); }
  hf = { ...hf, q, laedt: true, fehler: null };
  zeichneLaden();
  hfTimer = setTimeout(async () => {
    let ergebnisse = [], fehler = null;
    try { ergebnisse = await window.api.hfSearch(q); } catch (e) { fehler = fehlerText(e); }
    if (hf.q !== q) return;
    Object.assign(hf, { ergebnisse, fehler, laedt: false });
    zeichneLaden();
  }, 400);
});

function zeichneLaden() {
  zeichneZiele();
  zeichneTreffer();
  zeichneDetails();
}

function zeichneZiele() {
  const box = $('#ziele');
  box.innerHTML = '';
  for (const z of ZIELE) {
    const b = elem('button', 'ziel' + (z.id === zielId() ? ' an' : ''));
    const ok = z.bereit();
    b.innerHTML = '<span class="punkt"></span><b></b><small></small>';
    b.querySelector('.punkt').classList.toggle('an', ok);
    b.querySelector('b').textContent = z.name;
    b.querySelector('small').textContent = ok ? z.info() : z.aus();
    b.addEventListener('click', () => {
      cfg.downloadZiel = z.id;
      window.api.setConfig({ downloadZiel: z.id });
      zeichneLaden();
    });
    box.appendChild(b);
  }
  const bald = elem('div', 'ziel bald');
  bald.innerHTML = '<span></span><b>More connectors</b><small>coming soon</small>';
  box.appendChild(bald);
}

function zeichneTreffer() {
  const box = $('#hf-treffer');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  if (!hf.q) return leer(box, 'Type a model name above, e.g. “qwen3 8b” or “gemma”. Only GGUF models are shown – those run in Ollama and LM Studio.');
  if (hf.laedt) return leer(box, 'Searching Hugging Face…');
  if (hf.fehler) return leer(box, 'Hugging Face: ' + hf.fehler);
  if (!hf.ergebnisse.length) return leer(box, 'No GGUF models found.');
  for (const r of hf.ergebnisse) {
    const z = elem('div', 'm-zeile treffer' + (r.repo === hf.repo ? ' an' : ''));
    z.innerHTML = '<span class="m-name"></span><span class="m-info"></span>';
    z.querySelector('.m-name').textContent = r.repo;
    z.querySelector('.m-info').textContent = '↓ ' + kurz(r.downloads);
    z.title = 'huggingface.co/' + r.repo + '\n' + zahl(r.downloads) + ' downloads';
    z.addEventListener('click', () => waehleRepo(r.repo));
    box.appendChild(z);
  }
  box.scrollTop = scroll;
}

async function waehleRepo(repo) {
  hf.repo = repo;
  hf.dateien = null;
  zeichneLaden();
  let d;
  try { d = await window.api.hfFiles(repo); } catch (e) { d = { fehler: fehlerText(e) }; }
  if (hf.repo === repo) { hf.dateien = d; zeichneLaden(); }
}

function zeichneDetails() {
  const box = $('#hf-details');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  if (!hf.repo) return leer(box, 'Pick a model on the left to see the available sizes.');
  box.appendChild(elem('div', 'd-kopf', hf.repo));
  if (!hf.dateien) return leer(box, 'Loading files…');
  if (hf.dateien.fehler) return leer(box, 'Could not load files: ' + hf.dateien.fehler);
  if (!hf.dateien.length) return leer(box, 'No GGUF files in this repo.');
  const ziel = zielId();
  const bereit = ZIELE.find((z) => z.id === ziel).bereit();
  const vram = status.gpu ? status.gpu.total * 1024 * 1024 : 0;
  const ollamaNamen = new Set(((liste && liste.ollama.models) || []).map((m) => m.name.toLowerCase()));
  box.appendChild(elem('div', 'd-hinweis', 'Smaller = faster and less memory, larger = better quality. Q4_K_M is a good default.'));
  for (const f of hf.dateien) {
    const z = elem('div', 'quant');
    const passt = vram && f.size < vram * 0.92;
    z.append(elem('b', null, f.quant), elem('span', 'q-groesse', gb(f.size)),
      elem('span', 'tag' + (passt ? ' passt' : ''), !vram ? '' : passt ? 'fits your VRAM' : 'partly on CPU (slower)'));
    const key = `${ziel}|${hf.repo}|${f.quant}`;
    const da = ziel === 'ollama' ? ollamaNamen.has(`hf.co/${hf.repo}:${f.quant}`.toLowerCase()) : f.lmstudio;
    const knopf = elem('button', 'm-knopf');
    if (da) { knopf.textContent = '✓ In ' + zielName(ziel); knopf.disabled = true; }
    else if (downloads.has(key)) { knopf.textContent = 'Downloading…'; knopf.disabled = true; }
    else if (ziel === 'ollama' && f.files.length > 1) { knopf.textContent = 'Split file'; knopf.disabled = true; knopf.title = 'Ollama cannot download split GGUF files – choose LM Studio as the target'; }
    else if (!bereit) { knopf.textContent = 'Target offline'; knopf.disabled = true; }
    else {
      knopf.textContent = '↓ ' + zielName(ziel);
      knopf.title = 'Download to ' + zielName(ziel);
      knopf.addEventListener('click', () => starteDownload(f));
    }
    z.appendChild(knopf);
    box.appendChild(z);
  }
  box.scrollTop = scroll;
}

function starteDownload(f) {
  const ziel = zielId();
  const key = `${ziel}|${hf.repo}|${f.quant}`;
  if (downloads.has(key)) return;
  downloads.set(key, { ziel, repo: hf.repo, quant: f.quant, status: 'starting…', completed: 0, total: f.size });
  window.api.download({ key, ziel, repo: hf.repo, quant: f.quant, files: f.files, total: f.size });
  hinweis(`Downloading ${f.quant} to ${zielName(ziel)}`);
  zeichneBib();
}

const prozent = (d) => (d.total ? Math.min(100, (d.completed / d.total) * 100) : 0);
const downloadText = (d) => (d.total && d.completed ? `${Math.floor(prozent(d))}% · ${gb(d.completed)} / ${gb(d.total)}` : d.status || 'starting…');

function zeichneDownloads() {
  const box = $('#bib-downloads');
  box.innerHTML = '';
  if (!downloads.size) return;
  for (const [key, d] of downloads) {
    const z = elem('div', 'dl');
    z.dataset.key = key;
    z.innerHTML = '<span class="m-name"></span><span class="m-info"></span><button class="m-knopf">Cancel</button><div class="m-fortschritt"><i></i></div>';
    z.querySelector('.m-name').textContent = d.ziel === 'bibliothek' ? `${d.repo} → Ollama (Cowork · ${ROLLE_NAME[d.rolle] || ''})` : `${d.repo} · ${d.quant} → ${zielName(d.ziel)}`;
    z.querySelector('.m-info').textContent = downloadText(d);
    z.querySelector('.m-fortschritt i').style.width = prozent(d) + '%';
    z.querySelector('.m-knopf').addEventListener('click', () => window.api.downloadCancel(key));
    box.appendChild(z);
  }
}

window.api.onDownload(async (p) => {
  const d = downloads.get(p.key);
  if (!d) return;
  if (!p.fertig) {
    Object.assign(d, p);
    // nur die Fortschrittszeile aktualisieren
    const z = [...document.querySelectorAll('.dl')].find((x) => x.dataset.key === p.key);
    if (z) {
      z.querySelector('.m-info').textContent = downloadText(d);
      z.querySelector('.m-fortschritt i').style.width = prozent(d) + '%';
    }
    return;
  }
  downloads.delete(p.key);
  if (p.status === 'success' && d.ziel === 'bibliothek') {
    // empfohlenes Cowork-Modell fertig: gleich fuer die Rolle eintragen
    await window.api.autoSetzen(d.rolle, 'ollama,' + d.repo);
    hinweis(`${ROLLE_NAME[d.rolle]}: ${d.repo} is ready`);
    liste = await window.api.models();
    if (bibOffen() && bibTab === 'cowork') zeichneAutoRollen(true);
  } else if (p.status === 'success') {
    hinweis(`Downloaded ${d.quant} to ${zielName(d.ziel)}`);
    if (d.ziel === 'lmstudio' && hf.repo === d.repo && Array.isArray(hf.dateien)) {
      const f = hf.dateien.find((x) => x.quant === d.quant);
      if (f) f.lmstudio = true;
    }
    zeichneModelle();
    liste = await window.api.models();
  } else {
    hinweis(p.fehler === 'cancelled' ? 'Download cancelled' : 'Download failed: ' + p.fehler);
  }
  zeichneModelle();
});

// ---------------- Messwerte ----------------
function messwerte(kennung) {
  const k = kennung || 'global';
  if (!stats.has(k)) stats.set(k, { aktiv: new Map(), letzte: null, spitze: 0, model: null, runde: null, vorherEingabe: 0, zuletzt: 0 });
  return stats.get(k);
}

// Laufen mehrere Anfragen gleichzeitig (z. B. ein Titel nebenbei), zeigt die Leiste die mit den meisten Tokens,
// vor dem ersten Token die zuerst gestartete
function hauptLauf(m) {
  let best = null;
  if (m) for (const l of m.aktiv.values()) {
    if (!best || l.tokens > best.tokens || (l.tokens === best.tokens && l.t0 < best.t0)) best = l;
  }
  return best;
}

// "Saved": Glowline zaehlt die Tokens (neu / aus dem Cache / Ausgabe) und rechnet sie mit den Preisen
// des gewaehlten Vergleichsmodells um. So passt der Betrag sofort, wenn man ein anderes Modell waehlt.
// "Saved costs" je Bereich: Text-Bereiche zaehlen Tokens, Studio-Bereiche Bilder / Videosekunden / Zeichen
const PREIS_MODELLE = [
  { id: 'sonnet', name: 'Claude Sonnet', eingabe: 3, cache: 0.3, ausgabe: 15 },
  { id: 'opus', name: 'Claude Opus', eingabe: 5, cache: 0.5, ausgabe: 25 },
  { id: 'haiku', name: 'Claude Haiku', eingabe: 1, cache: 0.1, ausgabe: 5 },
  { id: 'gpt5', name: 'GPT-5', eingabe: 1.25, cache: 0.125, ausgabe: 10 },
  { id: 'gpt5mini', name: 'GPT-5 mini', eingabe: 0.25, cache: 0.025, ausgabe: 2 },
  { id: 'gemini', name: 'Gemini 2.5 Pro', eingabe: 1.25, cache: 0.31, ausgabe: 10 },
];
const KOSTEN_BEREICHE = {
  coding: { name: 'Coding', art: 'text', std: 'sonnet', info: 'coding agents in the terminal and the Code model in Cowork' },
  denken: { name: 'Reasoning', art: 'text', std: 'gpt5', info: 'the Reasoning model in Cowork' },
  chat: { name: 'Chat', art: 'text', std: 'haiku', info: 'fast and vision answers in Cowork' },
  bild: { name: 'Images', art: 'medien', zaehler: 'bild', einheit: 'per image', std: 'gptimage', liste: [
    { id: 'gptimage', name: 'GPT Image 1', je: 0.04 }, { id: 'flux', name: 'FLUX 1.1 Pro', je: 0.04 }, { id: 'imagen', name: 'Imagen 4 Ultra', je: 0.06 }] },
  video: { name: 'Video', art: 'medien', zaehler: 'videoSek', einheit: 'per second', std: 'sora', liste: [
    { id: 'sora', name: 'Sora 2', je: 0.1 }, { id: 'veofast', name: 'Veo 3 Fast', je: 0.15 }, { id: 'veo', name: 'Veo 3', je: 0.4 }] },
  stimme: { name: 'Voice', art: 'medien', zaehler: 'zeichen', einheit: 'per 1,000 characters', teiler: 1000, std: 'eleven', liste: [
    { id: 'eleven', name: 'ElevenLabs', je: 0.2 }, { id: 'openaitts', name: 'OpenAI TTS', je: 0.015 }] },
};
const LEER = { neu: 0, cache: 0, ausgabe: 0 };
function kostenBereich(k) {
  const b = KOSTEN_BEREICHE[k];
  const x = (cfg.kosten && cfg.kosten[k]) || {};
  if (b.art === 'text') {
    const std = PREIS_MODELLE.find((m) => m.id === b.std);
    return { modell: x.modell || b.std, preis: x.preis || { name: std.name, eingabe: std.eingabe, cache: std.cache, ausgabe: std.ausgabe }, tokens: x.tokens || { ...LEER } };
  }
  const std = b.liste.find((m) => m.id === b.std);
  return { modell: x.modell || b.std, preis: x.preis || { name: std.name, je: std.je } };
}
const medienZaehler = () => ({ bild: 0, videoSek: 0, zeichen: 0, ...(cfg.medienZaehler || {}) });
function gespartIn(k) {
  const b = KOSTEN_BEREICHE[k], x = kostenBereich(k);
  if (b.art === 'text') { const p = x.preis, t = x.tokens; return (t.neu * p.eingabe + t.cache * p.cache + t.ausgabe * p.ausgabe) / 1e6; }
  return (medienZaehler()[b.zaehler] / (b.teiler || 1)) * (x.preis.je || 0);
}
function gespartJetzt() {
  return (cfg.gespartAlt || 0) + Object.keys(KOSTEN_BEREICHE).reduce((a, k) => a + gespartIn(k), 0);
}
// welcher Bereich bekommt die Tokens: Terminal = Coding, Cowork je nach Rolle der Antwort
function kostenBereichFuer(s) {
  if (s.tab !== 'chat') return 'coding';
  const r = typeof chat !== 'undefined' && chat.antwort && chat.antwort.rolle;
  return r === 'coder' ? 'coding' : r === 'denker' ? 'denken' : 'chat';
}
function setzeKosten(k, patch) {
  cfg.kosten = { ...(cfg.kosten || {}), [k]: { ...kostenBereich(k), ...patch } };
  window.api.setConfig({ kosten: { [k]: cfg.kosten[k] } });
}
window.api.onKosten((z) => { cfg.medienZaehler = z; zeichneLeiste(); if (!$('#preise').classList.contains('versteckt')) zeichnePreise(); });
function tokenAnteile(m, s) {
  const neu = s.neu != null ? s.neu : Math.max(0, s.eingabe - m.vorherEingabe);
  return { neu, cache: Math.max(0, s.eingabe - neu), ausgabe: s.ausgabe || 0 };
}

window.api.onZoom((z) => hinweis('Interface size ' + z + ' % · Ctrl 0 = automatic'));
window.api.onStat((s) => {
  const m = messwerte(s.tab);
  const jetzt = Date.now();
  if (s.phase === 'start') {
    // Ein "Turn" = alles von deiner Eingabe (Enter) bis zur naechsten, inkl. Tool-Pausen dazwischen.
    // Ohne neue Eingabe beginnt ein neuer Turn erst nach 2 min Ruhe.
    const ruhe = m.runde && m.runde.ende && !m.aktiv.size ? jetzt - m.runde.ende : 0;
    if (!m.runde || neueEingabe || ruhe > 120000) m.runde = { start: jetzt, ende: null };
    else m.runde.ende = null;
    neueEingabe = false;
    m.aktiv.set(s.id, { id: s.id, t0: s.t0, erstes: null, tokens: 0, tps: null });
    m.model = s.backend + ',' + s.model;
  } else if (s.phase === 'erstes' && m.aktiv.has(s.id)) {
    m.aktiv.get(s.id).erstes = s.ttft;
  } else if (s.phase === 'lauf' && m.aktiv.has(s.id)) {
    const l = m.aktiv.get(s.id);
    l.tokens = s.tokens;
    l.tps = s.tps;
  } else if (s.phase === 'ende') {
    m.aktiv.delete(s.id);
    if (m.runde && !m.aktiv.size) m.runde.ende = jetzt;
    // Spitze nur aus der Endauswertung (die filtert am Stueck gelieferte Tool-Aufrufe heraus)
    if (s.status === 'ok' && s.tps && s.ausgabe > 20) m.spitze = Math.max(m.spitze, s.tps);
    // ohne verlaessliche Geschwindigkeit (Antwort kam am Stueck) den letzten Wert stehen lassen
    if (!s.tps && m.letzte && m.letzte.tps) s.tps = m.letzte.tps;
    // kurze Hintergrund-Anfragen (Titel usw.) ueberschreiben nicht die Hauptwerte
    const klein = s.ausgabe < 8 && m.letzte && m.letzte.status === 'ok';
    if (!klein || s.status !== 'ok') m.letzte = s;
    if (s.status === 'ok') {
      m.zuletzt = jetzt;
      if (s.eingabe && !istWolkeId(m.model)) {
        const t = tokenAnteile(m, s), k = kostenBereichFuer(s), summe = kostenBereich(k).tokens;
        setzeKosten(k, { tokens: { neu: summe.neu + t.neu, cache: summe.cache + t.cache, ausgabe: summe.ausgabe + t.ausgabe } });
        const p = kostenBereich(k).preis;
        window.api.statistikZaehle({ tokens: t.neu + t.cache + t.ausgabe, ausgabe: t.ausgabe, model: m.model, dollar: (t.neu * p.eingabe + t.cache * p.cache + t.ausgabe * p.ausgabe) / 1e6 });
        m.vorherEingabe = s.eingabe;
      }
    }
  }
  zeichneLeiste();
});

const dauer = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const vor = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const schoeneSkala = (v) => { for (const x of [50, 100, 150, 200, 300, 400, 500, 1000]) if (v <= x) return x; return Math.ceil(v / 500) * 500; };

function zeichneLeiste() {
  zeigeOrdner();
  const m = stats.get(aktiveKennung());
  const leiste = $('#leiste');
  const l = hauptLauf(m);
  const e = m && m.letzte;
  leiste.classList.toggle('laeuft', !!(l && l.erstes != null));
  leiste.classList.toggle('prefill', !!(l && l.erstes == null));
  leiste.classList.toggle('fehler', !l && !!e && e.status === 'fehler');

  let jetztTps = null;
  if (l) {
    jetztTps = l.erstes == null ? null : l.tps;
    $('#tps').textContent = l.erstes == null ? '…' : zahl(l.tps, 1);
    $('#l-erstes').textContent = l.erstes == null ? 'Reading prompt' : 'First token';
    $('#erstes').textContent = zahl(l.erstes == null ? (Date.now() - l.t0) / 1000 : l.erstes, 1) + 's';
    $('#ausgabe').textContent = zahl(l.tokens) + ' tok';
    if (e) $('#prefill').textContent = e.prefill ? zahl(e.prefill) + ' tok/s' : e.eingabe ? 'cached' : '–';
  } else if (e) {
    jetztTps = e.tps;
    $('#tps').textContent = e.status === 'fehler' ? 'Error' : zahl(e.tps, 1);
    $('#l-erstes').textContent = 'First token';
    $('#erstes').textContent = e.ttft != null ? zahl(e.ttft, 1) + 's' : '–';
    $('#prefill').textContent = e.prefill ? zahl(e.prefill) + ' tok/s' : e.eingabe ? 'cached' : '–';
    $('#ausgabe').textContent = zahl(e.ausgabe) + ' tok';
    leiste.title = e.meldung ? 'Last error: ' + e.meldung : '';
  } else {
    for (const id of ['#tps', '#erstes', '#prefill', '#ausgabe']) $(id).textContent = '–';
    $('#l-erstes').textContent = 'First token';
    leiste.title = '';
  }

  // Tacho mit Spitzenwert
  const spitze = m ? m.spitze : 0;
  const skala = schoeneSkala(Math.max(50, spitze * 1.15, jetztTps || 0));
  $('#skala-max').textContent = skala;
  $('#skala-mitte').textContent = skala / 2;
  $('#tacho-b').style.width = Math.min(100, ((jetztTps || 0) / skala) * 100) + '%';
  $('#spitze-m').style.display = spitze ? 'block' : 'none';
  $('#spitze-m').style.left = (spitze / skala) * 100 + '%';
  const st = $('#spitze-text');
  st.innerHTML = '';
  if (spitze) {
    const sp = document.createElement('span');
    sp.textContent = 'peak ~' + zahl(spitze, 1);
    sp.style.left = Math.min(80, Math.max(20, (spitze / skala) * 100)) + '%';
    st.appendChild(sp);
  }

  // Runde + letzte Antwort
  const r = m && m.runde;
  $('#runde').textContent = r ? dauer((r.ende || Date.now()) - r.start) : '–';
  $('#letzte').textContent = m && m.zuletzt && !l ? 'Last reply ' + vor(Date.now() - m.zuletzt) : '';

  // Prompt / Kontext
  const modelId = imChat() ? aktuellesModell() || '' : sitzung && KONTO[sitzung.tool] ? '' : (sitzung && sitzung.tool !== 'shell' && sitzung.model) || (m && m.model) || '';
  const wolke = istWolkeId(modelId);
  const name = modelId.replace(/^[a-z]+,/, '');
  const backend = BACKEND_NAME[backendVon(modelId)] || 'Ollama';
  const geladen = wolke ? { cloud: true } : (status.loaded || []).find((x) => x.name === name);
  const ausListe = liste && alleModelle().find((x) => x.id === modelId);
  const ctx = (geladen && geladen.ctx) || (ausListe && ausListe.ctx) || null;
  if (e && e.eingabe) {
    $('#kontext').textContent = ctx ? `${zahl(e.eingabe)} / ${kurz(ctx)}` : zahl(e.eingabe) + ' tok';
    const p = ctx ? Math.min(1, (e.eingabe + (e.ausgabe || 0)) / ctx) : 0;
    $('#kontext-b').style.width = p * 100 + '%';
    $('#kontext-b').className = p > 0.85 ? 'voll' : p > 0.6 ? 'warn' : '';
  } else {
    $('#kontext').textContent = ctx ? `0 / ${kurz(ctx)}` : '–';
    $('#kontext-b').style.width = '0';
  }

  // Kopfzeile + Knoepfe
  const kurzName = modellAnzeige(modelId);
  if (modelId) {
    const teile = [ausListe && ausListe.params, ausListe && ausListe.quant].filter(Boolean).join(', ');
    const gpuName = status.gpu && !wolke ? status.gpu.name.replace(/^NVIDIA (GeForce )?/, '') : '';
    $('#modell-info').textContent = kurzName + (teile ? ', ' + teile : '');
    const i = document.createElement('i');
    i.textContent = `  on ${backend}${gpuName ? ' · ' + gpuName : ''}${geladen ? '' : ' · not loaded'}`;
    $('#modell-info').append(i);
  } else {
    $('#modell-info').textContent = sitzung && sitzung.tool === 'shell' ? 'PowerShell · no model'
      : sitzung && KONTO[sitzung.tool] ? `${WERKZEUG_NAME[sitzung.tool]} · own ${KONTO[sitzung.tool]}, models chosen inside it` : 'No model active';
  }
  $('#tool-name').textContent = ansicht === 'studio' ? 'Studio · ' + BEREICHE[sz.bereich].name : ansicht === 'chat' ? 'Cowork' : sitzung ? WERKZEUG_NAME[sitzung.tool] : 'Tool';
  $('#modell-name').textContent = modelId ? kurzName : sitzung && KONTO[sitzung.tool] && !imChat() && ansicht === 'terminal' ? 'own account' : 'no model';
  $('#modell-chip').title = (modelId || '') + '\nClick: manage models';
  $('#modell-punkt').classList.toggle('an', !!geladen);

  $('#gespart').textContent = zahl(gespartJetzt(), 2) + ' $';
  $('#f-gespart').title = 'Saved costs: what the same work would have cost in the cloud\n'
    + Object.entries(KOSTEN_BEREICHE).map(([k, b]) => `${b.name}: ${zahl(gespartIn(k), 2)} $ (vs. ${kostenBereich(k).preis.name || 'your model'})`).join('\n')
    + '\nClick to choose the models or enter your own prices';
}

// ---------------- Vergleichsmodell fuer "Saved" ----------------
$('#f-gespart').addEventListener('click', () => {
  const offen = !$('#preise').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  const r = $('#f-gespart').getBoundingClientRect();
  $('#preise').style.left = Math.max(16, Math.min(window.innerWidth - 396, r.left - 20)) + 'px';
  $('#preise').classList.remove('versteckt');
  zeichnePreise();
});

let kostenTab = 'coding';
function zeichnePreise() {
  const k = kostenTab, b = KOSTEN_BEREICHE[k], x = kostenBereich(k), p = x.preis;
  const tabs = $('#p-tabs');
  tabs.innerHTML = '';
  for (const [id, t] of Object.entries(KOSTEN_BEREICHE)) {
    const e = elem('button', id === k ? 'an' : null, t.name);
    e.title = t.info || '';
    e.addEventListener('click', () => { kostenTab = id; zeichnePreise(); });
    tabs.appendChild(e);
  }
  const text = b.art === 'text';
  $('#p-titel').textContent = text ? `${b.name}: compare with` : `${b.name}: compare with (price ${b.einheit})`;
  $('#p-einheit').textContent = text ? 'Name and price per 1M tokens (USD)' : `Name and price ${b.einheit} (USD)`;
  $('#p-text').classList.toggle('versteckt', !text);
  $('#p-medien').classList.toggle('versteckt', text);
  const box = $('#p-liste');
  box.innerHTML = '';
  const liste = text ? PREIS_MODELLE : b.liste;
  const gleich = (m) => (text ? m.eingabe === p.eingabe && m.cache === p.cache && m.ausgabe === p.ausgabe : m.je === p.je);
  const aktiv = liste.find((m) => m.id === x.modell && gleich(m));
  for (const m of [...liste, { id: 'eigen', name: 'Your own model' }]) {
    const e = elem('button', 'p-modell' + ((aktiv ? aktiv.id === m.id : m.id === 'eigen') ? ' an' : ''));
    e.append(elem('b', null, m.name), elem('small', null, m.id === 'eigen' ? 'enter name and price below' : text ? `${m.eingabe} $ in · ${m.ausgabe} $ out` : `${m.je} $ ${b.einheit.replace('per ', '/ ')}`));
    e.addEventListener('click', () => {
      if (m.id === 'eigen') { setzeKosten(k, { modell: 'eigen', preis: { ...p, name: aktiv ? 'My model' : p.name } }); zeichnePreise(); zeichneLeiste(); (text ? $('#p-name') : $('#p-mname')).select(); return; }
      setzeKosten(k, { modell: m.id, preis: text ? { name: m.name, eingabe: m.eingabe, cache: m.cache, ausgabe: m.ausgabe } : { name: m.name, je: m.je } });
      zeichnePreise();
      zeichneLeiste();
    });
    box.appendChild(e);
  }
  const felder = text ? [['#p-name', 'name'], ['#p-eingabe', 'eingabe'], ['#p-cache', 'cache'], ['#p-ausgabe', 'ausgabe']] : [['#p-mname', 'name'], ['#p-je', 'je']];
  for (const [id, f] of felder) if (document.activeElement !== $(id)) $(id).value = p[f] ?? '';
  const z = medienZaehler();
  $('#p-summe').textContent = (text
    ? `${kurz(x.tokens.neu)} new · ${kurz(x.tokens.cache)} cached · ${kurz(x.tokens.ausgabe)} output tokens`
    : b.zaehler === 'bild' ? `${z.bild} images made` : b.zaehler === 'videoSek' ? `${z.videoSek} s of video made` : `${kurz(z.zeichen)} characters spoken`) + ` · ${zahl(gespartIn(k), 2)} $`;
  $('#p-gesamt').textContent = `Total saved: ${zahl(gespartJetzt(), 2)} $`;
}

for (const [id, f] of [['#p-name', 'name'], ['#p-eingabe', 'eingabe'], ['#p-cache', 'cache'], ['#p-ausgabe', 'ausgabe'], ['#p-mname', 'name'], ['#p-je', 'je']]) {
  $(id).addEventListener('input', () => {
    const v = f === 'name' ? $(id).value.slice(0, 40) : Math.max(0, parseFloat($(id).value) || 0);
    setzeKosten(kostenTab, { modell: 'eigen', preis: { ...kostenBereich(kostenTab).preis, [f]: v } });
    zeichnePreise();
    zeichneLeiste();
  });
}

$('#p-reset').addEventListener('click', () => {
  const b = $('#p-reset');
  if (!b.classList.contains('sicher')) {
    b.classList.add('sicher');
    b.textContent = 'Click again to reset all';
    setTimeout(() => { b.classList.remove('sicher'); b.textContent = 'Reset counter'; }, 3000);
    return;
  }
  b.classList.remove('sicher');
  b.textContent = 'Reset counter';
  for (const k of Object.keys(KOSTEN_BEREICHE)) if (KOSTEN_BEREICHE[k].art === 'text') setzeKosten(k, { tokens: { ...LEER } });
  cfg.medienZaehler = { bild: 0, videoSek: 0, zeichen: 0 };
  cfg.gespartAlt = 0;
  window.api.setConfig({ medienZaehler: cfg.medienZaehler, gespartAlt: 0 });
  zeichnePreise();
  zeichneLeiste();
});

// Laufende Zeiten hochzaehlen
let takt = 0;
setInterval(() => {
  if (document.hidden) return;
  const m = stats.get(aktiveKennung());
  if (m && (m.aktiv.size || (m.zuletzt && ++takt % 4 === 0))) zeichneLeiste();
}, 250);

window.api.onVollbild((an) => { document.body.classList.toggle('vollbild', an); try { fit.fit(); } catch {} });

window.api.onStatus((s) => {
  status = s;
  $('#b-ollama').classList.toggle('an', s.ollama);
  $('#b-lmstudio').classList.toggle('an', s.lmstudio);
  if (s.gpu) {
    $('#f-vram').title = s.gpu.name + ' – Grafikspeicher';
    $('#vram').textContent = `${zahl(s.gpu.used / 1024, 1)} / ${zahl(s.gpu.total / 1024, 1)} GB`;
    const p = s.gpu.used / s.gpu.total;
    $('#vram-b').style.width = p * 100 + '%';
    $('#vram-b').className = p > 0.92 ? 'voll' : p > 0.75 ? 'warn' : '';
    $('#strom').textContent = s.gpu.power != null && isFinite(s.gpu.power) ? `${zahl(s.gpu.power)} W` : s.gpu.util + ' %';
  }
  const m = stats.get(aktiveKennung());
  if (!m || !m.aktiv.size) zeichneLeiste();
});

// ---------------- Start ----------------
(async () => {
  cfg = await window.api.getConfig();
  ordneMenue();
  // Umstellung von altem "gespart"-Betrag auf Token-Zaehler: der bisherige Betrag bleibt erhalten
  if (!cfg.tokens && !cfg.kosten) {
    cfg.gespartAlt = cfg.gespart || 0;
    window.api.setConfig({ gespartAlt: cfg.gespartAlt });
  }
  // Umstellung auf Bereiche (3.3): bisheriger Zaehler + Vergleichsmodell werden "Coding"
  if (!cfg.kosten) {
    const alt = { tokens: cfg.tokens || { ...LEER } };
    if (cfg.preise) { alt.preis = { name: cfg.preise.name, eingabe: cfg.preise.eingabe, cache: cfg.preise.cache, ausgabe: cfg.preise.ausgabe }; alt.modell = cfg.preisModell || 'eigen'; }
    cfg.kosten = { coding: { ...kostenBereich('coding'), ...alt } };
    window.api.setConfig({ kosten: cfg.kosten });
  }
  term.options.fontSize = cfg.fontSize || 14;
  try { fit.fit(); } catch {}
  liste = await window.api.models().catch(() => null);
  // Kein (oder ein nicht mehr vorhandenes) Standardmodell: erst ein geladenes, sonst das erste verfuegbare nehmen
  if (liste && !alleModelle().some((m) => m.id === cfg.defaultModel)) {
    cfg.defaultModel = (await standardModell()) || '';
  }
  zeichneLeiste();
  window.glowlineBereit = true;
  if (!TESTMODUS) startAnsicht();
  // erster Start ohne ein einziges Modell: den Einrichtungs-Assistenten anbieten
  if (!TESTMODUS && !cfg.einrichtung && liste && !liste.ollama.models.length && !liste.lmstudio.models.length && !(await window.api.linkStand().catch(() => ({}))).app) zeigeEinrichtung();
})();

// ---------- Auto-Update: Chip unten rechts ----------
let updStand = null;
function zeigeUpdate(s) {
  if (!s) return;
  updStand = s;
  const chip = $('#update-chip');
  if (!chip) return;
  const zeigen = !!s.neu && s.modus !== 'aus';
  chip.classList.toggle('versteckt', !zeigen);
  if (!zeigen) return;
  updatePopup(s);
  $('#update-text').textContent = s.laedt ? `Update ${s.neu} · ${s.gesamt ? Math.floor((s.geladen / s.gesamt) * 100) : 0}%` : s.bereit ? `Restart to update (${s.neu})` : `Update ${s.neu}`;
  chip.title = (s.fehler ? s.fehler + '\n\n' : '') + (s.bereit ? 'Downloaded and checked. Click to install now and restart – or it installs by itself when you quit Glowline.' : 'Click to download and install Glowline ' + s.neu) + ((s.punkte || []).length ? '\n\nWhat\'s new:\n' + s.punkte.map((p) => '• ' + p).join('\n') : '');
}
// Pop-up "New update available": einmal pro Version (und nochmal, wenn es fertig geladen ist)
function updatePopup(s) {
  const pop = $('#update-pop');
  const merk = s.neu + (s.bereit ? '-bereit' : '');
  if (s.laedt || cfg.updateGesehen === merk || (cfg.updateGesehen === s.neu && !s.bereit)) return;
  $('#up-titel').textContent = s.bereit ? `Glowline ${s.neu} is ready to install` : `New update available: Glowline ${s.neu}`;
  const neu = (s.punkte || []).map((p) => '•  ' + p).join('\n');
  $('#up-text').textContent = (neu ? 'What’s new:\n' + neu + '\n\n' : '') + (s.bereit ? 'Downloaded and checked. Click “Restart now” – or it installs by itself next time you quit Glowline.' : 'You have ' + s.version + '. Updating takes about a minute; your chats and settings stay.');
  $('#up-los').textContent = s.bereit ? 'Restart now' : 'Update now';
  pop.dataset.merk = merk;
  pop.classList.remove('versteckt');
}
function updatePopupZu() {
  const pop = $('#update-pop');
  pop.classList.add('versteckt');
  cfg.updateGesehen = pop.dataset.merk;
  window.api.setConfig({ updateGesehen: cfg.updateGesehen });
}
$('#up-zu').addEventListener('click', updatePopupZu);
$('#up-spaeter').addEventListener('click', updatePopupZu);
$('#up-los').addEventListener('click', () => { updatePopupZu(); $('#update-chip').click(); });
window.api.onUpdate(zeigeUpdate);
window.api.updateStand().then(zeigeUpdate).catch(() => {});
$('#update-chip').addEventListener('click', async () => {
  if (!updStand || updStand.laedt) return;
  hinweis(updStand.bereit ? 'Installing the update – Glowline restarts in a moment' : 'Downloading the update – Glowline restarts when it is done');
  const s = await window.api.updateJetzt();
  if (s && s.fehler) hinweis(s.fehler);
});

// ---------- Leiste unten einpassen ----------
// Reicht der Platz nicht (z. B. wenn der Download- oder Update-Knopf dazukommt), fallen erst die unwichtigsten Werte weg –
// die Knoepfe rechts (Ordner, Werkzeug, Modell) bleiben immer ganz zu sehen
const LEISTE_WEG = ['#f-strom', '.feld:has(#runde)', '#f-gespart', '.feld:has(#prefill)', '.feld:has(#ausgabe)', '#f-vram', '.feld:has(#erstes)', '.feld:has(#kontext)', '.tacho', '.feld.gross'];
function leisteEinpassen() {
  const w = $('#leiste .werte');
  w.classList.remove('eng');
  for (const e of w.querySelectorAll('.eng-weg')) e.classList.remove('eng-weg');
  const zuBreit = () => w.scrollWidth > w.clientWidth + 1;
  for (const s of LEISTE_WEG) {
    if (!zuBreit()) return;
    const e = w.querySelector(s);
    if (e) e.classList.add('eng-weg');
  }
  // immer noch zu eng (sehr schmales Fenster): die Knopf-Texte werden gekuerzt
  if (zuBreit()) w.classList.add('eng');
}
{
  let geplant = false;
  const bald = () => { if (!geplant) { geplant = true; requestAnimationFrame(() => { geplant = false; leisteEinpassen(); }); } };
  const w = $('#leiste .werte');
  const mo = new MutationObserver(bald);
  // Zahlen und Knopf-Texte aendern sich; die Knoepfe kommen und gehen (Klasse "versteckt")
  mo.observe(w, { subtree: true, childList: true, characterData: true });
  for (const c of w.querySelectorAll('.chip')) mo.observe(c, { attributes: true, attributeFilter: ['class'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-ansicht'] });
  window.addEventListener('resize', bald);
  bald();
}
