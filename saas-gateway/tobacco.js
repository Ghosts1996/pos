"use strict";
/**
 * Табак на полках: кальянщик фотографирует полку на кассе, ИИ заведения
 * читает надписи на банках (марка, название вкуса, состав вкуса), касса
 * показывает список для проверки и сохраняет полку в tenants/{t}/tobaccoShelf
 * сама. По полке касса и приложение гостя подбирают миксы без ИИ
 * (lib/services/hookah/mix_engine.dart).
 *
 * Общий каталог вкусов (state/tobacco-catalog.json): каждая распознанная
 * банка любого заведения пополняет его — марка, название, вкусы, когда
 * впервые встретилась. Так база сама узнаёт о новинках: что недавно
 * появилось на полках, касса показывает в «Новинки вкусов». Только товары,
 * без данных людей.
 *
 * POST /tobaccoShelf {tenantId, action}:
 *   scan   {page: {mediaType, data}} → {items: [{brand, name, flavors, strength}]}
 *   learn  {items}                   → пополнить каталог (после сохранения полки)
 *   catalog                          → {fresh: […новинки за 60 дней], total}
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const tobaccoDb = require("./tobacco-db");

const TOBACCO_AI_PROMPT = `На фото — полка с банками табака для кальяна. Прочитай надписи на КАЖДОЙ видимой банке (и на крышках, и сбоку).
Банки бывают стопками, разной высоты, стеклянными с наклейкой, частично закрыты соседними; свет бывает тусклым — читай внимательно каждую стопку сверху вниз, слева направо.
Частая подпись «с ароматом …», «аромат …» — это и есть вкус банки. Марка обычно крупно на крышке или на ленте сбоку.
НЕ бери банки с обоев, плакатов, наклеек, фотографий и рекламы на стене — только настоящие банки на полке.
Крупные слова на банках вроде «СЛЕПОТА», «ИМПОТЕНЦИЯ», «ИНФАРКТ», «ИНСУЛЬТ», «ГАНГРЕНА», «МУЧИТЕЛЬНАЯ СМЕРТЬ», «БЕСПЛОДИЕ», «КУРЕНИЕ УБИВАЕТ», «СОДЕРЖИТ СИСТЕМНЫЕ ЯДЫ» и фото болезней — обязательные предупреждения о вреде. Это НЕ вкус и НЕ марка: никогда не пиши их в name.
Часто предупреждение закрывает лицевую сторону, а вкус написан от руки маркером на ленте или наклейке («Kriek», «Finlandia vanilla») — рукописная надпись и есть название вкуса. Ищи и мелкий текст состава: «с ароматом вишни» → вкус вишня. Марку ищи на ленте, крышке, боковой полосе (например TROFIMOFF'S, BONCHE, DARKSIDE, DEDUSHKA, ЛАСТОЧКА), а если её не видно — оставь brand пустым, не выдумывай.
МАРКА И ЛИНЕЙКА — РАЗНЫЕ ПОЛЯ, у КАЖДОЙ банки определяй оба. На ленте часто крупно написана линейка, а не марка: TERROR — линейка марки Trofimoff's (brand "Trofimoff's", line "Terror"), Shot — линейка Darkside, Shock — Black Burn, Hard Line — Spectrum, Земля/Огонь — Element, Noir — Tangiers. В line пиши линейку, в brand — марку (как в базе, например Trofimoff's — с апострофом).
КАК УЗНАТЬ ЛИНЕЙКУ: (1) надпись линейки на ленте, крышке или донышке; (2) цвет банки, ленты и крышки — у одной марки банки разного цвета почти всегда разные линейки (красная банка Trofimoff's — Burley); (3) форма и размер — жестянка, стеклянная банка, пластик, высокая или низкая, широкая или узкая, пакет; (4) известные вкусы линейки. Если у марки линейка одна или по виду не понять — line пустой, не выдумывай.
В look коротко опиши вид банки: цвет банки и ленты, материал и форму («чёрная жестянка, красная лента», «белая пластиковая, низкая») — по нему узнаются банки без надписи.
У ОДНОЙ банки надписи часто разнесены: название вкуса — на крышке или верхней наклейке (например «ORANGE TIC TAC»), а марка и «аромат …» — на боковой ленте (например «DEUS», «аромат апельсинового драже»), рядом может быть предупреждение («ИМПОТЕНЦИЯ»). Собери всё, что видно на одной банке, в ОДНУ запись: name — название вкуса, brand — марка с ленты, flavors — из «аромат …» (апельсиновое драже → апельсин, драже). Текст, обрезанный краем или повёрнутый, всё равно дочитывай по видимой части. Известные слова: Tic Tac — драже-конфеты, Bubble gum/Бубльгум — жвачка.
Фото может быть тёмным или смазанным — всё равно разбери каждую надпись, которую можно прочитать хотя бы частично; не пропускай банку, если читается вкус.
БАЗА МАРОК. Марку часто не видно (лента повёрнута, банку закрывает соседняя) — тогда определяй её по оформлению банки и по известным вкусам марки. Если прочитанное название вкуса есть в списке вкусов марки — это банка этой марки, пиши название так, как в списке:
${tobaccoDb.promptCatalog()}
ОДИНАКОВЫЙ ВИД — ОДНА МАРКА: если у банки марку не видно, а на снимке есть банка того же оформления (тот же цвет банки, та же лента, тот же шрифт) с видимой маркой — ставь ту же марку. Если марку не видно и по виду не узнать — brand пустой.
ВСЕ БАНКИ: перечисли каждую банку в каждой стопке, даже если видна только часть ленты. На полке бывает 15–25 банок — посчитай их и не пропускай.
Frigate — сухой табак (без глицерина, для крепости микса): вкуса часто нет, name — как написано, flavors — «табачный».
Бывают необычные «гастрономические» вкусы (салями, плов, сыр, бекон, кунжут) — пиши их как есть, это не ошибка.
Читай название по буквам и не исправляй на похожее слово: «Тростниковая мята», а не «Простниковая»; «Бубльгум» — это жвачка (bubble gum); «Wintergreen» / «Винтергрин» — грушанка, мятно-холодный вкус.
Для каждой банки верни:
- brand — марку, как написано (частые: Darkside, Musthave, Black Burn, Element, Blanch, Timeless, WTO, Frigate, Sapphire Crown, Original Virginia, Tangiers, Al Fakher, Adalya, Serbetli, Fumari, Starbuzz, Spectrum, Sebero, Duft, Satyr, Bonche, Jent, Trofimoff's, Deus, Dogma, Banger, Overdose, Хулиган, MattPear, Palitra, NАШ, Северный, Kraken, Daily Hookah, Burn, Sarma, Craftium, Starline, Morpheus, Lastochka, Timeline, Chabacco, Brusko, Zomo, Dedushka и др.);
- name — название вкуса так, как написано на банке, без перевода (например «Pinkman», «Supernova», «Ice Baby», «Love 66», «Спелая лесная малина»);
- flavors — из чего вкус, простыми русскими словами. Если название «придуманное», напиши, что знаешь об этой банке (Pinkman — грейпфрут, клубника, малина; Supernova — ментол, холодок; Love 66 — маракуйя, дыня, арбуз, мята). Не знаешь вкус и по надписи не понять — оставь пустым, не выдумывай;
- strength — крепость, если написана или известна линейка (light|medium|strong), иначе пусто;
- line — линейка марки, если видна (Core, Base, Hard Line, Земля…), иначе пусто;
- look — вид банки тремя-пятью словами: цвет банки, цвет ленты, рисунок (например «чёрная, фиолетовая лента, звёзды»).
Одинаковые банки (одна марка и вкус) — один раз. Нечитаемые — пропусти.
Ответь только JSON: {"items":[{"brand":"Black Burn","name":"Ice Baby","flavors":["грейпфрут","ягоды","холодок"],"strength":"strong","line":"","look":"чёрная, яркая этикетка"}]}`;

const MULTI_NOTE = `Это несколько снимков ОДНОГО и того же места с разных сторон (одна банка или одна полка). Одну и ту же банку на разных снимках узнавай по форме, цвету и наклейкам и записывай ОДИН раз, объединив всё, что прочитано на всех снимках: название с крышки или верхней наклейки, марку и «аромат …» с боковой ленты.`;

function cleanText(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Обязательные предупреждения о вреде на банках («СЛЕПОТА», «ИНФАРКТ»…) —
// не вкус. ИИ иногда берёт их за название, поэтому проверяем сами.
const WARNING_RE = /(слепот|импотенц|инфаркт|инсульт|гангрен|бесплод|мучительн|(?:^|[^а-яё])смерть(?:$|[^а-яё])|курение убива|системн\S* яд|канцероген|рак (горла|л[её]гких|полости)|выкидыш|пародонт|преждевременн|вред(ит)? здоров)/i;
function isWarning(text) {
  return WARNING_RE.test(String(text || ""));
}

/** Ответ ИИ → аккуратный список банок (без повторов). */
function itemsFromAi(parsed) {
  const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  const out = [];
  const seen = new Set();
  for (const it of raw.slice(0, 200)) {
    if (!it || typeof it !== "object") continue;
    const rawBrand = cleanText(it.brand, 40);
    const brand = isWarning(rawBrand) ? "" : rawBrand;
    const flavors = (Array.isArray(it.flavors) ? it.flavors : String(it.flavors || "").split(","))
      .map((f) => cleanText(f, 30).toLowerCase()).filter((f) => f && !isWarning(f)).slice(0, 6);
    let name = cleanText(it.name || it.flavor, 60);
    // Название — предупреждение о вреде: берём вкус из состава, иначе банку пропускаем.
    if (isWarning(name)) name = flavors.length ? flavors[0][0].toUpperCase() + flavors[0].slice(1) : "";
    if (!name) continue;
    const strength = ["light", "medium", "strong"].includes(it.strength) ? it.strength : "";
    const line = isWarning(it.line) ? "" : cleanText(it.line, 30);
    const look = cleanText(it.look, 80).toLowerCase();
    const key = `${brand.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ brand, name, flavors, strength, ...(line ? { line } : {}), ...(look ? { look } : {}) });
  }
  // По базе марок: «BLACKBURN» → «Black Burn», пустая марка — по
  // известному вкусу марки («Мощная мята» → Spectrum).
  tobaccoDb.enrich(out);
  // Марку не видно, а по виду банка как соседняя с маркой — та же марка
  // (ИИ описывает вид в look; совпадение слов ≥ 70 %).
  const words = (t) => new Set(String(t || "").replace(/ё/g, "е").split(/[^a-zа-я0-9]+/).filter((w) => w.length > 2));
  const branded = out.filter((x) => x.brand && x.look);
  for (const x of out) {
    if (x.brand || !x.look) continue;
    const a = words(x.look);
    if (a.size < 2) continue;
    let best = null;
    let bestScore = 0;
    for (const y of branded) {
      const b = words(y.look);
      const inter = [...a].filter((w) => b.has(w)).length;
      const score = inter / Math.max(a.size, b.size);
      if (score > bestScore) { bestScore = score; best = y; }
    }
    if (best && bestScore >= 0.7) x.brand = best.brand;
  }
  return out;
}

function createTobacco(deps) {
  const { verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, aiVendor, aiComplete, extractJson, limiter, stateDir, now = () => Date.now() } = deps;
  const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const catalogFile = path.join(stateDir || path.join(__dirname, "state"), "tobacco-catalog.json");
  let catalog = null;

  function loadCatalog() {
    if (catalog) return catalog;
    try { catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8")); } catch (_) { catalog = {}; }
    return catalog;
  }
  function saveCatalog() {
    try {
      fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
      fs.writeFileSync(catalogFile + ".tmp", JSON.stringify(catalog));
      fs.renameSync(catalogFile + ".tmp", catalogFile);
    } catch (e) {
      console.error(`tobacco: каталог не сохранён: ${e.message}`);
    }
  }

  // Большая полка читается ИИ дольше минуты: и касса, и nginx столько не
  // ждут одного ответа. Поэтому разбор — заданием: scanStart отдаёт номер,
  // касса спрашивает scanResult раз в несколько секунд.
  const jobs = new Map(); // id → {tid, status, items, error, at}
  const JOB_TTL_MS = 15 * 60 * 1000;
  function sweepJobs() {
    const t = now();
    for (const [id, j] of jobs) if (t - j.at > JOB_TTL_MS) jobs.delete(id);
  }
  function scanStart(tid, body) {
    sweepJobs();
    if ([...jobs.values()].filter((j) => j.tid === tid && j.status === "running").length >= 3) {
      throw new HttpError(429, "Уже читаются три снимка — дождитесь результата");
    }
    const id = crypto.randomBytes(12).toString("hex");
    const job = { tid, status: "running", items: null, error: "", at: now() };
    jobs.set(id, job);
    // Проверки (размер, лимит, ИИ подключён) — сразу, ошибка уйдёт в ответ.
    const run = scan(tid, body);
    run.then((r) => { job.status = "done"; job.items = r.items; job.at = now(); },
      (e) => { job.status = "failed"; job.error = String((e && e.message) || e).slice(0, 300); job.code = e && e.status; job.at = now(); });
    return { job: id };
  }
  function scanResult(tid, body) {
    const j = jobs.get(String(body.job || ""));
    if (!j || j.tid !== tid) throw new HttpError(404, "Снимок не найден — сфотографируйте полку ещё раз");
    if (j.status === "running") return { status: "running" };
    jobs.delete(String(body.job));
    if (j.status === "failed") return { status: "failed", error: j.error };
    return { status: "done", items: j.items };
  }

  async function scan(tid, body) {
    // Несколько снимков одной банки или полки с разных сторон (название на
    // крышке, марка и «аромат …» сбоку) — одним запросом, ИИ сводит их.
    const pages = (Array.isArray(body.pages) && body.pages.length ? body.pages : [body.page]).slice(0, 5);
    if (pages.length > 4) throw new HttpError(400, "Не больше 4 снимков за раз");
    let total = 0;
    for (const page of pages) {
      if (!page || !TYPES.has(page.mediaType) || typeof page.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(page.data)) {
        throw new HttpError(400, "Нужна фотография JPEG, PNG или WebP");
      }
      total += page.data.length;
    }
    if (total > 960000) throw new HttpError(413, "Фото больше 0,9 МБ — снимите полку ещё раз");
    const t = now();
    const lim = limiter.get(tid);
    if (!lim || lim.resetAt <= t) limiter.set(tid, { count: 1, resetAt: t + 3600000 });
    else if (lim.count + 1 > 60) throw new HttpError(429, "За час можно распознать до 60 снимков — продолжите позже");
    else lim.count += 1;
    const vendor = await aiVendor(tid);
    if (!vendor) throw new HttpError(412, "Подключите ИИ в кабинете (раздел «ИИ») — полка распознаётся через ключ заведения");
    let parsed;
    try {
      const text = await aiComplete(vendor, {
        system: "Ты внимательно читаешь надписи на банках табака. Отвечай только JSON.",
        content: [
          { type: "text", text: [TOBACCO_AI_PROMPT, learnedLooks(), pages.length > 1 ? MULTI_NOTE : ""].filter(Boolean).join("\n\n") },
          ...pages.map((page) => ({ type: "image", mediaType: page.mediaType, data: page.data })),
        ],
        maxTokens: 4000, heavy: true,
      });
      parsed = extractJson(text);
    } catch (e) {
      throw new HttpError(502, `ИИ не распознал полку: ${String(e.message || e).slice(0, 160)}`);
    }
    const items = itemsFromAi(parsed);
    if (!items.length) throw new HttpError(422, "Не удалось прочитать банки — снимите ближе и при хорошем свете");
    return { items };
  }

  /** Пополнить общий каталог банками, которые заведение сохранило. */
  function learn(items) {
    const cat = loadCatalog();
    const t = now();
    let added = 0;
    for (const it of itemsFromAi({ items }).slice(0, 300)) {
      const key = `${it.brand.toLowerCase()}|${it.name.toLowerCase()}`;
      const cur = cat[key];
      if (cur) {
        cur.count = (cur.count || 1) + 1;
        cur.last = t;
        if (!cur.flavors?.length && it.flavors.length) cur.flavors = it.flavors;
        // Линейку и вид банки поправило заведение — берём последнее подтверждённое.
        if (it.line) cur.line = it.line;
        if (it.look) {
          cur.looks = cur.looks || {};
          cur.looks[it.look] = (cur.looks[it.look] || 0) + 1;
          trimLooks(cur);
        }
      } else {
        cat[key] = { brand: it.brand, name: it.name, flavors: it.flavors, strength: it.strength, count: 1, first: t, last: t,
          ...(it.line ? { line: it.line } : {}), ...(it.look ? { looks: { [it.look]: 1 } } : {}) };
        added++;
      }
    }
    // Не больше 20 000 записей: самые редкие и давние — первыми на выход.
    const keys = Object.keys(cat);
    if (keys.length > 20000) {
      keys.sort((a, b) => (cat[a].count - cat[b].count) || (cat[a].last - cat[b].last));
      for (const k of keys.slice(0, keys.length - 20000)) delete cat[k];
    }
    saveCatalog();
    learnedCache = null;
    return { added, total: Object.keys(cat).length };
  }

  function trimLooks(c) {
    const ks = Object.keys(c.looks || {});
    if (ks.length <= 5) return;
    ks.sort((a, b) => c.looks[b] - c.looks[a]);
    for (const k of ks.slice(5)) delete c.looks[k];
  }

  /**
   * Вид банок, который заведения проверили и сохранили на полку: марка + линейка →
   * самые частые описания вида. Добавляется к подсказке ИИ — так он учится узнавать
   * линейку и марку по цвету и форме банки на любых полках.
   */
  let learnedCache = null;
  function learnedLooks(limit = 80) {
    if (learnedCache && learnedCache.at > now() - 600000) return learnedCache.text;
    const groups = new Map();
    for (const c of Object.values(loadCatalog())) {
      if (!c.brand || !c.looks) continue;
      const g = `${c.brand}${c.line ? ` ${c.line}` : ""}`;
      const cur = groups.get(g) || { looks: {}, n: 0 };
      for (const [l, n] of Object.entries(c.looks)) { cur.looks[l] = (cur.looks[l] || 0) + n; cur.n += n; }
      groups.set(g, cur);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, limit).map(([g, v]) => {
      const top = Object.entries(v.looks).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l);
      return `• ${g} — ${top.join("; ")}`;
    });
    const text = rows.length ? `ВИД БАНОК, ПРОВЕРЕННЫЙ ЗАВЕДЕНИЯМИ (марка и линейка — как выглядит банка):\n${rows.join("\n")}` : "";
    learnedCache = { at: now(), text };
    return text;
  }

  /** Новинки: впервые встретились за последние 60 дней (сначала новые). */
  function fresh(limit = 60) {
    const cat = loadCatalog();
    const since = now() - 60 * 86400000;
    const list = Object.values(cat).filter((c) => c.first >= since).sort((a, b) => b.first - a.first).slice(0, limit);
    return { fresh: list.map((c) => ({ brand: c.brand, name: c.name, flavors: c.flavors || [], first: c.first })), total: Object.keys(cat).length };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req, 1048576);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    // Полку снимает кальянщик с кассы — устройство кассы тоже «сотрудник».
    await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager", "employee"]);
    const action = String(body.action || "scan");
    if (action === "scan") return sendJson(res, 200, await scan(tid, body));
    if (action === "scanStart") return sendJson(res, 200, scanStart(tid, body));
    if (action === "scanResult") return sendJson(res, 200, scanResult(tid, body));
    if (action === "learn") return sendJson(res, 200, learn(Array.isArray(body.items) ? body.items : []));
    if (action === "catalog") return sendJson(res, 200, fresh(Number(body.limit) || 60));
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, scan, scanStart, scanResult, learn, fresh, jobs, learnedLooks };
}

module.exports = { createTobacco, itemsFromAi, isWarning, TOBACCO_AI_PROMPT };
