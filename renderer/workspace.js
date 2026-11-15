'use strict';
// Workspace: Chat + Prompt-Helfer (im Hauptbereich statt des Terminals) und die Konten-Seite im Modellfenster.
// Laeuft nach app.js und nutzt dessen Hilfsfunktionen ($, elem, cfg, liste, ...).

// ---------------- Modi ----------------
const MODI = {
  chat: { name: 'Chat', platz: 'Message the model…', system: '' },
  video: {
    name: 'Video prompt', platz: 'Describe your video idea, e.g. “a fox running through snow at sunset”…',
    system: `You are a prompt engineer for open video models (Wan 2.x, LTX-Video, HunyuanVideo).
Turn the user's idea into a prompt that these models follow well.
Rules:
- Write the prompt in English, one paragraph, 60-120 words, present tense.
- Order: main subject and look, what happens over the clip (one clear action), camera (shot size, movement), setting, lighting, style and mood.
- Concrete, visual words only. No sound, no on-screen text, no camera brand names, no lists inside the prompt.
- Keep it to ONE shot that fits about 5 seconds.
Answer in exactly this format:
**Prompt**
\`\`\`
<the prompt>
\`\`\`
**Negative prompt**
\`\`\`
<comma separated things to avoid>
\`\`\`
**Tip:** <one short sentence in the user's language, e.g. which length or resolution to use>
If the user asks for changes, reply with the full new version in the same format.`,
  },
  bild: {
    name: 'Image prompt', platz: 'Describe your image idea…',
    system: `You are a prompt engineer for open image models (FLUX, Qwen-Image, SDXL).
Turn the user's idea into a strong image prompt.
Rules:
- English, natural sentences, 40-90 words: subject, details, composition, setting, lighting, style, camera/lens if photographic.
- Put text that should appear in the image in "quotes".
Answer in exactly this format:
**Prompt**
\`\`\`
<the prompt>
\`\`\`
**Negative prompt**
\`\`\`
<things to avoid>
\`\`\`
**Format:** <suggested aspect ratio, e.g. 16:9> – <one short tip in the user's language>
If the user asks for changes, reply with the full new version in the same format.`,
  },
  stimme: {
    name: 'Voice script', platz: 'What should the voice say? Topic, length, mood…',
    system: `You write scripts for text-to-speech and voice cloning.
Rules:
- Write in the language the user writes in, unless they ask for another.
- Short, speakable sentences. Use commas and periods for natural pauses, "..." for a longer pause.
- Write numbers, dates and abbreviations as spoken words. No emojis, no markdown, no stage directions in brackets.
Answer with the script inside one code block and nothing else:
\`\`\`
<script>
\`\`\``,
  },
  coding: {
    name: 'Coding task', platz: 'What should the coding agent build or fix?',
    system: `You turn rough ideas into clear task prompts for coding agents (Claude Code, Codex, OpenCode).
Write the task in the user's language. Structure:
Goal (1-2 sentences), Context (what exists, if known), Requirements (bullets), Done when (testable bullets), Constraints (what not to touch).
Do not invent file names you were not told. Keep it short and precise.
Answer with the task inside one code block and nothing else.`,
  },
};

const chat = { modus: 'chat', verlaeufe: {}, laeuft: null, nr: 0 };
const verlauf = () => (chat.verlaeufe[chat.modus] = chat.verlaeufe[chat.modus] || []);
const chatModell = () => cfg.chatModel || cfg.defaultModel || '';

// Kopfleiste: Modi
const modiBox = $('#chat-modi');
for (const [id, m] of Object.entries(MODI)) {
  const b = elem('button', null, m.name);
  b.dataset.modus = id;
  b.addEventListener('click', () => { chat.modus = id; zeichneChat(); $('#chat-text').focus(); });
  modiBox.appendChild(b);
}

