// Spracheingabe in Cowork: Mikrofon-Knopf neben "Send" (oder Strg+Shift+Leertaste).
// Aufnahme hier im Fenster (16 kHz mono WAV), Erkennung mit whisper.cpp in hoeren.js – alles bleibt auf diesem PC.
const hz = { st: null, aufnahme: null, schreibt: null, wartend: null };
const MIC_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const HZ_TEST = new URLSearchParams(location.search).has('test');
const SPRACH_WAHL = [['auto', 'Detect automatically'], ['de', 'German'], ['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish']];

// Wohin der Text geht
const DIKTAT_ZIELE = {
  chat: { art: 'feld', feld: () => $('#chat-text') },
};
function zielHier() { return ansicht === 'chat' ? 'chat' : null; }

function micKnopf(id, cls) {
  const b = elem('button', 'mic' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  b.dataset.ziel = id;
  b.innerHTML = MIC_SVG + '<i></i>';
  b.addEventListener('click', (e) => { e.preventDefault(); diktat(id); });
  micZeichnen(b);
  return b;
}
function micZeichnen(nur) {
  for (const b of nur ? [nur] : document.querySelectorAll('.mic[data-ziel]')) {
    const id = b.dataset.ziel;
    const nimmt = hz.aufnahme && hz.aufnahme.id === id;
    const schreibt = hz.schreibt && hz.schreibt.id === id;
    b.classList.toggle('nimmt', !!nimmt);
    b.classList.toggle('schreibt', !!schreibt);
    b.title = nimmt ? 'Listening… click again (or Ctrl+Shift+Space) to stop' : schreibt ? 'Turning speech into text…'
      : hz.st && hz.st.bereit ? 'Voice input – click and talk (Ctrl+Shift+Space)' : 'Voice input – set up once (runs on this PC)';
  }
}
window.api.onHoeren((s) => {
  hz.st = s;
  hoerenPopZeichnen();
  micZeichnen();
  if (typeof dlAktualisieren === 'function') dlAktualisieren();
  // fertig geladen, waehrend jemand diktieren wollte: Fenster zu, Bescheid geben
  if (s.bereit && !s.laedt && hz.wartend) { hoerenPopZu(); hinweis('Voice input is ready – click the microphone and talk'); }
});
window.api.hoerenStand().then((s) => { hz.st = s; micZeichnen(); });

async function diktat(id) {
  if (!id) id = zielHier();
  if (!id) return;
  if (hz.aufnahme) return aufnahmeStopp();
  if (hz.schreibt) return;
  if (!hz.st) hz.st = await window.api.hoerenStand();
  if (!hz.st.bereit) { hz.wartend = id; return hoerenPopAuf(); }
  aufnahmeStart(id);
}

// ---------- Aufnahme ----------
async function aufnahmeStart(id) {
  let strom = null;
  try {
    // Test: kein echtes Mikrofon – ein leiser Testton statt der Stimme
    if (!HZ_TEST) strom = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    return hinweis(/denied|not allowed/i.test(String(e && e.message)) ? 'No access to the microphone – allow it in Windows settings → Privacy → Microphone' : 'No microphone found');
  }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const quelle = strom ? ctx.createMediaStreamSource(strom) : (() => { const o = ctx.createOscillator(); o.frequency.value = 220; o.start(); const g = ctx.createGain(); g.gain.value = 0.2; o.connect(g); return g; })();
  await ctx.audioWorklet.addModule('aufnahme-worklet.js');
  const proz = new AudioWorkletNode(ctx, 'aufnahme');
  const a = { id, ziel: DIKTAT_ZIELE[id], ctx, strom, teile: [], laenge: 0, pegel: 0, start: Date.now() };
  proz.port.onmessage = (e) => {
    const d = e.data;
    if (hz.aufnahme !== a) return;
    a.teile.push(d);
    a.laenge += d.length;
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    a.pegel = Math.sqrt(s / d.length);
    for (const b of document.querySelectorAll('.mic.nimmt i')) b.style.transform = `scale(${1 + Math.min(1, a.pegel * 8)})`;
    if (a.laenge > ctx.sampleRate * 300) aufnahmeStopp(); // max. 5 Minuten
  };
  quelle.connect(proz);
  proz.connect(ctx.destination); // gibt nur Stille aus (wir kopieren nichts in den Ausgang)
  a.proz = proz;
  hz.aufnahme = a;
  micZeichnen();
  hinweis('Listening… click the microphone again to stop');
}
function wavAus(teile, laenge, rate) {
  const buf = new ArrayBuffer(44 + laenge * 2);
  const v = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + laenge * 2, true); txt(8, 'WAVE'); txt(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, 'data'); v.setUint32(40, laenge * 2, true);
  let o = 44;
  for (const t of teile) for (let i = 0; i < t.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, t[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}
async function aufnahmeStopp(verwerfen) {
  const a = hz.aufnahme;
  if (!a) return;
  hz.aufnahme = null;
  try { a.proz.disconnect(); } catch {}
  if (a.strom) for (const t of a.strom.getTracks()) t.stop();
  const rate = a.ctx.sampleRate;
  a.ctx.close().catch(() => {});
  if (verwerfen || a.laenge < rate * 0.4) { micZeichnen(); if (!verwerfen) hinweis('Too short – hold on a bit longer'); return; }
  hz.schreibt = a;
  micZeichnen();
  const r = await window.api.hoerenSchreiben(wavAus(a.teile, a.laenge, rate)).catch((e) => ({ fehler: String(e) }));
  hz.schreibt = null;
  micZeichnen();
  if (r.fehler) return hinweis(r.fehler);
  if (!r.text) return hinweis('Didn’t catch anything – try again a bit closer to the microphone');
  einfuegen(a, r.text);
  // Whisper auf dem Prozessor war langsam: einmal auf Parakeet hinweisen
  if (r.modell && r.modell !== 'parakeet' && r.dauer > 6 && !hz.tippGezeigt) {
    hz.tippGezeigt = true;
    setTimeout(() => hinweis('Tip: the new Parakeet model is much faster – Tools → Voice input → Change'), 2500);
  }
}
function einfuegen(a, text) {
  const f = a.ziel.feld();
  if (!f) { window.api.clipWrite(text); return hinweis('Copied: ' + text.slice(0, 60)); }
  const s = f.selectionStart ?? f.value.length, e = f.selectionEnd ?? f.value.length;
  const vor = f.value.slice(0, s);
  const teil = (vor && !/\s$/.test(vor) ? ' ' : '') + text;
  f.value = vor + teil + f.value.slice(e);
  f.selectionStart = f.selectionEnd = s + teil.length;
  f.dispatchEvent(new Event('input', { bubbles: true }));
  f.focus();
}

// Strg+Shift+Leertaste in Cowork (Esc bricht ab)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.code === 'Space' || e.key === ' ') && (ansicht === 'chat' || hz.aufnahme)) { e.preventDefault(); e.stopPropagation(); diktat(hz.aufnahme ? hz.aufnahme.id : null); }
  else if (e.key === 'Escape' && hz.aufnahme) { aufnahmeStopp(true); hinweis('Recording cancelled'); }
}, true);

