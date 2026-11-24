// Studio-Werkzeuge und der Obsidian-Vault fuer Claude Code, Codex, OpenCode und Qwen Code (MCP ueber HTTP, nur 127.0.0.1).
// Ein zufaelliger Schluessel im Pfad sorgt dafuer, dass nur von Glowline gestartete Agenten sie benutzen koennen.
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.GLOWLINE_TEST ? 3467 : 3461; // Selbsttest eigener Port – die echte App laeuft oft nebenher
const schluessel = crypto.randomBytes(18).toString('hex');
const url = () => `http://127.0.0.1:${PORT}/mcp/${schluessel}`;
const urlObsidian = () => `http://127.0.0.1:${PORT}/mcp/${schluessel}/obsidian`;
const urlGedaechtnis = (aufgabe) => `http://127.0.0.1:${PORT}/mcp/${schluessel}/gedaechtnis/${aufgabe}`;

// Arbeitsgedaechtnis der Aufgabe: kurz, nur fuer diese Sitzung – uebersteht /clear und das Zusammenfassen
const GEDAECHTNIS_HINWEIS = 'Your working memory for the current task – a short note that survives /clear and context compaction and is erased when the user ends the task. '
  + 'At the start of every session and right after the context was cleared or compacted, call read_memory first. '
  + 'Keep it current while you work, without being asked: the goal, what is done, decisions and why, key file paths, open problems and the next steps. '
  + 'Update it after each meaningful step and before long operations. Keep it short (bullet points, max ~20 000 characters) – rewrite it with write_memory when it gets long. '
  + 'Don\'t copy file contents or the chat into it; it is only for what you would otherwise forget.';
