// Einrichtungs-Assistent: Express (Glowline waehlt passend zum PC und installiert alles) oder selbst einrichten
const ein = { seite: 'start', sys: null, wahl: { stufe: null, frei: false, teile: {}, werkzeuge: {} }, plan: null, alle: null, stand: null, sicherBis: 0, nr: 0 };
const TEIL_REIHE = ['coder', 'denker', 'helfer', 'bild', 'video', 'stimme', 'upscale'];
const gbText = (x) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + ' GB';

async function zeigeEinrichtung() {
  schliesseMenues();
  if (typeof schliesseBib === 'function') schliesseBib();
  $('#einrichtung').classList.remove('versteckt');
  ein.stand = await window.api.einrichtungStand();
  // laeuft noch (oder lief eben)? Dann gleich den Fortschritt zeigen
  if (ein.stand && (!ein.stand.fertig || ein.seite === 'lauf')) { ein.seite = 'lauf'; zeichneEinrichtung(); return; }
  ein.seite = 'start';
  ein.sys = null;
  zeichneEinrichtung();
  ein.sys = await window.api.einrichtungSystem().catch(() => null);
  if (ein.sys && !ein.wahl.stufe) ein.wahl.stufe = ein.sys.empfohlen;
  zeichneEinrichtung();
  if (ein.sys) await neuerPlan();
}
window.zeigeEinrichtung = zeigeEinrichtung;

function schliesseEinrichtung() {
  $('#einrichtung').classList.add('versteckt');
  // wer den Assistenten wegklickt, bekommt ihn beim naechsten Start nicht wieder (Models → Express setup holt ihn zurueck)
  if (!cfg.einrichtung) { cfg.einrichtung = 'selbst'; window.api.setConfig({ einrichtung: 'selbst' }); }
  fokus();
}
$('#ein-zu').addEventListener('click', schliesseEinrichtung);

function zeichneEinrichtung() {
  const box = $('#ein-inhalt');
  box.replaceChildren();
  $('#ein-titel').textContent = ein.seite === 'start' ? 'Welcome to Glowline' : ein.seite === 'express' ? 'Express setup' : 'Installing';
  if (ein.seite === 'start') return seiteStart(box);
  if (ein.seite === 'express') return seiteExpress(box);
  return seiteLauf(box);
}

function systemZeile() {
  const z = elem('div', 'ein-system');
  const s = ein.sys;
  if (!s) { z.appendChild(elem('span', 'ein-chip', 'Checking your PC…')); return z; }
  z.appendChild(elem('span', 'ein-chip', s.gpu ? `${s.gpu.name} · ${s.gpu.vram} GB` : 'No NVIDIA graphics card'));
  z.appendChild(elem('span', 'ein-chip', `${Math.round(s.ram)} GB RAM`));
  z.appendChild(elem('span', 'ein-chip' + (s.ollama.installiert ? '' : ' aus'), s.ollama.installiert ? 'Ollama installed' : 'Ollama not installed yet'));
  return z;
}

// kurze Zusammenfassung des Plans fuer die grosse Karte
function planText(p) {
  const neu = p.schritte.filter((x) => !x.da);
  if (!neu.length) return 'Everything is already installed.';
  const teile = [];
  const tools = neu.filter((x) => x.art === 'werkzeug').map((x) => x.titel);
  if (tools.length) teile.push(tools.join(', '));
  const modelle = neu.filter((x) => x.art === 'sprache').length;
  if (modelle) teile.push(modelle + ' AI model' + (modelle > 1 ? 's' : '') + ' for chat and code');
  if (neu.some((x) => x.art === 'studio' || x.art === 'motor')) teile.push('Studio for images, video and voice');
  return teile.join(' · ') + ' — about ' + gbText(p.gesamt) + ' to download';
}

