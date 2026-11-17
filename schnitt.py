# Film-Schnitt fuer Glowline: Szenen-Clips + Sprecher + Musik -> ein fertiges MP4.
# Laeuft mit dem Python des Studio-Motors (PyAV + numpy + Pillow sind dort schon drin, kein eigenes ffmpeg noetig).
# Aufruf: python schnitt.py auftrag.json   – Fortschritt als Zeilen "P <0..100>" auf stdout, Fehler auf stderr.
#
# auftrag.json: { ausgabe, breite, hoehe, fps, uebergang, musik, musikLaut, untertitel, schrift,
#                 szenen: [{ video, sprache, text }] }
import json
import os
import sys

import av
import numpy as np

RATE = 48000


def melde(p):
    print('P %d' % max(0, min(100, int(p))), flush=True)


def lies_audio(datei):
    """Ganze Audiodatei als float32-Array (Samples, 2) in 48 kHz."""
    if not datei or not os.path.exists(datei):
        return np.zeros((0, 2), np.float32)
    teile = []
    with av.open(datei) as c:
        if not c.streams.audio:
            return np.zeros((0, 2), np.float32)
        r = av.AudioResampler(format='flt', layout='stereo', rate=RATE)
        for f in c.decode(audio=0):
            for g in r.resample(f):
                teile.append(g.to_ndarray().reshape(-1, 2))
        for g in r.resample(None):
            teile.append(g.to_ndarray().reshape(-1, 2))
    return np.concatenate(teile).astype(np.float32) if teile else np.zeros((0, 2), np.float32)


def clip_info(datei):
    """Anzahl Bilder und fps eines Clips (ohne alles zu dekodieren, wenn die Datei es verraet)."""
    with av.open(datei) as c:
        s = c.streams.video[0]
        fps = float(s.average_rate or 24)
        n = s.frames or sum(1 for _ in c.decode(video=0))
    return n, fps


def lies_video(datei, b, h):
    """Alle Bilder eines Clips als Liste von uint8-Arrays (h, b, 3) in Zielgroesse + fps des Clips."""
    bilder = []
    with av.open(datei) as c:
        s = c.streams.video[0]
        fps = float(s.average_rate or 24)
        for f in c.decode(video=0):
            if f.width != b or f.height != h:
                # Seitenverhaeltnis behalten: erst passend skalieren, dann mittig zuschneiden
                q = max(b / f.width, h / f.height)
                nb, nh = max(b, round(f.width * q)), max(h, round(f.height * q))
                a = f.reformat(width=nb, height=nh, format='rgb24').to_ndarray()
                x, y = (nb - b) // 2, (nh - h) // 2
                bilder.append(np.ascontiguousarray(a[y:y + h, x:x + b]))
            else:
                bilder.append(f.to_ndarray(format='rgb24'))
    return bilder, fps


