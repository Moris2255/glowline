# Erzeugt das Glowline-Logo: Glims Gesicht (icon.png 1024 px, icon.ico mehrere Groessen)
# Kleine Groessen (16/32/48/64) werden Pixel fuer Pixel gesetzt, damit Glim in Taskleiste und Infobereich scharf bleibt
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024
HIER = os.path.dirname(os.path.abspath(__file__))

# Glim, 14 x 9 Felder: Fuehler, Kopf mit Augen, Fluegel an der Seite, leuchtender Bauch
GLIM = [
    '...w......w...',
    'g.WWWWWWWWWW.g',
    'gWWTEWWWWTEWWg',
    '.WWTEWWWWTEWW.',
    '..WWWWWWWWWW..',
    '...wwwwwwww...',
    '...hYYYYYYh...',
    '..hYYYTTYYYh..',
    '...hYYYYYYh...',
]
FARBE = {'T': (255, 255, 255), 'W': (236, 238, 243), 'w': (196, 200, 208), 'E': (24, 25, 30),
         'g': (128, 132, 142), 'Y': (255, 236, 160), 'h': (150, 120, 60)}
WARM = (255, 214, 110)


def grund(n, rand, radius):
    """dunkles abgerundetes Quadrat mit leichtem Verlauf und feinem Rand"""
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    a, b = (30, 30, 33), (12, 12, 13)
    g = Image.new('RGBA', (n, n))
    gp = g.load()
    for x in range(n):
        for y in range(n):
            t = min(1, (0.45 * x + 0.55 * y) / max(1, n - 1))
            gp[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    maske = Image.new('L', (n, n), 0)
    ImageDraw.Draw(maske).rounded_rectangle((rand, rand, n - 1 - rand, n - 1 - rand), radius=radius, fill=255)
    im.paste(g, (0, 0), maske)
    return im, maske


def glim(im, x0, y0, z, glanz):
    """Glim mit Feldgroesse z an (x0, y0); glanz = Unschaerfe des warmen Leuchtens um den Bauch (0 = keins)"""
    if glanz:
        ebene = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(ebene).ellipse((x0 + 2 * z, y0 + 5.5 * z, x0 + 12 * z, y0 + 9 * z), fill=WARM + (150,))
        im.alpha_composite(ebene.filter(ImageFilter.GaussianBlur(glanz)))
    d = ImageDraw.Draw(im)
    for j, zeile in enumerate(GLIM):
        for i, c in enumerate(zeile):
            if c in FARBE:
                d.rectangle((x0 + i * z, y0 + j * z, x0 + (i + 1) * z - 1, y0 + (j + 1) * z - 1), fill=FARBE[c] + (255,))


def logo():
    im, maske = grund(S, 46, 210)
    z = 52
    glim(im, (S - 14 * z) // 2, (S - 9 * z) // 2 + 10, z, 90)
    leer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    leer.paste(im, (0, 0), maske)
    ImageDraw.Draw(leer).rounded_rectangle((46, 46, S - 47, S - 47), radius=210, outline=(255, 255, 255, 22), width=5)
    return leer


def klein(n):
    """Taskleisten-Groesse: jedes Glim-Feld ist genau z Pixel gross"""
    z = n // 16
    im, maske = grund(n, 0, max(2, n // 5))
    glim(im, (n - 14 * z) // 2, (n - 9 * z) // 2, z, z * 1.2 if n >= 32 else 0)
    leer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    leer.paste(im, (0, 0), maske)
    return leer


if __name__ == '__main__':
    bild = logo()
    bild.save(os.path.join(HIER, 'icon.png'))
    gross = {g: bild.resize((g, g), Image.LANCZOS) for g in (24, 128, 256)}
    alle = {**gross, **{g: klein(g) for g in (16, 32, 48, 64)}}
    groessen = sorted(alle)
    alle[256].save(os.path.join(HIER, 'icon.ico'), sizes=[(g, g) for g in groessen],
                   append_images=[alle[g] for g in groessen if g != 256])
    print('ok')
