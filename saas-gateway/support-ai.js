"use strict";
/**
 * ИИ бота поддержки: несколько провайдеров и ключей по порядку, лёгкая и
 * сильная модель у каждого, переключение, когда у ключа закончились токены.
 *
 *  - Провайдеры — supportBot/config.ai.providers: [{ id, vendor, baseUrl,
 *    format, light, heavy, keyEnc, enabled }]. Порядок — приоритет: первым
 *    пробуем верхний, при ошибке — следующий.
 *  - Ошибка разбирается: кончился баланс/квота — ключ отдыхает 6 часов,
 *    ключ не принят — час, перегрузка (429) — минуту, модель не найдена —
 *    пробуем вторую модель того же провайдера. Всё отдыхает — ИИ зовёт
 *    человека.
 *  - Сложность вопроса (needsHeavy) — по признакам, без лишнего запроса к
 *    ИИ: длинный, юридический, расчёт или сравнение, долгий диалог — сильная
 *    модель; остальное — лёгкая (в 10–20 раз дешевле).
 *  - Модели можно не указывать: при сохранении бот спрашивает у провайдера
 *    список моделей (/models) и выбирает лёгкую и сильную сам.
 *
 * Форматы: OpenAI-совместимый (chat/completions — Tooken, DarkAPI,
 * OpenRouter, DeepSeek, OpenAI, Gemini, любой шлюз) и Anthropic Messages.
 */

const AI_TIMEOUT_MS = 45000;
const MAX_PROVIDERS = 8;