def untertitel_bild(text, b, h, schrift):
    """Untertitel als RGBA-Ebene (h, b, 4) – weisse Schrift mit dunklem Rand, unten im Bild."""
    from PIL import Image, ImageDraw, ImageFont
    groesse = max(18, int(min(b, h) * 0.055))
    try:
        font = ImageFont.truetype(schrift, groesse) if schrift and os.path.exists(schrift) else ImageFont.load_default(groesse)
    except Exception:
        font = ImageFont.load_default()
    ebene = Image.new('RGBA', (b, h), (0, 0, 0, 0))
    z = ImageDraw.Draw(ebene)
    # in Zeilen umbrechen, die in 86 % der Breite passen (hoechstens 3)
    worte, zeilen, jetzt = text.split(), [], ''
    for w in worte:
        probe = (jetzt + ' ' + w).strip()
        if z.textlength(probe, font=font) <= b * 0.86 or not jetzt:
            jetzt = probe
        else:
            zeilen.append(jetzt)
            jetzt = w
    if jetzt:
        zeilen.append(jetzt)
    zeilen = zeilen[-3:]
    zeile_h = int(groesse * 1.25)
    unten = h * (0.80 if h > b else 0.90)  # Hochformat: hoeher, damit TikTok-Knoepfe nichts verdecken
    y = int(unten - zeile_h * len(zeilen))
    rand = max(2, groesse // 12)
    for zl in zeilen:
        w = z.textlength(zl, font=font)
        z.text(((b - w) / 2, y), zl, font=font, fill=(255, 255, 255, 255), stroke_width=rand, stroke_fill=(0, 0, 0, 230))
        y += zeile_h
    a = np.asarray(ebene).astype(np.float32)
    return a[:, :, :3], a[:, :, 3:4] / 255.0


def zeit_srt(s):
    ms = int(round(s * 1000))
    return '%02d:%02d:%02d,%03d' % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


def main():
    with open(sys.argv[1], encoding='utf8') as f:
        a = json.load(f)
    b, h = int(a['breite']) // 2 * 2, int(a['hoehe']) // 2 * 2
    fps = int(a.get('fps') or 24)
    ueber = max(0, int(round(float(a.get('uebergang', 0.4)) * fps)))
    szenen = a['szenen']
    if not szenen:
        raise SystemExit('No scenes')

    # 1) Szenen vorbereiten: Laenge = Clip, oder laenger, wenn der Sprecher mehr Zeit braucht (Clip wird langsamer)
    plan = []
    for i, s in enumerate(szenen):
        anzahl, clip_fps = clip_info(s['video'])
        if not anzahl:
            raise SystemExit('Scene %d has no video frames' % (i + 1))
        sprache = lies_audio(s.get('sprache'))
        clip_n = max(1, round(anzahl * fps / clip_fps))
        brauch = int(np.ceil((len(sprache) / RATE + 0.5) * fps)) + ueber if len(sprache) else 0
        n = min(max(clip_n, brauch), clip_n * 2)  # hoechstens halbe Geschwindigkeit
        plan.append({'video': s['video'], 'n': n, 'sprache': sprache, 'text': (s.get('text') or '').strip()})
        melde(5 + 15 * (i + 1) / len(szenen))

    # Startzeit jeder Szene (Uebergaenge ueberlappen)
    start, t = [], 0
    for i, p in enumerate(plan):
        start.append(t)
        t += p['n'] - (ueber if i < len(plan) - 1 else 0)
    gesamt = t

    # 2) Ton: Sprecher an den Szenenanfang, Musik darunter (leiser, solange jemand spricht)
    ton = np.zeros((int(gesamt / fps * RATE) + RATE, 2), np.float32)
    sprech = np.zeros(len(ton), np.float32)
    srt = []
    for i, p in enumerate(plan):
        if not len(p['sprache']):
            continue
        a0 = int((start[i] / fps + (ueber / fps if i else 0) + 0.25) * RATE)
        stueck = p['sprache'][:max(0, len(ton) - a0)]
        ton[a0:a0 + len(stueck)] += stueck
        sprech[a0:a0 + len(stueck)] = 1
        if p['text']:
            srt.append((a0 / RATE, (a0 + len(stueck)) / RATE, p['text']))
    musik = lies_audio(a.get('musik'))
    if len(musik):
        wdh = int(np.ceil(len(ton) / len(musik)))
        musik = np.tile(musik, (wdh, 1))[:len(ton)]
        laut = float(a.get('musikLaut', 0.35))
        # weich zwischen laut und leise (Ducking), 0,3 s Rampen
        k = int(0.3 * RATE)
        huelle = np.convolve(sprech, np.ones(k, np.float32) / k, mode='same') if sprech.any() else sprech
        gain = laut * (1 - 0.65 * np.clip(huelle * 1.5, 0, 1))
        ton += musik * gain[:, None]
    # Ein- und Ausblenden
    ende = int(gesamt / fps * RATE)
    ton = ton[:ende]
    aus = min(len(ton), int(1.5 * RATE))
    if aus:
        ton[-aus:] *= np.linspace(1, 0, aus, dtype=np.float32)[:, None]
    spitze = float(np.abs(ton).max()) if len(ton) else 0
    if spitze > 0.98:
        ton *= 0.98 / spitze
    melde(25)

    # Untertitel-Ebenen (einmal pro Szene)
    unter = {}
    if a.get('untertitel'):
        for i, (s0, s1, txt) in enumerate(srt):
            unter[i] = (int(s0 * fps), int(s1 * fps), *untertitel_bild(txt, b, h, a.get('schrift')))

    # 3) Bild fuer Bild zusammensetzen und schreiben
    tmp = a['ausgabe'] + '.part.mp4'
    out = av.open(tmp, 'w')
    vs = out.add_stream('libx264', rate=fps)
    vs.width, vs.height, vs.pix_fmt = b, h, 'yuv420p'
    vs.options = {'crf': '20', 'preset': 'medium'}
    aus_s = out.add_stream('aac', rate=RATE)
    aus_s.layout = 'stereo'
    aus_s.bit_rate = 192000

    # hoechstens zwei Clips gleichzeitig im Speicher (aktueller + vorheriger fuer den Uebergang)
    cache = {}

    def bild_von(i, k):
        if i not in cache:
            for alt in [j for j in cache if j < i - 1]:
                del cache[alt]
            cache[i] = lies_video(plan[i]['video'], b, h)[0]
        bilder = cache[i]
        return bilder[min(len(bilder) - 1, int(k * len(bilder) / plan[i]['n']))]

    stueck, ton_pos = 1024, 0

    def ton_bis(ziel):
        nonlocal ton_pos
        while ton_pos + stueck <= ziel or (ziel >= len(ton) and ton_pos < len(ton)):
            teil = np.ascontiguousarray(ton[ton_pos:ton_pos + stueck].T)
            f = av.AudioFrame.from_ndarray(teil, format='fltp', layout='stereo')
            f.sample_rate = RATE
            f.pts = ton_pos
            for pk in aus_s.encode(f):
                out.mux(pk)
            ton_pos += teil.shape[1]

    ein, aus_n = int(0.5 * fps), int(1.5 * fps)
    for t in range(gesamt):
        # welche Szene(n) liegen hier? (im Uebergang zwei)
        i = max(j for j in range(len(plan)) if start[j] <= t)
        bild = bild_von(i, t - start[i]).astype(np.float32)
        if i > 0 and t - start[i] < ueber:
            vor = bild_von(i - 1, t - start[i - 1]).astype(np.float32)
            x = (t - start[i] + 1) / (ueber + 1)
            bild = vor * (1 - x) + bild * x
        for (u0, u1, farbe, alpha) in unter.values():
            if u0 <= t < u1:
                bild = bild * (1 - alpha) + farbe * alpha
        if t < ein:
            bild *= (t + 1) / ein
        if t >= gesamt - aus_n:
            bild *= (gesamt - t) / aus_n
        f = av.VideoFrame.from_ndarray(np.clip(bild, 0, 255).astype(np.uint8), format='rgb24')
        for pk in vs.encode(f):
            out.mux(pk)
        ton_bis(min(len(ton), int((t + 1) / fps * RATE)))
        if t % 24 == 0:
            melde(25 + 70 * t / gesamt)
    for pk in vs.encode():
        out.mux(pk)

    ton_bis(len(ton))
    for pk in aus_s.encode():
        out.mux(pk)
    out.close()
    os.replace(tmp, a['ausgabe'])

    # Untertitel-Datei daneben (fuer YouTube/TikTok-Upload)
    if srt:
        with open(os.path.splitext(a['ausgabe'])[0] + '.srt', 'w', encoding='utf8') as f:
            for n, (s0, s1, txt) in enumerate(srt, 1):
                f.write('%d\n%s --> %s\n%s\n\n' % (n, zeit_srt(s0), zeit_srt(s1), txt))
    melde(100)
    print(json.dumps({'datei': a['ausgabe'], 'sekunden': gesamt / fps}), flush=True)


if __name__ == '__main__':
    main()
