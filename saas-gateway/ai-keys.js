"use strict";
/**
 * Подключение ключа ИИ без настроек: владелец вставляет ключ — сервер сам
 * узнаёт провайдера, берёт с ключа список моделей и выбирает две: быструю
 * (подсказки кассиру, гость) и умную (отчёты, закупки, сложные вопросы).
 *
 * Запросы к провайдерам идут с сервера платформы, а не с планшета: заведению
 * не нужен VPN. Если зарубежный провайдер не пускает из России, а платформа
 * задала AI_UPSTREAM_PROXY (свой прокси за рубежом) — запросы идут через него.
 */
const https = require("https");

// Провайдеры, которые узнаём сами. Порядок — порядок перебора, когда по
// виду ключа провайдер не понять (сначала шлюзы с оплатой в рублях).
const KNOWN = [
  { id: "tooken", title: "Tooken Club", baseUrl: "https://tooken.club/v1", format: "openai" },
  { id: "darkapi", title: "DarkAPI", baseUrl: "https://darkapi.shop/v1", format: "openai" },
  { id: "openrouter", title: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai" },
  { id: "deepseek", title: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", format: "openai" },
  { id: "openai", title: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai" },
  { id: "gemini", title: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", format: "openai" },
  { id: "anthropic", title: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", format: "anthropic" },
];
const byId = (id) => KNOWN.find((k) => k.id === id) || null;

/** Кандидаты по виду ключа: у части провайдеров ключ узнаётся по началу. */
function candidatesFor(apiKey, baseUrl = "") {
  const key = String(apiKey || "").trim();
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (url) {
    const known = KNOWN.find((k) => url.startsWith(k.baseUrl.replace(/\/v1.*$/, "")));
    return [{ id: known ? known.id : "custom", title: known ? known.title : "Свой шлюз", baseUrl: url, format: known ? known.format : "auto" }];
  }
  if (/^sk-ant-/.test(key)) return [byId("anthropic")];
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) return [byId("gemini")];
  if (/^sk-or-/.test(key)) return [byId("openrouter")];
  if (/^sk-proj-|^sk-svcacct-/.test(key)) return [byId("openai")];
  // Остальное (sk-…, свои форматы шлюзов) — пробуем всех по очереди.
  return KNOWN.filter((k) => k.id !== "anthropic" && k.id !== "gemini");
}

// ---------------------------------------------------------- выбор моделей

// Не для чата: картинки, голос, поиск по смыслу и прочее.
const NOT_CHAT = /(embed|whisper|tts|audio|speech|transcri|image|dall-?e|imagen|vision-preview|moderation|realtime|search|rerank|davinci|babbage|curie|ada-|-instruct|computer-use|veo|sora|lyria|robotics|guard)/i;
// По порядку предпочтения. Быстрые — дёшево и мгновенно; умные — для отчётов и сложного.
const LIGHT = [
  /gpt-(4\.1|5(\.\d)?)-mini/i, /gpt-4o-mini/i, /deepseek-(chat|v3)/i, /claude.*haiku/i,
  /gemini.*flash(?!.*lite)/i, /gemini.*flash/i, /qwen.*(plus|turbo|flash)/i, /glm-4/i, /llama.*(70b|90b)/i,
  /(mini|flash|small|lite|haiku|turbo)/i,
];
const HEAVY = [
  /^(openai\/)?gpt-5(\.\d)?$/i, /gpt-5(?!.*(mini|nano|codex))/i, /gpt-4\.1(?!-(mini|nano))/i, /gpt-4o(?!-mini)/i,
  /claude.*sonnet/i, /gemini.*pro/i, /deepseek-(chat|v3)/i, /qwen.*max/i, /claude.*opus/i,
];
const hasDate = (id) => /(\d{4}-\d{2}-\d{2}|\d{6,8}|-\d{4}$|preview|exp)/i.test(id);
/** Номер поколения модели: gpt-4o → 4, claude-haiku-4-5 → 4.5, gemini-2.5-flash → 2.5. */
function versionOf(id) {
  const s = String(id).replace(/\d{4}-\d{2}-\d{2}|\d{6,8}/g, "");
  const m = s.match(/(\d+)(?:[.-](\d{1,2}))?(?!\d)/);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
}
// Лучший из подходящих: живой псевдоним (-latest), без даты, новее, короче.
const rank = (a, b) => (/latest/i.test(b) - /latest/i.test(a)) || (hasDate(a) - hasDate(b))
  || (versionOf(b) - versionOf(a)) || (a.length - b.length) || a.localeCompare(b);

/** Из списка моделей ключа — быстрая и умная. Без даты в имени (живой
 *  псевдоним, провайдер сам обновляет) — предпочтительнее. */
function pickModels(ids) {
  const list = [...new Set((ids || []).map(String).filter((id) => id && !NOT_CHAT.test(id)))];
  const best = (patterns) => {
    for (const re of patterns) {
      const hit = list.filter((id) => re.test(id)).sort(rank);
      if (hit.length) return hit[0];
    }
    return "";
  };
  const light = best(LIGHT) || list[0] || "";
  const heavy = best(HEAVY) || light;
  return { light, heavy };
}

/** Модель, которой больше нет у провайдера: ближайшая из списка (то же имя
 *  с датой, та же ступень — быстрая или умная). */
function replacementModel(missing, ids, tier = "light") {
  const list = (ids || []).map(String).filter((id) => !NOT_CHAT.test(id));
  const m = String(missing || "").toLowerCase();
  // То же имя с датой («gpt-4o-mini» → «gpt-4o-mini-2024-07-18»), а не соседняя модель.
  const same = list.filter((id) => id.toLowerCase().startsWith(`${m}-`) || id.toLowerCase() === m).sort(rank);
  if (same.length) return same[0];
  const picked = pickModels(list);
  return tier === "heavy" ? picked.heavy : picked.light;
}

// ------------------------------------------------------------ запросы

let proxyAgent;
function upstreamAgent() {
  const proxy = process.env.AI_UPSTREAM_PROXY;
  if (!proxy) return null;
  if (proxyAgent === undefined) {
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      proxyAgent = new HttpsProxyAgent(proxy);
    } catch (e) {
      console.error("ai-keys: AI_UPSTREAM_PROXY задан, но https-proxy-agent не найден:", e.message || e);
      proxyAgent = null;
    }
  }
  return proxyAgent;
}

/** fetch к провайдеру ИИ: напрямую или через прокси платформы. Переадресации
 *  не выполняются (адрес провайдера проверен заранее — защита от SSRF). */
async function aiFetch(url, { method = "GET", headers = {}, body, timeoutMs = 60000, fetchImpl } = {}) {
  const agent = fetchImpl ? null : upstreamAgent();
  if (!agent) {
    const res = await (fetchImpl || fetch)(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, contentType: res.headers.get("content-type") || "" };
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, contentType: res.headers["content-type"] || "" });
      });
    });
    req.on("timeout", () => req.destroy(new Error("время ожидания истекло")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const authHeaders = (c, apiKey) => (c.format === "anthropic"
  ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Authorization: `Bearer ${apiKey}` }
  : { Authorization: `Bearer ${apiKey}` });

/** Список моделей ключа (OpenAI: {data:[{id}]}, Anthropic: {data:[{id}]}, Gemini-совместимый — так же). */
async function listModels(c, apiKey, opts = {}) {
  const url = c.format === "anthropic" ? `${c.baseUrl}${/\/v1$/.test(c.baseUrl) ? "" : "/v1"}/models?limit=100` : `${c.baseUrl}/models`;
  const r = await aiFetch(url, { headers: authHeaders(c, apiKey), timeoutMs: opts.timeoutMs || 12000, fetchImpl: opts.fetchImpl });
  let json = null;
  try { json = JSON.parse(r.text); } catch (_) { /* не JSON */ }
  const ids = Array.isArray(json && json.data) ? json.data.map((m) => String((m && (m.id || m.name)) || "").replace(/^models\//, "")).filter(Boolean)
    : Array.isArray(json && json.models) ? json.models.map((m) => String((m && (m.id || m.name)) || "").replace(/^models\//, "")).filter(Boolean)
      : [];
  return { status: r.status, ids, error: r.ok ? "" : errorText(r) };
}

/** Короткий пробный ответ — так проверяется сам ключ (список моделей у
 *  части шлюзов открыт без ключа). */
async function tryChat(c, apiKey, model, opts = {}) {
  const anthropic = c.format === "anthropic";
  const url = anthropic ? `${c.baseUrl}${/\/v1$/.test(c.baseUrl) ? "" : "/v1"}/messages` : `${c.baseUrl}/chat/completions`;
  const body = anthropic
    ? { model, max_tokens: 16, messages: [{ role: "user", content: "Ответь одним словом: OK" }] }
    : { model, max_tokens: 16, messages: [{ role: "user", content: "Ответь одним словом: OK" }] };
  const r = await aiFetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(c, apiKey) }, body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs || 30000, fetchImpl: opts.fetchImpl,
  });
  return { status: r.status, ok: r.ok, error: r.ok ? "" : errorText(r) };
}

function errorText(r) {
  let msg = "";
  try {
    const j = JSON.parse(r.text);
    msg = (j.error && (j.error.message || j.error.type || j.error)) || j.message || j.detail || "";
  } catch (_) { msg = String(r.text || "").slice(0, 200); }
  return `${r.status}${msg ? ` ${String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200)}` : ""}`;
}

/** Понятная причина отказа для владельца заведения. */
function humanReason(status, error, title) {
  const e = String(error || "").toLowerCase();
  if (/location|region|country|unsupported_country|not available in your/.test(e) || status === 451) {
    return `${title} не пускает запросы из России. Возьмите ключ шлюза с оплатой в рублях (например, Tooken Club или DarkAPI) — он подключится так же, одним вставленным ключом.`;
  }
  if (status === 401 || /invalid.*key|incorrect api key|unauthori[sz]ed|authentication/.test(e)) return "Ключ не подошёл — проверьте, что скопировали его целиком, без пробелов.";
  if (status === 402 || /insufficient|quota|balance|credit|billing|payment/.test(e)) return `Ключ рабочий, но на счёте ${title} закончились деньги — пополните баланс.`;
  if (status === 403) return `${title} отказал в доступе: ${String(error || "").slice(0, 160)}`;
  if (status === 429) return `${title} просит подождать (слишком много запросов) — попробуйте через минуту.`;
  if (!status) return `${title} не ответил: ${String(error || "нет связи").slice(0, 160)}`;
  return `${title} ответил ошибкой: ${String(error || status).slice(0, 160)}`;
}

/**
 * Узнать провайдера ключа, его модели и проверить, что он отвечает.
 * → { ok, vendor, title, baseUrl, format, models[], light, heavy, reason }
 */
async function probeKey({ apiKey, baseUrl = "" }, opts = {}) {
  const key = String(apiKey || "").trim();
  if (key.length < 8) return { ok: false, reason: "Вставьте ключ целиком" };
  const cands = candidatesFor(key, baseUrl);
  // Список моделей — у всех кандидатов сразу; первый по порядку, кто ответил списком, — наш.
  const lists = await Promise.all(cands.map(async (c) => {
    const tries = c.format === "auto" ? [{ ...c, format: "openai" }, { ...c, format: "anthropic" }] : [c];
    for (const t of tries) {
      try {
        const r = await listModels(t, key, opts);
        if (r.ids.length) return { c: t, ...r };
        if (tries.length === 1 || t === tries[tries.length - 1]) return { c: t, ...r };
      } catch (e) {
        if (t === tries[tries.length - 1]) return { c: t, status: 0, ids: [], error: e.message || String(e) };
      }
    }
    return { c, status: 0, ids: [], error: "" };
  }));
  const found = lists.find((l) => l.status >= 200 && l.status < 300 && l.ids.length);
  if (!found) {
    // Ни один не отдал список: по одному кандидату объясняем причину, по многим — общая.
    const one = lists.length === 1 ? lists[0] : lists.find((l) => l.status && l.status !== 404) || lists[0];
    if (cands.length > 1 && !(one && [401, 402, 403, 451].includes(one.status))) {
      return { ok: false, reason: "Не удалось узнать, чей это ключ. Если это свой шлюз — укажите его адрес API (поле «Адрес», если провайдера нет в списке)." };
    }
    return { ok: false, vendor: one.c.id, title: one.c.title, reason: humanReason(one.status, one.error, one.c.title) };
  }
  const { light, heavy } = pickModels(found.ids);
  if (!light) return { ok: false, vendor: found.c.id, title: found.c.title, reason: `${found.c.title}: у ключа нет моделей для текста` };
  let chat;
  try {
    chat = await tryChat(found.c, key, light, opts);
  } catch (e) {
    chat = { ok: false, status: 0, error: e.message || String(e) };
  }
  const base = {
    vendor: found.c.id, title: found.c.title, baseUrl: found.c.baseUrl, format: found.c.format,
    models: found.ids.filter((id) => !NOT_CHAT.test(id)).slice(0, 300), light, heavy,
  };
  if (!chat.ok) return { ok: false, ...base, reason: humanReason(chat.status, chat.error, found.c.title) };
  return { ok: true, ...base };
}

module.exports = { KNOWN, candidatesFor, pickModels, replacementModel, aiFetch, listModels, probeKey, humanReason, NOT_CHAT };