function seiteStart(box) {
  box.appendChild(elem('p', 'ein-text', 'Glowline runs AI on your own PC – private and free. One click installs everything you need, including Claude Code, Codex and OpenCode. You can keep using Glowline while it downloads.'));
  box.appendChild(systemZeile());
  const p = ein.plan;
  const alles = elem('button', 'ein-karte empfohlen ein-gross');
  alles.id = 'ein-alles';
  alles.append(elem('em', null, 'Recommended'), elem('b', null, 'Install everything'),
    elem('span', null, !p ? 'Checking your PC…' : p.zuWenig.length ? `Not enough free space on ${p.zuWenig.join(', ')} – choose less under “Choose what to install”` : planText(p)));
  alles.disabled = !p || !!p.zuWenig.length || !p.schritte.some((x) => !x.da);
  alles.addEventListener('click', () => installieren(alles));
  box.appendChild(alles);
  const wahl = elem('div', 'ein-wahl');
  const karte = (titel, text, klick) => {
    const k = elem('button', 'ein-karte');
    k.append(elem('b', null, titel), elem('span', null, text));
    k.addEventListener('click', klick);
    wahl.appendChild(k);
    return k;
  };
  karte('Choose what to install', 'Pick the coding tools, the model size and which Studio parts you want.', () => { ein.seite = 'express'; zeichneEinrichtung(); }).disabled = !p;
  karte('Skip for now', 'Set things up yourself later under Models → Express setup.', schliesseEinrichtung);
  box.appendChild(wahl);
}

async function installieren(knopf) {
  knopf.disabled = true;
  try {
    ein.stand = await window.api.einrichtungStart(ein.wahl);
    ein.seite = 'lauf';
    zeichneEinrichtung();
  } catch (e) { hinweis(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); knopf.disabled = false; }
}

// Plan fuer die aktuelle Wahl + einmal "alles an" (fuer Groessen und Infos der abgewaehlten Zeilen)
async function neuerPlan() {
  const nr = ++ein.nr;
  const alleAn = { ...ein.wahl, teile: {} };
  const [plan, alle] = await Promise.all([window.api.einrichtungPlan(ein.wahl), window.api.einrichtungPlan(alleAn)]);
  if (nr !== ein.nr) return; // inzwischen schon wieder geklickt
  ein.plan = plan;
  ein.alle = alle;
  if (ein.seite === 'express' || ein.seite === 'start') zeichneEinrichtung();
}

function seiteExpress(box) {
  if (!ein.plan || !ein.sys) { box.appendChild(elem('p', 'ein-text', 'Checking your PC…')); return; }
  const s = ein.sys;
  box.appendChild(systemZeile());

  box.appendChild(elem('div', 'ein-schritt', 'Coding tools'));
  const tools = elem('div', 'ein-liste');
  for (const [t, w] of Object.entries(s.werkzeuge || {})) {
    const an = ein.wahl.werkzeuge[t] !== false;
    tools.appendChild(zeile({ titel: w.name, info: w.info, gb: 0.2, da: w.da }, 'w:' + t, an || w.da, (v) => { ein.wahl.werkzeuge[t] = v; }));
  }
  box.appendChild(tools);

  box.appendChild(elem('div', 'ein-schritt', 'AI model size'));
  const stufen = elem('div', 'ein-stufen');
  for (const [id, st] of Object.entries(s.stufen)) {
    const k = elem('button', 'ein-stufe' + (ein.wahl.stufe === id ? ' an' : ''));
    k.dataset.stufe = id;
    if (id === s.empfohlen) k.appendChild(elem('em', null, 'Best for your PC'));
    k.append(elem('b', null, st.name), elem('span', null, st.info));
    k.addEventListener('click', () => { ein.wahl.stufe = id; neuerPlan(); });
    stufen.appendChild(k);
  }
  box.appendChild(stufen);
  const frei = elem('label', 's-erlaubt ein-frei');
  const fx = elem('input'); fx.type = 'checkbox'; fx.checked = !!ein.wahl.frei;
  fx.addEventListener('change', () => { ein.wahl.frei = fx.checked; neuerPlan(); });
  frei.append(fx, elem('span', null, 'Uncensored language models (“abliterated”): the refusal filter is removed, so they answer everything. You are responsible for what you do with the answers.'));
  box.appendChild(frei);

  box.appendChild(elem('div', 'ein-schritt', 'What gets installed'));
  const liste = elem('div', 'ein-liste');
  const alleSchritte = ein.alle.schritte;
  const imPlan = (pred) => ein.plan.schritte.find(pred);
  for (const t of TEIL_REIHE) {
    // feste Bausteine (ohne Haken) vor ihrer Gruppe: Ollama vor den Sprachmodellen, der Motor vor dem Studio
    const fest = ein.plan.schritte.find((x) => (t === 'coder' && x.art === 'ollama') || (t === 'bild' && x.art === 'motor'));
    if (fest) liste.appendChild(zeile(fest, null));
    const sch = alleSchritte.find((x) => x.rolle === t || x.teil === t) || { titel: (s.rollen[t] || s.studioTeile[t]).name, info: 'Needs an NVIDIA graphics card', gb: 0, gesperrt: true };
    liste.appendChild(zeile(imPlan((x) => x.rolle === t || x.teil === t) || sch, t, !!imPlan((x) => x.rolle === t || x.teil === t)));
  }
  box.appendChild(liste);

  const fuss = elem('div', 'ein-fuss');
  const platz = Object.entries(ein.plan.platz).map(([l, p]) => `${l} ${p.frei != null ? p.frei + ' GB free' : ''}`).join(' · ');
  const summe = elem('div', 'ein-summe' + (ein.plan.zuWenig.length ? ' warn' : ''));
  summe.append(elem('b', null, ein.plan.gesamt ? 'Download about ' + gbText(ein.plan.gesamt) : 'Nothing to download'), elem('span', null, ein.plan.zuWenig.length ? `Not enough free space on ${ein.plan.zuWenig.join(', ')} – leave out a part or free up space` : platz));
  fuss.appendChild(summe);
  fuss.appendChild(elem('div', 'platz'));
  const zur = elem('button', 'm-knopf', 'Back');
  zur.addEventListener('click', () => { ein.seite = 'start'; zeichneEinrichtung(); });
  const los = elem('button', 's-los', 'Install');
  los.id = 'ein-los';
  const nichts = !ein.plan.schritte.some((x) => !x.da);
  los.disabled = !!ein.plan.zuWenig.length || nichts;
  if (nichts) los.textContent = 'All installed';
  los.addEventListener('click', () => installieren(los));
  fuss.append(zur, los);
  box.appendChild(fuss);
}

