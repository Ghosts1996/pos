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

const TOBACCO_AI_PROMPT = `На фото — полка с банками табака для кальяна. Прочитай надписи на КАЖДОЙ видимой банке.
Для каждой банки верни марку (Black Burn, Musthave, Darkside, Banger, Deus, Bonche, Spectrum, Sebero, Duft, Element, Satyr, Trofimoff, Хулиган, Dogma, Северный, Brusko, Nash, Lastochka, Terror, Sapphire, Chabacco, Jent, Starline, Overdose, Morpheus, Timeline, Frigate, ДГМ, Dedushka и др. — как написано), название вкуса так, как написано на банке, и сам вкус простыми русскими словами (например «Пинкман» → клубника, малина, грейпфрут; «Strawberry» → клубника).
Одинаковые банки (одна марка и вкус) — один раз. Нечитаемые — пропусти, не выдумывай.
Ответь только JSON: {"items":[{"brand":"Black Burn","name":"Спелая лесная малина","flavors":["малина"],"strength":"light|medium|strong|"}]}`;

function cleanText(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Ответ ИИ → аккуратный список банок (без повторов). */
function itemsFromAi(parsed) {
  const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
  const out = [];
  const seen = new Set();
  for (const it of raw.slice(0, 200)) {
    if (!it || typeof it !== "object") continue;
    const brand = cleanText(it.brand, 40);
    const name = cleanText(it.name || it.flavor, 60);
    if (!name) continue;
    const flavors = (Array.isArray(it.flavors) ? it.flavors : String(it.flavors || "").split(","))
      .map((f) => cleanText(f, 30).toLowerCase()).filter(Boolean).slice(0, 6);
    const strength = ["light", "medium", "strong"].includes(it.strength) ? it.strength : "";
    const key = `${brand.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ brand, name, flavors, strength });
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

  async function scan(tid, body) {
    const page = body.page;
    if (!page || !TYPES.has(page.mediaType) || typeof page.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(page.data)) {
      throw new HttpError(400, "Нужна фотография JPEG, PNG или WebP");
    }
    if (page.data.length > 960000) throw new HttpError(413, "Фото больше 0,9 МБ — снимите полку ещё раз");
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
        content: [{ type: "text", text: TOBACCO_AI_PROMPT }, { type: "image", mediaType: page.mediaType, data: page.data }],
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
      } else {
        cat[key] = { brand: it.brand, name: it.name, flavors: it.flavors, strength: it.strength, count: 1, first: t, last: t };
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
    return { added, total: Object.keys(cat).length };
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
    if (action === "learn") return sendJson(res, 200, learn(Array.isArray(body.items) ? body.items : []));
    if (action === "catalog") return sendJson(res, 200, fresh(Number(body.limit) || 60));
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, scan, learn, fresh };
}

module.exports = { createTobacco, itemsFromAi, TOBACCO_AI_PROMPT };
