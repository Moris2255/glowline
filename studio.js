// Studio: Bilder, Video, Upscaling und Stimme komplett in Glowline.
// Glowline richtet einen eigenen, abgeschotteten Python-Motor ein (uv + Python + PyTorch CUDA + ComfyUI)
// und steuert ihn unsichtbar im Hintergrund. Nichts davon muss man selbst installieren.
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const http = require('http');

const COMFY_PORT = 8189;
const STIMME_PORT = 8190;
const COMFY_ZIP = 'https://api.github.com/repos/Comfy-Org/ComfyUI/zipball/v0.45.0';
const UV_ZIP = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
const HF = 'https://huggingface.co';

// Ausgewaehlte Modelle: die besten, die auf normalen Grafikkarten laufen, mit freien Lizenzen
const KATALOG = {
  'flux2-klein': {
    art: 'bild', name: 'FLUX.2 klein 4B', info: 'Fast and sharp, 4 steps', lizenz: 'Apache-2.0', vram: 8,
    dateien: [
      { repo: 'Comfy-Org/Flux-2-Klein-4B', pfad: 'split_files/diffusion_models/flux-2-klein-4b.safetensors', ziel: 'diffusion_models', groesse: 7.75e9 },
      { repo: 'Comfy-Org/Flux-2-Klein-4B', pfad: 'split_files/text_encoders/qwen_3_4b.safetensors', ziel: 'text_encoders', groesse: 8.04e9 },
      { repo: 'Comfy-Org/Flux-2-Klein-4B', pfad: 'split_files/vae/flux2-vae.safetensors', ziel: 'vae', groesse: 0.34e9 },
    ],
  },
  'z-image': {
    art: 'bild', name: 'Z-Image Turbo', info: 'Photorealistic, great with text', lizenz: 'Apache-2.0', vram: 8,
    dateien: [
      { repo: 'Comfy-Org/z_image_turbo', pfad: 'split_files/diffusion_models/z_image_turbo_bf16.safetensors', ziel: 'diffusion_models', groesse: 12.31e9 },
      { repo: 'Comfy-Org/z_image_turbo', pfad: 'split_files/text_encoders/qwen_3_4b.safetensors', ziel: 'text_encoders', groesse: 8.04e9 },
      { repo: 'Comfy-Org/z_image_turbo', pfad: 'split_files/vae/ae.safetensors', ziel: 'vae', groesse: 0.34e9 },
    ],
  },
  'wan22-5b': {
    art: 'video', name: 'Wan 2.2 5B', info: 'Text or image to video, 720p, ~5 s', lizenz: 'Apache-2.0', vram: 8,
    dateien: [
      { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', pfad: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', ziel: 'diffusion_models', groesse: 10.0e9 },
      { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', pfad: 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', ziel: 'text_encoders', groesse: 6.74e9 },
      { repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged', pfad: 'split_files/vae/wan2.2_vae.safetensors', ziel: 'vae', groesse: 1.41e9 },
    ],
  },
  'esrgan-x4': {
    art: 'upscale', name: 'Real-ESRGAN x4', info: '4× sharper, for photos and renders', lizenz: 'BSD-3', vram: 2,
    dateien: [{ repo: 'Comfy-Org/Real-ESRGAN_repackaged', pfad: 'RealESRGAN_x4plus.safetensors', ziel: 'upscale_models', groesse: 0.07e9 }],
  },
  chatterbox: {
    art: 'stimme', name: 'Chatterbox Multilingual', info: 'Voice cloning from a short sample, 20+ languages incl. German', lizenz: 'MIT', vram: 4,
    dateien: [], // laedt sich beim ersten Einsatz selbst (Hugging Face), siehe stimme.py
  },
};

let basis = null, sende = () => {};
let comfy = null, stimme = null;
const laufend = new Map(); // Vorgang -> AbortController
const dateiLaedt = new Map(); // Zieldatei -> laufender Download (Modelle teilen sich Dateien)
// Wartet auf ein Versprechen, bricht aber sofort ab, wenn der Nutzer "Cancel" drueckt
function mitAbbruch(versprechen, ac) {
  if (ac.signal.aborted) return Promise.reject(new Error('cancelled'));
  return Promise.race([versprechen, new Promise((_, f) => ac.signal.addEventListener('abort', () => f(new Error('cancelled')), { once: true }))]);
}

const P = () => ({
  basis,
  uv: path.join(basis, 'uv', 'uv.exe'),
  python: path.join(basis, 'python'),
  cache: path.join(basis, 'cache'),
  comfy: path.join(basis, 'comfy'),
  venv: path.join(basis, 'venv'),
  py: path.join(basis, 'venv', 'Scripts', 'python.exe'),
  stimmeVenv: path.join(basis, 'stimme-venv'),
  stimmePy: path.join(basis, 'stimme-venv', 'Scripts', 'python.exe'),
  hf: path.join(basis, 'hf'),
  modelle: path.join(basis, 'comfy', 'models'),
  ausgabe: path.join(basis, 'ausgabe'),
  eingabe: path.join(basis, 'eingabe'),
  bereit: path.join(basis, 'bereit.json'),
  stimmeBereit: path.join(basis, 'stimme-bereit.json'),
});

function init(ordner, senden) {
  basis = ordner;
  sende = senden;
}

const uvEnv = () => ({ ...process.env, UV_PYTHON_INSTALL_DIR: P().python, UV_CACHE_DIR: P().cache, UV_NO_COLOR: '1', PYTHONUTF8: '1' });

function status() {
  const p = P();
  const modelle = {};
  for (const [id, m] of Object.entries(KATALOG)) {
    const fehlt = m.dateien.filter((d) => !fs.existsSync(path.join(p.modelle, d.ziel, path.basename(d.pfad))));
    modelle[id] = {
      ...m, id, dateien: undefined,
      da: m.art === 'stimme' ? fs.existsSync(p.stimmeBereit) : !fehlt.length,
      groesse: m.dateien.reduce((s, d) => s + d.groesse, 0),
      fehltGroesse: fehlt.reduce((s, d) => s + d.groesse, 0),
      teilweise: fehlt.reduce((s, d) => { try { return s + fs.statSync(path.join(p.modelle, d.ziel, path.basename(d.pfad)) + '.part').size; } catch { return s; } }, 0),
      laedt: laufend.has('modell:' + id),
    };
  }
  return {
    ordner: basis,
    eingerichtet: fs.existsSync(p.bereit),
    richtetEin: laufend.has('einrichten'),
    motor: comfy ? (comfy.bereit ? 'laeuft' : 'startet') : 'aus',
    modelle,
  };
}

// ---------- Hilfen ----------
function befehl(exe, args, opt, melde) {
  return new Promise((ok, fehler) => {
    const p = spawn(exe, args, { windowsHide: true, ...opt });
    let rest = '';
    const zeile = (d) => {
      rest = (rest + d).slice(-4000);
      const z = String(d).split(/\r?\n|\r/).map((x) => x.trim()).filter(Boolean).pop();
      if (z && melde) melde(z.slice(0, 160));
    };
    p.stdout.on('data', zeile);
    p.stderr.on('data', zeile);
    if (opt && opt.signal) opt.signal.addEventListener('abort', () => baumWeg(p));
    p.on('error', fehler);
    p.on('exit', (c) => (c === 0 ? ok() : fehler(new Error(`${path.basename(exe)} failed (${c}): ${rest.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`))));
  });
}

// Grosse Dateien: ein abgebrochener Download macht beim naechsten Mal dort weiter (.part)
async function ladeDatei(url, ziel, ac, fortschritt, kopf) {
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  const teil = ziel + '.part';
  let schon = 0;
  try { schon = fs.statSync(teil).size; } catch {}
  const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'Glowline', ...(kopf || {}), ...(schon ? { range: `bytes=${schon}-` } : {}) }, redirect: 'follow' });
  if (r.status === 416 && schon) { fs.renameSync(teil, ziel); return; }
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
  const weiter = r.status === 206;
  if (!weiter) schon = 0;
  const gesamt = (+r.headers.get('content-length') || 0) + schon;
  const out = fs.createWriteStream(teil, { flags: weiter ? 'a' : 'w' });
  let geladen = schon;
  try {
    for await (const stueck of r.body) {
      geladen += stueck.length;
      if (!out.write(stueck)) await new Promise((ok) => out.once('drain', ok));
      fortschritt(geladen, gesamt);
    }
    await new Promise((ok, f) => out.end((e) => (e ? f(e) : ok())));
    fs.renameSync(teil, ziel);
  } catch (e) {
    out.destroy();
    await new Promise((ok) => out.on('close', ok));
    // nur kleine Reste wegwerfen, grosse Teile behalten zum Weitermachen
    try { if (fs.statSync(teil).size < 50e6) fs.rmSync(teil, { force: true }); } catch {}
    throw e;
  }
}

