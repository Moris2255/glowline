'use strict';
// Workspace: Chat + Prompt-Helfer (im Hauptbereich statt des Terminals) und die Konten-Seite im Modellfenster.
// Laeuft nach app.js und nutzt dessen Hilfsfunktionen ($, elem, cfg, liste, ...).

// ---------------- Modi ----------------
const MODI = {
  auto: { name: 'Auto', platz: 'Ask anything – or say “create an image of …” · type / for commands', system: '' },
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

// Obsidian-Vault verbunden? (fuer "Save to Obsidian")
let gehirnAktiv = null;
function gehirnPruefen() { window.api.gehirnVaults().then((r) => { gehirnAktiv = r.aktiv; }).catch(() => {}); }
gehirnPruefen();
const chat = { modus: 'auto', verlaeufe: {}, laeuft: null, nr: 0, autoModell: '', fest: '', ziel: '', immerDenken: false }; // fest = Modell, das man ueber die Leiste gewaehlt hat
const verlauf = () => (chat.verlaeufe[chat.modus] = chat.verlaeufe[chat.modus] || []);
const chatModell = () => cfg.chatModel || cfg.defaultModel || '';
// Auto und Chat koennen Bilder, Videos, Stimme erzeugen und Bilder angehaengt bekommen
const mitMedien = () => chat.modus === 'auto' || chat.modus === 'chat';
const ROLLE_NAME = { schnell: 'Fast', coder: 'Code', denker: 'Reasoning', sehen: 'Vision' };
const ROLLE_INFO = {
  schnell: 'Small talk, quick questions – and it sorts every message and writes Studio prompts',
  coder: 'Programming questions, code, error messages',
  denker: 'Maths, planning, weighing options – thinks before answering',
  sehen: 'Questions about an attached image',
};

// Verlaeufe ueberstehen einen Neustart (nur auf diesem PC, im Glowline-Profil)
const SPEICHER = 'glowline-chats';
function speichereChats() {
  try {
    const kopie = {};
    for (const [k, v] of Object.entries(chat.verlaeufe)) kopie[k] = v.filter((n) => !n.laeuft).slice(-200);
    localStorage.setItem(SPEICHER, JSON.stringify({ verlaeufe: kopie, modus: chat.modus, fest: chat.fest, ziel: chat.ziel, immerDenken: chat.immerDenken }));
  } catch {}
}
try {
  const g = JSON.parse(localStorage.getItem(SPEICHER) || 'null');
  if (g && g.verlaeufe && typeof g.verlaeufe === 'object') {
    for (const [k, v] of Object.entries(g.verlaeufe)) if (MODI[k] && Array.isArray(v)) chat.verlaeufe[k] = v;
    // eigene Bilder aus dem Verlauf wieder anzeigen duerfen
    for (const v of Object.values(chat.verlaeufe)) for (const n of v) if (n.anhang) window.api.studioFreigeben(n.anhang);
  }
  // Cowork hat nur noch Auto (alte Chat-/Helfer-Verlaeufe bleiben gespeichert)
  if (g && typeof g.fest === 'string') chat.fest = g.fest;
  if (g && typeof g.ziel === 'string') chat.ziel = g.ziel;
  if (g) chat.immerDenken = !!g.immerDenken;
} catch {}

const modiBox = $('#chat-modi');
$('#chat-modelle').addEventListener('click', () => oeffneBib('cowork'));

function zeigeWorkspace(modus) {
  ansicht = 'chat';
  document.body.dataset.ansicht = ansicht;
  if (modus) chat.modus = modus;
  el.classList.add('versteckt');
  $('#studio').classList.add('versteckt');
  $('#artex').classList.add('versteckt');
  $('#apps').classList.add('versteckt');
  $('#chat').classList.remove('versteckt');
  $('#titel-text').innerHTML = '';
  $('#titel-text').append(elem('b', null, 'Cowork'));
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
  $('#artex').classList.add('versteckt');
  $('#apps').classList.add('versteckt');
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
  chat.immerDenken = false;
  cfg.chatModel = id;
  window.api.setConfig({ chatModel: id });
  // in Cowork ein Modell gewaehlt: alle Nachrichten gehen an dieses Modell, bis man zurueck auf Auto stellt
  if (ansicht === 'chat') {
    chat.fest = id;
    speichereChats();
    zeichneChat();
    hinweis('Cowork now uses ' + modellAnzeige(id) + ' for every message');
  } else hinweis('Chat model: ' + modellAnzeige(id));
  zeichneLeiste();
}

// Ueber dem Chat nur, wenn ein Modell fest gewaehlt ist (sonst waehlt Auto selbst)
function zeichneFest() {
  const box = $('#chat-rollen');
  box.innerHTML = '';
  const zeile = (teile, knopf, weg) => {
    const z = elem('div', 'status-zeile');
    const t = elem('span', 'fest-text');
    t.append(...teile);
    const b = elem('button', null, knopf);
    b.addEventListener('click', () => { weg(); speichereChats(); zeichneChat(); zeichneLeiste(); });
    z.append(t, b);
    box.appendChild(z);
  };
  if (chat.fest) zeile(['Every message goes to ', elem('b', null, modellAnzeige(chat.fest))], 'Back to Auto', () => { chat.fest = ''; hinweis('Cowork picks the model again'); });
  else if (chat.immerDenken) zeile(['Every message goes to the ', elem('b', null, 'Reasoning'), ' model'], 'Turn off', () => { chat.immerDenken = false; });
  if (chat.ziel) zeile(['Goal: ', elem('b', null, chat.ziel)], 'Clear goal', () => { chat.ziel = ''; });
  box.classList.toggle('versteckt', !box.children.length);
}

// Modellfenster → Cowork: welches Modell wofuer, jede Rolle umstellbar
let rollenNr = 0;
async function zeichneAutoRollen(neu) {
  const box = $('#auto-rollen');
  const nr = ++rollenNr;
  const [r, l, emp, st] = await Promise.all([
    window.api.autoRollen(neu).catch(() => null),
    liste ? Promise.resolve(liste) : window.api.models().catch(() => null),
    window.api.autoEmpfehlung().catch(() => null),
    window.api.studio().catch(() => null),
  ]);
  if (nr !== rollenNr || !r) return;
  if (l) liste = l;
  const auswahl = alleModelle().map((m) => m.id).filter((id) => !/^(abo|chatgpt),/.test(id));
  box.innerHTML = '';
  if (emp) {
    const pc = elem('div', 'rollen-pc');
    pc.append('Your PC: ', elem('b', null, emp.pc), emp.stufe ? ' → recommended models: ' : '', emp.stufe ? elem('b', null, emp.stufe) : '');
    box.appendChild(pc);
  }
  box.appendChild(elem('div', 'rollen-titel', 'Chat'));
  for (const rolle of Object.keys(ROLLE_NAME)) {
    const x = r.rollen[rolle] || { id: '', auto: true };
    const z = elem('div', 'rolle');
    const kopf = elem('span', 'rolle-kopf');
    kopf.append(elem('b', null, ROLLE_NAME[rolle]), elem('small', null, ROLLE_INFO[rolle]));
    z.appendChild(kopf);
    const rechts = elem('div', 'rolle-rechts');
    const s = elem('select');
    const o = elem('option', null, 'Auto · ' + (x.auto && x.id ? modellAnzeige(x.id) : x.auto ? 'none installed' : '…'));
    o.value = '';
    s.appendChild(o);
    for (const id of new Set([...(x.auto || !x.id ? [] : [x.id]), ...auswahl])) {
      const e = elem('option', null, modellAnzeige(id));
      e.value = id;
      s.appendChild(e);
    }
    s.value = x.auto ? '' : x.id;
    s.addEventListener('change', async () => {
      await window.api.autoSetzen(rolle, s.value);
      hinweis(ROLLE_NAME[rolle] + ': ' + (s.value ? modellAnzeige(s.value) : 'picked automatically'));
      zeichneAutoRollen();
    });
    z.appendChild(s);
    // Empfehlung fuer diesen PC: vorhanden -> eintragen, sonst aus der Ollama-Bibliothek laden
    const e = emp && emp.rollen[rolle];
    if (e) {
      const aktiv = e.id && x.id === e.id;
      const key = 'bibliothek|' + e.name;
      const laedt = downloads.has(key);
      const k = elem('button', 'rolle-empf' + (aktiv ? ' an' : ''),
        aktiv ? '✓ Recommended' : laedt ? 'Downloading…' : e.id ? 'Use recommended' : `Use recommended (${e.gb} GB)`);
      k.title = `Recommended for your PC: ${e.name}` + (e.id ? '' : ` – downloads ${e.gb} GB with Ollama`);
      k.disabled = aktiv || laedt || (!e.id && !emp.ollama);
      k.addEventListener('click', async () => {
        if (e.id) {
          await window.api.autoSetzen(rolle, e.id);
          hinweis(ROLLE_NAME[rolle] + ': ' + modellAnzeige(e.id));
          zeichneAutoRollen();
          return;
        }
        downloads.set(key, { ziel: 'bibliothek', repo: e.name, quant: '', rolle, status: 'starting…', completed: 0, total: Math.round(e.gb * 2 ** 30) });
        window.api.download({ key, ziel: 'bibliothek', repo: e.name });
        hinweis(`Downloading ${e.name} (${e.gb} GB) for ${ROLLE_NAME[rolle]}`);
        zeichneDownloads();
        zeichneAutoRollen();
      });
      const name = elem('small', 'rolle-empf-name', e.name);
      rechts.append(k, name);
    }
    z.appendChild(rechts);
    box.appendChild(z);
  }
  if (st) studioStandardZeilen(box, st);
}

// Studio-Standardmodelle: was Cowork (und das Studio beim Oeffnen) fuer Bilder, Videos, Upscale und Stimme nimmt
const STUDIO_ROLLE = { bild: ['Images', '“draw a cat”, logos, photos'], video: ['Video', '“make a video of …”, animate an image'], upscale: ['Upscale', 'make an image or video sharper'], stimme: ['Voice', '“read this out”, voice-overs'] };
function studioAuto(st, art) {
  const bereit = Object.values(st.modelle).filter((m) => m.art === art && m.da && !m.wolke);
  return (art === 'bild' && bereit.find((m) => m.id === 'z-image')) || bereit[0] || null;
}
function studioStandardZeilen(box, st) {
  const titel = elem('div', 'rollen-titel', 'Studio');
  titel.appendChild(elem('small', null, st.eingerichtet ? ' – used when you ask Cowork for an image, video or voice, and picked first in Studio' : ' – set up the Studio once to make images, videos and voices'));
  box.appendChild(titel);
  const std = cfg.studioStandard || {};
  for (const [art, [name, info]] of Object.entries(STUDIO_ROLLE)) {
    const modelle = Object.values(st.modelle).filter((m) => m.art === art);
    if (!modelle.length) continue;
    const z = elem('div', 'rolle');
    z.dataset.studio = art;
    const kopf = elem('span', 'rolle-kopf');
    kopf.append(elem('b', null, name), elem('small', null, info));
    z.appendChild(kopf);
    const s = elem('select');
    const auto = studioAuto(st, art);
    const o = elem('option', null, 'Auto · ' + (auto ? auto.name : 'nothing downloaded'));
    o.value = '';
    s.appendChild(o);
    for (const m of modelle) {
      const e = elem('option', null, m.name + (m.wolke ? (m.da ? ' · cloud, paid' : ' · needs a key') : m.da ? '' : ' · not downloaded'));
      e.value = m.id;
      e.disabled = !m.da;
      s.appendChild(e);
    }
    const jetzt = modelle.find((m) => m.id === std[art] && m.da);
    s.value = jetzt ? jetzt.id : '';
    s.addEventListener('change', async () => {
      cfg.studioStandard = { ...(cfg.studioStandard || {}), [art]: s.value };
      await window.api.setConfig({ studioStandard: cfg.studioStandard });
      if (sz.felder[art] && 'modell' in sz.felder[art]) sz.felder[art].modell = '';
      const m = modelle.find((x) => x.id === s.value);
      hinweis(name + ': ' + (m ? m.name + (m.wolke ? ' (cloud – costs money per use)' : '') : 'picked automatically'));
      zeichneAutoRollen();
    });
    z.appendChild(s);
    const rechts = elem('div', 'rolle-rechts');
    const fehlen = modelle.filter((m) => !m.da && !m.wolke).length;
    const k = elem('button', 'rolle-empf', !st.eingerichtet ? (st.fern ? 'Set up on your PC' : 'Set up Studio') : fehlen && !st.fern ? `Get models (${fehlen})` : 'Open in Studio');
    k.title = !st.eingerichtet ? 'Opens the Studio – click “Set up” there' : fehlen ? 'Opens Studio, where you can download more models' : 'Opens this part of the Studio';
    k.addEventListener('click', () => { schliesseBib(); zeigeStudio(art); });
    rechts.append(k, elem('small', 'rolle-empf-name', (jetzt || auto || modelle[0]).info || ''));
    z.appendChild(rechts);
    box.appendChild(z);
  }
}

// ---------------- Darstellung ----------------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// kleines, sicheres Markdown: Codebloecke, `code`, **fett**, Ueberschriften
function markdown(text) {
  const teile = String(text).split(/```[^\n`]*\n?/);
  return teile.map((t, i) => {
    if (i % 2) return `<div class="code"><button class="code-kopie">Copy</button><pre>${esc(t.replace(/\n$/, ''))}</pre></div>`;
    // LaTeX-Mathe der Modelle lesbar machen ($x = 12$, $$ … $$, \cdot)
    t = t.replace(/^[ \t]*\$\$[ \t]*$\n?/gm, '').replace(/\$\$([^$]+)\$\$/g, '$1').replace(/\$(\S(?:[^$\n]*\S)?)\$/g, '$1')
      .replace(/\\(cdot|times)\b/g, (_, x) => (x === 'cdot' ? '·' : '×')).replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
      .replace(/\\(left|right)\b/g, '').replace(/\\text\{([^{}]*)\}/g, '$1');
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
  $('#chat-text').placeholder = chat.fest ? 'Message ' + modellAnzeige(chat.fest) + ' – or ask for an image, video or voice' : MODI[chat.modus].platz;
  if (ansicht === 'chat') {
    $('#titel-text').innerHTML = '';
    $('#titel-text').append(elem('b', null, 'Cowork'));
  }
  const box = $('#chat-verlauf');
  box.innerHTML = '';
  const v = verlauf();
  if (!v.length) {
    const l = elem('div', 'chat-leer');
    l.append(elem('b', null, 'Cowork'), elem('span', null, chat.modus === 'auto'
      ? 'One chat for everything. Glowline picks the right model for each message – a fast one for quick questions, the coder for code, a thinking model for maths and plans, a vision model for questions about images. Ask for images, videos, voice or upscales and the Studio makes them right here. Want a specific model? Name it (“ask gemma: …”) or pick one bottom right.'
      : chat.modus === 'chat'
        ? 'Chat with any of your models – local or cloud. You can also ask for images, videos, voice or upscales, e.g. “create an image of a tree” – the Studio makes them right here.'
        : 'Type your idea in plain words. The model turns it into a ready-to-use ' + MODI[chat.modus].name.toLowerCase() + '.'));
    box.appendChild(l);
  }
  for (const n of v) box.appendChild(nachrichtElem(n));
  zeichneKnopf();
  zeichneAnhang();
  zeichneFest();
  box.scrollTop = box.scrollHeight;
}

function nachrichtElem(n) {
  const z = elem('div', 'nachricht ' + n.role + (n.fehler ? ' fehler' : ''));
  if (n.role === 'user') {
    z.textContent = n.content;
    if (n.anhang) { const b = elem('img', 'n-anhang'); b.src = dateiUrl(n.anhang); z.prepend(b); }
    return z;
  }
  if (n.rolle) z.appendChild(elem('div', 'n-rolle', ROLLE_NAME[n.rolle] + (n.modell ? ' · ' + modellAnzeige(n.modell) : '')));
  if (n.denken && !n.content) z.append(elem('div', 'denken', 'Thinking… ' + n.denken.slice(-160)));
  else if (n.denken) {
    const d = elem('details', 'denken');
    d.append(elem('summary', null, 'Thought for a moment'), elem('div', null, n.denken));
    z.appendChild(d);
  }
  const inhalt = elem('div', 'inhalt');
  inhalt.innerHTML = n.fehler ? esc(n.fehler) : markdown(n.content || (n.laeuft && !n.medien && !n.datei ? '…' : ''));
  z.appendChild(inhalt);
  // Notizen aus dem Obsidian-Vault, die mitgeschickt wurden – Klick oeffnet sie in Obsidian
  if (n.notizen && n.notizen.length) {
    const nz = elem('div', 'n-notizen');
    nz.appendChild(elem('span', null, 'From your notes'));
    for (const x of n.notizen) {
      const b = elem('button', null, x.titel);
      b.title = 'Open in Obsidian: ' + x.rel;
      b.addEventListener('click', () => window.api.gehirnOeffnen(x.rel));
      nz.appendChild(b);
    }
    z.appendChild(nz);
  }
  if (n.medien) { z.appendChild(chatMedienElem(n)); return z; }
  if (n.datei) { z.appendChild(chatDateiElem(n)); return z; }
  if (!n.laeuft && n.content) {
    const fuss = elem('div', 'n-fuss');
    const kopie = elem('button', null, 'Copy');
    kopie.addEventListener('click', () => { window.api.clipWrite(ersterCode(n.content) || n.content); hinweis('Copied'); });
    fuss.appendChild(kopie);
    if (gehirnAktiv) {
      const o = elem('button', null, n.obsidian ? '✓ In Obsidian' : 'Save to Obsidian');
      o.title = n.obsidian ? 'Open the note in Obsidian' : 'Save this answer as a note in your Obsidian vault (folder “Glowline”)';
      o.addEventListener('click', async () => {
        if (n.obsidian) return window.api.gehirnOeffnen(n.obsidian);
        const titel = (/^#{1,3}\s+(.+)$/m.exec(n.content) || [])[1] || n.frage || 'Glowline note';
        const r = await window.api.gehirnSpeichern(titel, n.content, n.modell);
        if (r.fehler) return hinweis(r.fehler);
        n.obsidian = r.rel;
        speichereChats();
        o.textContent = '✓ In Obsidian';
        hinweis('Saved to Obsidian: ' + r.rel);
      });
      fuss.appendChild(o);
    }
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
    if (n.modell && !n.rolle) fuss.appendChild(elem('span', null, modellAnzeige(n.modell)));
    z.appendChild(fuss);
  }
  for (const b of z.querySelectorAll('.code-kopie')) {
    b.addEventListener('click', () => { window.api.clipWrite(b.nextElementSibling.textContent); hinweis('Copied'); });
  }
  return z;
}

// Ergebnis eines Studio-Auftrags im Chat: Fortschritt, dann Bild / Video / Ton mit Knoepfen
function chatMedienElem(n) {
  const m = n.medien;
  const box = elem('div', 'n-medien');
  if (m.art === 'film' && m.film) {
    const b = elem('button', 'm-knopf', 'Open in Studio → Film');
    b.addEventListener('click', () => zeigeFilm(m.film));
    box.appendChild(b);
    return box;
  }
  if (m.fehlt) {
    const b = elem('button', 'm-knopf', 'Open Studio');
    b.addEventListener('click', () => zeigeStudio(m.fehlt));
    box.appendChild(b);
    return box;
  }
  const f = m.dateien && m.dateien[0];
  if (f) {
    const art = /\.(png|jpe?g|webp)$/i.test(f) ? 'img' : /\.(mp4|webm)$/i.test(f) ? 'video' : 'audio';
    const e = elem(art);
    if (art !== 'img') { e.controls = true; e.preload = 'metadata'; }
    if (art === 'video') e.loop = true;
    e.src = dateiUrl(f);
    box.appendChild(e);
  } else if (n.laeuft && m.status) {
    const st = elem('div', 'n-status');
    st.appendChild(elem('span', null, m.status + (m.prozent ? ` · ${m.prozent} %` : '')));
    if (m.vorgang) {
      const b = elem('div', 'balken');
      const i = elem('i');
      i.style.width = (m.prozent || 0) + '%';
      b.appendChild(i);
      st.appendChild(b);
    }
    box.appendChild(st);
  }
  if (m.prompt) {
    const d = elem('details');
    d.append(elem('summary', null, (m.art === 'voice' ? 'Text' : 'Prompt') + (m.modell ? ' · ' + m.modell : '')), elem('div', null, m.prompt));
    box.appendChild(d);
  }
  if (f && !n.laeuft) {
    const fuss = elem('div', 'n-fuss');
    const knopf = (text, tun) => { const b = elem('button', null, text); b.addEventListener('click', tun); fuss.appendChild(b); };
    if (m.art === 'image') {
      knopf('Upscale 4×', () => sendeChat({ text: 'Upscale this image', erzwinge: { art: 'upscale', quelle: f } }));
      knopf('Animate', () => sendeChat({ text: 'Animate this image', erzwinge: { art: 'video', quelle: f, bildPrompt: m.prompt || '' } }));
    }
    if (m.art === 'video' && /\.(mp4|webm)$/i.test(f)) knopf('Upscale', () => sendeChat({ text: 'Upscale this video', erzwinge: { art: 'upscale', quelle: f } }));
    knopf('Show in folder', () => window.api.studioZeigen(f));
    box.appendChild(fuss);
  }
  return box;
}

// von Cowork auf dem PC gespeicherte Datei(en): Name, Ort, Oeffnen / Im Ordner zeigen
const ANSEHBAR = /\.(html?|txt|md|json|csv|xml|svg|css|png|jpe?g|webp|gif|log|ini|ya?ml)$/i;
function chatDateiElem(n) {
  const d = n.datei;
  const box = elem('div', 'n-datei');
  if (n.laeuft) {
    const st = elem('div', 'n-status');
    st.append(elem('span', 'datei-icon', '📄'), elem('span', null, (d.status || 'Writing the file…') + (d.ordner ? ' → ' + d.ordner : '')));
    box.appendChild(st);
    return box;
  }
  for (const f of d.dateien || []) {
    const z = elem('div', 'datei-zeile');
    const info = elem('div', 'datei-info');
    info.append(elem('b', null, f.name), elem('small', null, `${d.geaendert ? 'Updated' : 'Saved'} in ${d.ordner} · ${f.groesse < 1024 ? f.groesse + ' B' : Math.round(f.groesse / 1024) + ' KB'}`));
    z.append(elem('span', 'datei-icon', '📄'), info);
    const knopf = (text, tun) => { const b = elem('button', null, text); b.addEventListener('click', tun); z.appendChild(b); };
    if (ANSEHBAR.test(f.pfad)) knopf('Open', () => window.api.dateiOeffnen(f.pfad));
    knopf('Show in folder', () => window.api.dateiZeigen(f.pfad));
    box.appendChild(z);
  }
  return box;
}
// zuletzt erstellte Datei: "mach den Vogel schneller" aendert dann genau die
function letzteDatei() {
  const v = verlauf();
  let antworten = 0;
  for (let i = v.length - 1; i >= 0 && antworten < 4; i--) {
    const n = v[i];
    if (n.role !== 'assistant' || n.lokal) continue;
    antworten++;
    if (n.datei && n.datei.dateien && n.datei.dateien.length) return (n.datei.dateien.find((f) => /\.html?$/i.test(f.pfad)) || n.datei.dateien[0]).pfad;
  }
  return null;
}

// Bild anhaengen (zum Hochskalieren oder Animieren): 📎 oder in den Chat ziehen
function zeichneAnhang() {
  const box = $('#chat-anhang');
  box.innerHTML = '';
  $('#chat-bild').classList.toggle('versteckt', !mitMedien());
  box.classList.toggle('versteckt', !chat.anhang || !mitMedien());
  if (!chat.anhang) return;
  const i = elem('img');
  i.src = dateiUrl(chat.anhang);
  const x = elem('button', null, '✕');
  x.title = 'Remove';
  x.addEventListener('click', () => { chat.anhang = null; zeichneAnhang(); });
  box.append(i, x);
}
$('#chat-bild').addEventListener('click', async () => {
  const p = await window.api.studioWaehle('bild');
  if (p) { chat.anhang = p; zeichneAnhang(); $('#chat-text').focus(); }
});
$('#chat').addEventListener('dragover', (e) => { if (mitMedien()) e.preventDefault(); });
$('#chat').addEventListener('drop', (e) => {
  if (!mitMedien()) return;
  e.preventDefault();
  const d = e.dataTransfer.files[0];
  const p = d && window.api.pfadVon(d);
  if (!p || !/\.(png|jpe?g|webp)$/i.test(p)) { hinweis('Please drop an image'); return; }
  window.api.studioFreigeben(p);
  chat.anhang = p;
  zeichneAnhang();
  $('#chat-text').focus();
});

// letztes Bild/Video/Ton im Chat, damit "mach es rot" oder "animiere das" wissen, was gemeint ist
function letztesMedium() {
  const v = verlauf();
  for (let i = v.length - 1; i >= 0; i--) {
    const n = v[i];
    if (n.role === 'user' && n.anhang) return { art: 'image', bild: n.anhang, prompt: '' };
    if (n.medien && n.medien.dateien && n.medien.dateien.length) {
      const f = n.medien.dateien[0];
      return { art: n.medien.art, prompt: n.medien.prompt || '', bild: /\.(png|jpe?g|webp)$/i.test(f) ? f : null, video: /\.(mp4|webm)$/i.test(f) ? f : null };
    }
    if (n.role === 'assistant' && !n.fehler) return null; // dazwischen normal gechattet
  }
  return null;
}
// Auto: ging es eben um ein Bild (angehaengt oder vom Sehen-Modell angeschaut)? Dann bleiben Folgefragen dort
function bildImGespraech(v) {
  const a = [...v].reverse().find((n) => n.role === 'assistant');
  const u = [...v].reverse().find((n) => n.role === 'user');
  if (a && a.rolle === 'sehen' && a.bild) return a.bild;
  if (u && u.anhang && !(a && a.medien)) return u.anhang; // Bild angehaengt, Antwort ging schief oder war Text
  return null;
}
// was das Modell vom Verlauf sieht: erzeugte Medien als kurze Notiz
const fuerModell = (n) => ({
  role: n.role,
  content: n.medien && n.medien.dateien
    ? `[Created ${n.medien.art === 'voice' ? 'a voice recording of the text' : n.medien.art === 'upscale' ? 'a 4× upscale' : 'an ' + n.medien.art + ' with the prompt'}: ${n.medien.prompt || ''}]`
    : n.datei && n.datei.dateien
      ? `[${n.datei.geaendert ? 'Updated' : 'Saved'} ${n.datei.dateien.map((f) => f.name).join(', ')} in ${n.datei.ordner} on the user's computer] ${n.content || ''}`
      : n.content + (n.anhang ? ' [attached an image]' : ''),
});

function zeichneKnopf() {
  $('#chat-los').textContent = chat.laeuft ? 'Stop' : 'Send';
  $('#chat-los').classList.toggle('stopp', !!chat.laeuft);
}

// ---------------- Befehle (/clear, /think, /image …) ----------------
const BEFEHLE = [
  { n: 'help', info: 'show all commands' },
  { n: 'clear', info: 'start a new chat', alias: ['new'] },
  { n: 'stop', info: 'stop the current answer', alias: ['pause'] },
  { n: 'retry', info: 'ask your last message again' },
  { n: 'copy', info: 'copy the last answer' },
  { n: 'export', info: 'copy the whole chat as text' },
  { n: 'think', arg: 'question', info: 'answer with the reasoning model' },
  { n: 'code', arg: 'question', info: 'answer with the coder model' },
  { n: 'fast', arg: 'question', info: 'answer with the fast model' },
  { n: 'thinking', arg: 'on | off', info: 'always use the reasoning model' },
  { n: 'image', arg: 'description', info: 'create an image in the Studio' },
  { n: 'video', arg: 'description', info: 'create a video in the Studio' },
  { n: 'voice', arg: 'text', info: 'read a text aloud' },
  { n: 'upscale', info: 'upscale the attached or last image / video' },
  { n: 'file', arg: 'what', info: 'create a file on your PC (Desktop unless you name a folder)' },
  { n: 'goal', arg: 'text | off', info: 'keep every answer focused on a goal' },
  { n: 'model', arg: 'name', info: 'use one model for every message' },
  { n: 'auto', info: 'let Cowork pick the model again' },
  { n: 'models', info: 'open the Cowork model settings' },
];
const befehlFinden = (w) => BEFEHLE.find((b) => b.n === w || (b.alias || []).includes(w));
function lokaleAntwort(text) {
  verlauf().push({ role: 'assistant', content: text, lokal: true });
  speichereChats();
  zeichneChat();
}
function eingabeLeeren() {
  $('#chat-text').value = '';
  passeHoeheAn();
  zeigeBefehle();
}
// true = erledigt (nichts weiter senden)
function befehl(text) {
  const m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(text.trim());
  const b = m && befehlFinden(m[1].toLowerCase());
  if (!b) { hinweis('Unknown command – type /help'); return true; }
  const rest = m[2].trim();
  const anhang = chat.anhang;
  eingabeLeeren();
  const senden = (vorgabe) => { chat.anhang = null; zeichneAnhang(); sendeChat({ anhang, ...vorgabe }); };
  const v = verlauf();
  switch (b.n) {
    case 'help':
      lokaleAntwort('**Commands**\n\n' + BEFEHLE.map((x) => `- \`/${x.n}${x.arg ? ' ' + x.arg : ''}\` – ${x.info}`).join('\n'));
      break;
    case 'clear': $('#chat-neu').click(); chat.ziel = ''; chat.immerDenken = false; speichereChats(); zeichneChat(); break;
    case 'stop': if (chat.laeuft) window.api.chatStopp(chat.laeuft); else hinweis('Nothing is running'); break;
    case 'retry': {
      const i = v.map((n) => n.role).lastIndexOf('user');
      if (i < 0 || chat.laeuft) { hinweis(chat.laeuft ? 'Wait for the answer first' : 'Nothing to retry'); break; }
      const alt = v[i];
      v.splice(i);
      sendeChat({ text: alt.content, anhang: alt.anhang || null });
      break;
    }
    case 'copy': {
      const a = [...v].reverse().find((n) => n.role === 'assistant' && n.content && !n.lokal);
      if (a) { window.api.clipWrite(a.content); hinweis('Copied'); } else hinweis('No answer yet');
      break;
    }
    case 'export': {
      const t = v.filter((n) => !n.lokal && n.content).map((n) => (n.role === 'user' ? '## You\n\n' : '## Glowline\n\n') + n.content).join('\n\n');
      if (t) { window.api.clipWrite(t); hinweis('Chat copied'); } else hinweis('The chat is empty');
      break;
    }
    case 'think': case 'code': case 'fast': {
      if (!rest) { hinweis(`Type your question after /${b.n}`); break; }
      senden({ text: rest, rolle: { think: 'denker', code: 'coder', fast: 'schnell' }[b.n], ohneStudio: true });
      break;
    }
    case 'thinking': {
      chat.immerDenken = rest ? !/^(off|aus|0|no|nein)$/i.test(rest) : !chat.immerDenken;
      if (chat.immerDenken) chat.fest = '';
      speichereChats(); zeichneChat();
      hinweis(chat.immerDenken ? 'Every message now goes to the reasoning model' : 'Cowork picks the model again');
      break;
    }
    case 'image': case 'video': case 'voice': {
      if (!rest) { hinweis(`Describe what you want after /${b.n}`); break; }
      senden({ text: rest, erzwinge: { art: b.n } });
      break;
    }
    case 'file':
      if (!rest) { hinweis('Say what the file should contain after /file, e.g. /file a jump game as HTML'); break; }
      senden({ text: rest, datei: true });
      break;
    case 'upscale': senden({ text: rest || 'Upscale this', erzwinge: { art: 'upscale', quelle: anhang || undefined } }); break;
    case 'goal':
      if (!rest) { lokaleAntwort(chat.ziel ? 'Current goal: **' + esc(chat.ziel) + '** – type `/goal off` to clear it.' : 'No goal set. Type e.g. `/goal learn Python basics` – every answer then stays focused on it.'); break; }
      chat.ziel = /^(off|aus|clear|none)$/i.test(rest) ? '' : rest.slice(0, 300);
      speichereChats(); zeichneChat();
      hinweis(chat.ziel ? 'Goal set' : 'Goal cleared');
      break;
    case 'model': {
      const id = rest && genanntesModell('use ' + rest);
      if (!id) { hinweis(rest ? 'No model called “' + rest + '” – see /models' : 'Type a model name after /model'); break; }
      setzeChatModell(id);
      break;
    }
    case 'auto': chat.fest = ''; chat.immerDenken = false; speichereChats(); zeichneChat(); zeichneLeiste(); hinweis('Cowork picks the model again'); break;
    case 'models': oeffneBib('cowork'); break;
  }
  return true;
}

// Vorschlaege beim Tippen von "/"
let befehlWahl = 0;
function befehlTreffer() {
  const t = $('#chat-text').value;
  const m = chat.modus === 'auto' && /^\/([a-z]*)$/i.exec(t);
  if (!m) return [];
  const w = m[1].toLowerCase();
  return BEFEHLE.filter((b) => b.n.startsWith(w) || (b.alias || []).some((a) => a.startsWith(w)));
}
function zeigeBefehle() {
  const box = $('#chat-befehle');
  const l = befehlTreffer();
  box.classList.toggle('versteckt', !l.length);
  box.innerHTML = '';
  befehlWahl = Math.min(befehlWahl, Math.max(0, l.length - 1));
  l.forEach((b, i) => {
    const z = elem('button', i === befehlWahl ? 'an' : null);
    z.append(elem('b', null, '/' + b.n), elem('i', null, b.arg || ''), elem('span', null, b.info));
    z.addEventListener('mousedown', (e) => { e.preventDefault(); nimmBefehl(b); });
    box.appendChild(z);
  });
}
function nimmBefehl(b) {
  const t = $('#chat-text');
  if (b.arg) { t.value = '/' + b.n + ' '; zeigeBefehle(); t.focus(); return; }
  t.value = '/' + b.n;
  sendeChat();
}

// ---------------- Senden ----------------
// "frag gemma: …", "ask kat-coder …", "mit qwen3-vl …": ein genanntes Modell nur fuer diese Nachricht
function genanntesModell(text) {
  const modelle = alleModelle().filter((m) => !/^(abo|chatgpt),/.test(m.id));
  const re = /\b(?:frag|fragt|ask|mit|with|use|using|nimm|benutze?|via|per)\s+(?:(?:dem|den|das|die|the)\s+)?([a-z][\w.:\/-]{2,})/gi;
  for (const t of String(text).matchAll(re)) {
    const w = t[1].toLowerCase().replace(/[.:]+$/, '');
    // normale Woerter sind keine Modellnamen ("erklaer das mit Code", "mit dem Bild")
    if (w.length < 3 || /^(code|coder|coding|bild|image|images|video|voice|text|python|java|javascript|chat|auto|fast|model|modell|this|that|thinking|reasoning|vision|ki|ai)$/.test(w)) continue;
    const treffer = modelle.filter((m) => {
      const n = (m.id.split('/').pop() + ' ' + modellAnzeige(m.id)).toLowerCase();
      return n.split(/[\s:/]+/).some((teil) => teil.startsWith(w));
    });
    if (treffer.length) return (treffer.find((m) => m.id === cfg.chatModel || m.id === chat.autoModell) || treffer[0]).id;
  }
  return '';
}
function sendeChat(vorgabe) {
  if (chat.laeuft) { if (!vorgabe) window.api.chatStopp(chat.laeuft); return; }
  const text = vorgabe ? vorgabe.text : $('#chat-text').value.trim();
  if (!text) { if (chat.anhang) hinweis('Say what to do with the image, e.g. “upscale it” or “animate it”'); return; }
  // fest gewaehlt (Leiste) oder in der Nachricht genannt ("frag gemma: …") -> dieses Modell, sonst Auto
  if (!vorgabe && chat.modus === 'auto' && /^\/[a-z]/i.test(text) && befehl(text)) return;
  const fest = chat.modus === 'auto' ? chat.fest || (vorgabe && vorgabe.modell) || genanntesModell(text) : '';
  const istAuto = chat.modus === 'auto' && !fest;
  const model = fest || chatModell();
  if (!model && !istAuto) { hinweis('Pick a model first (bottom right)'); return; }
  const v = verlauf();
  const mitStudio = mitMedien() && !(vorgabe && vorgabe.ohneStudio);
  const vorher = mitStudio ? letztesMedium() : null;
  const anhang = vorgabe ? vorgabe.anhang || null : mitStudio ? chat.anhang : null;
  // Auto: welches Modell hat zuletzt geantwortet (Folgefragen bleiben beim Coder / Denker / beim Bild)
  const voriges = istAuto ? [...v].reverse().find((n) => n.role === 'assistant' && !n.fehler && !n.lokal) : null;
  v.push({ role: 'user', content: text, anhang });
  const antwort = { role: 'assistant', content: '', denken: '', laeuft: true, modell: istAuto ? '' : model, frage: text.slice(0, 120) };
  v.push(antwort);
  if (!vorgabe) {
    $('#chat-text').value = '';
    chat.anhang = null;
    passeHoeheAn();
  }
  const id = 'c' + ++chat.nr;
  chat.laeuft = id;
  chat.antwort = antwort;
  neueEingabe = true;
  window.api.chat({
    id, model, system: [(!fest && MODI[chat.modus].system) || cfg.chatSystem || '', chat.ziel ? `The user's goal for this conversation: ${chat.ziel}\nKeep your answers focused on this goal.` : ''].filter(Boolean).join('\n\n'),
    nachrichten: v.filter((n) => n !== antwort && !n.fehler && !n.lokal).map(fuerModell),
    medien: mitStudio, anhang, letztesMedium: vorher, erzwinge: vorgabe && vorgabe.erzwinge,
    letzteDatei: letzteDatei(), datei: !!(vorgabe && vorgabe.datei), gehirn: true,
    auto: istAuto, vorigeRolle: voriges && voriges.rolle, rolle: (vorgabe && vorgabe.rolle) || (chat.immerDenken ? 'denker' : undefined), bildFrage: istAuto ? bildImGespraech(v.slice(0, -2)) : null,
  });
  zeichneChat();
}

window.api.onChat((p) => {
  if (p.id !== chat.laeuft || !chat.antwort) return;
  const a = chat.antwort;
  if (p.text != null) a.content = p.text;
  if (p.denken != null) a.denken = p.denken;
  if (p.medien) a.medien = { ...(a.medien || {}), ...p.medien };
  if ('datei' in p) a.datei = p.datei ? { ...(a.datei || {}), ...p.datei } : null;
  if (p.rolle) a.rolle = p.rolle;
  if (p.bild) a.bild = p.bild;
  if (p.notizen) a.notizen = p.notizen;
  if (p.modell) { a.modell = p.modell; chat.autoModell = p.modell; zeichneLeiste(); }
  if (p.fertig) {
    a.laeuft = false;
    if (p.fehler && !(p.fehler === 'stopped' && a.content)) a.fehler = p.fehler === 'stopped' ? 'Stopped.' : p.fehler;
    chat.laeuft = null;
    chat.antwort = null;
    speichereChats();
    zeichneChat();
    return;
  }
  // waehrend des Streamens nur die letzte Nachricht ersetzen
  const box = $('#chat-verlauf');
  const unten = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (box.lastElementChild) box.replaceChild(nachrichtElem(a), box.lastElementChild);
  if (unten) box.scrollTop = box.scrollHeight;
});

// Fortschritt des Studio-Auftrags in die laufende Chat-Antwort
window.api.onStudio((p) => {
  const a = chat.antwort;
  if (!a || !a.medien || !a.medien.vorgang || p.vorgang !== a.medien.vorgang || p.fertig) return;
  if (p.prozent != null) a.medien.prozent = p.prozent;
  if (p.text) a.medien.status = p.text;
  const box = $('#chat-verlauf');
  if (ansicht === 'chat' && box.lastElementChild) box.replaceChild(nachrichtElem(a), box.lastElementChild);
});

function passeHoeheAn() {
  const t = $('#chat-text');
  t.style.height = 'auto';
  t.style.height = Math.min(220, t.scrollHeight) + 'px';
}
$('#chat-text').addEventListener('input', () => { passeHoeheAn(); befehlWahl = 0; zeigeBefehle(); });
$('#chat-text').addEventListener('blur', () => $('#chat-befehle').classList.add('versteckt'));
$('#chat-text').addEventListener('keydown', (e) => {
  const l = befehlTreffer();
  if (l.length && !$('#chat-befehle').classList.contains('versteckt')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); befehlWahl = (befehlWahl + (e.key === 'ArrowDown' ? 1 : l.length - 1)) % l.length; zeigeBefehle(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); nimmBefehl(l[befehlWahl] || l[0]); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('#chat-befehle').classList.add('versteckt'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendeChat(); }
});
$('#chat-los').addEventListener('click', () => sendeChat());
$('#chat-neu').addEventListener('click', () => {
  if (chat.laeuft) window.api.chatStopp(chat.laeuft);
  chat.verlaeufe[chat.modus] = [];
  chat.anhang = null;
  speichereChats();
  zeichneChat();
  $('#chat-text').focus();
});

// ---------------- Konten (Tab im Modellfenster) ----------------
const KONTEN = [
  { id: 'anthropic', name: 'Anthropic API', wo: 'Claude Code, OpenCode, Chat', link: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI API', wo: 'Codex, OpenCode, Chat', link: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', wo: 'OpenCode, Qwen Code, Chat – hundreds of models with one key', link: 'https://openrouter.ai/keys' },
  { id: 'gemini', name: 'Google Gemini', wo: 'OpenCode, Qwen Code, Chat', link: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', wo: 'OpenCode, Qwen Code, Chat', link: 'https://platform.deepseek.com/api_keys' },
  { id: 'groq', name: 'Groq', wo: 'OpenCode, Qwen Code, Chat – very fast', link: 'https://console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', wo: 'OpenCode, Qwen Code, Chat', link: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', name: 'xAI (Grok)', wo: 'OpenCode, Qwen Code, Chat', link: 'https://console.x.ai' },
  { id: 'higgsfield', name: 'Higgsfield', wo: 'Studio → Video: cloud video models (Seedance, Wan 3.0). Paste the whole key (id:secret)', link: 'https://open.higgsfield.ai/api-keys' },
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