const GEDAECHTNIS = [
  { name: 'read_memory', description: 'Reads the working memory of the current task. Call it first in every session and after the context was cleared or compacted.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'write_memory', description: 'Replaces the whole working memory (use it to restructure or condense). Markdown, short bullet points.',
    inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
  { name: 'append_memory', description: 'Adds lines to the end of the working memory.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  { name: 'edit_memory', description: 'Replaces one exact piece of text in the working memory (must occur exactly once), e.g. to tick off a step.',
    inputSchema: { type: 'object', required: ['old_text', 'new_text'], properties: { old_text: { type: 'string' }, new_text: { type: 'string' } } } },
];
// Archiv der Aufgabe ("virtueller Kontext"): gross, durchsuchbar, nur die passenden Stellen kommen zurueck
const ARCHIV = [
  { name: 'archive_save', description: 'Saves something to the task archive for later: findings, analyses, error logs, documentation you read, intermediate results, details behind the short memory note. Give it a clear title.',
    inputSchema: { type: 'object', required: ['title', 'text'], properties: { title: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'archive_search', description: 'Searches the task archive and returns the best matching passages (with entry numbers). Use it before re-reading files or redoing work.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 15, default: 5 } } } },
  { name: 'archive_read', description: 'Reads one whole archive entry by its number.',
    inputSchema: { type: 'object', required: ['number'], properties: { number: { type: 'integer' } } } },
];
const tausend = (n) => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n < 1000 ? String(n) : Math.round(n / 1000) + 'k';
const archivHinweis = (max) => ` You also have a task archive of ${tausend(max)} tokens – a virtual extension of your context window. `
  + 'Whenever you read something big (docs, long files, logs) or work out details (analyses, findings, intermediate results), save the details there with archive_save and keep only a one-line pointer in the memory note. '
  + 'Later, archive_search finds the right passages instead of re-reading files or redoing work; only those come back into your context. '
  + `The archive holds at most ${tausend(max)} tokens for this task – when it is full, nothing more can be added.`;

// Obsidian-Vault ("Gehirn"): darf alles lesen und aendern, ohne Nachfrage – Glowline sichert alte Fassungen
const OBSIDIAN = [
  { name: 'search_notes', description: 'Full-text search in the user\'s Obsidian vault (their knowledge base). Returns the best matching notes with a snippet. Search here first when a task touches what the user knows, likes or has written down.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 6 } } } },
  { name: 'read_note', description: 'Reads a note. Path relative to the vault, e.g. "Wissen/Python.md" – a plain note name like "Python" also works.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'list_notes', description: 'Lists all notes in the vault or in one folder of it.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Folder relative to the vault (optional)' } } } },
  { name: 'write_note', description: 'Creates a note or replaces its whole content. Markdown with [[wikilinks]] and optional YAML front matter. Folders are created as needed.',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean', default: true } } } },
  { name: 'edit_note', description: 'Replaces one exact piece of text in a note (must occur exactly once). Read the note first.',
    inputSchema: { type: 'object', required: ['path', 'old_text', 'new_text'], properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } } } },
  { name: 'append_to_note', description: 'Adds text to the end of a note (creates it if missing).',
    inputSchema: { type: 'object', required: ['path', 'text'], properties: { path: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'move_note', description: 'Renames or moves a note. [[Links]] to it are updated in all other notes.',
    inputSchema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'delete_note', description: 'Moves a note to the vault trash (.trash), like deleting in Obsidian.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'note_links', description: 'Shows which notes a note links to and which notes link to it.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
];

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

function starten(studio, vorVramFrei, version, gehirn, gedaechtnis) {
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

  function rufeObsidian(name, a) {
    if (name === 'search_notes') {
      const r = gehirn.suche(String(a.query || ''), Math.min(20, Math.max(1, +a.limit || 6)));
      return text(r.length ? r.map((x) => `## ${x.rel}${x.kopf && x.kopf !== x.titel ? ' › ' + x.kopf : ''}\n${x.text.slice(0, 700)}`).join('\n\n') : 'No matching notes. Try other words, or list_notes.');
    }
    if (name === 'read_note') { const r = gehirn.lese(a.path); return text(`# ${r.rel}\n\n${r.text}`); }
    if (name === 'list_notes') { const r = gehirn.liste(a.folder ? String(a.folder) : ''); return text(`Vault "${r.vault}" – ${r.notizen.length} notes:\n` + r.notizen.join('\n')); }
    if (name === 'write_note') { const r = gehirn.schreibe(a.path, String(a.content ?? ''), a.overwrite !== false); return text((r.neu ? 'Created ' : 'Updated ') + r.rel); }
    if (name === 'edit_note') { const r = gehirn.ersetze(a.path, a.old_text, String(a.new_text ?? '')); return text('Changed ' + r.rel); }
    if (name === 'append_to_note') { const r = gehirn.anhaengen(a.path, String(a.text ?? '')); return text('Appended to ' + r.rel); }
    if (name === 'move_note') { const r = gehirn.verschiebe(a.from, a.to); return text(`Moved ${r.von} → ${r.nach}` + (r.links ? ` (updated links in ${r.links} notes)` : '')); }
    if (name === 'delete_note') { const r = gehirn.loesche(a.path); return text(`Moved ${r.rel} to the vault trash`); }
    if (name === 'note_links') { const r = gehirn.links(a.path); return text(`${r.rel}\nLinks to: ${r.ausgehend.join(', ') || '–'}\nLinked from: ${r.eingehend.join(', ') || '–'}`); }
    return text('Unknown tool ' + name, true);
  }

  function rufeGedaechtnis(aufgabe, name, a) {
    if (name === 'read_memory') {
      const t = gedaechtnis.lese(aufgabe), st = gedaechtnis.archivStand(aufgabe);
      const archiv = st.max ? `\n\n---\nArchive: ${st.eintraege} entries, ~${tausend(st.belegt)} of ${tausend(st.max)} tokens used${st.eintraege ? ' – search it with archive_search' : ''}.` : '';
      return text((t ? t : '(empty – nothing saved yet for this task. Start it with write_memory: goal, plan, next steps.)') + archiv);
    }
    if (name === 'archive_save') { const r = gedaechtnis.archivSpeichere(aufgabe, a.title, a.text); return text(`Saved as entry #${r.nr} (~${r.tokens} tokens). Archive: ~${tausend(r.belegt)} of ${tausend(r.max)} tokens used.`); }
    if (name === 'archive_search') {
      const r = gedaechtnis.archivSuche(aufgabe, String(a.query || ''), Math.min(15, Math.max(1, +a.limit || 5)));
      return text(r.length ? r.map((x) => `## #${x.nr} ${x.titel}\n${x.text}`).join('\n\n') : 'Nothing found in the archive. Try other words.');
    }
    if (name === 'archive_read') { const e = gedaechtnis.archivEintrag(aufgabe, a.number); return text(`# #${e.nr} ${e.titel}\n\n${e.text}`); }
    // Erinnerung, solange das Archiv leer ist: Details gehoeren dorthin, nicht in die kurze Notiz
    const tipp = () => { const st = gedaechtnis.archivStand(aufgabe); return st.max && !st.eintraege ? ' Tip: your archive is still empty – save the details of what you read or worked out (analyses, findings, docs, logs) with archive_save now, so a later session can search them instead of redoing the work.' : ''; };
    if (name === 'write_memory') { const n = gedaechtnis.schreibe(aufgabe, a.content); return text(`Saved (${n} characters).` + tipp()); }
    if (name === 'append_memory') { const n = gedaechtnis.anhaengen(aufgabe, a.text); return text(`Added (${n} characters in total).` + tipp()); }
    if (name === 'edit_memory') { const n = gedaechtnis.ersetze(aufgabe, a.old_text, a.new_text); return text(`Changed (${n} characters).` + tipp()); }
    return text('Unknown tool ' + name, true);
  }

  async function nachricht(m, art, aufgabe) {
    const obsidian = art === 'obsidian';
    if (!m || m.jsonrpc !== '2.0' || !m.method) return null;
    if (m.id === undefined) return null; // Benachrichtigung
    if (m.method === 'initialize' && art === 'gedaechtnis') {
      return ergebnis(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'glowline-memory', version },
        instructions: GEDAECHTNIS_HINWEIS + (gedaechtnis.archivStand(aufgabe).max ? archivHinweis(gedaechtnis.archivStand(aufgabe).max) : ''),
      });
    }
    if (m.method === 'initialize' && obsidian) {
      const v = gehirn.aktiv();
      return ergebnis(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'glowline-obsidian', version },
        instructions: `The user's Obsidian vault${v ? ' "' + v.name + '"' : ''} – their second brain. Search and read it whenever a task touches their knowledge. You may create, change, move and delete notes freely, no need to ask: Glowline keeps a backup of every old version. Write Markdown with [[wikilinks]], keep the vault's folder structure and style.`,
      });
    }
    if (m.method === 'initialize') {
      return ergebnis(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'glowline-studio', version },
        instructions: 'Local image, video, upscale and voice generation on this PC. Results are saved files; tell the user the path.',
      });
    }
    if (m.method === 'ping') return ergebnis(m.id, {});
    if (m.method === 'tools/list') return ergebnis(m.id, { tools: art === 'gedaechtnis' ? (gedaechtnis.archivStand(aufgabe).max ? [...GEDAECHTNIS, ...ARCHIV] : GEDAECHTNIS) : obsidian ? OBSIDIAN : WERKZEUGE });
    if (m.method === 'tools/call') {
      const n = m.params.name, a = m.params.arguments || {};
      try { return ergebnis(m.id, art === 'gedaechtnis' ? rufeGedaechtnis(aufgabe, n, a) : obsidian ? rufeObsidian(n, a) : await rufe(n, a)); } catch (e) { return ergebnis(m.id, text('Failed: ' + e.message, true)); }
    }
    return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
  }

  const server = http.createServer((req, res) => {
    // nur unser Pfad, keine Browser (die schicken einen Origin mit)
    const basis = `/mcp/${schluessel}`;
    const g = req.url.startsWith(basis + '/gedaechtnis/') && gedaechtnis ? req.url.slice(basis.length + 13) : null;
    const art = req.url === basis ? 'studio' : req.url === basis + '/obsidian' && gehirn ? 'obsidian' : g && gedaechtnis.gueltig(g) ? 'gedaechtnis' : null;
    if (!art || req.headers.origin) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    let roh = '';
    req.on('data', (d) => { roh += d; if (roh.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let m;
      try { m = JSON.parse(roh); } catch { res.writeHead(400).end(); return; }
      const antworten = (await Promise.all((Array.isArray(m) ? m : [m]).map((x) => nachricht(x, art, g)))).filter(Boolean);
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

module.exports = { starten, url, urlObsidian, urlGedaechtnis, PORT };
