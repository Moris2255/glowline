// Studio-Werkzeuge fuer Claude Code, Codex und OpenCode (MCP ueber HTTP, nur 127.0.0.1).
// Ein zufaelliger Schluessel im Pfad sorgt dafuer, dass nur von Glowline gestartete Agenten sie benutzen koennen.
const http = require('http');
const crypto = require('crypto');

const PORT = 3461;
const schluessel = crypto.randomBytes(18).toString('hex');
const url = () => `http://127.0.0.1:${PORT}/mcp/${schluessel}`;

const WERKZEUGE = [
  {
    name: 'studio_status',
    description: 'Lists the Glowline Studio models (image, video, upscale, voice) and whether they are downloaded. Call this first if unsure.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_image',
    description: 'Generates an image locally on this PC with Glowline Studio and returns the file path. Write the prompt in English, detailed and visual.',
    inputSchema: {
      type: 'object', required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', enum: ['flux2-klein', 'z-image'], description: 'Default: the first downloaded one' },
        width: { type: 'integer', minimum: 256, maximum: 2048, default: 1024 },
        height: { type: 'integer', minimum: 256, maximum: 2048, default: 1024 },
        seed: { type: 'integer' },
      },
    },
  },
  {
    name: 'generate_video',
    description: 'Generates a short video (up to 5 s, Wan 2.2) locally and returns the mp4 path. Can start from an image. Takes several minutes.',
    inputSchema: {
      type: 'object', required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        seconds: { type: 'number', minimum: 1, maximum: 5, default: 5 },
        width: { type: 'integer', default: 1280 },
        height: { type: 'integer', default: 704 },
        start_image: { type: 'string', description: 'Absolute path of an image to animate (optional)' },
      },
    },
  },
  {
    name: 'upscale_image',
    description: 'Upscales an image 4× (Real-ESRGAN) and returns the new file path.',
    inputSchema: { type: 'object', required: ['image'], properties: { image: { type: 'string', description: 'Absolute path' } } },
  },
  {
    name: 'text_to_speech',
    description: 'Speaks a text with Chatterbox (local) and returns a wav path. Optionally clones the voice from a short sample. Only clone voices you have permission to use.',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: {
        text: { type: 'string' },
        language: { type: 'string', default: 'de', description: 'Language code, e.g. de, en, fr' },
        voice_sample: { type: 'string', description: 'Absolute path of a 5-15 s wav/mp3 sample (optional)' },
      },
    },
  },
];

function starten(studio, vorVramFrei, version) {
  let nr = 0;
  const ergebnis = (id, result) => ({ jsonrpc: '2.0', id, result });
  const text = (t, fehler) => ({ content: [{ type: 'text', text: t }], isError: !!fehler });

  async function rufe(name, a) {
    const st = studio.status();
    if (name === 'studio_status') {
      if (!st.eingerichtet) return text('Glowline Studio is not set up yet. Ask the user to open Studio in Glowline (tool menu) and click "Set up".');
      return text(Object.values(st.modelle).filter((m) => !m.wolke).map((m) => `${m.id} (${m.art}): ${m.name} – ${m.da ? 'ready' : 'not downloaded'}`).join('\n'));
    }
    if (!st.eingerichtet) return text('Glowline Studio is not set up yet. Ask the user to open Studio in Glowline and click "Set up".', true);
    const da = (art) => Object.values(st.modelle).filter((m) => m.art === art && m.da).map((m) => m.id);
    let auftrag;
    if (name === 'generate_image') {
      const modell = a.model && st.modelle[a.model] && st.modelle[a.model].art === 'bild' ? a.model : da('bild')[0];
      auftrag = { modell, prompt: String(a.prompt || ''), breite: a.width, hoehe: a.height, seed: a.seed };
    } else if (name === 'generate_video') {
      auftrag = { modell: 'wan22-5b', prompt: String(a.prompt || ''), negativ: a.negative_prompt, sekunden: Math.min(5, Math.max(1, +a.seconds || 5)), breite: a.width || 1280, hoehe: a.height || 704, bildDatei: a.start_image };
    } else if (name === 'upscale_image') {
      auftrag = { modell: 'esrgan-x4', bildDatei: a.image };
    } else if (name === 'text_to_speech') {
      auftrag = { modell: 'chatterbox', prompt: String(a.text || ''), sprache: a.language || 'de', bildDatei: a.voice_sample };
    } else return text('Unknown tool ' + name, true);
    if (!auftrag.modell || !st.modelle[auftrag.modell] || !st.modelle[auftrag.modell].da) {
      return text('The model for this is not downloaded. Ask the user to download it in Glowline Studio.', true);
    }
    const r = await studio.auftrag({ ...auftrag, id: 'agent' + ++nr, vonAgent: true }, vorVramFrei);
    if (r.fehler) return text('Failed: ' + r.fehler, true);
    return text('Done. File(s):\n' + r.dateien.join('\n'));
  }

  async function nachricht(m) {
    if (!m || m.jsonrpc !== '2.0' || !m.method) return null;
    if (m.id === undefined) return null; // Benachrichtigung
    if (m.method === 'initialize') {
      return ergebnis(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'glowline-studio', version },
        instructions: 'Local image, video, upscale and voice generation on this PC. Results are saved files; tell the user the path.',
      });
    }
    if (m.method === 'ping') return ergebnis(m.id, {});
    if (m.method === 'tools/list') return ergebnis(m.id, { tools: WERKZEUGE });
    if (m.method === 'tools/call') {
      try { return ergebnis(m.id, await rufe(m.params.name, m.params.arguments || {})); } catch (e) { return ergebnis(m.id, text('Failed: ' + e.message, true)); }
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }

  const server = http.createServer((req, res) => {
    // nur unser Pfad, keine Browser (die schicken einen Origin mit)
    if (req.url !== `/mcp/${schluessel}` || req.headers.origin) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    let roh = '';
    req.on('data', (d) => { roh += d; if (roh.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let m;
      try { m = JSON.parse(roh); } catch { res.writeHead(400).end(); return; }
      const antworten = (await Promise.all((Array.isArray(m) ? m : [m]).map(nachricht))).filter(Boolean);
      if (!antworten.length) { res.writeHead(202).end(); return; }
      const out = JSON.stringify(Array.isArray(m) ? antworten : antworten[0]);
      res.writeHead(200, { 'content-type': 'application/json' }).end(out);
    });
  });
  server.requestTimeout = 0; // Videos dauern
  server.on('error', () => {});
  server.listen(PORT, '127.0.0.1');
  return server;
}

module.exports = { starten, url, PORT };
