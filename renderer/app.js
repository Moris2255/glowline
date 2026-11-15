'use strict';
// Glowline: ein Terminal + die Leiste. Werkzeug/Modell/Ordner wechseln startet die Sitzung neu.
const $ = (s) => document.querySelector(s);
const zahl = (n, d = 0) => (n == null || !isFinite(n) ? '–' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kurz = (n) => (n == null ? '–' : n >= 1000 ? zahl(n / 1000, n >= 10000 ? 0 : 1) + 'k' : String(n));
const WERKZEUG_NAME = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', shell: 'PowerShell' };
const TESTMODUS = new URLSearchParams(location.search).has('test');

let cfg = {};
let liste = null; // Modell-Liste
let status = { loaded: [] };
let sitzung = null; // { id, kennung, tool, model, cwd, beendet }
let gespart = 0;
let neueEingabe = false; // Enter gedrueckt -> naechste Anfrage startet einen neuen Turn
const stats = new Map(); // Kennung -> Messwerte

const THEMA = {
  background: '#0c0d0f', foreground: '#e6e7e9', cursor: '#ffffff', cursorAccent: '#0c0d0f',
  selectionBackground: '#ffffff33',
  black: '#1d1f23', red: '#ef5f58', green: '#5fd39a', yellow: '#e8b04a', blue: '#6aa5f8', magenta: '#c792ea', cyan: '#5fc9d6', white: '#e6e7e9',
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
try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}

term.onData((d) => {
  if (!sitzung) return;
  if (sitzung.beendet) { if (d === '\r') starteSitzung({}); return; }
  if (d.includes('\r')) neueEingabe = true;
  window.api.write(sitzung.id, d);
});
term.onResize(({ cols, rows }) => { if (sitzung && !sitzung.beendet) window.api.resize(sitzung.id, cols, rows); });
new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe($('#terms'));

window.api.onData((id, d) => { if (sitzung && sitzung.id === id) term.write(d); });
window.api.onExit((id, code) => {
  if (!sitzung || sitzung.id !== id) return;
  sitzung.beendet = true;
  term.write(`\r\n\x1b[90m[${WERKZEUG_NAME[sitzung.tool]} exited${code ? ' (code ' + code + ')' : ''} – press Enter to restart]\x1b[0m\r\n`);
});

async function starteSitzung(neu) {
  const tool = neu.tool || (sitzung && sitzung.tool) || cfg.defaultTool || 'claude';
  const model = neu.model || (sitzung && sitzung.model) || cfg.defaultModel || (tool !== 'shell' ? await standardModell() : null);
  if (!model && tool !== 'shell') {
    if (sitzung && !sitzung.beendet) window.api.kill(sitzung.id);
    sitzung = { id: null, kennung: null, tool, model: null, cwd, beendet: true };
    term.reset();
    term.write('\x1b[90m[No local model found. Start Ollama or LM Studio, then press Enter.]\x1b[0m\r\n');
    zeichneLeiste();
    return;
  }
  const cwd = neu.cwd || (sitzung && sitzung.cwd) || cfg.lastDir;
  if (sitzung && !sitzung.beendet) window.api.kill(sitzung.id);
  term.reset();
  try { fit.fit(); } catch {}
  const r = await window.api.spawn({ tool, model: tool === 'shell' ? null : model, cwd, cols: term.cols, rows: term.rows });
  sitzung = { id: r.id, kennung: r.tab, tool, model, cwd: r.cwd, beendet: false };
  if (tool !== 'shell') { cfg.defaultTool = tool; cfg.defaultModel = model; }
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
  if (e.key === 'Escape' && document.querySelector('.menue:not(.versteckt)')) { schliesseMenues(); e.preventDefault(); }
});

// ---------------- Menues ----------------
function schliesseMenues() {
  for (const m of document.querySelectorAll('.menue')) m.classList.add('versteckt');
  for (const c of document.querySelectorAll('.chip')) c.classList.remove('offen');
  term.focus();
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menue') && !e.target.closest('.chip')) {
    if (document.querySelector('.menue:not(.versteckt)')) schliesseMenues();
  }
});

