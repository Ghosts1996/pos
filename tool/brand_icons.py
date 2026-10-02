"""Иконки ZalPOS: касса (Android, Windows), сайт и запасная иконка гостя.

Знак — смарт-касса с чеком: светлый корпус терминала, медный экран с
галочкой «оплачено», из принтера выходит чек. Фон — тёплый графит палитры
«Графит и медь» (lib/theme/app_colors.dart). Свечений нет — мягкие тени и
ровный переход тона.

Запасная иконка приложения гостя (у заведения ещё нет логотипа) —
нейтральная: тёмно-серый фон и клош слоновой костью, без цветов ZalPOS:
приложение гостя показывает только бренд заведения.

Запуск из корня репозитория (нужны Pillow и numpy):
    python3 tool/brand_icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 1024   # размер исходников
SS = 4     # суперсэмплинг: рисуем крупнее и уменьшаем — ровные края
N = S * SS

IVORY = (244, 237, 227)
IVORY_LINE = (205, 191, 172)
BRASS = (207, 165, 103)
COPPER = (191, 101, 54)
COPPER_LIGHT = (214, 128, 78)
COPPER_DARK = (150, 75, 38)
GRAPHITE_LIGHT = (46, 38, 31)
GRAPHITE_DARK = (16, 13, 10)
NEUTRAL_LIGHT = (40, 40, 40)
NEUTRAL_DARK = (20, 20, 20)


def k(v):
    return int(v * SS)


def gradient(c1, c2, size=N):
    """Переход тона: верхний левый угол чуть светлее."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.clip((x * 0.35 + y) / (1.35 * size), 0, 1)[..., None]
    arr = np.array(c1, np.float32) * (1 - t) + np.array(c2, np.float32) * t
    return Image.fromarray(arr.astype(np.uint8), 'RGB').convert('RGBA')


def vertical(w, h, c1, c2):
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    arr = np.array(c1, np.float32) * (1 - t) + np.array(c2, np.float32) * t
    return Image.fromarray(np.repeat(arr, w, axis=1).astype(np.uint8), 'RGB').convert('RGBA')


def shadow(im, box, radius, blur, alpha, dy):
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([box[0], box[1] + k(dy), box[2], box[3] + k(dy)], radius=radius, fill=alpha)
    im.paste(Image.new('RGBA', im.size, (8, 6, 4, 255)), (0, 0), mask.filter(ImageFilter.GaussianBlur(k(blur))))


def gradient_rrect(im, box, radius, c1, c2):
    x0, y0, x1, y1 = [int(v) for v in box]
    mask = Image.new('L', (x1 - x0, y1 - y0), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, x1 - x0 - 1, y1 - y0 - 1], radius=radius, fill=255)
    im.paste(vertical(x1 - x0, y1 - y0, c1, c2), (x0, y0), mask)


def zigzag(y, x0, x1, teeth, depth):
    pts, w = [], (x1 - x0) / teeth
    for i in range(teeth + 1):
        pts.append((x0 + i * w, y))
        if i < teeth:
            pts.append((x0 + i * w + w / 2, y + depth))
    return pts


