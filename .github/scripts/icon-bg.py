"""Фон адаптивной иконки приложения гостя по логотипу заведения.

Печатает цвет #RRGGBB: цвет угла логотипа, если угол непрозрачный (тогда
лаунчер обрезает края без шва), иначе светлый фон под тёмный логотип и
тёмный под светлый. Цветов ZalPOS здесь нет: иконка гостя — бренд
заведения. Любая ошибка — нейтральный тёмный фон, сборка не падает.

    python3 .github/scripts/icon-bg.py /tmp/tenant_logo.png
"""
import sys

DARK = '#141414'
LIGHT = '#F4F1EC'


def main(path):
    try:
        from PIL import Image
    except ImportError:
        return DARK
    try:
        im = Image.open(path).convert('RGBA')
    except Exception:
        return DARK
    im.thumbnail((256, 256))
    r, g, b, a = im.getpixel((2, 2))
    if a > 230:
        return '#%02X%02X%02X' % (r, g, b)
    px = im.load()
    total = weight = 0.0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a < 32:
                continue
            total += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * a
            weight += a
    if not weight:
        return DARK
    return LIGHT if total / weight < 0.45 else DARK


if __name__ == '__main__':
    print(main(sys.argv[1]) if len(sys.argv) > 1 else DARK)
