// Konten: Claude-Abo, ChatGPT-Konto (Codex) und API-Schluessel fuer Cloud-Modelle.
// Schluessel liegen verschluesselt (Windows-Anmeldung, safeStorage) in <userData>\konten.json
// und verlassen den Hauptprozess nie: der Mess-Proxy setzt sie erst beim Weiterleiten ein.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = os.homedir();

// Cloud-Anbieter. format: welches API-Format der Anbieter spricht; nurWerkzeug: nur in diesem Werkzeug nutzbar
const WOLKEN = {
  abo: { name: 'Claude subscription', basis: 'https://api.anthropic.com', format: 'anthropic', nurWerkzeug: 'claude' },
  chatgpt: { name: 'ChatGPT account', basis: null, format: 'responses', nurWerkzeug: 'codex' },
  anthropic: { name: 'Anthropic API', basis: 'https://api.anthropic.com', format: 'anthropic', key: 'anthropic', link: 'https://console.anthropic.com/settings/keys' },
  openai: { name: 'OpenAI API', basis: 'https://api.openai.com', format: 'openai', key: 'openai', link: 'https://platform.openai.com/api-keys' },
  openrouter: { name: 'OpenRouter', basis: 'https://openrouter.ai/api', format: 'openai', key: 'openrouter', link: 'https://openrouter.ai/keys' },
  gemini: { name: 'Google Gemini', basis: 'https://generativelanguage.googleapis.com/v1beta/openai', ohneV1: true, format: 'openai', key: 'gemini', link: 'https://aistudio.google.com/apikey' },
  // weitere Anbieter mit OpenAI-kompatibler Schnittstelle (Modellliste unter /v1/models)
  deepseek: { name: 'DeepSeek', basis: 'https://api.deepseek.com', format: 'openai', key: 'deepseek', link: 'https://platform.deepseek.com/api_keys', einfach: true },
  groq: { name: 'Groq', basis: 'https://api.groq.com/openai', format: 'openai', key: 'groq', link: 'https://console.groq.com/keys', einfach: true },
  mistral: { name: 'Mistral', basis: 'https://api.mistral.ai', format: 'openai', key: 'mistral', link: 'https://console.mistral.ai/api-keys', einfach: true },
  xai: { name: 'xAI (Grok)', basis: 'https://api.x.ai', format: 'openai', key: 'xai', link: 'https://console.x.ai', einfach: true },
};
// Schluessel, die man eintragen kann (huggingface: Downloads geschuetzter Modelle, higgsfield: Cloud-Videos im Studio)
const SCHLUESSEL = ['anthropic', 'openai', 'openrouter', 'gemini', 'deepseek', 'groq', 'mistral', 'xai', 'huggingface', 'higgsfield'];

const datei = () => path.join(app.getPath('userData'), 'konten.json');
let speicher = null;
function lade() {
  if (speicher) return speicher;
  try { speicher = JSON.parse(fs.readFileSync(datei(), 'utf8')); } catch { speicher = {}; }
  return speicher;
}

function schluessel(id) {
  const roh = lade()[id];
  if (!roh) return null;
  try { return safeStorage.decryptString(Buffer.from(roh, 'base64')); } catch { return null; }
}

function setzeSchluessel(id, wert) {
  if (!SCHLUESSEL.includes(id)) throw new Error('unknown account');
  const s = lade();
  wert = String(wert || '').trim();
  if (!wert) delete s[id];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is not available');
    if (wert.length > 400 || /\s/.test(wert)) throw new Error('This does not look like an API key');
    s[id] = safeStorage.encryptString(wert).toString('base64');
  }
  fs.writeFileSync(datei(), JSON.stringify(s, null, 2));
  modellCache.clear();
}

// Status fuer die Oberflaeche: nie den Schluessel selbst, nur die letzten 4 Zeichen
function status() {
  const aus = {};
  for (const id of SCHLUESSEL) {
    const k = schluessel(id);
    aus[id] = { gesetzt: !!k, ende: k ? k.slice(-4) : '' };
  }
  aus.abo = { angemeldet: fs.existsSync(path.join(HOME, '.claude', '.credentials.json')) };
  aus.chatgpt = { angemeldet: fs.existsSync(path.join(HOME, '.codex', 'auth.json')) };
  return aus;
}