def terminal_layer():
    """Смарт-касса с чеком на прозрачном слое N×N."""
    im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    # Чек позади терминала: зубчатый край сверху, строки и медный итог.
    rx0, rx1, ry0, ry1 = k(352), k(672), k(150), k(560)
    shadow(im, (rx0, ry0, rx1, ry1), k(8), blur=30, alpha=90, dy=10)
    d = ImageDraw.Draw(im)
    d.polygon([(rx0, ry1), (rx0, ry0 + k(16))] + zigzag(ry0 + k(16), rx0, rx1, 9, -k(16)) + [(rx1, ry0 + k(16)), (rx1, ry1)], fill=IVORY)
    for i, w in enumerate((200, 150, 220)):
        y = ry0 + k(78 + i * 52)
        d.rounded_rectangle([rx0 + k(44), y, rx0 + k(44 + w), y + k(16)], radius=k(8), fill=IVORY_LINE)
    y = ry0 + k(78 + 3 * 52 + 8)
    d.rounded_rectangle([rx0 + k(44), y, rx0 + k(150), y + k(18)], radius=k(9), fill=COPPER)
    d.rounded_rectangle([rx1 - k(124), y, rx1 - k(44), y + k(18)], radius=k(9), fill=COPPER)
    # Корпус терминала.
    bx0, bx1, by0, by1 = k(214), k(810), k(430), k(860)
    shadow(im, (bx0, by0, bx1, by1), k(70), blur=46, alpha=150, dy=34)
    gradient_rrect(im, (bx0, by0, bx1, by1), k(74), (247, 241, 233), (222, 210, 193))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([k(330), by0 + k(30), k(694), by0 + k(46)], radius=k(8), fill=(176, 162, 143))
    # Экран с галочкой «оплачено».
    sx0, sx1, sy0, sy1 = k(262), k(762), k(492), k(762)
    gradient_rrect(im, (sx0, sy0, sx1, sy1), k(42), COPPER_LIGHT, COPPER_DARK)
    d = ImageDraw.Draw(im)
    cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
    pts = [(cx - k(84), cy + k(4)), (cx - k(22), cy + k(64)), (cx + k(96), cy - k(66))]
    d.line(pts, fill=IVORY, width=k(46), joint='curve')
    for px, py in (pts[0], pts[2]):
        r = k(23)
        d.ellipse([px - r, py - r, px + r, py + r], fill=IVORY)
    # Индикатор и подставка.
    d.ellipse([k(708), k(800), k(732), k(824)], fill=BRASS)
    d.rounded_rectangle([k(430), k(806), k(594), k(818)], radius=k(6), fill=(190, 177, 158))
    return im


def with_terminal(background, scale=1.0):
    """Терминал поверх фона; [scale] < 1 — для переднего слоя адаптивной
    иконки (видимая зона Android — круг 66 %)."""
    layer = terminal_layer()
    if scale != 1.0:
        size = int(N * scale)
        small = layer.resize((size, size), Image.LANCZOS)
        layer = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        layer.paste(small, ((N - size) // 2, (N - size) // 2), small)
    out = background.copy()
    out.alpha_composite(layer)
    return out


def draw_cloche(im, scale=1.0, color=IVORY):
    """Клош на блюде — нейтральный знак заведения общепита."""
    d = ImageDraw.Draw(im)
    c = S * SS / 2
    k = scale * SS
    t = int(26 * k)
    # купол
    d.arc([c - 250 * k, c - 210 * k, c + 250 * k, c + 290 * k], start=180, end=360, fill=color, width=t)
    # ручка
    d.ellipse([c - 34 * k, c - 270 * k, c + 34 * k, c - 202 * k], outline=color, width=int(22 * k))
    # блюдо
    d.rounded_rectangle([c - 320 * k, c + 60 * k, c + 320 * k, c + 60 * k + t], radius=t // 2, fill=color)
    return im


def down(im, size=S):
    return im.resize((size, size), Image.LANCZOS)


def rounded(im, radius_ratio=0.22):
    size = im.size[0]
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=int(size * 4 * radius_ratio), fill=255)
    out = im.copy()
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def main():
    icons = ROOT / 'assets/icon'
    # Касса: квадратная иконка (Android до 8, основа уведомлений), фон и
    # передний слой адаптивной иконки.
    down(with_terminal(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK))).convert('RGB').save(icons / 'icon.png')
    down(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)).convert('RGB').save(icons / 'icon_background.png')
    down(with_terminal(Image.new('RGBA', (N, N), (0, 0, 0, 0)), scale=0.7)).save(icons / 'icon_foreground.png')

    # Windows: скруглённый квадрат, все размеры, которые просит проводник.
    square = rounded(down(with_terminal(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)), 256), 0.2)
    square.save(icons / 'app_icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # Сайт и кабинет.
    rounded(down(with_terminal(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)), 512), 0.2).save(ROOT / 'saas/console/favicon.png')

    # Запасная иконка приложения гостя — нейтральная.
    neutral = gradient(NEUTRAL_LIGHT, NEUTRAL_DARK)
    down(draw_cloche(neutral.copy())).convert('RGB').save(icons / 'guest_icon.png')
    down(neutral).convert('RGB').save(icons / 'guest_icon_background.png')
    down(draw_cloche(Image.new('RGBA', (S * SS, S * SS), (0, 0, 0, 0)), scale=0.72)).save(icons / 'guest_icon_foreground.png')
    down(draw_cloche(neutral.copy()), 512).convert('RGB').save(ROOT / 'saas/guest-web/app/icon.png')


if __name__ == '__main__':
    main()
