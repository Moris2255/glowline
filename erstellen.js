'use strict';
const fs = require('fs');
// "Erstelle mir ein Bild von einem Baum" im Chat: erkennen, Prompt verbessern, im Studio erzeugen.
// Ablauf: Stichwort-Vorfilter -> Chatmodell sortiert mit einem Wort -> Chatmodell schreibt den Prompt -> Studio-Auftrag.

// nur bei solchen Woertern wird ueberhaupt nachgefragt, normale Chats bleiben so schnell wie vorher
const WORTE = /(bild|foto|photo|image|picture|\bpic\b|zeichn|\bdraw|paint|\bmal |\bmale |malen|illustration|wallpaper|logo|poster|\bicon|video|\bclip|animier|animat|beweg|\bmove|lebendig|to life|\bfilm|stimme|voice|vorles|\blies |\bread\b|sprich|\bsag |\bspeak|\bsay |speech|\btts\b|audio|upscal|hochskal|skalier|vergr[öo]ß|sch[äa]rfer|sharper|enlarge)/i;

const SORTIEREN = `Classify the user's LAST message. Answer with exactly one word: image, video, voice, upscale or chat.
image = they want you to create a picture, photo, drawing, logo or wallpaper, or change the image you just created
video = they want you to create a video, clip or animation, or animate an image
voice = they want words spoken out loud or read aloud
upscale = they want an existing image or video made bigger or sharper
chat = everything else: questions, explanations, advice, ideas, thanks, also questions ABOUT images or videos

Examples:
"Erstelle mir ein Bild von einem Baum" -> image
"zeichne einen Drachen" -> image
"Was ist ein gutes Bildformat für Instagram?" -> chat
"Wie schreibe ich gute Video-Prompts?" -> chat
"Lies vor: Hallo zusammen" -> voice
"make a short clip of waves at night" -> video
"animiere das" -> video
"bring das Bild zum Leben" -> video
"mach das Bild schärfer" -> upscale
"(You just created a video.) mach das Video schärfer" -> upscale
"erklär mir Photosynthese" -> chat
"(You just created an image.) mach den Himmel lila" -> image
"(You just created an image.) danke, sieht super aus" -> chat
"(You just created an image.) lass es sich bewegen" -> video`;

// Film aus mehreren Szenen ("erstelle einen 60 Sekunden Film über …"): erst Stichwort, dann Ja/Nein-Frage ans Chatmodell
const FILM_WORT = /\b(film|filmchen|movie|kurzfilm|short ?film|trailer)\b|\b\d{2,3}\s*-?\s*(s|sek\.?|sekunden|seconds?|secs?)\b[^.?!\n]{0,60}\b(video|clip)|\b(video|clip)\b[^.?!\n]{0,60}\b\d{2,3}\s*-?\s*(s|sek\.?|sekunden|seconds?|secs?)\b|\b(\d|eine|one|zwei|two)\s*-?\s*min(ute|uten|utes|\.)?\b[^.?!\n]{0,60}\b(video|clip)/i;
const FILM_FRAGE = `Does the user want you to CREATE a new short film right now – a little story with several scenes, longer than 10 seconds? Answer with exactly one word: yes or no.
Examples:
"erstelle einen 60 Sekunden Film über einen Hamster im Weltall" -> yes
"mach mir einen kurzen Film über Dinosaurier" -> yes
"make a 30 second video about the ocean with a narrator" -> yes
"kannst du einen Trailer für mein Spiel machen? Es geht um Roboter" -> yes
"was ist dein Lieblingsfilm?" -> no
"write a review of the movie Inception" -> no
"wie macht man einen guten Kurzfilm?" -> no
"make a short clip of waves at night" -> no
"empfiehl mir einen Film für heute Abend" -> no`;
// gewuenschte Laenge: 30, 60 oder 90 s (das Naechstliegende)
function filmLaenge(t) {
  let s = 0;
  const sek = /\b(\d{2,3})\s*-?\s*(s|sek\.?|sekunden|seconds?|secs?)\b/i.exec(t);
  const min = /\b(\d(?:[.,]5)?|eine|one|zwei|two|anderthalb)\s*-?\s*min/i.exec(t);
  if (sek) s = +sek[1];
  else if (min) s = { eine: 1, one: 1, zwei: 2, two: 2, anderthalb: 1.5 }[min[1].toLowerCase()] * 60 || parseFloat(min[1].replace(',', '.')) * 60;
  if (!s) return /\b(kurz|short|klein|mini)/i.test(t) ? 30 : 60;
  return [30, 60, 90].reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
}

