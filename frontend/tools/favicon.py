"""Rechnet favicon.ico und apple-touch-icon.png aus dem Zeichen in favicon.svg.

    ../.venv/bin/python tools/favicon.py

Die SVG ist die Quelle; hier stehen dieselben Maße noch einmal als Zahlen,
weil Pillow kein SVG liest und eine Rasterbibliothek für fünf Rechtecke zu
viel verlangt wäre. Wer das Zeichen ändert, ändert beides.

Gezeichnet wird vierfach vergrößert und danach verkleinert: das glättet die
Kanten, ohne dass Pillow Kantenglättung für Rechtecke beherrschen müsste.
"""

from pathlib import Path

from PIL import Image, ImageDraw

FIELD = "#fbb1a4"  # --key hell
INK = "#361917"  # --on-key
RADIUS = 7.5
# x, Höhe — y ergibt sich aus der Mitte, Breite steht in BAR_W.
BARS = [(2, 9), (8, 16), (14, 23), (20, 16), (26, 10)]
BAR_W, BAR_R = 4, 1.8
# Bei 16 Pixeln sind fünf Balken drei graue Striche: dort stehen drei
# breitere. Das betrifft nur die kleinste Stufe der .ico, die noch
# Browser ohne SVG-Favicon anzeigen; überall sonst gilt das Zeichen oben.
BARS_SMALL = [(3.5, 13), (13.5, 23), (23.5, 15)]
BAR_W_SMALL = 5
SMALL_UP_TO = 24
SUPER = 8
HERE = Path(__file__).resolve().parent


def render(size: int) -> Image.Image:
    """Das Zeichen in `size` Pixeln Kantenlänge."""
    k = size * SUPER / 32  # Einheiten der SVG in Pixel dieser Größe
    bars = BARS_SMALL if size <= SMALL_UP_TO else BARS
    width = BAR_W_SMALL if size <= SMALL_UP_TO else BAR_W
    img = Image.new("RGBA", (size * SUPER, size * SUPER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        (0, 0, size * SUPER - 1, size * SUPER - 1), radius=RADIUS * k, fill=FIELD
    )
    for x, height in bars:
        y = (32 - height) / 2
        draw.rounded_rectangle(
            (x * k, y * k, (x + width) * k - 1, (y + height) * k - 1),
            radius=BAR_R * k,
            fill=INK,
        )
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = HERE.parent / "public"
    # Mehrere Größen in einer .ico: der Browser nimmt die passende, statt
    # eine große herunterzurechnen. Jede Stufe wird einzeln gezeichnet und
    # über `append_images` mitgegeben — ohne das verkleinert Pillow still
    # die größte, und das gröbere Zeichen der 16er käme nie an.
    sizes = (16, 32, 48)
    icons = {s: render(s) for s in sizes}
    icons[48].save(
        out / "favicon.ico",
        sizes=[(s, s) for s in sizes],
        append_images=[icons[s] for s in sizes],
    )
    render(180).save(out / "apple-touch-icon.png")
    print(f"geschrieben: {out/'favicon.ico'}, {out/'apple-touch-icon.png'}")


if __name__ == "__main__":
    main()