function entpacke(zip, ziel) {
  return new Promise((ok, fehler) => execFile('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${ziel.replace(/'/g, "''")}' -Force`],
  { windowsHide: true, timeout: 600000 }, (e) => (e ? fehler(e) : ok())));
}

// ---------- Einrichten (einmalig, ~5 GB) ----------
const SCHRITTE = ['Downloading the setup tool', 'Installing Python', 'Downloading the engine', 'Installing PyTorch (largest step)', 'Installing engine parts'];
async function einrichten() {
  if (laufend.has('einrichten')) return;
  const ac = new AbortController();
  laufend.set('einrichten', ac);
  const p = P();
  const melde = (schritt, text, anteil) => sende('studio', { vorgang: 'einrichten', schritt, schritte: SCHRITTE.length, titel: SCHRITTE[schritt], text, prozent: Math.round(((schritt + (anteil || 0)) / SCHRITTE.length) * 100) });
  try {
    fs.mkdirSync(p.basis, { recursive: true });
    if (!fs.existsSync(p.uv)) {
      const zip = path.join(p.basis, 'uv.zip');
      await ladeDatei(UV_ZIP, zip, ac, (g, t) => melde(0, `${Math.round(g / 1e6)} MB`, t ? g / t : 0));
      await entpacke(zip, path.join(p.basis, 'uv'));
      fs.rmSync(zip, { force: true });
    }
    melde(1, 'Python 3.12', 0);
    await befehl(p.uv, ['python', 'install', '3.12'], { env: uvEnv(), signal: ac.signal }, (z) => melde(1, z, 0.5));
    if (!fs.existsSync(path.join(p.comfy, 'main.py'))) {
      const zip = path.join(p.basis, 'comfy.zip');
      await ladeDatei(COMFY_ZIP, zip, ac, (g) => melde(2, `${Math.round(g / 1e6)} MB`, 0.5));
      const tmp = path.join(p.basis, 'comfy-tmp');
      fs.rmSync(tmp, { recursive: true, force: true });
      await entpacke(zip, tmp);
      const innen = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((n) => fs.existsSync(path.join(n, 'main.py')));
      if (!innen) throw new Error('Engine download is incomplete');
      // Modelle eines frueheren Versuchs behalten
      if (fs.existsSync(p.comfy)) fs.rmSync(p.comfy, { recursive: true, force: true });
      fs.renameSync(innen, p.comfy);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
    if (!fs.existsSync(p.py)) await befehl(p.uv, ['venv', p.venv, '--python', '3.12'], { env: uvEnv(), signal: ac.signal }, (z) => melde(2, z, 0.9));
    melde(3, 'about 3 GB – this takes a few minutes', 0);
    await befehl(p.uv, ['pip', 'install', '--python', p.py, 'torch', 'torchvision', 'torchaudio', '--index-url', TORCH_INDEX],
      { env: uvEnv(), signal: ac.signal }, (z) => melde(3, z, 0.5));
    melde(4, 'ComfyUI requirements', 0);
    await befehl(p.uv, ['pip', 'install', '--python', p.py, '-r', path.join(p.comfy, 'requirements.txt')],
      { env: uvEnv(), signal: ac.signal }, (z) => melde(4, z, 0.5));
    fs.mkdirSync(p.ausgabe, { recursive: true });
    fs.mkdirSync(p.eingabe, { recursive: true });
    fs.writeFileSync(p.bereit, JSON.stringify({ zeit: new Date().toISOString(), comfy: COMFY_ZIP }));
    sende('studio', { vorgang: 'einrichten', fertig: true });
  } catch (e) {
    sende('studio', { vorgang: 'einrichten', fertig: true, fehler: ac.signal.aborted ? 'cancelled' : e.message });
  } finally {
    laufend.delete('einrichten');
  }
}

// Stimme braucht eigene Pakete (andere PyTorch-Version), daher eine zweite Umgebung
async function stimmeEinrichten(ac, melde) {
  const p = P();
  await befehl(p.uv, ['python', 'install', '3.11'], { env: uvEnv(), signal: ac.signal }, melde);
  if (!fs.existsSync(p.stimmePy)) await befehl(p.uv, ['venv', p.stimmeVenv, '--python', '3.11'], { env: uvEnv(), signal: ac.signal }, melde);
  await befehl(p.uv, ['pip', 'install', '--python', p.stimmePy, 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124'],
    { env: uvEnv(), signal: ac.signal }, melde);
  await befehl(p.uv, ['pip', 'install', '--python', p.stimmePy, 'chatterbox-tts', 'setuptools<81'], { env: uvEnv(), signal: ac.signal }, melde);
  // Stimmenmodell gleich mitladen, damit der erste Einsatz nicht minutenlang wartet
  melde('Downloading the voice model (~3 GB)');
  await befehl(p.stimmePy, ['-c', "from chatterbox.mtl_tts import ChatterboxMultilingualTTS as C; C.from_pretrained(device='cpu')"],
    { env: { ...process.env, PYTHONUTF8: '1', HF_HOME: p.hf }, signal: ac.signal }, melde);
  fs.writeFileSync(p.stimmeBereit, JSON.stringify({ zeit: new Date().toISOString() }));
}

// ---------- Modelle laden ----------
async function modellHolen(id) {
  const m = KATALOG[id];
  const key = 'modell:' + id;
  if (!m || laufend.has(key)) return;
  const ac = new AbortController();
  laufend.set(key, ac);
  const p = P();
  const melde = (x) => sende('studio', { vorgang: key, ...x });
  try {
    if (m.art === 'stimme') {
      await stimmeEinrichten(ac, (z) => melde({ text: z }));
    } else {
      const fehlt = m.dateien.filter((d) => !fs.existsSync(path.join(p.modelle, d.ziel, path.basename(d.pfad))));
      // nur zaehlen, was wirklich fehlt (Dateien, die ein anderes Modell schon mitgebracht hat, nicht als Fortschritt anzeigen)
      const gesamt = fehlt.reduce((s, d) => s + d.groesse, 0) || 1;
      let vorher = 0;
      for (const d of fehlt) {
        const ziel = path.join(p.modelle, d.ziel, path.basename(d.pfad));
        // laedt ein anderes Modell diese Datei gerade? Dann darauf warten statt dieselbe .part-Datei doppelt zu schreiben
        while (dateiLaedt.has(ziel)) await mitAbbruch(dateiLaedt.get(ziel).catch(() => {}), ac);
        if (!fs.existsSync(ziel)) {
          const url = `${HF}/${d.repo}/resolve/main/${d.pfad.split('/').map(encodeURIComponent).join('/')}`;
          const laden = ladeDatei(url, ziel, ac, (g) => {
            const jetzt = vorher + g;
            melde({ completed: jetzt, total: gesamt, prozent: Math.min(100, Math.round((jetzt / gesamt) * 100)) });
          });
          dateiLaedt.set(ziel, laden);
          try { await laden; } finally { dateiLaedt.delete(ziel); }
        }
        vorher += d.groesse;
      }
    }
    melde({ fertig: true });
  } catch (e) {
    melde({ fertig: true, fehler: ac.signal.aborted ? 'cancelled' : e.message });
  } finally {
    laufend.delete(key);
  }
}

// Was laeuft gerade? (fuer die Rueckfrage beim Schliessen)
function beschaeftigt() {
  const k = [...laufend.keys()];
  return { auftraege: k.filter((x) => x.startsWith('auftrag:')).length, laden: k.filter((x) => x === 'einrichten' || x.startsWith('modell:')).length };
}
function abbrechen(vorgang) { const ac = laufend.get(vorgang); if (ac) ac.abort(); }

// ---------- Motor (ComfyUI) ----------
async function comfyStarten() {
  if (comfy && comfy.bereit) return;
  const p = P();
  if (!fs.existsSync(p.bereit)) throw new Error('Set up the Studio first');
  if (!comfy) {
    const proz = spawn(p.py, [path.join(p.comfy, 'main.py'), '--listen', '127.0.0.1', '--port', String(COMFY_PORT),
      '--output-directory', p.ausgabe, '--input-directory', p.eingabe, '--disable-auto-launch', '--preview-method', 'none'],
    { cwd: p.comfy, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', HF_HOME: p.hf } });
    comfy = { proz, bereit: false, log: '' };
    const merk = (d) => { comfy && (comfy.log = (comfy.log + d).slice(-6000)); };
    proz.stdout.on('data', merk);
    proz.stderr.on('data', merk);
    proz.on('exit', () => { comfy = null; });
  }
  for (let i = 0; i < 480; i++) {
    if (!comfy) throw new Error('The engine stopped while starting');
    try {
      const r = await fetch(`http://127.0.0.1:${COMFY_PORT}/system_stats`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { comfy.bereit = true; return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The engine did not start: ' + (comfy ? comfy.log.split('\n').slice(-4).join(' ') : ''));
}

// ganzen Prozessbaum beenden (das venv-python startet das echte Python als Kindprozess)
function baumWeg(proz) {
  if (!proz || proz.exitCode !== null) return;
  try { require('child_process').execFileSync('taskkill', ['/PID', String(proz.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { try { proz.kill(); } catch {} }
}
function stoppen() {
  if (comfy) { baumWeg(comfy.proz); comfy = null; }
  if (stimme) { baumWeg(stimme.proz); stimme = null; }
}

// Grafikspeicher fuer den Chat freigeben: Motor entlaedt seine Modelle, Stimmen-Dienst geht aus
async function frei() {
  if (stimme && ![...laufend.keys()].some((k) => k.startsWith('auftrag:'))) { baumWeg(stimme.proz); stimme = null; }
  await comfyFrei();
}
async function comfyFrei() {
  try { await fetch(`http://127.0.0.1:${COMFY_PORT}/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }); } catch {}
}

// ---------- Ablaeufe (ComfyUI-Workflows im API-Format) ----------
const zufall = () => Math.floor(Math.random() * 2 ** 48);
const dn = (pfad) => path.basename(pfad);
const D = (id, i) => dn(KATALOG[id].dateien[i].pfad);

function workflow(a) {
  const seed = Number.isFinite(+a.seed) && a.seed !== '' && a.seed != null ? +a.seed : zufall();
  const raster = a.modell === 'wan22-5b' ? 32 : 16; // Wan braucht Vielfache von 32
  const w = Math.max(256, Math.round((+a.breite || 1024) / raster) * raster), h = Math.max(256, Math.round((+a.hoehe || 1024) / raster) * raster);
  if (a.modell === 'flux2-klein') {
    return {
      1: { class_type: 'UNETLoader', inputs: { unet_name: D('flux2-klein', 0), weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: D('flux2-klein', 1), type: 'flux2', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: D('flux2-klein', 2) } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['2', 0] } },
      5: { class_type: 'EmptyFlux2LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      6: { class_type: 'Flux2Scheduler', inputs: { steps: +a.schritte || 4, width: w, height: h } },
      7: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      8: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
      9: { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['10', 0], cfg: 1 } },
      10: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      11: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['8', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['6', 0], latent_image: ['5', 0] } },
      12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
      13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'bild/glowline' } },
    };
  }
  if (a.modell === 'z-image') {
    return {
      1: { class_type: 'UNETLoader', inputs: { unet_name: D('z-image', 0), weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: D('z-image', 1), type: 'lumina2', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: D('z-image', 2) } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['2', 0] } },
      5: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      6: { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      7: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
      8: { class_type: 'KSampler', inputs: { model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed, steps: +a.schritte || 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1 } },
      9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'bild/glowline' } },
    };
  }
  if (a.modell === 'wan22-5b') {
    const wf = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: D('wan22-5b', 0), weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: D('wan22-5b', 1), type: 'wan', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: D('wan22-5b', 2) } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['2', 0] } },
      5: { class_type: 'CLIPTextEncode', inputs: { text: a.negativ || 'blurry, low quality, static, distorted, watermark, text, subtitles', clip: ['2', 0] } },
      6: { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width: w, height: h, length: Math.max(5, Math.round(((+a.sekunden || 5) * 24) / 4) * 4 + 1), batch_size: 1 } },
      7: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
      8: { class_type: 'KSampler', inputs: { model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed, steps: +a.schritte || 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 } },
      9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      10: { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 24 } },
      11: { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'video/glowline', format: 'mp4', 'format.codec': 'h264' } },
    };
    if (a.bild) {
      wf[12] = { class_type: 'LoadImage', inputs: { image: a.bild } };
      wf[6].inputs.start_image = ['12', 0];
    }
    return wf;
  }
  if (a.modell === 'esrgan-x4') {
    return {
      1: { class_type: 'LoadImage', inputs: { image: a.bild } },
      2: { class_type: 'UpscaleModelLoader', inputs: { model_name: D('esrgan-x4', 0) } },
      3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'upscale/glowline' } },
    };
  }
  throw new Error('Unknown model');
}

// Breite/Hoehe aus dem PNG-Kopf (reicht fuer die Groessen-Bremse beim Upscaling)
function pngGroesse(datei) {
  try {
    const fd = fs.openSync(datei, 'r'), b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    return b.toString('latin1', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  } catch { return null; }
}

// Bild in den Eingabe-Ordner kopieren (ComfyUI liest nur von dort)
function eingabeBild(datei, upscale) {
  if (!datei || !fs.existsSync(datei)) throw new Error('Image not found');
  const g = upscale && pngGroesse(datei);
  if (g && g.w * g.h > 4.5e6) throw new Error(`This image is already large (${g.w} × ${g.h}). 4× would be ${g.w * 4} × ${g.h * 4} – too big`);
  const name = `glowline_${Date.now()}${path.extname(datei).toLowerCase() || '.png'}`;
  fs.copyFileSync(datei, path.join(P().eingabe, name));
  return name;
}

// Immer nur ein Auftrag gleichzeitig auf der Grafikkarte, weitere warten in der Reihe
let kette = Promise.resolve();
function auftrag(a, vorVramFrei) {
  const key = 'auftrag:' + a.id;
  const ac = new AbortController();
  laufend.set(key, ac);
  const kopf = { vorgang: key, art: KATALOG[a.modell] ? KATALOG[a.modell].art : null, modell: a.modell, prompt: a.prompt || '', vonAgent: !!a.vonAgent };
  const melde = (x) => sende('studio', { ...kopf, ...x });
  melde({ text: 'Waiting…', wartet: true });
  let gestartet = false;
  const lauf = kette.then(() => { if (ac.signal.aborted) return { fehler: 'cancelled' }; gestartet = true; return ausfuehren(a, vorVramFrei, ac, melde); });
  kette = lauf.catch(() => {});
  // Abbruch in der Warteschlange sofort melden, nicht erst wenn der Auftrag dran waere
  const wartAbbruch = new Promise((ok) => ac.signal.addEventListener('abort', () => {
    if (!gestartet) { melde({ fertig: true, fehler: 'cancelled' }); ok({ fehler: 'cancelled' }); }
  }, { once: true }));
  return Promise.race([lauf, wartAbbruch]).finally(() => laufend.delete(key));
}
async function ausfuehren(a, vorVramFrei, ac, melde) {
  const t0 = Date.now();
  try {
    if (ac.signal.aborted) throw new Error('cancelled');
    const m = KATALOG[a.modell];
    if (!m) throw new Error('Unknown model');
    if (!status().modelle[a.modell].da) throw new Error(`${m.name} is not downloaded yet`);
    if (vorVramFrei) await mitAbbruch(vorVramFrei(), ac);
    let dateien;
    if (m.art === 'stimme') dateien = await stimmeAuftrag(a, ac, melde);
    else {
      if (stimme) { baumWeg(stimme.proz); stimme = null; } // Stimme braucht ~3 GB, die fehlen sonst
      melde({ text: comfy && comfy.bereit ? 'Starting…' : 'Starting the engine…', prozent: 0 });
      await mitAbbruch(comfyStarten(), ac); // der Motor startet im Hintergrund weiter, der naechste Auftrag ist dann schneller
      const wa = { ...a };
      if (a.bildDatei) wa.bild = eingabeBild(a.bildDatei, a.modell === 'esrgan-x4');
      dateien = await comfyLauf(workflow(wa), ac, melde);
    }
    melde({ fertig: true, dateien, dauer: Date.now() - t0 });
    return { dateien };
  } catch (e) {
    const fehler = ac.signal.aborted ? 'cancelled' : e.message;
    melde({ fertig: true, fehler });
    return { fehler };
  }
}

async function comfyLauf(wf, ac, melde) {
  const client = 'glowline' + Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${COMFY_PORT}/ws?clientId=${client}`);
  let promptId = null, fertig, fehler;
  const ende = new Promise((ok, f) => { fertig = ok; fehler = f; });
  const knoten = Object.keys(wf).length;
  let erledigt = 0;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    const x = d.data || {};
    if (promptId && x.prompt_id && x.prompt_id !== promptId) return;
    if (d.type === 'progress') melde({ prozent: Math.round((x.value / x.max) * 100), schritt: `${x.value}/${x.max}`, text: 'Generating' });
    else if (d.type === 'executing' && x.node) { erledigt++; melde({ text: 'Working (' + Math.min(erledigt, knoten) + '/' + knoten + ')' }); }
    else if (d.type === 'execution_success' || (d.type === 'executing' && x.node === null)) fertig();
    else if (d.type === 'execution_error') fehler(new Error(x.exception_message || 'Generation failed'));
    else if (d.type === 'execution_interrupted') fehler(new Error('cancelled'));
  };
  ws.onclose = () => fehler(new Error('The engine stopped unexpectedly (maybe out of graphics memory)'));
  const stopp = () => {
    // aus der Warteschlange der Engine nehmen und laufende Berechnung unterbrechen
    if (promptId) fetch(`http://127.0.0.1:${COMFY_PORT}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
    fetch(`http://127.0.0.1:${COMFY_PORT}/interrupt`, { method: 'POST' }).catch(() => {});
    fehler(new Error('cancelled'));
  };
  ende.catch(() => {});
  try {
    await mitAbbruch(new Promise((ok, f) => { ws.onopen = ok; ws.onerror = () => f(new Error('Engine not reachable')); }), ac);
    ac.signal.addEventListener('abort', stopp, { once: true });
    const r = await fetch(`http://127.0.0.1:${COMFY_PORT}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: client }) });
    const j = await r.json();
    if (!r.ok || j.error) {
      const det = j.node_errors ? Object.values(j.node_errors).map((n) => (n.errors || []).map((e) => e.details || e.message).join(', ')).join('; ') : '';
      throw new Error(((j.error && j.error.message) || 'Engine rejected the job') + (det ? ': ' + det : ''));
    }
    promptId = j.prompt_id;
    if (ac.signal.aborted) stopp();
    await ende;
    const h = await (await fetch(`http://127.0.0.1:${COMFY_PORT}/history/${promptId}`)).json();
    const aus = [];
    for (const o of Object.values((h[promptId] || {}).outputs || {})) {
      for (const liste of Object.values(o)) {
        if (!Array.isArray(liste)) continue;
        for (const f of liste) if (f && f.filename && f.type === 'output') aus.push(path.join(P().ausgabe, f.subfolder || '', f.filename));
      }
    }
    if (!aus.length) throw new Error('The engine finished but saved no file');
    return aus;
  } finally {
    try { ws.close(); } catch {}
  }
}

// ---------- Stimme ----------
async function stimmeStarten() {
  if (stimme && stimme.bereit) return;
  const p = P();
  if (!stimme) {
    const proz = spawn(p.stimmePy, [path.join(__dirname, 'stimme.py').replace('app.asar', 'app.asar.unpacked'), String(STIMME_PORT), p.ausgabe],
      { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', HF_HOME: p.hf } });
    stimme = { proz, bereit: false, log: '' };
    const merk = (d) => { stimme && (stimme.log = (stimme.log + d).slice(-6000)); };
    proz.stdout.on('data', merk);
    proz.stderr.on('data', merk);
    proz.on('exit', () => { stimme = null; });
  }
  for (let i = 0; i < 600; i++) {
    if (!stimme) throw new Error('The voice engine stopped while starting');
    try {
      const r = await fetch(`http://127.0.0.1:${STIMME_PORT}/ok`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { stimme.bereit = true; return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The voice engine did not start');
}

async function stimmeAuftrag(a, ac, melde) {
  melde({ text: stimme && stimme.bereit ? 'Speaking…' : 'Starting the voice engine…' });
  await mitAbbruch(comfyFrei(), ac);
  await mitAbbruch(stimmeStarten(), ac);
  melde({ text: 'Speaking…' });
  // ohne Zeitlimit (fetch bricht nach 5 min ab, lange Texte dauern laenger)
  const j = await new Promise((ok, fehler) => {
    const body = JSON.stringify({ text: a.prompt, sprache: a.sprache || 'de', referenz: a.bildDatei || null, ausdruck: +a.ausdruck || 0.5 });
    const req = http.request({ host: '127.0.0.1', port: STIMME_PORT, path: '/tts', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let roh = '';
      res.on('data', (d) => { roh += d; });
      res.on('end', () => { try { ok(JSON.parse(roh)); } catch { fehler(new Error('Voice engine sent no answer')); } });
    });
    req.on('error', fehler);
    ac.signal.addEventListener('abort', () => { req.destroy(new Error('cancelled')); if (stimme) { baumWeg(stimme.proz); stimme = null; } });
    req.end(body);
  });
  if (j.fehler) throw new Error(j.fehler);
  return [j.datei];
}

// ---------- Galerie ----------
const ENDUNGEN = /\.(png|jpe?g|webp|mp4|webm|wav|mp3|flac)$/i;
function galerie() {
  const p = P();
  const aus = [];
  const geh = (ordner) => {
    let eintraege = [];
    try { eintraege = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(ordner, e.name);
      if (e.isDirectory()) geh(voll);
      else if (ENDUNGEN.test(e.name)) { try { aus.push({ datei: voll, zeit: fs.statSync(voll).mtimeMs }); } catch {} }
    }
  };
  geh(p.ausgabe);
  return aus.sort((a, b) => b.zeit - a.zeit).slice(0, 200);
}
const inAusgabe = (datei) => { const r = path.relative(P().ausgabe, path.resolve(datei)); return r && !r.startsWith('..') && !path.isAbsolute(r); };

module.exports = { KATALOG, init, status, beschaeftigt, einrichten, modellHolen, abbrechen, auftrag, galerie, stoppen, comfyFrei, frei, inAusgabe, P, comfyStarten };
