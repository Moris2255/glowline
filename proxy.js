// Mess-Proxy: steht zwischen Claude Code / Codex / OpenCode und Ollama bzw. LM Studio.
// Reicht alles unveraendert durch (beide koennen Anthropic- und OpenAI-Format selbst)
// und misst dabei Prefill, erstes Token und Tokens pro Sekunde.
//
// Pfad-Schema: /s/<tab>/<backend>/v1/...   (backend = auto | ollama | lmstudio)
// Modellnamen duerfen "ollama,name" oder "lmstudio,name" sein (wie bei claude-code-router).
const http = require('http');
const { EventEmitter } = require('events');

const GEMESSEN = new Set(['/v1/messages', '/v1/responses', '/v1/chat/completions', '/v1/completions']);
const WEG_ANFRAGE = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const WEG_ANTWORT = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

// Cloud-Anbieter nur mit Komma ("openai,gpt-5"), damit lokale Namen wie "openai/gpt-oss-20b" lokal bleiben
const WOLKEN_IDS = ['abo', 'chatgpt', 'anthropic', 'openai', 'openrouter', 'gemini', 'deepseek', 'groq', 'mistral', 'xai'];
const WOLKE = new RegExp(`^(${WOLKEN_IDS.join('|')}),(.+)$`);
function teileModell(name) {
  const m = /^(ollama|lmstudio)[,/](.+)$/.exec(name) || WOLKE.exec(name);
  return m ? { backend: m[1], model: m[2] } : { backend: null, model: name };
}
const istWolke = (b) => WOLKEN_IDS.includes(b);

function liesKoerper(req) {
  return new Promise((ok, fehler) => {
    const teile = [];
    req.on('data', (c) => teile.push(c));
    req.on('end', () => ok(Buffer.concat(teile)));
    req.on('error', fehler);
  });
}

