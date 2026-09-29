# Временный помощник: подбирает живые фото блюд демо-меню с Unsplash
# (unsplash.com/license — бесплатно, в том числе в коммерческих целях).
# Запускается из .github/workflows/demo-photos.yml:
#   candidates — по 8 вариантов на блюдо, листы-превью sheet-*.jpg;
#   final      — выбранные варианты (choices.json) в saas/console/demo-menu.
import json
import os
import shutil
import sys
import time
from io import BytesIO

import requests
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "saas", "console", "demo-menu")
UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept": "application/json",
}
PER = 8
CELL = 190
LABEL = 170


def load(name, default):
    p = os.path.join(HERE, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default


def get(url, **kw):
    for attempt in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=30, **kw)
            if r.status_code == 200:
                return r
            print("HTTP", r.status_code, url[:120])
        except requests.RequestException as e:
            print("ERR", e, url[:120])
        time.sleep(2 * (attempt + 1))
    return None


def search(query):
    r = get("https://unsplash.com/napi/search/photos", params={"query": query, "per_page": 30})
    if not r:
        return []
    out = []
    for p in r.json().get("results", []):
        raw = p.get("urls", {}).get("raw", "")
        if p.get("premium") or p.get("plus") or "plus.unsplash.com" in raw or not raw:
            continue
        user = p.get("user") or {}
        out.append({
            "id": p["id"],
            "raw": raw,
            "author": user.get("name", ""),
            "username": user.get("username", ""),
            "alt": p.get("alt_description") or "",
        })
        if len(out) == PER:
            break
    return out


def sized(raw, w, h, q):
    sep = "&" if "?" in raw else "?"
    return f"{raw}{sep}w={w}&h={h}&fit=crop&q={q}&fm=jpg"


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def candidates(only):
    queries = load("queries.json", {})
    cands = load("candidates.json", {})
    slugs = [s for s in queries if not only or s in only]
    for s in slugs:
        cands[s] = search(queries[s])
        print(s, len(cands[s]))
    json.dump(cands, open(os.path.join(HERE, "candidates.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    for f in os.listdir(HERE):
        if f.startswith("sheet-"):
            os.remove(os.path.join(HERE, f))
    big, small = font(22), font(20)
    rows = 8
    for n in range(0, len(slugs), rows):
        part = slugs[n:n + rows]
        sheet = Image.new("RGB", (LABEL + PER * CELL, len(part) * CELL), (24, 24, 28))
        d = ImageDraw.Draw(sheet)
        for r, s in enumerate(part):
            y = r * CELL
            d.text((8, y + CELL // 2 - 12), s, fill=(255, 255, 255), font=big)
            for i, c in enumerate(cands[s]):
                resp = get(sized(c["raw"], CELL - 6, CELL - 6, 60))
                if not resp:
                    continue
                img = Image.open(BytesIO(resp.content)).convert("RGB")
                x = LABEL + i * CELL
                sheet.paste(img, (x + 3, y + 3))
                d.rectangle((x + 3, y + 3, x + 31, y + 31), fill=(0, 0, 0))
                d.text((x + 10, y + 5), str(i), fill=(255, 220, 0), font=small)
        sheet.save(os.path.join(HERE, f"sheet-{n // rows + 1:02d}.jpg"), quality=70)


def final():
    cands = load("candidates.json", {})
    choices = load("choices.json", {})
    credits = []
    for s, pick in choices.items():
        c = cands[s][pick] if isinstance(pick, int) else next(x for x in cands[s] if x["id"] == pick)
        resp = get(sized(c["raw"], 512, 512, 74))
        if not resp:
            sys.exit(f"не скачалось: {s}")
        Image.open(BytesIO(resp.content)).convert("RGB").save(
            os.path.join(OUT, f"{s}.jpg"), quality=78, optimize=True, progressive=True)
        credits.append(f"{s}.jpg — {c['author']} (unsplash.com/@{c['username']}), https://unsplash.com/photos/{c['id']}")
        print("ok", s)
    with open(os.path.join(OUT, "CREDITS.txt"), "w", encoding="utf-8") as f:
        f.write("Фото демо-меню — Unsplash, лицензия Unsplash (https://unsplash.com/license):\n"
                "бесплатно, в том числе в коммерческих целях, без обязательного указания автора.\n\n")
        f.write("\n".join(sorted(credits)) + "\n")
    shutil.rmtree(HERE)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "candidates"
    only = [s for s in os.environ.get("ONLY", "").split(",") if s]
    candidates(only) if mode == "candidates" else final()
