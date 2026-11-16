// Downloads-Tab: alles, was gerade laedt, an einem Ort – Modelle, Express-Einrichtung, Studio, Installer
const installerLauf = new Map(); // id -> letzter Stand aus main.js
const INSTALLER_NAME = { ollama: 'Ollama installer', lmstudio: 'LM Studio installer' };
window.api.onInstaller((s) => { installerLauf.set(s.id, s); dlAktualisieren(); });

function alleDownloads() {
  const l = [];
  // Modelle aus Models → Download und Cowork
  for (const [key, d] of downloads) {
    l.push({
      key: 'm:' + key, gruppe: 'Models',
      titel: d.ziel === 'bibliothek' ? d.repo : `${d.repo} · ${d.quant}`,
      ziel: d.ziel === 'bibliothek' ? 'Ollama' : zielName(d.ziel),
      prozent: prozent(d), text: downloadText(d), abbrechen: () => window.api.downloadCancel(key),
    });
  }
  // Express-Einrichtung (auch Werkzeuge wie Claude Code)
  const st = ein.stand;
  if (st && !st.fertig) {
    st.schritte.forEach((s, i) => {
      if (s.status !== 'laeuft' && s.status !== 'wartet') return;
      l.push({
        key: 'e:' + i, gruppe: 'Express setup', titel: s.titel, ziel: s.info || '',
        prozent: s.status === 'laeuft' ? s.prozent || 0 : 0,
        text: s.status === 'wartet' ? 'Waiting' + (s.gb ? ' · ' + gbText(s.gb) : '') : s.text || 'Starting…',
        wartet: s.status === 'wartet',
        abbrechen: () => { window.api.einrichtungAbbrechen(); hinweis('Cancelling the setup…'); },
        abbrechenText: 'Cancel setup',
      });
    });
  }
  // Studio-Motor und Studio-Modelle
  for (const [v, s] of sz.laden) {
    if (s.fertig) continue;
    const m = v.startsWith('modell:') && sz.st && sz.st.modelle[v.slice(7)];
    l.push({
      key: 's:' + v, gruppe: 'Studio', titel: v === 'einrichten' ? 'Studio engine' : (m ? m.name : v.slice(7)), ziel: 'Studio',
      prozent: s.prozent || 0, text: s.prozent != null ? Math.round(s.prozent) + ' %' + (s.text ? ' · ' + s.text : '') : s.text || s.titel || 'Starting…',
      abbrechen: () => window.api.studioAbbrechen(v),
    });
  }
  // Installer (Ollama, LM Studio)
  for (const [id, s] of installerLauf) {
    if (!s.laeuft) continue;
    l.push({
      key: 'i:' + id, gruppe: 'Programs', titel: INSTALLER_NAME[id] || id, ziel: 'Downloads folder',
      prozent: s.gesamt ? (s.geladen / s.gesamt) * 100 : 0,
      text: s.gesamt ? `${Math.floor((s.geladen / s.gesamt) * 100)}% · ${gb(s.geladen)} / ${gb(s.gesamt)}` : 'Starting…',
      abbrechen: () => window.api.installerAbbrechen(id),
    });
  }
  return l;
}

// Seite nur bei neuen/weggefallenen Eintraegen neu bauen, sonst nur Text und Balken (Klicks gehen nicht verloren)
function zeichneDlSeite() {
  const box = $('#dl-liste');
  if (!box) return;
  const l = alleDownloads();
  const schluessel = l.map((x) => x.key + (x.wartet ? '-w' : '')).join('|');
  if (box.dataset.schluessel !== schluessel) {
    box.dataset.schluessel = schluessel;
    box.replaceChildren();
    if (!l.length) {
      leer(box, 'Nothing is downloading right now. Models you download (Models → Download, Cowork, Express setup, Studio) show up here with their progress.');
      return;
    }
    let gruppe = null;
    for (const x of l) {
      if (x.gruppe !== gruppe) { gruppe = x.gruppe; box.appendChild(elem('div', 'dl-gruppe', gruppe)); }
      const z = elem('div', 'dl-zeile' + (x.wartet ? ' wartet' : ''));
      z.dataset.key = x.key;
      const t = elem('div', 'dl-text');
      t.append(elem('b', null, x.titel), elem('small', null, x.ziel));
      const r = elem('div', 'dl-rechts');
      r.append(elem('span', 'dl-stand'));
      const k = elem('button', 'm-knopf', x.abbrechenText || 'Cancel');
      k.addEventListener('click', () => { k.disabled = true; k.textContent = 'Cancelling…'; x.abbrechen(); });
      r.appendChild(k);
      const b = elem('div', 'dl-balken');
      b.appendChild(elem('i'));
      z.append(t, r, b);
      box.appendChild(z);
    }
  }
  for (const x of l) {
    const z = box.querySelector(`.dl-zeile[data-key="${CSS.escape(x.key)}"]`);
    if (!z) continue;
    z.querySelector('.dl-stand').textContent = x.text;
    z.querySelector('.dl-balken i').style.width = Math.max(x.wartet ? 0 : 1, Math.min(100, x.prozent || 0)) + '%';
  }
}

// Zaehler am Tab und Chip unten in der Leiste (Klick oeffnet den Tab)
function dlAktualisieren() {
  const l = alleDownloads();
  const aktiv = l.filter((x) => !x.wartet);
  const tab = document.querySelector('.bib-tabs [data-tab="downloads"]');
  if (tab) tab.textContent = l.length ? `Downloads (${l.length})` : 'Downloads';
  const chip = $('#dl-chip');
  chip.classList.toggle('versteckt', !l.length);
  if (l.length) {
    const p = aktiv.length ? aktiv.reduce((s, x) => s + (x.prozent || 0), 0) / aktiv.length : 0;
    $('#dl-chip-text').textContent = `${l.length} download${l.length > 1 ? 's' : ''}` + (aktiv.length ? ` · ${Math.floor(p)}%` : '');
  }
  if (bibOffen() && bibTab === 'downloads') zeichneDlSeite();
}
setInterval(dlAktualisieren, 700);
$('#dl-chip').addEventListener('click', () => oeffneBib('downloads'));