class StatsProxy extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.nr = 0;
  }

  listen(port) {
    return new Promise((ok, fehler) => {
      this.server = http.createServer((q, s) =>
        this.handle(q, s).catch((err) => {
          if (!s.headersSent) s.writeHead(502, { 'content-type': 'application/json' });
          s.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Glowline: ' + err.message } }));
        })
      );
      this.server.requestTimeout = 0;
      this.server.headersTimeout = 0;
      this.server.on('error', fehler);
      this.server.listen(port, '127.0.0.1', ok);
    });
  }

  async handle(req, res) {
    // Browser schicken immer einen Origin mit (bei DNS-Rebinding auch einen fremden Host). Solche Anfragen nie
    // weiterreichen, sonst koennte eine Webseite ueber Glowline die eigenen API-Schluessel benutzen.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(host)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://lokal');
    let pfad = url.pathname, tab = null, backend = 'auto';
    const s = /^\/s\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pfad);
    if (s) { tab = s[1]; backend = s[2]; pfad = s[3] || '/'; }
    if (backend === 'auto') backend = this.cfg.defaultBackend || 'ollama';

    const roh = await liesKoerper(req);
    let json = null;
    if (roh.length && (req.headers['content-type'] || '').includes('json')) {
      try { json = JSON.parse(roh.toString('utf8')); } catch {}
    }

    let model = json && typeof json.model === 'string' ? json.model : null;
    if (model) {
      const t = teileModell(model);
      if (t.backend) backend = t.backend;
      model = json.model = t.model;
      // Modelle, die in Ollama kein "Denken" koennen: Thinking-Felder entfernen
      if ((this.cfg.ohneDenken || []).includes(model)) {
        delete json.thinking; delete json.reasoning; delete json.reasoning_effort; delete json.think;
      }
    }
    const wolke = istWolke(backend) && this.wolke;
    if (!wolke && !this.cfg.backends[backend]) backend = 'ollama';

    if (!wolke && pfad === '/v1/messages/count_tokens') return this.zaehleTokens(req, res, backend, pfad + url.search, json);

    const kopf = {};
    for (const [k, v] of Object.entries(req.headers)) if (!WEG_ANFRAGE.has(k)) kopf[k] = v;
    // Cloud: der Schluessel kommt erst hier dazu (Platzhalter "glowline" wird ersetzt)
    const ziel = wolke ? this.wolke(backend, pfad, kopf) + url.search : this.cfg.backends[backend] + pfad + url.search;

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });

    const st = req.method === 'POST' && json && GEMESSEN.has(pfad) ? this.beginne(tab, backend, model, json) : null;

    let oben;
    try {
      oben = await fetch(ziel, {
        method: req.method,
        headers: kopf,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : json ? JSON.stringify(json) : roh,
        signal: ac.signal,
      });
    } catch (e) {
      if (st) this.beende(st, 'fehler', `${backend} not reachable`);
      throw new Error(`${backend} not reachable (${(e.cause && e.cause.code) || e.message})`);
    }

    const rk = {};
    oben.headers.forEach((v, k) => { if (!WEG_ANTWORT.has(k)) rk[k] = v; });
    res.writeHead(oben.status, rk);
    if (!oben.body) { res.end(); if (st) this.beende(st, oben.ok ? 'ok' : 'fehler'); return; }

    const strom = (oben.headers.get('content-type') || '').includes('event-stream');
    const dec = new TextDecoder();
    let puffer = '', ganz = '';
    try {
      for await (const stueck of oben.body) {
        res.write(stueck);
        if (!st) continue;
        const text = dec.decode(stueck, { stream: true });
        if (strom && oben.ok) {
          puffer += text;
          let i;
          while ((i = puffer.indexOf('\n')) >= 0) {
            const zeile = puffer.slice(0, i).trim();
            puffer = puffer.slice(i + 1);
            if (zeile.startsWith('data:')) this.ereignis(st, zeile.slice(5).trim());
          }
        } else if (ganz.length < 4e6) ganz += text;
      }
    } catch {
      if (st) this.beende(st, 'abgebrochen');
      res.end();
      return;
    }
    res.end();
    if (!st) return;
    if (!oben.ok) return this.beende(st, 'fehler', fehlerText(ganz) || `HTTP ${oben.status}`);
    if (!strom && ganz) { try { this.verbrauch(st, JSON.parse(ganz).usage); } catch {} }
    this.beende(st, 'ok');
  }

  // Ollama kennt count_tokens nicht immer -> grob schaetzen statt Fehler
  async zaehleTokens(req, res, backend, pfad, json) {
    try {
      const r = await fetch(this.cfg.backends[backend] + pfad, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json || {}),
      });
      if (r.ok) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(await r.text()); }
    } catch {}
    const n = Math.ceil(JSON.stringify([json && json.system, json && json.messages, json && json.tools]).length / 3.5);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: n }));
  }

  beginne(tab, backend, model, json) {
    const st = {
      id: ++this.nr, tab, backend, model, t0: Date.now(), erstes: 0, deltas: 0,
      eingabe: 0, ausgabe: 0, gesendet: 0, max: json.max_tokens || json.max_output_tokens || null,
    };
    this.emit('stat', { phase: 'start', id: st.id, tab, backend, model, t0: st.t0 });
    return st;
  }

  verbrauch(st, u) {
    if (!u) return;
    // Anthropic-Format: input_tokens = nur neu verarbeitete, Cache kommt extra.
    // OpenAI-Format: prompt_tokens = alles, davon cached_tokens aus dem Cache.
    const cache = u.cache_read_input_tokens ?? (u.prompt_tokens_details || u.input_tokens_details || {}).cached_tokens ?? 0;
    let ein, neu;
    if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
      neu = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      ein = neu + (u.cache_read_input_tokens || 0);
    } else {
      ein = u.input_tokens ?? u.prompt_tokens ?? 0;
      neu = Math.max(0, ein - cache);
    }
    const aus = u.output_tokens ?? u.completion_tokens ?? 0;
    if (ein > 0) { st.eingabe = ein; st.neu = neu; }
    if (aus > 0) st.ausgabe = aus;
  }

  ereignis(st, daten) {
    if (!daten || daten === '[DONE]') return;
    let d;
    try { d = JSON.parse(daten); } catch { return; }
    const t = d.type;
    let token = false;
    if (t === 'content_block_delta') token = true;
    else if (t === 'message_start') this.verbrauch(st, d.message && d.message.usage);
    else if (t === 'message_delta') this.verbrauch(st, d.usage);
    else if (typeof t === 'string' && t.startsWith('response.')) {
      if (t.endsWith('.delta')) token = true;
      else if (t === 'response.completed' || t === 'response.incomplete') this.verbrauch(st, d.response && d.response.usage);
    } else if (Array.isArray(d.choices)) {
      const dl = d.choices[0] && (d.choices[0].delta || d.choices[0]);
      if (dl && (dl.content || dl.reasoning || dl.reasoning_content || dl.tool_calls || dl.text)) token = true;
      if (d.usage) this.verbrauch(st, d.usage);
    }
    if (token) this.tick(st);
  }

  tick(st) {
    const jetzt = Date.now();
    st.deltas++;
    if (!st.erstes) {
      st.erstes = jetzt;
      this.emit('stat', { phase: 'erstes', id: st.id, tab: st.tab, ttft: (jetzt - st.t0) / 1000, eingabe: st.eingabe });
    }
    if (jetzt - st.gesendet < 150) return;
    st.gesendet = jetzt;
    const dauer = (jetzt - st.erstes) / 1000;
    this.emit('stat', {
      phase: 'lauf', id: st.id, tab: st.tab, tokens: st.deltas,
      tps: dauer > 0.6 && st.deltas >= 8 ? (st.deltas - 1) / dauer : null,
    });
  }

  beende(st, status, meldung) {
    const ende = Date.now();
    const aus = st.ausgabe || st.deltas;
    const ttft = st.erstes ? (st.erstes - st.t0) / 1000 : null;
    // Nur wenn wirklich Token fuer Token gestreamt wurde, ist (Tokens / Streamzeit) die echte Geschwindigkeit.
    // Kommt z. B. ein Tool-Aufruf am Stueck, waere das Zeitfenster winzig -> unrealistische Spitzen.
    const fenster = (ende - (st.erstes || ende)) / 1000;
    const dekodier = st.erstes && st.deltas >= 8 && fenster >= 0.5 && st.deltas >= aus * 0.7
      ? (Math.max(aus, st.deltas) - 1) / fenster
      : null;
    this.emit('stat', {
      phase: 'ende', id: st.id, tab: st.tab, backend: st.backend, model: st.model, status, meldung: meldung || null,
      eingabe: st.eingabe, ausgabe: aus, ttft, dauer: (ende - st.t0) / 1000,
      neu: st.neu, tps: dekodier,
      // Prefill nur aus wirklich neu verarbeiteten Tokens (Cache-Treffer kosten keine Rechenzeit)
      prefill: st.neu > 32 && ttft ? st.neu / ttft : null,
    });
  }
}

function fehlerText(roh) {
  try {
    const j = JSON.parse(roh);
    return (j.error && (j.error.message || j.error)) || j.message || null;
  } catch { return roh ? roh.slice(0, 200) : null; }
}

module.exports = {
  istWolke, StatsProxy, teileModell };