// ---------- Einrichten (einmal) ----------
function hoerenPopAuf() {
  $('#hoeren-pop').classList.remove('versteckt');
  hoerenPopZeichnen();
}
function hoerenPopZu() { $('#hoeren-pop').classList.add('versteckt'); hz.wartend = null; }
function hoerenPopZeichnen() {
  const box = $('#hoeren-pop');
  if (!box || box.classList.contains('versteckt') || !hz.st) return;
  const s = hz.st;
  box.replaceChildren();
  const kopf = elem('div', 'hp-kopf');
  kopf.appendChild(elem('b', null, 'Voice input'));
  const zu = elem('button', 'hp-zu', '✕');
  zu.title = 'Close';
  zu.addEventListener('click', hoerenPopZu);
  kopf.appendChild(zu);
  box.appendChild(kopf);
  box.appendChild(elem('p', null, 'Talk to Cowork instead of typing. Speech recognition runs on this PC; nothing you say leaves your computer. Download once:'));
  const karten = elem('div', 'hp-karten');
  const INFO = {
    parakeet: 'Fastest and very accurate · finds the language by itself · 25 European languages (German, English, French, …)',
    beste: 'Every language, but slower on the processor',
    schnell: 'Quick and small, less accurate',
  };
  for (const [id, m] of Object.entries(s.modelle)) {
    const k = elem('button', 'hp-karte' + (s.modell === id && s.bereit ? ' an' : ''));
    k.dataset.id = id;
    k.append(elem('b', null, m.name + (id === 'parakeet' ? ' · recommended' : '')), elem('span', null, INFO[id] + ' · ' + Math.round(m.groesse / 1e6) + ' MB'));
    if (s.modell === id && s.bereit) k.appendChild(elem('em', null, 'installed'));
    k.disabled = !!s.laedt;
    k.addEventListener('click', () => { if (!(s.modell === id && s.bereit)) window.api.hoerenHolen(id); });
    karten.appendChild(k);
  }
  box.appendChild(karten);
  if (s.laedt) {
    const p = s.laedt.gesamt ? (s.laedt.geladen / s.laedt.gesamt) * 100 : 0;
    const z = elem('div', 'hp-lauf');
    const b = elem('div', 'dl-balken');
    const i = elem('i');
    i.style.width = Math.max(1, Math.min(100, p)) + '%';
    b.appendChild(i);
    const ab = elem('button', 'anp-knopf', 'Cancel');
    ab.addEventListener('click', () => window.api.hoerenAbbrechen());
    z.append(elem('span', null, `Downloading… ${Math.floor(p)}% · ${Math.round(s.laedt.geladen / 1e6)} / ${Math.round(s.laedt.gesamt / 1e6)} MB`), b, ab);
    box.appendChild(z);
  }
  if (s.fehler) box.appendChild(elem('p', 'hp-fehler', s.fehler));
  const fuss = elem('div', 'hp-fuss');
  const sp = elem('select');
  for (const [id, n] of SPRACH_WAHL) { const o = elem('option', null, n); o.value = id; sp.appendChild(o); }
  sp.value = s.sprache;
  sp.addEventListener('change', async () => { hz.st = await window.api.hoerenSprache(sp.value); });
  const l = elem('label');
  l.append(elem('span', null, 'Language'), sp);
  // Parakeet erkennt die Sprache selbst – die Auswahl gilt nur fuer Whisper
  if (s.modell === 'parakeet' && s.bereit) fuss.appendChild(elem('span', 'hp-leise', 'Language is detected automatically'));
  else fuss.appendChild(l);
  if (s.bereit && !s.laedt) {
    const weg = elem('button', 'anp-knopf', 'Remove');
    weg.title = 'Delete the speech model from this PC';
    weg.addEventListener('click', async () => { hz.st = await window.api.hoerenEntfernen(); hoerenPopZeichnen(); hinweis('Voice input removed'); });
    fuss.appendChild(weg);
  }
  box.appendChild(fuss);
}