// Folgewunsch ohne Stichwort ("mach den Himmel lila"): Ja/Nein-Frage + feste Regel gegen Fragen, Witze usw.
const FOLGE = (was) => `The assistant just created ${was} for the user. Does the user's message ask for a new or changed version of it? Answer with exactly one word: yes or no.
Examples:
"mach den Himmel lila" -> yes
"make it more colorful" -> yes
"jetzt mit einem Hund daneben" -> yes
"nochmal, aber bei Nacht" -> yes
"danke, sieht super aus" -> no
"wie hast du das gemacht?" -> no
"what is the capital of France?" -> no
"schreib mir ein Gedicht" -> no
"tell me a fun fact" -> no`;
const NICHT_FOLGE = /^(was|wie|warum|wieso|weshalb|wer|wo|wann|welche\w*|what|how|why|who|where|when|which)\b|witz|joke|gedicht|poem|geschichte|story|hausaufgab|homework|erkl[äa]r|explain|erz[äa]hl|tell me|[üu]bersetz|translate|rechne|calculate|danke|thanks|thank you|code|programm/i;
const WAS = { image: 'an image', upscale: 'an image', video: 'a video', voice: 'a voice recording' };

const SCHREIBEN = {
  image: `You write prompts for an image generator. Turn the user's request into ONE English prompt of 40-80 words in natural sentences: subject, details, composition, setting, lighting, style (photo, illustration, 3D render …).
Only if the user asks for words or letters in the image, put exactly that text in "quotes" – otherwise use no quotation marks at all. If the user changes an image you created before, describe the complete new image.
Always write the prompt in English, even if the user writes in another language. Answer with the prompt only: no intro, no title, no quotes around it.`,
  video: `You write prompts for a video generator that makes ONE shot of about 5 seconds. Turn the user's request into ONE English prompt of 50-100 words, present tense:
subject and look, one clear action, camera (shot size, movement), setting, lighting, mood. No sound, no on-screen text.
Always write the prompt in English, even if the user writes in another language. Answer with the prompt only: no intro, no title, no quotes around it.`,
  voice: `You prepare text for a text-to-speech voice. Write exactly the words that should be spoken, in the language the user wants (otherwise the language they write in).
If the user gives the text, use it word for word. Otherwise write it yourself, short and natural. Speakable sentences, numbers as words, no emojis, no markdown, no stage directions.
Answer with the words to speak only.`,
};

const STUDIO_ART = { image: 'bild', video: 'video', upscale: 'upscale', voice: 'stimme' };
const BEREICH = { image: 'Images', video: 'Video', upscale: 'Upscale', voice: 'Voice' };
const FORMAT = {
  image: { quadrat: [1024, 1024], quer: [1344, 768], hoch: [768, 1344] },
  video: { quadrat: [960, 960], quer: [1280, 704], hoch: [704, 1280] },
};

