// Glowline Link: am PC "Share this PC" (Code anzeigen), in der App "Glowline Link" einen PC im Heimnetz koppeln
const lk = { stand: null, funde: null, sucht: false, host: '', fehler: null, laeuft: false };

async function zeigeLink() {
  schliesseMenues();
  if (typeof schliesseBib === 'function') schliesseBib();
  $('#link').classList.remove('versteckt');
  lk.fehler = null;
  lk.stand = await window.api.linkStand();
  zeichneLink();
  if (lk.stand.app && !lk.stand.verbunden) linkSuchen();
}
function schliesseLink() { $('#link').classList.add('versteckt'); fokus(); }
$('#link-zu').addEventListener('click', schliesseLink);

async function linkSuchen() {
  lk.sucht = true;
  zeichneLink();
  lk.funde = await window.api.linkSuchen().catch(() => []);
  lk.sucht = false;
  if (!lk.host && lk.funde.length === 1) lk.host = lk.funde[0].host;
  zeichneLink();
}

function zeichneLink() {
  const box = $('#link-inhalt');
  box.replaceChildren();
  const st = lk.stand;
  if (!st) return;
  if (st.app) return st.verbunden ? linkVerbunden(box, st) : linkKoppeln(box);
  linkPc(box, st);
}

// ---------- PC: teilen ----------
function linkPc(box, st) {
  box.appendChild(elem('p', 'ein-text', 'Use the models on this PC from your laptop: install Glowline Link on the laptop, connect both to the same network and enter the code shown here. The laptop then runs Claude Code, Codex, OpenCode and Cowork with this PC’s graphics card.'));
  const an = elem('button', 'ein-karte ein-gross' + (st.teilen ? ' empfohlen' : ''));
  an.id = 'link-teilen';
  an.append(elem('b', null, st.teilen ? '✓ This PC is shared' : 'Share this PC'),
    elem('span', null, st.teilen ? 'Click to stop sharing.' : 'Laptops in your home network can use this PC’s models after entering a code.'));
  an.addEventListener('click', async () => {
    an.disabled = true;
    lk.stand = { app: false, ...(await window.api.linkTeilen(!st.teilen)) };
    zeichneLink();
  });
  box.appendChild(an);
  if (st.fehler) box.appendChild(elem('p', 'ein-text link-fehler', st.fehler));
  if (!st.teilen) return;
  const code = elem('div', 'link-code');
  code.append(elem('small', null, 'Code for Glowline Link'), elem('b', null, st.code.slice(0, 3) + ' ' + st.code.slice(3)));
  box.appendChild(code);
  const info = elem('div', 'ein-system');
  info.appendChild(elem('span', 'ein-chip', st.name));
  for (const a of st.adressen) info.appendChild(elem('span', 'ein-chip', a));
  info.appendChild(elem('span', 'ein-chip' + (st.geraete.length ? '' : ' aus'), st.geraete.length ? `${st.geraete.length} laptop${st.geraete.length > 1 ? 's' : ''} connected` : 'No laptop connected yet'));
  box.appendChild(info);
  box.appendChild(elem('p', 'ein-text klein', 'If Windows asks whether Glowline may use the network, allow it for private networks. Only devices in your home network can connect, and only with the code.'));
  const fuss = elem('div', 'ein-fuss');
  fuss.appendChild(elem('div', 'platz'));
  const neu = elem('button', 'm-knopf', 'New code');
  neu.title = 'Makes a new code – laptops that are connected now have to enter it again';
  neu.addEventListener('click', async () => { lk.stand = { app: false, ...(await window.api.linkNeu()) }; zeichneLink(); hinweis('New code – connected laptops have to connect again'); });
  fuss.appendChild(neu);
  box.appendChild(fuss);
}

