// Glowline im Terminal: "gl" / "glowline" starten cli/glowline-cli.js, das mit der laufenden App spricht.
// Die App bleibt der Chef (Grafikkarte, Studio, Modelle) – das Terminal ist nur ein zweites Fenster fuer Cowork.
// Kleiner Server nur auf 127.0.0.1, Zufallsport + Zufallsschluessel in terminal.json (liegt im eigenen AppData).
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

let d = null; // { chatSenden, chatStopp, hoerer, proxy, gpu, modelle, cfg, erlaubt, freigeben, oeffnen, kopieren, autostart, statistik, vorschau, fensterJs, zeigen, version, datei, test }
let server = null;
const MEDIEN = /\.(png|jpe?g|webp|mp4|webm|wav|mp3|flac|ogg|m4a)$/i;

function init(x) { d = x; }

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
}
function body(req, max = 4e6) {
  return new Promise((ok, f) => {
    const teile = [];
    let n = 0;
    req.on('data', (x) => { n += x.length; if (n > max) { f(new Error('too big')); req.destroy(); } else teile.push(x); });
    req.on('end', () => { try { ok(teile.length ? JSON.parse(Buffer.concat(teile).toString('utf8')) : {}); } catch (e) { f(e); } });
    req.on('error', f);
  });
}

// alle Modelle als flache Liste (fuer /model und die Anzeige)
function flach(l) {
  const aus = [];
  for (const b of ['ollama', 'lmstudio']) for (const m of (l[b] && l[b].models) || []) aus.push({ id: m.id, name: m.name, params: m.params, quant: m.quant, ctx: m.ctx });
  for (const w of Object.values(l.wolke || {})) for (const m of (w && w.models) || []) if (m && m.id) aus.push({ id: m.id, name: m.name || m.id });
  return aus;
}