function zeigeWorkspace(modus) {
  ansicht = 'chat';
  document.body.dataset.ansicht = ansicht;
  if (modus) chat.modus = modus;
  el.classList.add('versteckt');
  $('#studio').classList.add('versteckt');
  $('#chat').classList.remove('versteckt');
  $('#titel-text').innerHTML = '';
  $('#titel-text').append(elem('b', null, 'Workspace'), '  ·  ' + MODI[chat.modus].name);
  zeichneChat();
  zeichneLeiste();
  $('#chat-text').focus();
}
function zeigeTerminal() {
  if (ansicht === 'terminal') return;
  ansicht = 'terminal';
  document.body.dataset.ansicht = ansicht;
  $('#chat').classList.add('versteckt');
  $('#studio').classList.add('versteckt');
  el.classList.remove('versteckt');
  try { fit.fit(); } catch {}
  if (sitzung) {
    $('#titel-text').innerHTML = '';
    $('#titel-text').append(elem('b', null, WERKZEUG_NAME[sitzung.tool]), '  ·  ' + String(sitzung.cwd || '').replace(/^C:\\Users\\[^\\]+/i, '~'));
  }
  zeichneLeiste();
  term.focus();
}
window.zeigeWorkspace = zeigeWorkspace;

function setzeChatModell(id) {
  cfg.chatModel = id;
  window.api.setConfig({ chatModel: id });
  hinweis('Chat model: ' + modellAnzeige(id));
  zeichneLeiste();
}

