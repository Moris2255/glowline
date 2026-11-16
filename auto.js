'use strict';
// Auto-Chat: sucht fuer jede Nachricht das passende Modell aus – schnell (Smalltalk, kurze Fragen), Coder (Programmieren),
// Denker (Rechnen, Planen, Abwaegen) und Sehen (Fragen zu einem Bild). Die Rollen waehlt Glowline selbst aus den
// installierten Ollama-Modellen; im Workspace kann man jede Rolle auf ein anderes Modell (auch Cloud) stellen.
const os = require('os');
const { execFile } = require('child_process');

const ROLLEN = ['schnell', 'coder', 'denker', 'sehen'];
const NAME = { schnell: 'Fast', coder: 'Code', denker: 'Reasoning', sehen: 'Vision' };

// feste Wortregeln statt eines Sortier-Modells: kleine Modelle sagen hier fast immer "chat"
const CODE = /```|\b(code|coden|programm\w*|skript\w*|script\w*|python|javascript|typescript|js|ts|java|kotlin|c\+\+|c#|rust|golang|php|ruby|swift|lua|html|css|sql|regex|json|yaml|bash|powershell|node|npm|pip|react|vue|svelte|electron|django|flask|api|git|github|docker|compil\w*|kompil\w*|debug\w*|bug|bugs|stack ?trace|exception|syntax\w*|funktion|function|variable|klasse|class|methode|method|algorithm\w*|algorithmus|website|webseite|homepage|app|plugin|datapack|discord-?bot)\b/i;
const CODE_ZEICHEN = /\bE[A-Z]{3,}\b|\w+Error\b|\(\)\s*[{;]|=>|^\s*(import|def|const|let|var|public|#include)\b/m;
const DENKEN = /\b(rechne|berechne|ausrechnen|l[öo]se|solve|beweis\w*|prove|gleichung\w*|equation|integral|ableitung|wahrscheinlichkeit|probability|prozent\w* von|wie lange brauch\w*|wie viele|how many|how long|plane?|planung|lernplan|trainingsplan|zeitplan|schedule|strategie|strategy|vergleich\w*|compare|w[äa]ge|abw[äa]gen|vor- und nachteile|pros and cons|warum genau|erkl[äa]r\w*[^.?!]{0,40}\b(genau|ausf[üu]hrlich|detailliert)|step by step|schritt f[üu]r schritt|logik\w*|r[äa]tsel|puzzle|analysier\w*|analy[sz]e|optimier\w*|entscheid\w*|was soll ich)\b|\d\s*[x×*/^=+\-]\s*\d|\d+\s*[a-z]\s*[+\-=]/i;
// kurze Antworten wie "danke" beenden ein Code-/Denk-Gespraech, alles andere bleibt beim letzten Modell
const ABSCHLUSS = /^(danke|thanks|thank you|ok(ay)?|cool|super|nice|top|perfekt|hi|hallo|hey|moin)\b/i;
// mit angehaengtem Bild: diese Woerter heissen "mach was damit" (Studio), alles andere ist eine Frage zum Bild
const BILD_TUN = /upscal|hochskal|skalier|sch[äa]rfer|sharper|aufl[öo]sung|animier|animate|beweg|video|clip|vorlesen|lies .*vor|read .*aloud|mach (es|das|daraus|ihn|sie)|make (it|this)|[äa]nder|change|verwandel|turn (it|this)|f[äa]rb/i;
// Frage zu einem eben erzeugten Bild
const BILD_FRAGE = /\b(was|what|wer|who)\b[^.?!]{0,30}\b(auf|on|in)\s+(dem|the|diesem|this)\s+(bild|foto|image|picture|photo)|\b(beschreib|describe)\w*\b[^.?!]{0,20}\b(bild|foto|image|picture|photo|es|it)\b/i;

const SYSTEM = {
  schnell: 'You are a friendly, helpful assistant. Answer briefly and clearly in the language the user writes in.',
  coder: 'You are an expert programmer. Give working code in fenced code blocks with the language name, explain briefly, and answer in the language the user writes in.',
  denker: 'You are a careful thinker. Work through the problem step by step, check your result, then give a clear final answer. Write maths as plain text (e.g. 2x + 7 = 3x - 5, x = 12), never LaTeX. Answer in the language the user writes in.',
  sehen: 'You can see the attached image. Answer questions about it precisely and in the language the user writes in.',
};

// nur zweite Wahl, wenn Glowline selbst aussucht (man kann sie trotzdem fest einstellen)
const ROH = /abliterat|uncensor|heretic|nsfw/i;
const NEBEN = /enhancer|helfer|-test|-ref\b|embed|draft|mtp|rerank/i;

let d = null; // { cfg, setzeConfig }
const faehig = new Map(); // Name+Digest -> Faehigkeiten aus /api/show
let vramGb;
let zwischen = null; // { zeit, rollen }

function init(hilfen) { d = hilfen; }

function vram() {
  if (vramGb !== undefined) return Promise.resolve(vramGb);
  return new Promise((ok) => execFile('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 6000 }, (e, aus) => {
    vramGb = e ? 0 : (+String(aus).split('\n')[0] || 0) / 1024;
    ok(vramGb);
  }));
}

const milliarden = (s) => { const m = /([\d.]+)\s*([MB])/i.exec(String(s || '')); return m ? +m[1] / (m[2].toUpperCase() === 'M' ? 1000 : 1) : 0; };

async function ollamaModelle() {
  const O = d.cfg().backends.ollama;
  let tags;
  try { tags = await (await fetch(O + '/api/tags', { signal: AbortSignal.timeout(3000) })).json(); } catch { return []; }
  const alle = await Promise.all((tags.models || []).map(async (m) => {
    const key = m.name + '@' + m.digest;
    let caps = faehig.get(key);
    if (!caps) {
      try {
        const j = await (await fetch(O + '/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(5000) })).json();
        caps = Array.isArray(j.capabilities) ? j.capabilities : ['completion'];
        faehig.set(key, caps);
      } catch { caps = ['completion']; }
    }
    const fam = (m.details && m.details.family) || '';
    return {
      id: 'ollama,' + m.name, name: m.name, gb: m.size / 1e9, b: milliarden(m.details && m.details.parameter_size), caps,
      moe: /moe/i.test(fam) || /[-_]a\d+(\.\d+)?b\b/i.test(m.name), fam,
    };
  }));
  return alle.filter((m) => m.caps.includes('completion') && !/embed|bert/i.test(m.name + ' ' + m.fam));
}

// Glowlines eigene Wahl fuer jede Rolle
function waehle(modelle, v) {
  const ram = os.totalmem() / 1e9;
  const passt = (m) => (m.moe ? m.gb <= v + ram * 0.5 : m.gb <= Math.max(v * 1.15, 3));
  const rang = (wert) => (a, b) => (ROH.test(a.name) - ROH.test(b.name)) || (NEBEN.test(a.name) - NEBEN.test(b.name))
    || (passt(b) - passt(a)) || (/^hf\.co\//.test(a.name) - /^hf\.co\//.test(b.name)) || (wert(a) - wert(b));
  const erstes = (liste, wert) => (liste.length ? [...liste].sort(rang(wert))[0].id : '');
  const cfg = d.cfg();
  const istDa = (id) => modelle.some((m) => m.id === id);
  const gross = (m) => -m.gb;

  const klein = modelle.filter((m) => m.b >= 1 && m.b <= 5 && !/coder|code|vl\b|vision|r1/i.test(m.name));
  const chatM = modelle.find((m) => m.id === cfg.chatModel && m.b && m.b <= 5);
  const schnell = chatM ? chatM.id : erstes(klein, (m) => Math.abs(m.b - 2));

  const coderListe = modelle.filter((m) => /coder|code|devstral|codestral|starcoder|kat-/i.test(m.name));
  const coder = /coder|code|devstral|codestral/i.test(cfg.defaultModel || '') && istDa(cfg.defaultModel) ? cfg.defaultModel
    : erstes(coderListe, gross) || erstes(modelle.filter((m) => /qwen3\.5|qwen3-?coder/i.test(m.name) && m.b >= 4), gross);

  const denkListe = modelle.filter((m) => !/coder|code|vl\b|vision/i.test(m.name) && ((m.caps.includes('thinking') && m.b >= 3) || /\br1\b|-r1|qwq|think|reason|magistral|gpt-oss/i.test(m.name)));
  const denker = erstes(denkListe, gross);

  // Sehen: am liebsten echte Vision-Modelle (qwen3-vl, llama3.2-vision), keine Coder
  const sehListe = modelle.filter((m) => m.caps.includes('vision'));
  // mllama (llama3.2-vision) laeuft in neueren Ollama-Versionen nicht mehr: nur, wenn sonst nichts da ist
  const alt = (m) => /mllama/i.test(m.fam);
  const echt = sehListe.filter((m) => !alt(m) && /vl\b|vl[-:]|vision|llava|moondream|minicpm-v/i.test(m.name + ' ' + m.fam));
  const imNamen = echt.filter((m) => /vl\b|vl[-:]|vision|llava|moondream|minicpm-v/i.test(m.name));
  const sehen = erstes(imNamen.filter((m) => m.b >= 3), gross) || erstes(echt.filter((m) => m.b >= 3), gross) || erstes(sehListe.filter((m) => !alt(m) && m.b >= 3 && !/coder|code/i.test(m.name)), gross)
    || erstes(sehListe.filter((m) => !alt(m)), gross) || erstes(sehListe, gross);
  return { schnell, coder, denker, sehen };
}

// { schnell: { id, auto }, ... } – fest eingestellt (cfg.autoRollen) oder von Glowline gewaehlt
async function rollen(neu) {
  if (!neu && zwischen && Date.now() - zwischen.zeit < 20000) return zwischen.rollen;
  const [modelle, v] = await Promise.all([ollamaModelle(), vram()]);
  const selbst = waehle(modelle, v);
  const fest = d.cfg().autoRollen || {};
  const ersatz = d.cfg().chatModel || d.cfg().defaultModel || '';
  const aus = {};
  for (const r of ROLLEN) {
    if (fest[r]) aus[r] = { id: fest[r], auto: false };
    else aus[r] = { id: selbst[r] || (r === 'sehen' ? '' : selbst.schnell || ersatz), auto: true };
  }
  zwischen = { zeit: Date.now(), rollen: aus };
  return aus;
}
function vergiss() { zwischen = null; }

// welche Rolle soll antworten? (Bilder/Videos/Stimme regelt erstellen.js vorher)
function rolleFuer(text, vorige) {
  const t = String(text || '');
  if (CODE.test(t) || CODE_ZEICHEN.test(t)) return 'coder';
  if (DENKEN.test(t) || t.length > 500) return 'denker';
  if ((vorige === 'coder' || vorige === 'denker') && !ABSCHLUSS.test(t.trim())) return vorige;
  return 'schnell';
}

module.exports = { init, rollen, vergiss, rolleFuer, ROLLEN, NAME, SYSTEM, BILD_TUN, BILD_FRAGE, faehigkeiten: (id) => {
  for (const [k, v] of faehig) if ('ollama,' + k.split('@')[0] === id) return v;
  return null;
} };
