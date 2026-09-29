# Временный помощник: подбирает живые фото блюд демо-меню. Источники:
# Unsplash (unsplash.com/license — бесплатно, в том числе в коммерческих
# целях) и, если он недоступен, Openverse (только CC0 / общественное
# достояние / CC BY — авторы в CREDITS.txt).
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
from PIL import Image, ImageDraw, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "saas", "console", "demo-menu")
UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept": "application/json, image/*",
}
PER = 12
CELL = 190
LABEL = 170
unsplash_ok = True


def log(*a):
    print(*a, flush=True)


def load(name, default):
    p = os.path.join(HERE, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default


def get(url, tries=3, **kw):
    for attempt in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=20, **kw)
            if r.status_code == 200:
                return r
            log("HTTP", r.status_code, url[:100], r.text[:120].replace("\n", " "))
            if r.status_code in (401, 403, 404):
                return None
        except requests.RequestException as e:
            log("ERR", type(e).__name__, url[:100])
        time.sleep(2 * (attempt + 1))
    return None


def unsplash(query):
    global unsplash_ok
    if not unsplash_ok:
        return []
    r = get("https://unsplash.com/napi/search/photos", tries=2, params={"query": query, "per_page": 30})
    if not r:
        unsplash_ok = False
        log("Unsplash недоступен — дальше только Openverse")
        return []
    out = []
    for p in r.json().get("results", []):
        raw = p.get("urls", {}).get("raw", "")
        if p.get("premium") or p.get("plus") or "plus.unsplash.com" in raw or not raw:
            continue
        user = p.get("user") or {}
        out.append({
            "src": "unsplash", "id": p["id"],
            "thumb": sized(raw, CELL - 6, CELL - 6, 60),
            "full": sized(raw, 512, 512, 76),
            "credit": f"{user.get('name', '')} (unsplash.com/@{user.get('username', '')}), https://unsplash.com/photos/{p['id']}, лицензия Unsplash",
        })
    return out


def openverse(query):
    r = get("https://api.openverse.org/v1/images/", params={
        "q": query, "license": "cc0,pdm,by,by-sa", "category": "photograph",
        "page_size": 20, "mature": "false",
    })
    if not r:
        return []
    out = []
    for p in r.json().get("results", []):
        lic = f"{(p.get('license') or '').upper()} {p.get('license_version') or ''}".strip()
        out.append({
            "src": "openverse", "id": p["id"],
            "thumb": p.get("thumbnail") or p["url"],
            "full": p["url"],
            "credit": f"{p.get('creator') or 'автор не указан'}, {p.get('foreign_landing_url') or p['url']}, {lic}",
        })
    time.sleep(3)  # анонимный лимит Openverse
    return out


def sized(raw, w, h, q):
    sep = "&" if "?" in raw else "?"
    return f"{raw}{sep}w={w}&h={h}&fit=crop&q={q}&fm=jpg"


def square(data, size):
    img = Image.open(BytesIO(data)).convert("RGB")
    return ImageOps.fit(img, (size, size), Image.LANCZOS)


def font(size):
    f = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    return ImageFont.truetype(f, size) if os.path.exists(f) else ImageFont.load_default()


def candidates(only):
    queries = load("queries.json", {})
    cands = load("candidates.json", {})
    slugs = [s for s in queries if not only or s in only]
    for s in slugs:
        qs = queries[s] if isinstance(queries[s], list) else [queries[s]]
        found, seen = [], set()
        for q in qs:
            for c in unsplash(q) + openverse(q):
                if c["id"] not in seen:
                    seen.add(c["id"])
                    found.append(c)
        cands[s] = found[:PER]
        log(s, len(cands[s]), cands[s][0]["src"] if cands[s] else "-")
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
                resp = get(c["thumb"], tries=2)
                if not resp:
                    continue
                try:
                    img = square(resp.content, CELL - 6)
                except Exception as e:
                    log("не картинка", s, i, e)
                    continue
                x = LABEL + i * CELL
                sheet.paste(img, (x + 3, y + 3))
                d.rectangle((x + 3, y + 3, x + 31, y + 31), fill=(0, 0, 0))
                d.text((x + 10, y + 5), str(i), fill=(255, 220, 0), font=small)
        name = f"sheet-{n // rows + 1:02d}.jpg"
        sheet.save(os.path.join(HERE, name), quality=70)
        log("лист", name)


def final():
    cands = load("candidates.json", {})
    choices = load("choices.json", {})
    # Уже выбранные ранее фото остаются: их строки в CREDITS.txt не теряются.
    path = os.path.join(OUT, "CREDITS.txt")
    head, credits = "", []
    if os.path.exists(path):
        text = open(path, encoding="utf-8").read()
        head, _, body = text.partition("\n\n")
        credits = [l for l in body.splitlines() if l and l.split(" — ")[0][:-4] not in choices]
    for s, pick in choices.items():
        # «другое-блюдо:номер» — вариант из подборки другого блюда
        src, _, idx = str(pick).rpartition(":")
        c = cands[src or s][int(idx)]
        resp = get(c["full"])
        if not resp:
            sys.exit(f"не скачалось: {s}")
        square(resp.content, 512).save(os.path.join(OUT, f"{s}.jpg"), quality=78, optimize=True, progressive=True)
        credits.append(f"{s}.jpg — {c['credit']}")
        log("ok", s)
    with open(path, "w", encoding="utf-8") as f:
        if head:
            f.write(head + "\n\n")
        else:
            f.write("Фото демо-меню. Unsplash — https://unsplash.com/license (бесплатно, в том\n"
                    "числе в коммерческих целях); CC0 / PDM — общественное достояние;\n"
                    "CC BY / CC BY-SA — https://creativecommons.org/licenses/ (фото обрезаны и уменьшены;\n"
                    "изменённые фото CC BY-SA распространяются на тех же условиях).\n\n")
        f.write("\n".join(sorted(credits)) + "\n")
    shutil.rmtree(HERE)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "candidates"
    only = [s.strip() for s in os.environ.get("ONLY", "").split(",") if s.strip()]
    candidates(only) if mode == "candidates" else final()
