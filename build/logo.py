# Erzeugt das Glowline-Logo (icon.png 1024 px, icon.ico mehrere Groessen)
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024
HIER = os.path.dirname(os.path.abspath(__file__))


def verlauf(w, h, a, b):
    im = Image.new('RGBA', (w, h))
    px = im.load()
    for x in range(w):
        t = x / max(1, w - 1)
        c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
        for y in range(h):
            px[x, y] = c
    return im


def logo():
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # Grundflaeche: dunkles abgerundetes Quadrat mit feinem Rand
    maske = Image.new('L', (S, S), 0)
    ImageDraw.Draw(maske).rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=255)
    grund = Image.new('RGBA', (S, S))
    a, b = (30, 31, 35), (10, 11, 13)
    gp = grund.load()
    for x in range(S):
        for y in range(S):
            t = (x + y) / (2 * S - 2)
            gp[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    im.paste(grund, (0, 0), maske)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=220, outline=(255, 255, 255, 28), width=6)

    pink, lila = (255, 255, 255), (150, 154, 162)  # weiss statt pink/lila

    # Leuchtlinie unten (mit Glow)
    linie = Image.new('L', (S, S), 0)
    ImageDraw.Draw(linie).rounded_rectangle((210, 700, 814, 772), radius=36, fill=255)
    glow = linie.filter(ImageFilter.GaussianBlur(46))
    farbe = verlauf(S, S, lila, pink)
    im.paste(farbe, (0, 0), glow.point(lambda v: int(v * 0.9)))
    im.paste(farbe, (0, 0), linie)
    # heller Kern in der Linie
    kern = Image.new('L', (S, S), 0)
    ImageDraw.Draw(kern).rounded_rectangle((250, 726, 774, 746), radius=10, fill=150)
    im.paste((255, 255, 255, 255), (0, 0), kern.filter(ImageFilter.GaussianBlur(4)))

    # Prompt-Pfeil ">" und Cursor-Strich
    pfeil = Image.new('L', (S, S), 0)
    pd = ImageDraw.Draw(pfeil)
    pd.line([(250, 270), (430, 420), (250, 570)], fill=255, width=88, joint='curve')
    for x, y in [(250, 270), (250, 570)]:
        pd.ellipse((x - 44, y - 44, x + 44, y + 44), fill=255)
    pd.ellipse((430 - 44, 420 - 44, 430 + 44, 420 + 44), fill=255)
    pd.rounded_rectangle((500, 530, 760, 600), radius=35, fill=255)
    im.paste((255, 255, 255, 60), (0, 0), pfeil.filter(ImageFilter.GaussianBlur(22)))
    im.paste((240, 242, 248, 255), (0, 0), pfeil)
    return im


if __name__ == '__main__':
    bild = logo()
    bild.save(os.path.join(HIER, 'icon.png'))
    bild.resize((256, 256), Image.LANCZOS).save(
        os.path.join(HIER, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('ok')
