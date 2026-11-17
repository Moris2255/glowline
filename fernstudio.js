// Glowline Link: das Studio des PCs benutzen. Auftraege gehen ueber das Link-Tor an den PC,
// der rechnet auf seiner Grafikkarte, die Ergebnisse landen hier im Studio-Ordner unter ausgabe/link.
const fs = require('fs');
const path = require('path');

const LEER = { ordner: '', eingerichtet: false, richtetEin: false, motor: 'aus', modelle: {}, fern: true, offline: true, pc: '' };

function fernStudio(studio, link, sende) {
  let st = { ...LEER };
  let zuletzt = 0, laeuft = null;
  const auftraege = new Map(); // vorgang -> AbortController

  // Stand vom PC holen (hoechstens alle 3 s), dazwischen den letzten Stand zeigen
  async function frisch(sofort) {
    if (laeuft) return laeuft;
    if (!sofort && Date.now() - zuletzt < 3000) return st;
    const b = link.torBasis();
    if (!b) { st = { ...LEER }; return st; }
    laeuft = (async () => {
      try {
        const r = await fetch(b + '/studio/status', { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        st = { ...j, ordner: studio.P().basis, fern: true, offline: false, pc: j.name || '', richtetEin: false };
        for (const m of Object.values(st.modelle || {})) m.laedt = false;
      } catch { st = { ...st, fern: true, offline: true }; }
      zuletzt = Date.now();
      laeuft = null;
      return st;
    })();
    return laeuft;
  }

  // Ergebnis vom PC in den eigenen Studio-Ordner holen
  async function holen(b, n, ac) {
    const ziel0 = path.join(studio.P().ausgabe, 'link', ...n.split('/').filter((x) => x && x !== '..'));
    let ziel = ziel0, i = 1;
    while (fs.existsSync(ziel)) ziel = ziel0.replace(/(\.\w+)$/, `_${i++}$1`);
    await studio.ladeDatei(b + '/studio/datei?n=' + encodeURIComponent(n), ziel, ac, () => {});
    return ziel;
  }

  async function auftrag(a) {
    const vorgang = 'auftrag:' + a.id;
    const km = studio.KATALOG[a.modell];
    const kopf = { vorgang, art: km ? km.art : null, modell: a.modell, prompt: a.prompt || '', vonAgent: !!a.vonAgent, vonChat: !!a.vonChat, wolke: !!(km && km.wolke) };
    const melde = (x) => sende('studio', { ...kopf, ...x });
    const ac = new AbortController();
    auftraege.set(vorgang, ac);
    const t0 = Date.now();
    melde({ text: 'Sending to ' + (st.pc || 'your PC') + '…', wartet: true });
    try {
      const b = link.torBasis();
      if (!b) throw new Error('Not connected to a PC – open Link');
      const { bildDatei, ...rest } = a;
      const koerper = { ...rest };
      if (bildDatei) {
        if (!fs.existsSync(bildDatei)) throw new Error('Image not found');
        if (fs.statSync(bildDatei).size > 150e6) throw new Error('This file is too big to send to the PC (max. 150 MB)');
        koerper.bild = fs.readFileSync(bildDatei).toString('base64');
        koerper.bildName = path.basename(bildDatei);
      }
      let r;
      try {
        r = await fetch(b + '/studio/auftrag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(koerper), signal: ac.signal });
      } catch (e) { if (ac.signal.aborted) throw e; throw new Error('Can’t reach your PC – is it on and Glowline open?'); }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      // Fortschritt kommt Zeile fuer Zeile (NDJSON), die letzte Zeile ist das Ergebnis
      let rest2 = '', ende = null;
      const dec = new TextDecoder();
      for await (const stueck of r.body) {
        rest2 += dec.decode(stueck, { stream: true });
        let i;
        while ((i = rest2.indexOf('\n')) >= 0) {
          const zeile = rest2.slice(0, i); rest2 = rest2.slice(i + 1);
          let j; try { j = JSON.parse(zeile); } catch { continue; }
          if (j.e) melde({ ...j.e, fertig: undefined, vorgang });
          else if (j.fertig) ende = j;
        }
      }
      if (!ende) throw new Error('The connection to the PC broke off');
      if (ende.fehler) throw new Error(ende.fehler);
      melde({ text: 'Downloading the result…', prozent: 99 });
      const dateien = [];
      for (const n of ende.dateien || []) dateien.push(await holen(b, n, ac));
      melde({ fertig: true, dateien, dauer: Date.now() - t0 });
      return { dateien };
    } catch (e) {
      const fehler = ac.signal.aborted ? 'cancelled' : e.message;
      melde({ fertig: true, fehler });
      return { fehler };
    } finally { auftraege.delete(vorgang); }
  }

  const echtAbbrechen = studio.abbrechen;
  Object.assign(studio, {
    fern: true,
    frisch,
    status: () => { frisch().catch(() => {}); return st; },
    auftrag,
    abbrechen: (v) => { const ac = auftraege.get(v); if (ac) ac.abort(); else echtAbbrechen(v); },
    beschaeftigt: () => ({ auftraege: auftraege.size, gpu: 0, laden: 0 }),
    einrichten: () => sende('studio', { vorgang: 'einrichten', fertig: true, fehler: 'Set up the Studio on your PC (Glowline → Studio)' }),
    modellHolen: (id) => sende('studio', { vorgang: 'modell:' + id, fertig: true, fehler: 'Download this model on your PC' }),
  });
  frisch(true).catch(() => {});
}

module.exports = fernStudio;