function zeile(sch, teil, an, setze) {
  const z = elem('label', 'ein-zeile' + (teil && !an ? ' aus' : '') + (sch.gesperrt ? ' gesperrt' : ''));
  if (teil) {
    const x = elem('input'); x.type = 'checkbox'; x.checked = !!an; x.disabled = !!sch.gesperrt;
    x.dataset.teil = teil;
    x.disabled = x.disabled || !!(setze && sch.da); // installierte Werkzeuge bleiben
    x.addEventListener('change', () => { if (setze) setze(x.checked); else ein.wahl.teile[teil] = x.checked; neuerPlan(); });
    z.appendChild(x);
  } else z.appendChild(elem('span', 'ein-fest', '•'));
  const t = elem('div', 'ein-z-text');
  t.append(elem('b', null, sch.titel), elem('small', null, sch.info || ''));
  z.appendChild(t);
  z.appendChild(elem('span', 'ein-gb' + (sch.da || sch.basis ? ' da' : ''), sch.da ? '✓ installed' : sch.basis ? '✓ downloaded' : sch.gesperrt ? '' : gbText(sch.gb)));
  return z;
}

const STATUS_ZEICHEN = { wartet: '○', laeuft: '', fertig: '✓', da: '✓', fehler: '✕', abgebrochen: '–' };
function seiteLauf(box) {
  const st = ein.stand;
  if (!st) return;
  const liste = elem('div', 'ein-liste');
  liste.id = 'ein-lauf';
  box.appendChild(liste);
  const fuss = elem('div', 'ein-fuss');
  const summe = elem('div', 'ein-summe');
  summe.id = 'ein-lauf-summe';
  fuss.append(summe, elem('div', 'platz'));
  const ab = elem('button', 'm-knopf', 'Cancel');
  ab.id = 'ein-abbrechen';
  ab.addEventListener('click', () => {
    // zweimal klicken: der Zustand liegt in ein.sicherBis, damit er das Neuzeichnen uebersteht
    if (Date.now() < ein.sicherBis) { ein.sicherBis = 0; window.api.einrichtungAbbrechen(); ab.textContent = 'Cancelling…'; ab.disabled = true; return; }
    ein.sicherBis = Date.now() + 4000;
    ab.textContent = 'Sure?';
    setTimeout(() => { if (Date.now() >= ein.sicherBis && !ab.disabled) ab.textContent = 'Cancel'; }, 4100);
  });
  const nochmal = elem('button', 'm-knopf', 'Retry');
  nochmal.id = 'ein-nochmal';
  nochmal.addEventListener('click', async () => {
    nochmal.disabled = true;
    try { ein.stand = await window.api.einrichtungStart(ein.wahl); zeichneEinrichtung(); } catch (e) { hinweis(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); nochmal.disabled = false; }
  });
  const zu = elem('button', 's-los', 'Hide');
  zu.id = 'ein-fertig';
  zu.addEventListener('click', () => { $('#einrichtung').classList.add('versteckt'); if (ein.stand && ein.stand.fertig) ein.seite = 'start'; fokus(); });
  fuss.append(ab, nochmal, zu);
  box.appendChild(fuss);
  aktualisiereLaufListe();
}

