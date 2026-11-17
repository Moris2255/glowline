// Stats-Seite (Models → Stats): Heatmap der letzten 12 Monate, Serien, gesparte Kosten, Lieblingsmodelle
function statZahl(n) {
  n = +n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2).replace(/\.?0+$/, '') + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
const statTag = (z) => `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
const MONATE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Serien: aktuelle (bis heute oder gestern) und laengste, nur Tage mit Anfragen zaehlen
function statSerien(tage, heute) {
  const aktiv = new Set(Object.entries(tage).filter(([, t]) => t.anfragen > 0 || Object.values(t.medien || {}).some((x) => x > 0)).map(([k]) => k));
  const sortiert = [...aktiv].sort();
  let laengste = 0, lauf = 0, vorher = null;
  for (const k of sortiert) {
    const d = new Date(k + 'T12:00:00');
    lauf = vorher && (d - vorher) / 864e5 < 1.5 ? lauf + 1 : 1;
    laengste = Math.max(laengste, lauf);
    vorher = d;
  }
  let aktuell = 0;
  const z = new Date(heute + 'T12:00:00');
  if (!aktiv.has(statTag(z))) z.setDate(z.getDate() - 1); // heute noch nichts gemacht: Serie von gestern zaehlt noch
  while (aktiv.has(statTag(z))) { aktuell++; z.setDate(z.getDate() - 1); }
  return { aktiv: aktiv.size, aktuell, laengste };
}

async function zeichneStats() {
  const box = $('#stats-inhalt');
  if (!box) return;
  const s = await window.api.statistik().catch(() => null);
  box.replaceChildren();
  if (!s) return;
  const tage = s.tage || {};
  const werte = Object.values(tage);
  const summe = (f) => werte.reduce((a, t) => a + (f(t) || 0), 0);
  const serien = statSerien(tage, s.heute);
  // Gesamt-Tokens: Zaehler von "Saved costs" (laeuft schon laenger als die Tagesstatistik)
  const tokensGesamt = Object.keys(KOSTEN_BEREICHE).filter((k) => KOSTEN_BEREICHE[k].art === 'text')
    .reduce((a, k) => { const t = kostenBereich(k).tokens; return a + t.neu + t.cache + t.ausgabe; }, 0);
  const modelle = {};
  for (const t of werte) for (const [m, n] of Object.entries(t.modelle || {})) modelle[m] = (modelle[m] || 0) + n;
  const top = Object.entries(modelle).sort((a, b) => b[1] - a[1]);
  const medien = (art) => summe((t) => (t.medien || {})[art]);
  const heuteT = tage[s.heute] || {};

  const karten = elem('div', 'stats-karten');
  const karte = (titel, wert, extra, cls) => { const k = elem('div', 'stats-karte' + (cls ? ' ' + cls : '')); k.append(elem('small', null, titel), elem('b', null, wert)); if (extra) k.appendChild(elem('small', null, extra)); karten.appendChild(k); };
  karte('Tokens on your PC', statZahl(Math.max(tokensGesamt, summe((t) => t.tokens))), 'today ' + statZahl(heuteT.tokens || 0));
  karte('Saved', Math.max(gespartJetzt(), summe((t) => t.dollar)).toFixed(2) + ' $', 'today ' + (heuteT.dollar || 0).toFixed(2) + ' $', 'gruen');
  karte('Requests', statZahl(summe((t) => t.anfragen)), 'today ' + statZahl(heuteT.anfragen || 0));
  karte('Current streak', serien.aktuell + (serien.aktuell === 1 ? ' day' : ' days'), 'longest ' + serien.laengste);
  karte('Active days', String(serien.aktiv), 'since you started counting');
  karte('Favourite model', top[0] ? top[0][0].replace(/:latest$/, '') : '–', top[0] ? statZahl(top[0][1]) + ' tokens' : 'nothing yet', 'text');
  const mz = medienZaehler();
  karte('Made in Studio', statZahl((mz.bild || 0) + medien('upscale')) + ' images', `${Math.round(mz.videoSek || 0)} s video · ${statZahl(medien('stimme'))} voice`);
  box.appendChild(karten);

  // Heatmap: 53 Wochen, Spalten = Wochen (Mo oben), Farbe nach Tokens des Tages
  box.appendChild(elem('div', 'stats-titel', 'Activity – last 12 months'));
  const hb = elem('div', 'stats-heat-box');
  const ende = new Date(s.heute + 'T12:00:00');
  const start = new Date(ende);
  start.setDate(start.getDate() - 7 * 52 - ((ende.getDay() + 6) % 7)); // auf Montag
  const maxT = Math.max(1, ...Object.entries(tage).filter(([k]) => k >= statTag(start)).map(([, t]) => t.tokens || 0));
  const stufe = (t) => { if (!t || !(t.tokens || t.anfragen)) return ''; const r = (t.tokens || 0) / maxT; return r > 0.6 ? 's4' : r > 0.3 ? 's3' : r > 0.1 ? 's2' : 's1'; };
  const monate = elem('div', 'stats-monate');
  const heat = elem('div', 'stats-heat');
  let letzterMonat = -1, woche = 0;
  for (const z = new Date(start); z <= ende || (z.getDay() + 6) % 7 !== 0; z.setDate(z.getDate() + 1)) {
    const wt = (z.getDay() + 6) % 7;
    if (wt === 0) {
      const m = elem('span', null, z.getMonth() !== letzterMonat && z.getDate() <= 7 ? MONATE[z.getMonth()] : '');
      if (m.textContent) letzterMonat = z.getMonth();
      monate.appendChild(m);
      woche++;
    }
    const k = statTag(z);
    const t = tage[k];
    const c = elem('i', z > ende ? 'leer' : stufe(t) + (k === s.heute ? ' heute' : ''));
    if (z <= ende) c.title = `${z.getDate()} ${MONATE[z.getMonth()]} ${z.getFullYear()}: ` + (t && t.anfragen ? `${statZahl(t.tokens)} tokens · ${t.anfragen} requests · ${(t.dollar || 0).toFixed(2)} $ saved` : 'nothing') + (t && t.medien && Object.keys(t.medien).length ? ' · ' + Object.entries(t.medien).map(([a, n]) => `${n} ${a === 'bild' ? 'image' : a === 'stimme' ? 'voice' : a}`).join(', ') : '');
    heat.appendChild(c);
  }
  const zeile = elem('div', 'stats-heat-zeile');
  const wtage = elem('div', 'stats-wtage');
  for (const w of ['Mon', '', 'Wed', '', 'Fri', '', '']) wtage.appendChild(elem('span', null, w));
  zeile.append(wtage, heat);
  hb.append(monate, zeile);
  const leg = elem('div', 'stats-legende');
  leg.appendChild(elem('span', null, 'Less '));
  for (const st of ['s0', 's1', 's2', 's3', 's4']) leg.appendChild(elem('i', st));
  leg.appendChild(elem('span', null, ' More'));
  hb.appendChild(leg);
  box.appendChild(hb);
  // Kaestchen so gross, dass die 53 Wochen die Breite fuellen
  const groesse = () => { const z = Math.max(10, Math.min(24, Math.floor((hb.clientWidth - 64) / woche) - 3)); hb.style.setProperty('--z', z + 'px'); hb.scrollLeft = hb.scrollWidth; };
  setTimeout(groesse, 0);
  new ResizeObserver(groesse).observe(hb);

  // Lieblingsmodelle
  if (top.length) {
    box.appendChild(elem('div', 'stats-titel', 'Most used models'));
    const l = elem('div', 'stats-modelle');
    for (const [m, n] of top.slice(0, 8)) {
      const z = elem('div', 'stats-modell');
      const balken = elem('div');
      const i = elem('i');
      i.style.width = Math.max(2, (n / top[0][1]) * 100) + '%';
      balken.appendChild(i);
      z.append(elem('span', null, m), balken, elem('b', null, statZahl(n)));
      z.title = m;
      l.appendChild(z);
    }
    box.appendChild(l);
  }
  box.appendChild(elem('p', 'stats-hinweis', 'Counts everything your local models answer in Glowline (Claude Code, Codex, OpenCode, Cowork …) and what the Studio makes. Cloud models aren’t counted – they cost money. Everything stays on this PC.'
    + (Object.keys(tage).length <= 2 ? ' The daily activity is recorded from version 5.0 on, so the map fills up from today.' : '')));
}