// ---------------- Darstellung ----------------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// kleines, sicheres Markdown: Codebloecke, `code`, **fett**, Ueberschriften
function markdown(text) {
  const teile = String(text).split(/```[^\n`]*\n?/);
  return teile.map((t, i) => {
    if (i % 2) return `<div class="code"><button class="code-kopie">Copy</button><pre>${esc(t.replace(/\n$/, ''))}</pre></div>`;
    return esc(t)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,4} (.+)$/gm, '<b class="h">$1</b>');
  }).join('');
}
const ersterCode = (text) => {
  const m = /```[^\n`]*\n?([\s\S]*?)```/.exec(text);
  if (m) return m[1].trim();
  const p = /\*\*Prompt\*\*\s*\n([\s\S]*?)(\n\s*\*\*|$)/.exec(text); // kleine Modelle lassen die Codebloecke manchmal weg
  return p ? p[1].trim() : null;
};

function zeichneChat() {
  for (const b of modiBox.children) b.classList.toggle('an', b.dataset.modus === chat.modus);
  $('#chat-text').placeholder = MODI[chat.modus].platz;
  if (ansicht === 'chat') {
    $('#titel-text').innerHTML = '';
    $('#titel-text').append(elem('b', null, 'Workspace'), '  ·  ' + MODI[chat.modus].name);
  }
  const box = $('#chat-verlauf');
  box.innerHTML = '';
  const v = verlauf();
  if (!v.length) {
    const l = elem('div', 'chat-leer');
    l.append(elem('b', null, MODI[chat.modus].name), elem('span', null, chat.modus === 'chat'
      ? 'Chat with any of your models – local or cloud. Pick the model bottom right.'
      : 'Type your idea in plain words. The model turns it into a ready-to-use ' + MODI[chat.modus].name.toLowerCase() + '.'));
    box.appendChild(l);
  }
  for (const n of v) box.appendChild(nachrichtElem(n));
  zeichneKnopf();
  box.scrollTop = box.scrollHeight;
}

function nachrichtElem(n) {
  const z = elem('div', 'nachricht ' + n.role + (n.fehler ? ' fehler' : ''));
  if (n.role === 'user') { z.textContent = n.content; return z; }
  if (n.denken && !n.content) z.append(elem('div', 'denken', 'Thinking… ' + n.denken.slice(-160)));
  else if (n.denken) {
    const d = elem('details', 'denken');
    d.append(elem('summary', null, 'Thought for a moment'), elem('div', null, n.denken));
    z.appendChild(d);
  }
  const inhalt = elem('div', 'inhalt');
  inhalt.innerHTML = n.fehler ? esc(n.fehler) : markdown(n.content || (n.laeuft ? '…' : ''));
  z.appendChild(inhalt);
  if (!n.laeuft && n.content) {
    const fuss = elem('div', 'n-fuss');
    const kopie = elem('button', null, 'Copy');
    kopie.addEventListener('click', () => { window.api.clipWrite(ersterCode(n.content) || n.content); hinweis('Copied'); });
    fuss.appendChild(kopie);
    if (chat.modus === 'coding' && sitzung && !sitzung.beendet && sitzung.tool !== 'shell') {
      const t = elem('button', null, '→ Send to ' + WERKZEUG_NAME[sitzung.tool]);
      t.addEventListener('click', () => {
        zeigeTerminal();
        term.paste(ersterCode(n.content) || n.content);
        hinweis('Pasted – press Enter in the terminal to start');
      });
      fuss.appendChild(t);
    }
    // Prompt-Helfer -> direkt im Studio erzeugen
    const ziel = { bild: 'bild', video: 'video', stimme: 'stimme' }[chat.modus];
    if (ziel && ersterCode(n.content)) {
      const t = elem('button', null, '→ Create in Studio');
      t.addEventListener('click', () => {
        const bloecke = [...n.content.matchAll(/```[^\n`]*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
        sz.felder[ziel].prompt = ersterCode(n.content);
        if (ziel === 'video' && bloecke[1]) sz.felder.video.negativ = bloecke[1];
        zeigeStudio(ziel);
      });
      fuss.appendChild(t);
    }
    if (n.modell) fuss.appendChild(elem('span', null, modellAnzeige(n.modell)));
    z.appendChild(fuss);
  }
  for (const b of z.querySelectorAll('.code-kopie')) {
    b.addEventListener('click', () => { window.api.clipWrite(b.nextElementSibling.textContent); hinweis('Copied'); });
  }
  return z;
}

function zeichneKnopf() {
  $('#chat-los').textContent = chat.laeuft ? 'Stop' : 'Send';
  $('#chat-los').classList.toggle('stopp', !!chat.laeuft);
}

// ---------------- Senden ----------------
function sendeChat() {
  if (chat.laeuft) { window.api.chatStopp(chat.laeuft); return; }
  const text = $('#chat-text').value.trim();
  if (!text) return;
  const model = chatModell();
  if (!model) { hinweis('Pick a model first (bottom right)'); return; }
  const v = verlauf();
  v.push({ role: 'user', content: text });
  const antwort = { role: 'assistant', content: '', denken: '', laeuft: true, modell: model };
  v.push(antwort);
  $('#chat-text').value = '';
  passeHoeheAn();
  const id = 'c' + ++chat.nr;
  chat.laeuft = id;
  chat.antwort = antwort;
  neueEingabe = true;
  window.api.chat({
    id, model, system: MODI[chat.modus].system || cfg.chatSystem || '',
    nachrichten: v.filter((n) => n !== antwort && !n.fehler).map((n) => ({ role: n.role, content: n.content })),
  });
  zeichneChat();
}

window.api.onChat((p) => {
  if (p.id !== chat.laeuft || !chat.antwort) return;
  const a = chat.antwort;
  if (p.text != null) a.content = p.text;
  if (p.denken != null) a.denken = p.denken;
  if (p.fertig) {
    a.laeuft = false;
    if (p.fehler && !(p.fehler === 'stopped' && a.content)) a.fehler = p.fehler === 'stopped' ? 'Stopped.' : p.fehler;
    chat.laeuft = null;
    chat.antwort = null;
    zeichneChat();
    return;
  }
  // waehrend des Streamens nur die letzte Nachricht ersetzen
  const box = $('#chat-verlauf');
  const unten = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (box.lastElementChild) box.replaceChild(nachrichtElem(a), box.lastElementChild);
  if (unten) box.scrollTop = box.scrollHeight;
});

function passeHoeheAn() {
  const t = $('#chat-text');
  t.style.height = 'auto';
  t.style.height = Math.min(220, t.scrollHeight) + 'px';
}
$('#chat-text').addEventListener('input', passeHoeheAn);
$('#chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendeChat(); }
});
$('#chat-los').addEventListener('click', sendeChat);
$('#chat-neu').addEventListener('click', () => {
  if (chat.laeuft) window.api.chatStopp(chat.laeuft);
  chat.verlaeufe[chat.modus] = [];
  zeichneChat();
  $('#chat-text').focus();
});

// ---------------- Konten (Tab im Modellfenster) ----------------
const KONTEN = [
  { id: 'anthropic', name: 'Anthropic API', wo: 'Claude Code, OpenCode, Chat', link: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI API', wo: 'Codex, OpenCode, Chat', link: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', wo: 'OpenCode, Chat – hundreds of models with one key', link: 'https://openrouter.ai/keys' },
  { id: 'gemini', name: 'Google Gemini', wo: 'OpenCode, Chat', link: 'https://aistudio.google.com/apikey' },
  { id: 'huggingface', name: 'Hugging Face', wo: 'Downloads of gated models (optional)', link: 'https://huggingface.co/settings/tokens' },
];

async function zeichneKonten() {
  const box = $('#konten-liste');
  const st = await window.api.konten().catch(() => ({}));
  box.innerHTML = '';
  gruppe(box, 'Subscriptions – use your own login');
  const abos = [
    { id: 'abo', name: 'Claude subscription', wo: 'Claude Code (Pro / Max)', tool: 'claude', model: 'abo,sonnet', an: st.abo && st.abo.angemeldet },
    { id: 'chatgpt', name: 'ChatGPT account', wo: 'Codex (Plus / Pro)', tool: 'codex', model: 'chatgpt,standard', an: st.chatgpt && st.chatgpt.angemeldet },
  ];
  for (const a of abos) {
    const z = elem('div', 'konto');
    const t = elem('div', 'k-text');
    t.append(elem('b', null, a.name), elem('small', null, `Works in ${a.wo}. ${a.an ? 'You are logged in.' : 'Not logged in yet.'}`));
    const s = elem('span', 'k-status' + (a.an ? ' an' : ''), a.an ? '✓ connected' : '–');
    const b = elem('button', 'm-knopf', a.an ? 'Use in ' + WERKZEUG_NAME[a.tool] : 'Log in');
    b.addEventListener('click', () => {
      schliesseBib();
      zeigeTerminal();
      starteSitzung({ tool: a.tool, model: a.model });
      if (!a.an) hinweis(`${WERKZEUG_NAME[a.tool]} will ask you to log in`);
    });
    z.append(t, s, b);
    box.appendChild(z);
  }
  gruppe(box, 'API keys – pay per use, encrypted on this PC');
  for (const k of KONTEN) {
    const info = st[k.id] || {};
    const z = elem('div', 'konto');
    const t = elem('div', 'k-text');
    t.append(elem('b', null, k.name), elem('small', null, k.wo));
    const s = elem('span', 'k-status' + (info.gesetzt ? ' an' : ''), info.gesetzt ? '✓ ••••' + info.ende : '–');
    const eingabe = elem('input');
    eingabe.type = 'password';
    eingabe.placeholder = info.gesetzt ? 'Replace key…' : 'Paste key…';
    eingabe.spellcheck = false;
    const speichern = elem('button', 'm-knopf', 'Save');
    const fertig = async (wert) => {
      try {
        await window.api.kontoSetzen(k.id, wert);
        hinweis(wert ? k.name + ' key saved' : k.name + ' key removed');
        liste = await window.api.models();
      } catch (e) { hinweis(fehlerText(e)); }
      zeichneKonten();
    };
    speichern.addEventListener('click', () => { if (eingabe.value.trim()) fertig(eingabe.value); });
    eingabe.addEventListener('keydown', (e) => { if (e.key === 'Enter' && eingabe.value.trim()) fertig(eingabe.value); });
    const aktion = elem('div', 'k-aktion');
    aktion.append(eingabe, speichern);
    if (info.gesetzt) {
      const weg = elem('button', 'm-knopf', 'Remove');
      weg.addEventListener('click', () => {
        if (!weg.classList.contains('sicher')) { weg.classList.add('sicher'); weg.textContent = 'Sure?'; return; }
        fertig('');
      });
      aktion.appendChild(weg);
    }
    const l = elem('button', 'k-link', 'Get a key ↗');
    l.addEventListener('click', () => window.api.link(k.link));
    aktion.appendChild(l);
    z.append(t, s, aktion);
    box.appendChild(z);
  }
  box.appendChild(elem('div', 'm-fuss', 'Keys are encrypted with your Windows login and only sent to their provider. Subscriptions stay inside the official tools, Glowline never reads your login.'));
}