$('#tool-chip').addEventListener('click', () => {
  const offen = !$('#tools').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.classList.toggle('an', !!sitzung && b.dataset.tool === sitzung.tool);
  $('#ordner-name').textContent = sitzung ? sitzung.cwd : cfg.lastDir;
  $('#tools').classList.remove('versteckt');
  $('#tool-chip').classList.add('offen');
});
for (const b of document.querySelectorAll('#tools [data-tool]')) {
  b.addEventListener('click', () => { schliesseMenues(); starteSitzung({ tool: b.dataset.tool }); });
}
$('#ordner-wahl').addEventListener('click', async () => {
  const p = await window.api.pickDir(sitzung ? sitzung.cwd : cfg.lastDir);
  schliesseMenues();
  if (p) starteSitzung({ cwd: p });
});

$('#modell-chip').addEventListener('click', async () => {
  const offen = !$('#modelle').classList.contains('versteckt');
  schliesseMenues();
  if (offen) return;
  $('#modelle').classList.remove('versteckt');
  $('#modell-chip').classList.add('offen');
  $('#m-suche').value = '';
  $('#m-fuss').textContent = sitzung && sitzung.tool === 'claude'
    ? 'Click a model to switch it right inside Claude Code (/model)'
    : 'Click a model to restart the session with it';
  zeichneModelle();
  $('#m-suche').focus();
  liste = await window.api.models();
  zeichneModelle();
});
$('#m-suche').addEventListener('input', zeichneModelle);
$('#m-neu').addEventListener('click', async () => { liste = null; zeichneModelle(); liste = await window.api.models(); zeichneModelle(); });

const sortiere = (a) => [...a].sort((x, y) => (y.loaded - x.loaded) || x.name.localeCompare(y.name));

function waehleModell(id) {
  schliesseMenues();
  if (!sitzung || sitzung.beendet || sitzung.tool === 'shell') return starteSitzung({ model: id, tool: sitzung && sitzung.tool === 'shell' ? cfg.defaultTool : undefined });
  if (sitzung.tool === 'claude') {
    // Claude Code kann das Modell im laufenden Gespraech wechseln
    window.api.write(sitzung.id, '/model ' + id);
    setTimeout(() => window.api.write(sitzung.id, '\r'), 150);
    sitzung.model = id;
    cfg.defaultModel = id;
    window.api.setConfig({ defaultModel: id });
    hinweis('Switched model: ' + id.replace(/^(ollama|lmstudio),/, ''));
    zeichneLeiste();
  } else {
    starteSitzung({ model: id });
  }
}

function zeichneModelle() {
  const box = $('#m-liste');
  if (!liste) { box.innerHTML = '<div class="m-leer">Loading models…</div>'; return; }
  const such = $('#m-suche').value.trim().toLowerCase();
  const aktuell = sitzung ? sitzung.model : cfg.defaultModel;
  box.innerHTML = '';
  for (const [name, g] of [['Ollama', liste.ollama], ['LM Studio', liste.lmstudio]]) {
    const kopf = document.createElement('div');
    kopf.className = 'm-gruppe';
    const geladen = g.models.filter((m) => m.loaded).length;
    kopf.textContent = `${name} · ${g.online ? g.models.length + ' models' + (geladen ? `, ${geladen} loaded` : '') : 'offline'}`;
    box.appendChild(kopf);
    for (const m of sortiere(g.models)) {
      if (such && !m.name.toLowerCase().includes(such)) continue;
      const z = document.createElement('div');
      z.className = 'm-zeile' + (m.id === aktuell ? ' aktuell' : '');
      const info = [m.params, m.quant, m.size ? zahl(m.size / 1e9, 1) + ' GB' : null].filter(Boolean).join(' · ');
      const vram = m.loaded && m.vram ? `${zahl(m.vram / 1e9, 1)} GB VRAM${m.ctx ? ' · ' + kurz(m.ctx) + ' ctx' : ''}` : '';
      z.innerHTML = `<span class="punkt ${m.loaded ? 'an' : ''}"></span><span class="m-name"></span><span class="m-info"></span><button class="m-knopf"></button>`;
      z.querySelector('.m-name').textContent = m.name;
      z.querySelector('.m-info').textContent = vram || info;
      z.title = m.id + (info ? '\n' + info : '');
      const knopf = z.querySelector('.m-knopf');
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
      box.appendChild(z);
    }
    if (!g.online) {
      const l = document.createElement('div');
      l.className = 'm-leer';
      l.textContent = name === 'LM Studio' ? 'LM Studio server is not running (in LM Studio: Developer → Start Server).' : 'Ollama is not running.';
      box.appendChild(l);
    }
  }
}

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