const deutsch = (t) => /[äöüß]|\b(der|die|das|und|ist|nicht|ich|du|mir|mich|ein|eine|einen|mach|bitte|erstelle|zeichne|von|mit|lies|sag)\b/i.test(t);
function formatAus(t, art) {
  if (/tiktok|reel|story|stories|shorts|hochkant|hochformat|portrait|vertical|vertikal|handy|phone|9:16/i.test(t)) return 'hoch';
  if (/youtube|desktop|wallpaper|hintergrundbild|querformat|landscape|breitbild|cinematic|kino|16:9|banner/i.test(t)) return 'quer';
  if (/quadrat|square|1:1|profilbild|avatar|logo|icon/i.test(t)) return 'quadrat';
  return art === 'video' ? 'quer' : 'quadrat';
}
const FORMAT_WORT = /tiktok|reel|story|stories|shorts|hochkant|hochformat|portrait|vertical|vertikal|handy|phone|9:16|youtube|desktop|wallpaper|hintergrundbild|querformat|landscape|breitbild|cinematic|kino|16:9|banner|quadrat|square|1:1/i;
// Seitenverhaeltnis eines PNG (Video aus einem Bild soll dessen Format behalten)
function bildFormat(f) {
  try {
    const b = Buffer.alloc(24);
    const fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, b, 0, 24, 0); } finally { fs.closeSync(fd); }
    if (b.toString('ascii', 1, 4) !== 'PNG') return null;
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    return w > h * 1.2 ? 'quer' : h > w * 1.2 ? 'hoch' : 'quadrat';
  } catch { return null; }
}
function spracheAus(wunsch, text) {
  const s = [['en', /englisch|english/i], ['fr', /franz[öo]sisch|french/i], ['es', /spanisch|spanish/i], ['it', /italienisch|italian/i], ['nl', /niederl[äa]ndisch|holl[äa]ndisch|dutch/i],
    ['pl', /polnisch|polish/i], ['pt', /portugiesisch|portuguese/i], ['tr', /t[üu]rkisch|turkish/i], ['ru', /russisch|russian/i], ['ja', /japanisch|japanese/i], ['zh', /chinesisch|chinese/i], ['de', /deutsch|german/i]]
    .find(([, re]) => re.test(wunsch));
  if (s) return s[0];
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  return deutsch(text) ? 'de' : 'en';
}
// Modelle schreiben gern "Prompt:" davor, Anfuehrungszeichen oder Codebloecke drumherum
function saeubere(t) {
  return String(t || '').replace(/\*\*/g, '').replace(/^\s*(?:[^\n]{0,80}:[ \t]*\n+)+/, '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[^\n]*\n?/g, '').replace(/^\s*\[created [^:\]]*:\s*/i, '').replace(/\]\s*$/, '').replace(/^\s*\**(prompt|text|script)\**\s*:\s*/i, '').trim().replace(/^["“„']([\s\S]*)["”']$/, '$1').trim();
}

// kleine Modelle lehnen manchmal ab ("I can't create images") statt einen Prompt zu schreiben
const ABLEHNUNG = /\b(I'?m (not able|unable)|I am (not able|unable)|I can(no|')t|as an AI|ich kann (leider )?(keine|nicht)|als (eine )?KI|is (German|Spanish|French|Italian) for|I'?ll (incorporate|add|include)|translates? (to|as))\b/i;

let d;
function init(deps) { d = deps; }

// Welches Studio-Modell Cowork nimmt: das eingestellte Standardmodell (Models → Cowork), wenn es bereit ist –
// auch ein Cloud-Modell, aber nur wenn es ausdruecklich gewaehlt wurde. Sonst automatisch ein lokales.
function studioModellFuer(st, sart) {
  const alle = Object.values(st.modelle || {}).filter((m) => m.art === sart);
  const std = ((d.cfg().studioStandard || {})[sart]) || '';
  const gewaehlt = alle.find((m) => m.id === std && m.da);
  if (gewaehlt) return gewaehlt;
  const bereit = alle.filter((m) => m.da && !m.wolke);
  // Bild: Z-Image zuerst (das installiert Express), sonst das erste geladene
  return (sart === 'bild' && bereit.find((m) => m.id === 'z-image')) || bereit[0];
}

// eine kurze Antwort ohne Streaming; Ollama direkt (ohne "Denken"), sonst ueber den Proxy
async function frage(modellId, system, msgs, max, signal) {
  const { backend, model } = d.teileModell(String(modellId || ''));
  const b = backend || 'ollama';
  const w = d.konten.WOLKEN[b];
  let text;
  if (b === 'ollama') {
    const body = { model, stream: false, think: false, options: { temperature: 0.2, num_predict: max }, messages: [{ role: 'system', content: system }, ...msgs] };
    const schicke = () => fetch(d.cfg().backends.ollama + '/api/chat', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let r = await schicke();
    if (r.status === 400) { delete body.think; r = await schicke(); } // Modell kann kein "Denken"
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(j.error || 'HTTP ' + r.status).slice(0, 300));
    text = j.message && j.message.content;
  } else {
    const anthropic = w && w.format === 'anthropic';
    // denkende Cloud-Modelle brauchen Platz fuers Denken, sonst bleibt die Antwort leer
    const platz = Math.max(max, 1500);
    const body = anthropic
      ? { model, max_tokens: platz, system, messages: msgs }
      : { model, max_tokens: platz, temperature: 0.2, messages: [{ role: 'system', content: system }, ...msgs] };
    const r = await fetch(`http://127.0.0.1:${d.cfg().port}/s/chat/${b}` + (anthropic ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer glowline', 'x-api-key': 'glowline', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String((j.error && (j.error.message || j.error)) || j.message || 'HTTP ' + r.status).slice(0, 300));
    text = anthropic ? (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') : j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  }
  return String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

// true = als Studio-Auftrag erledigt, false = normal weiterchatten
async function versuche(o) {
  const { modell, nachrichten, ac, melde } = o;
  const letzte = nachrichten[nachrichten.length - 1];
  if (!letzte || letzte.role !== 'user') return false;
  const wunsch = String(letzte.content);
  const vorher = o.letztesMedium || null; // { art, prompt } der letzten Studio-Antwort im Chat
  let art = o.erzwinge && STUDIO_ART[o.erzwinge.art] ? o.erzwinge.art : null;
  if (!art && !o.erzwinge && d.film && FILM_WORT.test(wunsch)) {
    const a = await frage(modell, FILM_FRAGE, [{ role: 'user', content: wunsch }], 4, ac.signal).catch(() => '');
    if (/^\W*yes\b/i.test(a)) return filmPlanen(o, wunsch);
  }
  if (!art && WORTE.test(wunsch)) {
    const frageText = vorher ? `(You just created ${WAS[vorher.art] || 'an image'}.) ${wunsch}` : wunsch;
    const a = await frage(modell, SORTIEREN, [{ role: 'user', content: frageText }], 8, ac.signal).catch(() => '');
    const m = /\b(image|video|voice|upscale)\b/.exec(a.toLowerCase());
    if (!m) return false;
    art = m[1];
  } else if (!art && vorher && WAS[vorher.art] && !NICHT_FOLGE.test(wunsch.trim())) {
    const a = await frage(modell, FOLGE(WAS[vorher.art]), [{ role: 'user', content: wunsch }], 4, ac.signal).catch(() => '');
    if (!/^\W*yes\b/i.test(a)) return false;
    art = vorher.art === 'upscale' ? 'image' : vorher.art;
  }
  if (!art) return false;
  const de = deutsch(wunsch);
  const st = d.studio.status();
  const sart = STUDIO_ART[art];
  const km = studioModellFuer(st, sart);
  const fehlt = (text) => { melde({ fertig: true, text, medien: { art, fehlt: sart } }); return true; };
  if (!st.eingerichtet && !(km && km.wolke)) return fehlt(de ? 'Dafür muss das Studio einmal eingerichtet werden (ca. 5 GB). Öffne Studio und klicke auf „Set up“.' : 'The Studio needs a one-time setup for this (about 5 GB). Open Studio and click “Set up”.');
  if (!km) return fehlt(de ? `Das Modell dafür ist noch nicht geladen – hol es dir unter Studio → ${BEREICH[art]}.` : `The model for this isn't downloaded yet – get it in Studio → ${BEREICH[art]}.`);

  // Quellbild: angehaengtes Bild, sonst (wenn gemeint) das zuletzt erzeugte
  const erlaubt = (f) => f && d.erlaubt(f);
  let quelle = erlaubt(o.anhang) ? o.anhang : null;
  if (!quelle && o.erzwinge && erlaubt(o.erzwinge.quelle)) quelle = o.erzwinge.quelle;
  const meintLetztes = art === 'upscale' || /animier|animat|beweg|\bmove|lebendig|to life|daraus|davon|from (it|this|that)|this (image|picture|photo)|(das|dieses|dem) (bild|foto)|the (image|picture|photo)|\b(es|it)\b.*(beweg|move|animat|animier)/i.test(wunsch);
  if (!quelle && meintLetztes && vorher && vorher.bild && erlaubt(vorher.bild)) quelle = vorher.bild;
  if (!quelle && art === 'upscale' && vorher && vorher.video && erlaubt(vorher.video)) quelle = vorher.video; // "mach das Video schärfer"
  if (art === 'upscale' && !quelle) return fehlt(de ? 'Schick mir zuerst ein Bild: zieh es in den Chat oder klick auf 📎.' : 'Send me an image first: drop it into the chat or click 📎.');

  // Prompt verbessern (Upscale braucht keinen)
  let prompt = o.erzwinge && o.erzwinge.prompt ? String(o.erzwinge.prompt) : '';
  if (!prompt && art !== 'upscale') {
    melde({ medien: { art, status: de ? 'Prompt wird verbessert…' : 'Improving the prompt…' } });
    let system = SCHREIBEN[art];
    const bildInhalt = (o.erzwinge && o.erzwinge.quelle === quelle && o.erzwinge.bildPrompt) || (vorher && vorher.bild === quelle && vorher.prompt) || '';
    if (art === 'video' && quelle) system += `\nThe video starts from an existing image${bildInhalt ? ` that shows: ${bildInhalt}` : ''}. Describe that scene and the motion that happens in it.`;
    const frueher = vorher && vorher.prompt && (vorher.art === art || (art === 'image' && vorher.art === 'upscale')) ? vorher.prompt : '';
    const eingabe = frueher
      ? `Current ${art === 'voice' ? 'text' : art + ' prompt'}:\n${frueher}\n\nThe user wants this change: ${wunsch}\n\nWrite the complete new ${art === 'voice' ? 'text' : 'prompt'} with the change applied.`
      : `Request: ${wunsch}`;
    prompt = saeubere(await frage(modell, system, [{ role: 'user', content: eingabe }], art === 'voice' ? 700 : 300, ac.signal).catch((e) => { if (ac.signal.aborted) throw e; return ''; }));
    // nichts Brauchbares: dann eben der Wunsch selbst (beim Animieren: das Bild + sanfte Bewegung)
    if (!prompt || ABLEHNUNG.test(prompt)) prompt = art === 'video' && quelle && bildInhalt ? bildInhalt + ' Gentle natural motion, slow camera push-in.' : frueher ? frueher + ' ' + wunsch : wunsch;
  }
  if (ac.signal.aborted) throw new Error('stopped');

  const id = 'chat' + Date.now();
  const vorgang = 'auftrag:' + id;
  const a = { id, modell: km.id, vonChat: true };
  const fmt = FORMAT[art] && FORMAT[art][(art === 'video' && quelle && !FORMAT_WORT.test(wunsch) && bildFormat(quelle)) || formatAus(wunsch, art)];
  if (art === 'image') Object.assign(a, { prompt, breite: fmt[0], hoehe: fmt[1] });
  if (art === 'video') Object.assign(a, { prompt, sekunden: 5, breite: fmt[0], hoehe: fmt[1], bildDatei: quelle || undefined });
  if (art === 'upscale') Object.assign(a, { bildDatei: quelle });
  if (art === 'voice') Object.assign(a, { prompt, sprache: spracheAus(wunsch, prompt) });
  const info = { art, vorgang, prompt, modell: km.name, quelle: quelle || null, status: de ? 'Wartet…' : 'Waiting…' };
  melde({ medien: info });
  const stopp = () => d.studio.abbrechen(vorgang);
  ac.signal.addEventListener('abort', stopp, { once: true });
  const r = await d.studio.auftrag(a, d.vramFrei);
  ac.signal.removeEventListener('abort', stopp);
  if (r.fehler) {
    melde({ fertig: true, fehler: r.fehler === 'cancelled' ? 'stopped' : r.fehler, medien: { ...info, status: null } });
    return true;
  }
  const fertigText = de
    ? { image: 'Hier ist dein Bild.', video: 'Hier ist dein Video.', upscale: 'Hier ist dein Bild in 4× Größe.', voice: 'Hier ist die Sprachausgabe.' }
    : { image: 'Here is your image.', video: 'Here is your video.', upscale: 'Here is your image at 4× size.', voice: 'Here is the voice recording.' };
  if (art === 'upscale' && /\.(mp4|webm|mov)$/i.test(String(quelle))) fertigText.upscale = de ? 'Hier ist dein schärferes Video.' : 'Here is your sharper video.';
  melde({ fertig: true, text: fertigText[art], medien: { ...info, status: null, dateien: r.dateien || [] } });
  return true;
}

// Cowork schreibt nur das Drehbuch – ansehen, aendern und rechnen lassen geht unter Studio → Film
async function filmPlanen(o, wunsch) {
  const de = deutsch(wunsch);
  const laenge = filmLaenge(wunsch);
  o.melde({ medien: { art: 'film', status: de ? 'Drehbuch wird geschrieben…' : 'Writing the script…' } });
  try {
    const f = await d.film.planen({ thema: wunsch, laenge, format: formatAus(wunsch, 'video') === 'hoch' ? 'hoch' : 'quer', sprache: spracheAus(wunsch, wunsch), modell: o.modell, signal: o.ac.signal });
    const zeilen = f.szenen.map((s, i) => `${i + 1}. ${s.text || '…'}`).join('\n');
    o.melde({
      fertig: true,
      text: de
        ? `„${f.titel}“ – Drehbuch mit ${f.szenen.length} Szenen (${laenge} s):\n\n${zeilen}\n\nUnter Studio → Film kannst du alles ändern und den Film machen lassen – am besten über Nacht, das dauert eine Weile.`
        : `“${f.titel}” – a script with ${f.szenen.length} scenes (${laenge} s):\n\n${zeilen}\n\nIn Studio → Film you can change anything and let the Studio make the film – best overnight, it takes a while.`,
      medien: { art: 'film', film: f.id },
    });
  } catch (e) {
    if (o.ac.signal.aborted) throw new Error('stopped');
    o.melde({ fertig: true, text: (de ? 'Das Drehbuch hat nicht geklappt: ' : 'Writing the script failed: ') + e.message });
  }
  return true;
}

module.exports = { filmLaenge, FILM_WORT, studioModellFuer, init, versuche, frage, deutsch, WORTE };