async function anfrage(req, res, schluessel, port) {
  // nur dieses Programm: Schluessel aus terminal.json, Host muss 127.0.0.1 sein (gegen DNS-Rebinding)
  if (req.headers['x-glowline'] !== schluessel || req.headers.host !== '127.0.0.1:' + port) return json(res, 403, { fehler: 'forbidden' });
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/info') {
      const l = await d.modelle().catch(() => ({}));
      const c = d.cfg();
      return json(res, 200, { version: d.version, chatModel: c.chatModel || '', chatSystem: c.chatSystem || '', modelle: flach(l), gpu: await d.gpu() });
    }
    // Leiste unten (wie im Fenster): GPU, geladene Modelle, gesparte $
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { gpu: await d.gpu(), geladen: d.geladen(), gespart: await d.gespart() });
    // fuer /usage und /stats: Tageszahlen der Stats-Seite (Tokens, Anfragen, gesparte $, Modelle, Studio)
    if (req.method === 'GET' && url.pathname === '/stats') return json(res, 200, { ...d.statistik(), gpu: await d.gpu() });
    if (req.method === 'POST' && url.pathname === '/chat') {
      const a = await body(req);
      const id = 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      let offen = true;
      const schreib = (o) => { if (offen) res.write(JSON.stringify(o) + '\n'); };
      // Studio-Fortschritt und Geschwindigkeit mitschicken
      let vorgang = null;
      const hoer = (kanal, p) => {
        if (kanal === 'studio' && p && vorgang && p.vorgang === vorgang && !p.fertig) schreib({ studio: { prozent: p.prozent, text: p.text } });
      };
      const stat = (s) => {
        if (!s || s.tab !== 'chat') return;
        if (s.phase === 'erstes') schreib({ stat: { ttft: s.ttft } });
        else if (s.phase === 'lauf') schreib({ stat: { tps: s.tps, tokens: s.tokens } });
        else if (s.phase === 'ende' && s.status === 'ok') schreib({ stat: { tps: s.tps, tokens: s.ausgabe, ttft: s.ttft, kontext: s.eingabe, prefill: s.prefill || 0 } });
      };
      d.hoerer.add(hoer);
      const proxy = d.proxy();
      if (proxy) proxy.on('stat', stat);
      res.on('close', () => { if (offen) { offen = false; d.chatStopp(id); } });
      // gezogene Bilder/Videos duerfen gelesen werden (wie 📎 im Fenster)
      for (const f of [a.anhang, a.erzwinge && a.erzwinge.quelle]) if (typeof f === 'string' && MEDIEN.test(f) && fs.existsSync(f)) d.freigeben(f);
      const ordner = typeof a.ordner === 'string' && fs.existsSync(a.ordner) ? a.ordner : null;
      await d.chatSenden({ ...a, id, ordner }, (p) => {
        if (p.medien && p.medien.vorgang) vorgang = p.medien.vorgang;
        schreib({ chat: p });
      });
      d.hoerer.delete(hoer);
      if (proxy) proxy.off('stat', stat);
      offen = false;
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/oeffnen') {
      const a = await body(req);
      return json(res, 200, { ok: d.oeffnen(String(a.pfad || ''), !!a.zeigen) });
    }
    // mit Windows starten (unsichtbar im Infobereich) – dann ist gl sofort bereit
    // /update in gl: pruefen, laden (gl fragt den Stand ab), installieren + Glowline neu starten
    if (req.method === 'GET' && url.pathname === '/update') return json(res, 200, await d.update.pruefen().catch((e) => ({ ...d.update.stand(), fehler: String(e.message || e) })));
    if (req.method === 'GET' && url.pathname === '/update/stand') return json(res, 200, d.update.stand());
    // Hinweis unten in gl: nicht bei Updates "aus", GitHub hoechstens alle 5 Minuten fragen (im Test nur das Test-GitHub)
    if (req.method === 'GET' && url.pathname === '/update/hinweis') {
      const st = d.update.stand();
      if (st.modus === 'aus' || (d.test && !process.env.GLOWLINE_TEST_UPDATE) || Date.now() - (st.geprueft || 0) < 5 * 60 * 1000) return json(res, 200, st);
      return json(res, 200, await d.update.pruefen().catch(() => d.update.stand()));
    }
    if (req.method === 'POST' && url.pathname === '/update/laden') { d.update.laden().catch(() => {}); return json(res, 200, d.update.stand()); }
    if (req.method === 'POST' && url.pathname === '/update/installieren') {
      const ok = d.update.stand().bereit;
      json(res, 200, { ok });
      if (ok) setTimeout(() => d.update.jetzt().catch(() => {}), 1500); // gl hat sich bis dahin verabschiedet
      return;
    }
    // Sprechen in gl (Leertaste halten): Glowline nimmt auf, gl bekommt den Text
    if (req.method === 'POST' && url.pathname === '/hoeren/start') return json(res, 200, await d.fensterJs('glHoerenStart()'));
    if (req.method === 'POST' && url.pathname === '/hoeren/stopp') { const a = await body(req); return json(res, 200, await d.fensterJs(`glHoerenStopp(${a.verwerfen ? 'true' : 'false'})`)); }
    if (req.method === 'GET' && url.pathname === '/hoeren/pegel') return json(res, 200, { pegel: +(await d.fensterJs('glHoerenPegel()')) || 0 });
    if (req.method === 'POST' && url.pathname === '/hoeren/einrichten') {
      const r = await d.fensterJs('glHoerenEinrichten()');
      if (r && r.bereit === false) d.zeigen();
      return json(res, 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/autostart') {
      const a = await body(req);
      return json(res, 200, { an: !!d.autostart(typeof a.an === 'boolean' ? a.an : undefined) });
    }
    if (req.method === 'POST' && url.pathname === '/kopieren') {
      const a = await body(req);
      d.kopieren(String(a.text || ''));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/freigeben') {
      const a = await body(req);
      const f = typeof a.pfad === 'string' ? path.resolve(a.pfad) : '';
      const ok = !!f && MEDIEN.test(f) && fs.existsSync(f);
      if (ok) d.freigeben(f);
      return json(res, 200, { ok });
    }
    // kleine Vorschau als Pixel (das Terminal malt sie mit Halbblock-Zeichen)
    if (req.method === 'GET' && url.pathname === '/vorschau') {
      const f = url.searchParams.get('f') || '';
      if (!d.erlaubt(f)) return json(res, 404, { fehler: 'not found' });
      const v = await d.vorschau(f, Math.max(8, Math.min(160, +url.searchParams.get('b') || 60)), Math.max(4, Math.min(120, +url.searchParams.get('h') || 40)));
      return json(res, v ? 200 : 404, v || { fehler: 'no preview' });
    }
    json(res, 404, { fehler: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { fehler: String((e && e.message) || e) });
    else res.end();
  }
}

