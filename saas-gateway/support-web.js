"use strict";

/**
 * Поиск в интернете для ИИ-бота поддержки: внешние факты, которых нет в базе
 * (законы и их изменения, требования ФНС и Роскомнадзора, банки, ОФД,
 * оборудование и драйверы, сторонние сервисы и их ошибки).
 *
 * Поисковики: без ключа — DuckDuckGo (HTML-выдача), с ключом — Brave Search,
 * Tavily или Serper (Google). Страницы читаем сами: только внешние https-адреса
 * (проверка как у адресов ИИ — нельзя ходить во внутреннюю сеть сервера), до
 * 1,5 МБ, текст без разметки.
 */

const SEARCH_PROVIDERS = {
  auto: { title: "Без ключа (DuckDuckGo)", needsKey: false },
  brave: { title: "Brave Search API", needsKey: true, hint: "Ключ из api.search.brave.com" },
  tavily: { title: "Tavily", needsKey: true, hint: "Ключ из app.tavily.com — выдача уже с текстом страниц" },
  serper: { title: "Serper (Google)", needsKey: true, hint: "Ключ из serper.dev" },
};

const PAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; ZalPOS-Support/1.0; +https://zalpos.ru)";

/** HTML → читаемый текст. */
function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|head|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&laquo;/g, "«").replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
};

/** Выдача DuckDuckGo (html.duckduckgo.com) → [{ title, url, snippet }]. */
function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/g;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 10) {
    let url = m[1].replace(/&amp;/g, "&");
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js|\/\/duckduckgo\.com\/\?/.test(url)) continue;
    out.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3] || m[4] || "") });
  }
  return out;
}

function createWebSearch({ fetchImpl, assertPublicUrl, settings }) {
  const doFetch = fetchImpl || fetch;

  async function getJson(url, init) {
    const resp = await doFetch(url, { ...init, signal: AbortSignal.timeout(12000), redirect: "error" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`поиск ответил ${resp.status}${data && data.message ? `: ${String(data.message).slice(0, 120)}` : ""}`);
    return data;
  }

  /** Найти: [{ title, url, snippet, content? }]. */
  async function search(query, { limit = 5 } = {}) {
    const q = String(query || "").trim().slice(0, 300);
    if (!q) return [];
    const { provider = "auto", key = "" } = settings() || {};
    let list = [];
    if (provider === "brave" && key) {
      const data = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}&search_lang=ru&country=RU`, {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
      });
      list = ((data.web && data.web.results) || []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description || "") }));
    } else if (provider === "tavily" && key) {
      const data = await getJson("https://api.tavily.com/search", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: q, max_results: limit, search_depth: "basic", include_answer: false }),
      });
      list = (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || "").slice(0, 400), content: String(r.content || "") }));
    } else if (provider === "serper" && key) {
      const data = await getJson("https://google.serper.dev/search", {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q, gl: "ru", hl: "ru", num: limit }),
      });
      list = (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
    } else {
      const resp = await doFetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9" },
        body: `q=${encodeURIComponent(q)}&kl=ru-ru`,
        signal: AbortSignal.timeout(12000), redirect: "error",
      });
      if (!resp.ok) throw new Error(`поиск ответил ${resp.status}`);
      list = parseDuckDuckGo(await resp.text());
    }
    const seen = new Set();
    return list.filter((r) => r && /^https:\/\//.test(r.url || "") && !seen.has(r.url) && seen.add(r.url)).slice(0, limit)
      .map((r) => ({ ...r, title: String(r.title || domainOf(r.url)).slice(0, 200), snippet: String(r.snippet || "").slice(0, 500) }));
  }

  /** Текст страницы (до limit символов) или "". Переадресации — с проверкой каждого адреса. */
  async function readPage(url, limit = 3500) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https:\/\//.test(current)) return "";
      await assertPublicUrl(current);
      const resp = await doFetch(current, {
        headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9", Accept: "text/html,text/plain" },
        signal: AbortSignal.timeout(10000), redirect: "manual",
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
        current = new URL(resp.headers.get("location"), current).toString();
        continue;
      }
      if (!resp.ok) return "";
      const type = String(resp.headers.get("content-type") || "");
      if (!/text\/html|text\/plain|application\/xhtml/.test(type)) return "";
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > PAGE_MAX_BYTES) return "";
      const raw = buf.toString("utf8");
      const text = /text\/plain/.test(type) ? raw : htmlToText(raw);
      return text.slice(0, limit);
    }
    return "";
  }

  /** Найти и прочитать: выдача + текст первых pages страниц. */
  async function research(query, { limit = 5, pages = 2 } = {}) {
    const results = await search(query, { limit });
    const read = [];
    for (const r of results) {
      if (read.length >= pages) break;
      if (r.content && r.content.length > 300) {
        read.push({ ...r, text: r.content.slice(0, 3500) });
        continue;
      }
      const text = await readPage(r.url).catch(() => "");
      if (text && text.length > 200) read.push({ ...r, text });
    }
    return { query, results, pages: read };
  }

  return { search, readPage, research };
}

module.exports = { SEARCH_PROVIDERS, createWebSearch, htmlToText, parseDuckDuckGo, domainOf };