// Ziel-URL und Kopfzeilen fuer den Proxy
function ziel(backend, pfad, kopf) {
  const w = WOLKEN[backend];
  if (!w || !w.basis) throw new Error(`${backend} cannot be used here`);
  if (w.key) {
    const k = schluessel(w.key);
    if (!k) throw new Error(`No ${w.name} key – add one under Models → Accounts`);
    delete kopf.authorization;
    delete kopf['x-api-key'];
    if (w.format === 'anthropic') { kopf['x-api-key'] = k; kopf['anthropic-version'] = kopf['anthropic-version'] || '2023-06-01'; }
    else kopf.authorization = 'Bearer ' + k;
    if (backend === 'openrouter') { kopf['http-referer'] = 'https://github.com/Moris2255/glowline'; kopf['x-title'] = 'Glowline'; }
  }
  return w.basis + (w.ohneV1 ? pfad.replace(/^\/v1(?=\/)/, '') : pfad);
}

// ---------- Modell-Listen der Cloud-Anbieter (10 min zwischengespeichert) ----------
const modellCache = new Map();
async function hole(url, kopf) {
  const r = await fetch(url, { headers: kopf, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-|codex)/i;
const OPENAI_WEG = /(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|dall-e|whisper)/i;
const NICHT_CHAT = /(embed|whisper|tts|transcri|audio|speech|moderation|guard|ocr|imagine|image|video|vision-only)/i;

async function anbieterModelle(id) {
  const c = modellCache.get(id);
  if (c && Date.now() - c.zeit < 600000) return c.liste;
  let liste = [];
  const k = WOLKEN[id].key ? schluessel(WOLKEN[id].key) : null;
  if (id === 'abo') {
    liste = [['opus', 'Claude Opus'], ['sonnet', 'Claude Sonnet'], ['haiku', 'Claude Haiku']].map(([m, n]) => ({ model: m, name: n }));
  } else if (id === 'chatgpt') {
    liste = [{ model: 'standard', name: 'Codex default model' }];
  } else if (!k) {
    liste = [];
  } else if (id === 'anthropic') {
    const r = await hole('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': k, 'anthropic-version': '2023-06-01' });
    liste = (r.data || []).map((m) => ({ model: m.id, name: m.display_name || m.id }));
  } else if (id === 'openai') {
    const r = await hole('https://api.openai.com/v1/models', { authorization: 'Bearer ' + k });
    liste = (r.data || []).filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_WEG.test(m.id)).map((m) => ({ model: m.id, name: m.id }))
      .sort((a, b) => b.model.localeCompare(a.model));
  } else if (id === 'openrouter') {
    const r = await hole('https://openrouter.ai/api/v1/models', { authorization: 'Bearer ' + k });
    liste = (r.data || []).map((m) => ({ model: m.id, name: m.name || m.id, ctx: m.context_length || null }));
  } else if (WOLKEN[id].einfach) {
    const r = await hole(WOLKEN[id].basis + '/v1/models', { authorization: 'Bearer ' + k });
    liste = (r.data || []).map((m) => String(m.id)).filter((m) => !NICHT_CHAT.test(m)).sort().map((m) => ({ model: m, name: m }));
  } else if (id === 'gemini') {
    const r = await hole('https://generativelanguage.googleapis.com/v1beta/openai/models', { authorization: 'Bearer ' + k });
    liste = (r.data || []).map((m) => String(m.id).replace(/^models\//, '')).filter((m) => /^gemini/i.test(m) && !/(embedding|tts|image|live)/i.test(m))
      .map((m) => ({ model: m, name: m }));
  }
  modellCache.set(id, { zeit: Date.now(), liste });
  return liste;
}

// Alle verbundenen Cloud-Konten mit ihren Modellen
async function wolkenListe() {
  const st = status();
  const aus = {};
  await Promise.all(Object.keys(WOLKEN).map(async (id) => {
    const w = WOLKEN[id];
    const verbunden = id === 'abo' || id === 'chatgpt' ? st[id].angemeldet : st[w.key].gesetzt;
    const e = { name: w.name, verbunden, nurWerkzeug: w.nurWerkzeug || null, format: w.format, models: [], fehler: null };
    if (verbunden) {
      try {
        // nicht laenger als 2,5 s warten: die Liste kommt dann beim naechsten Oeffnen aus dem Zwischenspeicher
        const laeuft = anbieterModelle(id);
        laeuft.catch(() => {});
        const l = await Promise.race([laeuft, new Promise((ok) => setTimeout(() => ok(null), 2500))]);
        if (!l) { e.fehler = 'loading…'; aus[id] = e; return; }
        e.models = l.map((m) => ({ id: id + ',' + m.model, name: m.name, model: m.model, ctx: m.ctx || null, wolke: true, loaded: false }));
      } catch (err) { e.fehler = err.message; }
    }
    aus[id] = e;
  }));
  return aus;
}

module.exports = { WOLKEN, SCHLUESSEL, schluessel, setzeSchluessel, status, ziel, wolkenListe };