// nur die Liste und die Knoepfe anpassen (kommt alle 250 ms), damit Klicks nicht verloren gehen
function aktualisiereLaufListe() {
  const st = ein.stand, liste = $('#ein-lauf');
  if (!st || !liste) return;
  liste.replaceChildren();
  for (const s of st.schritte) {
    const z = elem('div', 'ein-zeile lauf ' + s.status);
    const zeichen = elem('span', 'ein-status', STATUS_ZEICHEN[s.status] || '');
    if (s.status === 'laeuft') zeichen.appendChild(elem('i', 'ein-dreh'));
    const t = elem('div', 'ein-z-text');
    t.append(elem('b', null, s.titel), elem('small', null, s.fehler || s.text || s.info || ''));
    if (s.status === 'laeuft') {
      const balken = elem('div', 'ein-balken');
      const f = elem('i'); f.style.width = Math.max(2, s.prozent || 0) + '%';
      balken.appendChild(f);
      t.appendChild(balken);
    }
    z.append(zeichen, t, elem('span', 'ein-gb', s.status === 'laeuft' && s.prozent ? s.prozent + ' %' : s.status === 'wartet' && s.gb ? gbText(s.gb) : ''));
    liste.appendChild(z);
    // Ollama liess sich nicht automatisch installieren: Installer per Knopf in den Downloads-Ordner
    if (s.status === 'fehler' && /ollama\.com\/download/.test(s.fehler || '')) liste.appendChild(installerKnopf('ollama', 'Get the Ollama installer, run it, then press Retry.'));
  }
  const fehler = st.schritte.filter((s) => s.status === 'fehler').length;
  const offen = st.schritte.filter((s) => s.status === 'wartet' || s.status === 'laeuft').length;
  $('#ein-lauf-summe').replaceChildren(
    elem('b', null, !st.fertig ? `Installing… ${st.schritte.length - offen} of ${st.schritte.length} done` : st.abgebrochen ? 'Cancelled' : fehler ? `Finished with ${fehler} problem${fehler > 1 ? 's' : ''}` : 'All set!'),
    elem('span', null, !st.fertig ? 'You can hide this window and keep working – it continues in the background.'
      : st.abgebrochen ? 'Finished parts are kept. Press Retry to continue later.'
        : fehler ? 'Press Retry to try the failed parts again.' : 'The coder model is now your default in the terminal, the fast helper in Chat.'));
  $('#ein-titel').textContent = !st.fertig ? 'Installing' : 'Setup finished';
  $('#ein-abbrechen').classList.toggle('versteckt', !!st.fertig);
  $('#ein-nochmal').classList.toggle('versteckt', !st.fertig || (!fehler && !st.abgebrochen));
  $('#ein-nochmal').disabled = false;
  $('#ein-fertig').textContent = st.fertig ? 'Done' : 'Hide';
}

window.api.onEinrichtung(async (st) => {
  const warFertig = ein.stand && ein.stand.fertig;
  ein.stand = st;
  if (ein.seite === 'lauf') aktualisiereLaufListe();
  // fertig: Modellliste neu laden, damit die neuen Modelle gleich im Menue stehen
  if (st && st.fertig && !warFertig) {
    liste = await window.api.models().catch(() => liste);
    zeichneLeiste();
    if ($('#einrichtung').classList.contains('versteckt')) hinweis(st.abgebrochen ? 'Setup cancelled' : 'Setup finished – new models are ready');
  }
});
window.api.onConfig((c) => { cfg = c; zeichneLeiste(); });

$('#bib-express').addEventListener('click', zeigeEinrichtung);
