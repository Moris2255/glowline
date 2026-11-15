# Kleiner Stimmen-Dienst fuer Glowline (Chatterbox Multilingual, MIT).
# Startet auf 127.0.0.1, nimmt Text (+ optional eine kurze Sprachprobe zum Klonen) und speichert eine WAV.
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
AUSGABE = os.path.join(sys.argv[2], 'stimme')
os.makedirs(AUSGABE, exist_ok=True)

modell = None


def lade():
    global modell
    if modell is None:
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        modell = ChatterboxMultilingualTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')
    return modell


def sprich(text, sprache, referenz, ausdruck):
    import torchaudio
    m = lade()
    args = {'language_id': sprache, 'exaggeration': ausdruck}
    if referenz:
        args['audio_prompt_path'] = referenz
    wav = m.generate(text, **args)
    datei = os.path.join(AUSGABE, 'glowline_%d.wav' % int(time.time() * 1000))
    torchaudio.save(datei, wav, m.sr, encoding="PCM_S", bits_per_sample=16)
    return datei


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def antwort(self, code, daten):
        roh = json.dumps(daten).encode('utf8')
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(roh)))
        self.end_headers()
        self.wfile.write(roh)

    def do_GET(self):
        self.antwort(200 if self.path == '/ok' else 404, {'ok': True})

    def do_POST(self):
        if self.path != '/tts':
            return self.antwort(404, {'fehler': 'not found'})
        try:
            a = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
            text = str(a.get('text') or '').strip()
            if not text:
                return self.antwort(400, {'fehler': 'No text'})
            datei = sprich(text[:4000], a.get('sprache') or 'de', a.get('referenz'), float(a.get('ausdruck') or 0.5))
            self.antwort(200, {'datei': datei})
        except Exception as e:  # Fehler an Glowline melden statt abzustuerzen
            self.antwort(500, {'fehler': str(e)[:400]})


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
