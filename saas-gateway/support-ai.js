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
  tooken: { title: "Tooken Club", baseUrl: "https://tooken.club/v1", format: "openai", light: "gpt-4o-mini", heavy: "gpt-4o", hint: "Ключ из кабинета tooken.club — один ключ к GPT, Claude и DeepSeek, оплата в рублях" },
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
    list = [{ id: "p1", vendor: v, baseUrl: a.baseUrl || VENDORS[v].baseUrl, light: a.model || VENDORS[v].light, heavy: VENDORS[v].heavy || a.model || "", keyEnc: a.keyEnc || "", enabled: true }];
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
      light: String(p.light || "").trim() || def.light, heavy: String(p.heavy || "").trim() || def.heavy || String(p.light || "").trim(),
      chosen: !!(String(p.light || "").trim() && String(p.heavy || "").trim()),
      keyEnc: p.keyEnc || "", enabled: p.enabled !== false,
    };
  });
}

// Как узнать «лёгкую» и «сильную» модель по названию из списка провайдера.
const LIGHT_PREF = [/claude-haiku/, /gpt-4\.1-mini/, /gpt-4o-mini/, /gpt-5-mini/, /gemini[\w.-]*flash(?![\w.-]*lite)/, /deepseek-chat/, /qwen[\w.-]*(turbo|plus)/, /llama[\w.-]*(8b|70b)/, /mini/, /flash/];
const HEAVY_PREF = [/claude-sonnet/, /gpt-5(?![\w.-]*(mini|nano))/, /gpt-4\.1(?![\w.-]*(mini|nano))/, /gpt-4o(?![\w.-]*mini)/, /gemini[\w.-]*pro/, /deepseek-(chat|v3)/, /qwen[\w.-]*max/, /claude-opus/, /llama[\w.-]*405b/];
const SKIP = /(embed|whisper|tts|audio|image|dall|vision-preview|moderation|search|realtime|transcribe|instruct|davinci|babbage|-0301|-0314)/;

/** Из списка моделей провайдера — лёгкая и сильная. Короткое имя (без даты) предпочтительнее. */
function pickModels(ids, vendor = "custom") {
  const all = [...new Set((ids || []).map(String))].filter((id) => !SKIP.test(id.toLowerCase()));
  const pick = (prefs) => {
    for (const re of prefs) {
      const hits = all.filter((id) => re.test(id.toLowerCase())).sort((a, b) => a.length - b.length);
      if (hits.length) return hits[0];
    }
    return "";
  };
  const def = VENDORS[vendor] || VENDORS.custom;
  const light = (def.light && all.includes(def.light) ? def.light : pick(LIGHT_PREF)) || all[0] || def.light;
  const heavy = (def.heavy && all.includes(def.heavy) ? def.heavy : pick(HEAVY_PREF)) || light;
  return { light, heavy };
}

/** Вопрос сложный — сильная модель. Признаки, без запроса к ИИ. */
function needsHeavy(question, history = []) {
  const t = norm(question);
  if (t.length > 450) return true;
  if ((t.match(/\?/g) || []).length >= 3) return true;
  if (/(закон|фз|юрид|юрист|договор|оферт|налог|ндс|усн|патент|штраф|лицензи|роскомнадзор|персональн|152|54-фз|маркировк|егаис|суд|претензи|трудов|увольн|расч[её]т|посчита|сравни|проанализ|анализ|стратег|прогноз|почему (все еще|до сих)|вс[её] (еще|равно) не|после (этого|обновлени)[а-я ]*не)/.test(t)) return true;
  return history.filter((m) => m.authorRole === "ai").length >= 3;
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
function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
  if (!rest.length || rest[0].role !== "user") rest.unshift({ role: "user", content: "(начало переписки)" });
  return { system, messages: rest };
}

/**
 * Маршрутизатор ИИ. getKey(p) — расшифрованный ключ; onStatus(p, status) —
 * сохранить состояние ключа; onSwitch(from, to, reason) — сообщить админам.
 */
function createAiRouter({ fetchImpl, now = () => Date.now(), getKey, onStatus = () => {}, onSwitch = () => {}, onUsage = () => {} }) {
  const doFetch = fetchImpl || fetch;
  const status = new Map(); // id → { state, text, until, lastOkAt, lastModel }

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
  async function complete(providers, messages, { tier = "light", maxTokens = 600, temperature = 0.3 } = {}) {
    const list = providers.filter(usable);
    if (!list.length) throw new Error("ИИ не настроен: нет включённых ключей");
    const errors = [];
    let first = null;
    for (const p of list) {
      if (restingUntil(p) > now()) {
        errors.push(`${p.title}: ${(status.get(p.id) || {}).text || "отдыхает"}`);
        continue;
      }
      const want = tier === "heavy" ? p.heavy || p.light : p.light || p.heavy;
      const other = tier === "heavy" ? p.light : p.heavy;
      const models = [...new Set([want, other].filter(Boolean))];
      if (!models.length) continue;
      for (let i = 0; i < models.length; i++) {
        try {
          const r = await callOnce(p, models[i], messages, { maxTokens, temperature });
          const st = { state: "ok", text: "работает", until: 0, lastOkAt: now(), lastModel: models[i] };
          status.set(p.id, st);
          onStatus(p, st);
          onUsage(p, models[i], r.tokens, tier === "heavy" && models[i] === p.heavy && p.heavy !== p.light);
          if (first && first.id !== p.id) onSwitch(first, p, errors[errors.length - 1] || "");
          return { text: r.text, provider: p, model: models[i], tokens: r.tokens };
        } catch (e) {
          const c = classifyError(e.status, e.message);
          errors.push(`${p.title} (${models[i]}): ${c.text}`);
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
    const model = p.light || p.heavy;
    if (!getKey(p)) return { state: "nokey", text: "нет ключа" };
    if (!model) return { state: "model", text: "не выбрана модель" };
    const started = now();
    try {
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

module.exports = { VENDORS, MAX_PROVIDERS, normalizeProviders, pickModels, needsHeavy, classifyError, toAnthropic, createAiRouter };