async function starte() {
  if (server) return;
  const schluessel = crypto.randomBytes(24).toString('hex');
  server = http.createServer((req, res) => anfrage(req, res, schluessel, server.address().port));
  await new Promise((ok, f) => { server.once('error', f); server.listen(0, '127.0.0.1', ok); });
  fs.mkdirSync(path.dirname(d.datei), { recursive: true });
  fs.writeFileSync(d.datei, JSON.stringify({ port: server.address().port, schluessel, pid: process.pid, version: d.version }));
}
function stoppe() {
  try { if (server) server.close(); } catch {}
  // nur die eigene Datei wegraeumen (eine andere Glowline-Instanz koennte sie neu geschrieben haben)
  try { const j = JSON.parse(fs.readFileSync(d.datei, 'utf8')); if (j.pid === process.pid) fs.rmSync(d.datei, { force: true }); } catch {}
}

// ---------- gl / glowline einrichten ----------
// bin-Ordner mit gl.cmd + glowline.cmd, Ordner in den Benutzer-PATH, PowerShell-Alias "gl" (Get-Location) im Profil abschalten
const MARKE_START = '# >>> Glowline: "gl" startet Glowline im Terminal >>>';
const MARKE_ENDE = '# <<< Glowline <<<';
function cmdDatei(exe, cli, api) {
  const q = (s) => '"' + String(s).replace(/%/g, '%%') + '"';
  return ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `${q(exe)} ${q(cli)} --api ${q(api)} --app ${q(exe)} %*`, ''].join('\r\n');
}
function ps(befehl) {
  return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', befehl], { windowsHide: true, timeout: 30000 }, (e, aus) => ok(e ? null : String(aus).trim())));
}
async function installiere({ bin, exe, cli, dokumente }) {
  const ergebnis = { bin, path: false, profil: [] };
  fs.mkdirSync(bin, { recursive: true });
  const inhalt = cmdDatei(exe, cli, d.datei);
  for (const n of ['gl.cmd', 'glowline.cmd']) {
    const f = path.join(bin, n);
    let alt = '';
    try { alt = fs.readFileSync(f, 'utf8'); } catch {}
    if (alt !== inhalt) fs.writeFileSync(f, inhalt);
  }
  // Benutzer-PATH: nur anhaengen, nie etwas anderes veraendern (kein setx – das kuerzt lange PATHs)
  const esc = (s) => s.replace(/'/g, "''");
  const r = await ps(`$p=[Environment]::GetEnvironmentVariable('Path','User'); $t=@(); if($p){$t=$p -split ';'}; if($t -notcontains '${esc(bin)}'){ [Environment]::SetEnvironmentVariable('Path', (@($t | Where-Object { $_ }) + '${esc(bin)}') -join ';', 'User'); 'neu' } else { 'da' }`);
  ergebnis.path = r === 'neu' || r === 'da';
  // PowerShell: "gl" ist dort schon ein Alias (Get-Location) und gewinnt gegen gl.cmd – im Profil entfernen.
  // Nur wenn Skripte erlaubt sind, sonst gaebe es bei jedem Start einen roten Fehler.
  const regel = await ps('Get-ExecutionPolicy');
  if (regel && !/^(Restricted|AllSigned)$/i.test(regel)) {
    const block = [MARKE_START, "if (Test-Path Alias:gl) { Remove-Item Alias:gl -Force }", MARKE_ENDE].join('\r\n');
    for (const ordner of ['WindowsPowerShell', 'PowerShell']) {
      const o = path.join(dokumente, ordner);
      // PowerShell 7 nur, wenn es den Ordner schon gibt
      if (ordner === 'PowerShell' && !fs.existsSync(o)) continue;
      const f = path.join(o, 'profile.ps1');
      // Profil kann UTF-16 (mit BOM) sein: in derselben Kodierung zurueckschreiben
      let roh = null;
      try { roh = fs.readFileSync(f); } catch {}
      const u16 = !!roh && roh[0] === 0xff && roh[1] === 0xfe;
      const alt = !roh ? '' : u16 ? roh.toString('utf16le', 2) : roh.toString('utf8');
      if (alt.includes(MARKE_START)) { ergebnis.profil.push(f); continue; }
      fs.mkdirSync(o, { recursive: true });
      const neu = (alt && !/\n$/.test(alt) ? alt + '\r\n' : alt) + block + '\r\n';
      fs.writeFileSync(f, u16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(neu, 'utf16le')]) : neu);
      ergebnis.profil.push(f);
    }
  }
  return ergebnis;
}

module.exports = { init, starte, stoppe, installiere, cmdDatei };