function kosten(m, s) {
  const p = cfg.preise || { eingabe: 3.75, cache: 0.3, ausgabe: 15 };
  const neu = s.neu != null ? s.neu : Math.max(0, s.eingabe - m.vorherEingabe);
  return (neu * p.eingabe + (s.eingabe - neu) * p.cache + s.ausgabe * p.ausgabe) / 1e6;
}

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
      if (s.eingabe) {
        gespart += kosten(m, s);
        m.vorherEingabe = s.eingabe;
        window.api.setConfig({ gespart });
      }
    }
  }
  zeichneLeiste();
});

const dauer = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const vor = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const schoeneSkala = (v) => { for (const x of [50, 100, 150, 200, 300, 400, 500, 1000]) if (v <= x) return x; return Math.ceil(v / 500) * 500; };

function zeichneLeiste() {
  const m = sitzung && stats.get(sitzung.kennung);
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
  const modelId = (sitzung && sitzung.tool !== 'shell' && sitzung.model) || (m && m.model) || '';
  const name = modelId.replace(/^(ollama|lmstudio),/, '');
  const backend = modelId.startsWith('lmstudio,') ? 'LM Studio' : 'Ollama';
  const geladen = (status.loaded || []).find((x) => x.name === name);
  const ausListe = liste && [...liste.ollama.models, ...liste.lmstudio.models].find((x) => x.id === modelId);
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
  const kurzName = name.replace(/^hf\.co\/[^/]+\//, '');
  if (modelId) {
    const teile = [ausListe && ausListe.params, ausListe && ausListe.quant].filter(Boolean).join(', ');
    const gpuName = status.gpu ? status.gpu.name.replace(/^NVIDIA (GeForce )?/, '') : '';
    $('#modell-info').textContent = kurzName + (teile ? ', ' + teile : '');
    const i = document.createElement('i');
    i.textContent = `  on ${backend}${gpuName ? ' · ' + gpuName : ''}${geladen ? '' : ' · not loaded'}`;
    $('#modell-info').append(i);
  } else {
    $('#modell-info').textContent = sitzung && sitzung.tool === 'shell' ? 'PowerShell · no model' : 'No model active';
  }
  $('#tool-name').textContent = sitzung ? WERKZEUG_NAME[sitzung.tool] : 'Tool';
  $('#modell-name').textContent = modelId ? kurzName : 'no model';
  $('#modell-chip').title = (modelId || '') + '\nClick: manage models';
  $('#modell-punkt').classList.toggle('an', !!geladen);

  $('#gespart').textContent = zahl(gespart, 2) + ' $';
  const p = cfg.preise || { eingabe: 3.75, cache: 0.3, ausgabe: 15 };
  $('#f-gespart').title = `Estimate: what these tokens would have cost on the Claude API\n(${p.eingabe} $ new / ${p.cache} $ cache / ${p.ausgabe} $ output per 1M tokens, change under "preise" in config.json)`;
}

// Laufende Zeiten hochzaehlen
setInterval(() => { const m = sitzung && stats.get(sitzung.kennung); if (m && (m.aktiv.size || m.zuletzt)) zeichneLeiste(); }, 250);

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
  const m = sitzung && stats.get(sitzung.kennung);
  if (!m || !m.aktiv.size) zeichneLeiste();
});

// ---------------- Start ----------------
(async () => {
  cfg = await window.api.getConfig();
  gespart = cfg.gespart || 0;
  term.options.fontSize = cfg.fontSize || 14;
  try { fit.fit(); } catch {}
  liste = await window.api.models().catch(() => null);
  // Kein (oder ein nicht mehr vorhandenes) Standardmodell: erst ein geladenes, sonst das erste verfuegbare nehmen
  if (liste && ![...liste.ollama.models, ...liste.lmstudio.models].some((m) => m.id === cfg.defaultModel)) {
    cfg.defaultModel = (await standardModell()) || '';
  }
  zeichneLeiste();
  window.glowlineBereit = true;
  if (!TESTMODUS) starteSitzung({});
})();
