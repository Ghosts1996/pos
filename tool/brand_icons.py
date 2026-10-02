"""Иконки ZalPOS: касса (Android, Windows), сайт и запасная иконка гостя.

Знак — буква Z антиквой (Cormorant Garamond, как в логотипе) в «комнате»:
латунные стены с дверным проёмом и распашной дверью, как на чертеже зала
(касса начинается со схемы зала). Фон — тёплый графит палитры «Графит и
медь» (lib/theme/app_colors.dart). Свечений нет — только ровный переход
тона, как на остальных экранах.

Запасная иконка приложения гостя (у заведения ещё нет логотипа) —
нейтральная: тёмно-серый фон и клош слоновой костью, без цветов ZalPOS:
приложение гостя показывает только бренд заведения.

Запуск из корня репозитория (нужны Pillow и numpy):
    python3 tool/brand_icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / 'assets/fonts/CormorantGaramond-SemiBoldItalic.ttf'
S = 1024   # размер исходников
SS = 4     # суперсэмплинг: рисуем крупнее и уменьшаем — ровные края

BRASS = (207, 165, 103)
IVORY = (242, 234, 223)
GRAPHITE_LIGHT = (44, 36, 29)
GRAPHITE_DARK = (17, 14, 11)
NEUTRAL_LIGHT = (40, 40, 40)
NEUTRAL_DARK = (20, 20, 20)


def gradient(c1, c2, size=S * SS):
    """Диагональный переход: верхний левый угол чуть светлее."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.clip((x + y) / (2 * size), 0, 1)[..., None]
    arr = np.array(c1, np.float32) * (1 - t) + np.array(c2, np.float32) * t
    return Image.fromarray(arr.astype(np.uint8), 'RGB').convert('RGBA')


def draw_mark(im, scale=1.0):
    """Z в комнате с дверью. [scale] — 1.0 для квадратной иконки, меньше —
    для переднего слоя адаптивной иконки (видимая зона Android — круг 66 %)."""
    d = ImageDraw.Draw(im)
    c = S * SS / 2
    half = 280 * scale * SS
    w = 20 * scale * SS
    x0, x1, y0, y1 = c - half, c + half, c - half, c + half
    d.rectangle([x0, y0, x1, y0 + w], fill=BRASS)
    d.rectangle([x0, y0, x0 + w, y1], fill=BRASS)
    d.rectangle([x1 - w, y0, x1, y1], fill=BRASS)
    hinge = x1 - w
    r = half * 0.52
    d.rectangle([x0, y1 - w, hinge - r, y1], fill=BRASS)
    t = max(2, int(7 * scale * SS))
    hy = y1 - w / 2
    d.rectangle([hinge - t, hy - r, hinge, hy], fill=BRASS)
    d.arc([hinge - r, hy - r, hinge + r, hy + r], start=180, end=270, fill=BRASS, width=t)
    font = ImageFont.truetype(str(FONT), int(460 * scale * SS))
    bb = d.textbbox((0, 0), 'Z', font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    d.text((c - tw / 2 - bb[0] - 22 * scale * SS, c - th / 2 - bb[1] - 34 * scale * SS), 'Z', font=font, fill=IVORY)
    return im


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
    down(draw_mark(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK))).convert('RGB').save(icons / 'icon.png')
    down(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)).convert('RGB').save(icons / 'icon_background.png')
    down(draw_mark(Image.new('RGBA', (S * SS, S * SS), (0, 0, 0, 0)), scale=0.74)).save(icons / 'icon_foreground.png')

    # Windows: скруглённый квадрат, все размеры, которые просит проводник.
    square = rounded(down(draw_mark(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)), 256), 0.2)
    square.save(icons / 'app_icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # Сайт и кабинет.
    rounded(down(draw_mark(gradient(GRAPHITE_LIGHT, GRAPHITE_DARK)), 512), 0.2).save(ROOT / 'saas/console/favicon.png')

    # Запасная иконка приложения гостя — нейтральная.
    neutral = gradient(NEUTRAL_LIGHT, NEUTRAL_DARK)
    down(draw_cloche(neutral.copy())).convert('RGB').save(icons / 'guest_icon.png')
    down(neutral).convert('RGB').save(icons / 'guest_icon_background.png')
    down(draw_cloche(Image.new('RGBA', (S * SS, S * SS), (0, 0, 0, 0)), scale=0.72)).save(icons / 'guest_icon_foreground.png')
    down(draw_cloche(neutral.copy()), 512).convert('RGB').save(ROOT / 'saas/guest-web/app/icon.png')


if __name__ == '__main__':
    main()