// ---------- Laptop: koppeln ----------
function linkKoppeln(box) {
  box.appendChild(elem('p', 'ein-text', 'Connect to your Glowline PC. On the PC open Glowline → Models → Link and click “Share this PC”. Both need to be in the same network.'));
  box.appendChild(elem('div', 'ein-schritt', '1 · Pick your PC'));
  const liste = elem('div', 'ein-liste');
  if (lk.sucht) liste.appendChild(elem('div', 'ein-zeile', 'Searching your network…'));
  else if (!lk.funde || !lk.funde.length) liste.appendChild(elem('div', 'ein-zeile', 'No PC found – is “Share this PC” turned on? You can also type its address below.'));
  for (const f of lk.funde || []) {
    const z = elem('button', 'ein-zeile link-pc' + (lk.host === f.host ? ' an' : ''));
    const t = elem('div', 'ein-z-text');
    t.append(elem('b', null, f.name), elem('small', null, f.host));
    z.append(elem('span', 'ein-status', lk.host === f.host ? '●' : '○'), t);
    z.addEventListener('click', () => { lk.host = f.host; zeichneLink(); });
    liste.appendChild(z);
  }
  box.appendChild(liste);
  const adr = elem('input', 'link-feld');
  adr.id = 'link-host';
  adr.placeholder = 'or type the PC’s address, e.g. 192.168.1.20';
  adr.value = lk.host;
  adr.spellcheck = false;
  adr.addEventListener('input', () => { lk.host = adr.value.trim(); });
  const nochmal = elem('button', 'm-knopf', lk.sucht ? 'Searching…' : 'Search again');
  nochmal.disabled = lk.sucht;
  nochmal.addEventListener('click', linkSuchen);
  const zeile = elem('div', 'link-zeile');
  zeile.append(adr, nochmal);
  box.appendChild(zeile);
  box.appendChild(elem('div', 'ein-schritt', '2 · Enter the code shown on the PC'));
  const code = elem('input', 'link-feld link-codefeld');
  code.id = 'link-code';
  code.placeholder = '123 456';
  code.inputMode = 'numeric';
  code.maxLength = 7;
  box.appendChild(code);
  if (lk.fehler) box.appendChild(elem('p', 'ein-text link-fehler', lk.fehler));
  const fuss = elem('div', 'ein-fuss');
  fuss.appendChild(elem('div', 'platz'));
  const los = elem('button', 's-los', lk.laeuft ? 'Connecting…' : 'Connect');
  los.id = 'link-los';
  los.disabled = lk.laeuft;
  const verbinden = async () => {
    lk.host = adr.value.trim() || lk.host;
    if (!lk.host) { lk.fehler = 'Pick your PC or type its address'; return zeichneLink(); }
    lk.laeuft = true; lk.fehler = null; zeichneLink();
    try {
      const v = await window.api.linkKoppeln(lk.host, code.value.replace(/\D/g, ''));
      hinweis('Connected to ' + v.name);
      lk.stand = await window.api.linkStand();
      await linkNeuLaden();
    } catch (e) { lk.fehler = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    lk.laeuft = false;
    zeichneLink();
  };
  los.addEventListener('click', verbinden);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') verbinden(); });
  fuss.appendChild(los);
  box.appendChild(fuss);
  setTimeout(() => (lk.host ? code : adr).focus(), 50);
}

function linkVerbunden(box, st) {
  const k = elem('div', 'ein-karte ein-gross' + (st.online ? ' empfohlen' : ''));
  k.append(elem('b', null, (st.online ? '● ' : '○ ') + st.name), elem('span', null, st.online ? `Connected (${st.host}) – all models come from this PC.` : `${st.host} is not reachable right now – is the PC on and Glowline open there?`));
  box.appendChild(k);
  const fuss = elem('div', 'ein-fuss');
  fuss.appendChild(elem('div', 'platz'));
  const weg = elem('button', 'm-knopf', 'Disconnect');
  weg.addEventListener('click', async () => { await window.api.linkTrennen(); lk.stand = await window.api.linkStand(); zeichneLink(); linkSuchen(); });
  const ok = elem('button', 's-los', 'Done');
  ok.addEventListener('click', schliesseLink);
  fuss.append(weg, ok);
  box.appendChild(fuss);
}

// nach dem Koppeln: Modelle vom PC holen und eins als Standard nehmen
async function linkNeuLaden() {
  liste = await window.api.models().catch(() => liste);
  if (liste && !alleModelle().some((m) => m.id === cfg.defaultModel)) cfg.defaultModel = (await standardModell()) || '';
  zeichneLeiste();
}

window.api.onLink((s) => { if (lk.stand && !lk.stand.app) { lk.stand = { app: false, ...s }; if (!$('#link').classList.contains('versteckt')) zeichneLink(); } });
$('#bib-link').addEventListener('click', zeigeLink);
window.zeigeLink = zeigeLink;

// Glowline Link: Studio und Express-Einrichtung gibt es dort nicht; ohne Kopplung gleich den Verbinden-Dialog
(async () => {
  const st = await window.api.linkStand().catch(() => null);
  if (!st || !st.app) return;
  document.body.classList.add('link-app');
  document.title = 'Glowline Link';
  if (ansicht === 'studio') zeigeTerminal(); // Studio rechnet auf der eigenen Grafikkarte – gibt es im Link nicht
  if (!st.verbunden && !TESTMODUS) zeigeLink();
})();