// Zeile im Tool-Menue (Start & list)
function hoerenMenueZeile(box) {
  const s = hz.st;
  const z = elem('div', 'anp-zeile anp-update');
  const m = s && s.bereit ? s.modelle[s.modell] : null;
  const sprache = s && s.modell === 'parakeet' ? 'any language' : (SPRACH_WAHL.find((x) => x[0] === (s && s.sprache)) || SPRACH_WAHL[0])[1];
  z.appendChild(elem('span', null, 'Voice input' + (m ? ' · ' + m.name + ' · ' + sprache : ' · not set up')));
  const k = elem('button', 'anp-knopf', m ? 'Change' : 'Set up');
  k.addEventListener('click', () => { schliesseMenues(); hoerenPopAuf(); });
  z.appendChild(k);
  box.appendChild(z);
}

// Eintrag im Downloads-Tab
function hoerenDownloads() {
  const s = hz.st;
  if (!s || !s.laedt) return [];
  const p = s.laedt.gesamt ? (s.laedt.geladen / s.laedt.gesamt) * 100 : 0;
  return [{
    key: 'h:' + s.laedt.modell, gruppe: 'Voice input', titel: 'Whisper · ' + s.modelle[s.laedt.modell].name, ziel: 'this PC',
    prozent: p, text: `${Math.floor(p)}% · ${Math.round(s.laedt.geladen / 1e6)} / ${Math.round(s.laedt.gesamt / 1e6)} MB`,
    abbrechen: () => window.api.hoerenAbbrechen(),
  }];
}

// Knopf in der Cowork-Eingabe, links neben "Send"
{
  const b = micKnopf('chat');
  b.id = 'chat-mic';
  $('#chat-los').before(b);
}