const VENDORS = {
  // Модели Tooken Club бот выбирает сам по списку /v1/models (pickModels):
  // лучшие по цене и качеству на каждую ступень сложности.
  tooken: { title: "Tooken Club", baseUrl: "https://tooken.club/v1", format: "openai", light: "", heavy: "", fallback: { light: "gpt-4o-mini", heavy: "gpt-4o" }, hint: "Ключ из кабинета tooken.club — один ключ к GPT, Claude, DeepSeek, GLM и Gemini, оплата в рублях. Модели бот подберёт сам" },
  darkapi: { title: "DarkAPI", baseUrl: "https://darkapi.shop/v1", format: "openai", light: "deepseek-chat", heavy: "deepseek-chat", hint: "Ключ из кабинета darkapi.shop" },
  openrouter: { title: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai", light: "openai/gpt-4o-mini", heavy: "openai/gpt-4o", hint: "Ключ из openrouter.ai/keys — сотни моделей по одному ключу" },
  deepseek: { title: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", format: "openai", light: "deepseek-chat", heavy: "deepseek-reasoner", hint: "Ключ из platform.deepseek.com" },
  openai: { title: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai", light: "gpt-4o-mini", heavy: "gpt-4o", hint: "Ключ из platform.openai.com (из РФ без прокси может не работать)" },
  anthropic: { title: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic", light: "claude-haiku-5-5", heavy: "claude-sonnet-5-5", hint: "Ключ из console.anthropic.com (из РФ без прокси может не работать)" },
  gemini: { title: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", format: "openai", light: "gemini-flash-latest", heavy: "gemini-pro-latest", hint: "Ключ из aistudio.google.com (из РФ нужен прокси в адресе API)" },
  custom: { title: "Свой шлюз", baseUrl: "", format: "openai", light: "", heavy: "", hint: "Любой OpenAI-совместимый адрес …/v1 и ключ к нему" },
};

const norm = (t) => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/** Провайдеры из настроек; старый формат (один ai.vendor/model/keyEnc) — первым провайдером. */
function normalizeProviders(ai) {
  const a = ai && typeof ai === "object" ? ai : {};
  let list = Array.isArray(a.providers) ? a.providers : [];
  if (!list.length && (a.keyEnc || a.baseUrl)) {
    const v = VENDORS[a.vendor] ? a.vendor : "custom";
    list = [{ id: "p1", vendor: v, baseUrl: a.baseUrl || VENDORS[v].baseUrl, light: a.model || VENDORS[v].light || (VENDORS[v].fallback || {}).light || "", heavy: VENDORS[v].heavy || (VENDORS[v].fallback || {}).heavy || a.model || "", keyEnc: a.keyEnc || "", enabled: true }];
  }
  return list.slice(0, MAX_PROVIDERS).map((p, i) => {
    const v = VENDORS[p.vendor] ? p.vendor : "custom";
    const def = VENDORS[v];
    return {
      id: String(p.id || `p${i + 1}`), vendor: v, title: def.title,
      baseUrl: String(p.baseUrl || def.baseUrl || "").replace(/\/+$/, ""),
      format: p.format === "anthropic" || (v === "anthropic" && p.format !== "openai") ? "anthropic" : "openai",
      // Не указали модели — проверенные модели провайдера; у «своего шлюза»
      // их нет, тогда бот подбирает по списку моделей (pickModels).
      light: String(p.light || "").trim() || def.light || (def.fallback || {}).light || "",
      heavy: String(p.heavy || "").trim() || def.heavy || (def.fallback || {}).heavy || String(p.light || "").trim(),
      // Ступени, которые бот подбирает сам (вписать вручную можно только лёгкую и сильную).
      medium: String(p.medium || "").trim(), max: String(p.max || "").trim(), vision: String(p.vision || "").trim(),
      // Старые модели Tooken по умолчанию (gpt-4o-mini / gpt-4o) — не выбор
      // человека: бот заменит их лучшими из нынешнего списка.
      chosen: !!(String(p.light || "").trim() && String(p.heavy || "").trim())
        && !(v === "tooken" && p.light === "gpt-4o-mini" && p.heavy === "gpt-4o" && !p.manual),
      manual: !!p.manual,
      keyEnc: p.keyEnc || "", enabled: p.enabled !== false,
    };
  });
}

// Ступени сложности и модели на каждую — лучшие по цене и качеству (по
// коэффициентам Tooken Club: DeepSeek V4.1 Flash ×0,3, GPT-6 Luna ×0,5,
// Claude Sonnet 5.5 ×1,2, Claude Opus 5.5 ×1,8, Gemini 3.8 Flash ×1):
//  light  — короткие ответы по готовому шаблону, разбор вопроса, сжатие переписки;
//  medium — обычный ответ клиенту;
//  heavy  — законы, расчёты, найденное в интернете, недовольство, обман;
//  max    — сильная модель не помогла, а клиент всё ещё недоволен;
//  vision — посмотреть скриншот.
// Дорогие модели (Claude Fable ×2,5, Gemini 4 Argon ×2,6) бот сам не берёт.
const TIER_PREF = {
  light: [/deepseek[\w.-]*v4\.?1[\w.-]*flash/, /deepseek[\w.-]*flash/, /glm[\w.-]*flash/, /gpt-?6[\w.-]*luna/, /claude[\w.-]*haiku/, /gpt-4\.1-mini/, /gpt-4o-mini/, /gpt-5-mini/, /gemini[\w.-]*flash(?![\w.-]*lite)/, /deepseek-chat/, /qwen[\w.-]*(turbo|plus)/, /mini/, /flash/],
  medium: [/gpt-?6[\w.-]*luna/, /claude[\w.-]*haiku/, /deepseek[\w.-]*v4[\w.-]*pro/, /glm[\w.-]*5\.?3(?![\w.-]*flash)/, /gpt-?5\.6[\w.-]*terra/, /gemini[\w.-]*flash/, /gpt-4o-mini/, /deepseek-chat/],
  heavy: [/claude[\w.-]*sonnet/, /gpt-?6\.1[\w.-]*sol/, /deepseek[\w.-]*v4[\w.-]*pro/, /gpt-?5\.6[\w.-]*terra/, /gpt-5(?![\w.-]*(mini|nano))/, /gpt-4\.1(?![\w.-]*(mini|nano))/, /gpt-4o(?![\w.-]*mini)/, /gemini[\w.-]*pro/, /deepseek-(chat|v3)/, /qwen[\w.-]*max/, /llama[\w.-]*405b/],
  max: [/claude[\w.-]*opus/, /gpt-?6(?![\w.-]*(luna|\.1))[\w.-]*astra/, /claude[\w.-]*sonnet/, /gpt-?6\.1[\w.-]*sol/],
  vision: [/gemini[\w.-]*flash(?![\w.-]*lite)/, /gpt-?6[\w.-]*luna/, /claude[\w.-]*haiku/, /gpt-4o-mini/, /claude[\w.-]*sonnet/, /gpt-?6\.1/, /gpt-4o/],
};
// Не берём сами: дорогие и не для текста.
const PRICEY = /(fable|argon)/;
const LIGHT_PREF = TIER_PREF.light;
const HEAVY_PREF = TIER_PREF.heavy;
const SKIP = /(embed|whisper|tts|audio|image|dall|vision-preview|moderation|search|realtime|transcribe|instruct|davinci|babbage|-0301|-0314|sunburst)/;

/** Коэффициент списания у Tooken Club (×токены) — для учёта расхода баланса. */
const COST = [[/fable/, 2.5], [/argon/, 2.6], [/opus/, 1.8], [/astra/, 1.8], [/sonnet/, 1.2], [/sol/, 1.2], [/haiku/, 0.7], [/terra/, 0.8], [/grok/, 0.8],
  [/luna/, 0.5], [/deepseek[\w.-]*pro/, 0.4], [/glm[\w.-]*flash/, 0.3], [/glm/, 0.4], [/deepseek[\w.-]*flash/, 0.3], [/gemini[\w.-]*flash/, 1]];
const costOf = (model) => {
  const m = String(model || "").toLowerCase();
  const hit = COST.find(([re]) => re.test(m));
  return hit ? hit[1] : 1;
};

/** Из списка моделей провайдера — лёгкая и сильная. Короткое имя (без даты) предпочтительнее. */
function pickModels(ids, vendor = "custom") {
  const all = [...new Set((ids || []).map(String))].filter((id) => !SKIP.test(id.toLowerCase()) && !PRICEY.test(id.toLowerCase()));
  const pick = (prefs) => {
    for (const re of prefs) {
      const hits = all.filter((id) => re.test(id.toLowerCase())).sort((a, b) => a.length - b.length);
      if (hits.length) return hits[0];
    }
    return "";
  };
  const def = VENDORS[vendor] || VENDORS.custom;
  const light = (def.light && all.includes(def.light) ? def.light : pick(TIER_PREF.light)) || all[0] || def.light || (def.fallback || {}).light || "";
  const heavy = (def.heavy && all.includes(def.heavy) ? def.heavy : pick(TIER_PREF.heavy)) || (all.length ? "" : (def.fallback || {}).heavy) || light;
  const medium = pick(TIER_PREF.medium) || light;
  const max = pick(TIER_PREF.max) || heavy;
  const vision = pick(TIER_PREF.vision) || "";
  return { light, medium, heavy, max, vision };
}

/** Модели по порядку для ступени: нужная, потом соседние (если её нет или она отдыхает). */
function chainFor(p, tier) {
  const order = {
    light: [p.light, p.medium, p.heavy],
    medium: [p.medium, p.light, p.heavy],
    heavy: [p.heavy, p.medium, p.light],
    max: [p.max, p.heavy, p.medium],
    vision: [p.vision, p.medium, p.light, p.heavy],
  }[tier] || [p.light, p.heavy];
  return [...new Set(order.filter(Boolean))];
}

/** Вопрос сложный — сильная модель. Признаки, без запроса к ИИ. */
function needsHeavy(question, history = []) {
  const t = norm(question);
  if (t.length > 450) return true;
  if ((t.match(/\?/g) || []).length >= 3) return true;
  if (/(закон|фз|юрид|юрист|договор|оферт|налог|ндс|усн|патент|штраф|лицензи|роскомнадзор|персональн|152|54-фз|маркировк|егаис|суд|претензи|трудов|увольн|расч[её]т|посчита|сравни|проанализ|анализ|стратег|прогноз|почему (все еще|до сих)|вс[её] (еще|равно) не|после (этого|обновлени)[а-я ]*не)/.test(t)) return true;
  // Долгий диалог сам по себе не повод для сильной модели: повод — недовольство
  // клиента (его ловит pickTier). Иначе с третьего ответа платили бы втридорога.
  return history.filter((m) => m.authorRole === "ai").length >= 10;
}

/** Разбор ошибки провайдера: что случилось и сколько ключу отдыхать. */
function classifyError(status, message) {
  const m = norm(message);
  if (status === 402 || /insufficient|quota|balance|credit|billing|payment required|недостаточно|баланс|закончил|exceeded your|out of tokens|no credits/.test(m)) {
    return { kind: "exhausted", ms: 6 * 3600 * 1000, text: "закончились токены или баланс" };
  }
  if (status === 401 || status === 403 || /invalid[\w ]*key|incorrect api key|unauthori[sz]ed|authentication|permission denied|api key/.test(m)) {
    return { kind: "auth", ms: 3600 * 1000, text: "ключ не принят" };
  }
  if (status === 404 || /model[\w ]*(not found|does not exist|not available|not supported)|unknown model|no such model/.test(m)) {
    return { kind: "model", ms: 30 * 60 * 1000, text: "модель недоступна" };
  }
  if (status === 429) return { kind: "rate", ms: 60 * 1000, text: "слишком много запросов" };
  return { kind: "down", ms: 2 * 60 * 1000, text: "провайдер не ответил" };
}

/** Anthropic: system отдельно, первым — сообщение пользователя. */
/** Содержимое в формате OpenAI (строка или части text/image_url) → Anthropic. */
function anthropicContent(content) {
  if (!Array.isArray(content)) return String(content || "");
  return content.map((c) => {
    const url = c && c.type === "image_url" && String((c.image_url && c.image_url.url) || "");
    const m = url && url.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    return { type: "text", text: String((c && c.text) || "") };
  });
}

function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: anthropicContent(m.content) }));
  if (!rest.length || rest[0].role !== "user") rest.unshift({ role: "user", content: "(начало переписки)" });
  return { system, messages: rest };
}

/**
 * Маршрутизатор ИИ. getKey(p) — расшифрованный ключ; onStatus(p, status) —
 * сохранить состояние ключа; onSwitch(from, to, reason) — сообщить админам.
 */
/** Имя модели без дат, версий-суффиксов и знаков: «deepseek-v4.1-flash-1017» → «deepseekv41flash». */
const modelKey = (id) => String(id || "").toLowerCase().replace(/^models\//, "").replace(/[-_.](\d{4}|\d{6,8}|latest|preview)$/g, "").replace(/[^a-z0-9]/g, "");

/** Модели нет у провайдера под таким именем — ближайшая из его списка:
 *  то же имя с датой/суффиксом («…-flash» → «…-flash-1017»), то же имя без
 *  знаков, иначе модель той же ступени. Пусто — подобрать нечего. */
function closestModel(model, ids, tier = "light") {
  const list = [...new Set((ids || []).map(String))];
  if (!model || list.includes(model)) return model && list.includes(model) ? model : "";
  const m = String(model).toLowerCase();
  const byShortest = (a, b) => a.length - b.length;
  const prefix = list.filter((id) => id.toLowerCase().startsWith(`${m}-`) || id.toLowerCase().startsWith(`${m}.`)).sort(byShortest);
  if (prefix.length) return prefix[0];
  const k = modelKey(model);
  const same = list.filter((id) => modelKey(id) === k || (k.length >= 6 && modelKey(id).startsWith(k))).sort(byShortest);
  if (same.length) return same[0];
  const picked = pickModels(list);
  return picked[tier] || picked.light || "";
}

function createAiRouter({ fetchImpl, now = () => Date.now(), getKey, onStatus = () => {}, onSwitch = () => {}, onUsage = () => {}, onModelFix = () => {} }) {
  const doFetch = fetchImpl || fetch;
  const status = new Map(); // id → { state, text, until, lastOkAt, lastModel }
  // Список моделей провайдера — раз в час, для исправления имён моделей.
  const modelLists = new Map(); // id → { at, ids }
  async function modelsOf(p) {
    const hit = modelLists.get(p.id);
    if (hit && now() - hit.at < 3600 * 1000) return hit.ids;
    const ids = await listModels(p);
    modelLists.set(p.id, { at: now(), ids });
    return ids;
  }
  const TIER_FIELDS = ["light", "medium", "heavy", "max", "vision"];

  /** Модель ответила ошибкой не про ключ и баланс — есть ли у провайдера
   *  такая модель? Нет — ближайшая из списка, и все ступени с этим именем
   *  исправляются (onModelFix сохранит в настройки). */
  async function fixModel(p, model, tier) {
    let ids;
    try {
      ids = await modelsOf(p);
    } catch (_) {
      return "";
    }
    if (!ids.length || ids.includes(model)) return "";
    const to = closestModel(model, ids, tier);
    if (!to || to === model) return "";
    const fields = TIER_FIELDS.filter((f) => p[f] === model);
    for (const f of fields) p[f] = to;
    onModelFix(p, model, to, fields);
    return to;
  }

  const restingUntil = (p) => Number((status.get(p.id) || {}).until) || 0;
  const usable = (p) => p.enabled && !!getKey(p) && !!p.baseUrl;

  async function callOnce(p, model, messages, { maxTokens, temperature }) {
    const key = getKey(p);
    let url;
    let init;
    if (p.format === "anthropic") {
      const a = toAnthropic(messages);
      url = `${p.baseUrl}${/\/v1$/.test(p.baseUrl) ? "" : "/v1"}/messages`;
      init = {
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system: a.system, messages: a.messages }),
      };
    } else {
      url = `${p.baseUrl}/chat/completions`;
      init = {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      };
    }
    let resp;
    try {
      resp = await doFetch(url, { method: "POST", ...init, signal: AbortSignal.timeout(AI_TIMEOUT_MS), redirect: "error" });
    } catch (e) {
      const err = new Error(`нет связи: ${e.message || e}`);
      err.status = 0;
      throw err;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(String((data.error && (data.error.message || data.error.type)) || data.message || resp.status).slice(0, 200));
      err.status = resp.status;
      throw err;
    }
    const text = p.format === "anthropic"
      ? (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
      : ((((data.choices || [])[0] || {}).message || {}).content || "");
    if (!String(text).trim()) {
      const err = new Error("пустой ответ");
      err.status = 200;
      throw err;
    }
    const u = data.usage || {};
    const tokens = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
    return { text: String(text), tokens };
  }

  /** Ответ ИИ: провайдеры по порядку, у каждого — нужная модель, потом запасная. */
  /** soft — пробный запрос (например, картинка): ошибка не отправляет ключ
   *  «отдыхать» и не считается переключением — модель могла просто не уметь. */
  async function complete(providers, messages, { tier = "light", maxTokens = 600, temperature = 0.3, soft = false } = {}) {
    const list = providers.filter(usable);
    if (!list.length) throw new Error("ИИ не настроен: нет включённых ключей");
    const errors = [];
    let first = null;
    for (const p of list) {
      if (restingUntil(p) > now()) {
        errors.push(`${p.title}: ${(status.get(p.id) || {}).text || "отдыхает"}`);
        continue;
      }
      const models = chainFor(p, tier);
      if (!models.length) continue;
      for (let i = 0; i < models.length; i++) {
        try {
          const r = await callOnce(p, models[i], messages, { maxTokens, temperature });
          const st = { state: "ok", text: "работает", until: 0, lastOkAt: now(), lastModel: models[i] };
          status.set(p.id, st);
          onStatus(p, st);
          onUsage(p, models[i], r.tokens, (tier === "heavy" || tier === "max") && models[i] !== p.light, { tier, cost: Math.round((Number(r.tokens) || 0) * costOf(models[i])) });
          if (first && first.id !== p.id) onSwitch(first, p, errors[errors.length - 1] || "");
          return { text: r.text, provider: p, model: models[i], tokens: r.tokens, tier };
        } catch (e) {
          const c = classifyError(e.status, e.message);
          // Имя модели не совпало со списком провайдера — исправляем и повторяем.
          if (c.kind !== "auth" && c.kind !== "exhausted" && !e.fixed) {
            const to = await fixModel(p, models[i], tier);
            if (to) {
              try {
                const r = await callOnce(p, to, messages, { maxTokens, temperature });
                const st = { state: "ok", text: "работает", until: 0, lastOkAt: now(), lastModel: to };
                status.set(p.id, st);
                onStatus(p, st);
                onUsage(p, to, r.tokens, (tier === "heavy" || tier === "max") && to !== p.light, { tier, cost: Math.round((Number(r.tokens) || 0) * costOf(to)) });
                return { text: r.text, provider: p, model: to, tokens: r.tokens, tier };
              } catch (e2) {
                e = e2;
                e.fixed = true;
              }
            }
          }
          errors.push(`${p.title} (${models[i]}): ${c.text}`);
          if (soft) continue;
          // Модели нет — пробуем вторую модель того же провайдера.
          if (c.kind === "model" && i < models.length - 1) continue;
          const st = { state: c.kind, text: c.text, until: now() + c.ms, lastOkAt: (status.get(p.id) || {}).lastOkAt || 0, detail: e.message };
          status.set(p.id, st);
          onStatus(p, st);
          if (!first) first = p;
          break;
        }
      }
    }
    const err = new Error(`все ключи недоступны — ${errors.join("; ")}`);
    err.all = true;
    throw err;
  }

  /** Список моделей провайдера (для автовыбора лёгкой и сильной). */
  async function listModels(p) {
    const key = getKey(p);
    const url = p.format === "anthropic" ? `${p.baseUrl}${/\/v1$/.test(p.baseUrl) ? "" : "/v1"}/models` : `${p.baseUrl}/models`;
    const headers = p.format === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
    const resp = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000), redirect: "error" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(String((data.error && data.error.message) || resp.status).slice(0, 200));
      err.status = resp.status;
      throw err;
    }
    return (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map((m) => m.id || m.name).filter(Boolean)
      .map((id) => String(id).replace(/^models\//, ""));
  }

  /** Проверка одного ключа маленьким запросом. */
  async function check(p) {
    let model = p.light || p.heavy;
    if (!getKey(p)) return { state: "nokey", text: "нет ключа" };
    if (!model) return { state: "model", text: "не выбрана модель" };
    const started = now();
    try {
      // Имя модели сверяем со списком провайдера заранее — проверка ключа
      // не должна падать из-за «deepseek-v4.1-flash» вместо «…-flash-1017».
      model = (await fixModel(p, model, "light")) || model;
      await callOnce(p, model, [{ role: "user", content: "Ответь одним словом: ок" }], { maxTokens: 5, temperature: 0 });
      const st = { state: "ok", text: "работает", until: 0, lastOkAt: now(), lastModel: model, ms: now() - started };
      status.set(p.id, st);
      onStatus(p, st);
      return st;
    } catch (e) {
      const c = classifyError(e.status, e.message);
      const st = { state: c.kind, text: c.text, until: c.kind === "ok" ? 0 : now() + Math.min(c.ms, 10 * 60 * 1000), detail: e.message };
      status.set(p.id, st);
      onStatus(p, st);
      return st;
    }
  }

  return { complete, listModels, check, status, restore: (id, st) => status.set(id, st) };
}

module.exports = { VENDORS, MAX_PROVIDERS, TIER_PREF, normalizeProviders, pickModels, closestModel, chainFor, costOf, needsHeavy, classifyError, toAnthropic, createAiRouter };
