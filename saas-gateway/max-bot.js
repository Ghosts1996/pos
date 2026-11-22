"use strict";
/**
 * Бот заведения в мессенджере MAX — тот же бот, что в Telegram (telegram.js:
 * отчёты, сигналы, итоги смены, карточки заказов с кнопками, рабочая группа),
 * только разговаривает с API ботов MAX. Этот файл — «переводчик»:
 *
 *  - call(token, method, params) принимает вызовы в виде Telegram Bot API
 *    (sendMessage, editMessageText, answerCallbackQuery…) и выполняет их
 *    запросами к API MAX (POST /messages, PUT /messages, POST /answers…);
 *  - toTgUpdate(update) превращает событие MAX (message_created,
 *    message_callback, bot_started) в обновление вида Telegram, которое
 *    понимает telegram.js.
 *
 * API MAX (официальные клиенты max-messenger/max-bot-api-client-go и -ts):
 * адрес https://platform-api2.max.ru (прежний — platform-api.max.ru), ключ
 * бота — в заголовке Authorization как есть; вебхук — POST /subscriptions
 * с секретом, MAX присылает его в заголовке X-Max-Bot-Api-Secret.
 *
 * Чаты: личный чат в telegram.js — это ID человека (как в Telegram), поэтому
 * сообщение в личный чат уходит параметром user_id, а в группу — chat_id
 * (ID групп в MAX отрицательные; положительные, если встретятся, бот
 * запоминает по событиям).
 *
 * Серверы MAX — в России. Всё равно, как и в Telegram, имён и телефонов
 * гостей и сотрудников бот не отправляет.
 */

const BASES = (process.env.MAX_API_BASE || "https://platform-api2.max.ru,https://platform-api.max.ru")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const TIMEOUT_MS = 10000;
// События, на которые подписывается бот.
const UPDATE_TYPES = ["message_created", "message_callback", "bot_started"];

class MaxUnreachable extends Error {}

/** Клавиатура Telegram → вложение MAX «inline_keyboard». [] — убрать клавиатуру. */
function keyboardOf(markup) {
  if (!markup) return undefined;
  if (markup.remove_keyboard) return [];
  let rows = [];
  if (Array.isArray(markup.inline_keyboard)) {
    rows = markup.inline_keyboard.map((row) => (row || []).map((b) => {
      if (!b || !b.text) return null;
      if (b.url) return { type: "link", text: String(b.text).slice(0, 128), url: String(b.url) };
      if (b.callback_data != null) return { type: "callback", text: String(b.text).slice(0, 128), payload: String(b.callback_data) };
      return null;
    }).filter(Boolean));
  } else if (Array.isArray(markup.keyboard)) {
    // Кнопки внизу экрана Telegram: в MAX — кнопки «отправить этот текст»,
    // нажатие приходит обычным сообщением, как в Telegram.
    rows = markup.keyboard.map((row) => (row || []).map((b) => (b && b.text ? { type: "message", text: String(b.text).slice(0, 128) } : null)).filter(Boolean));
  }
  rows = rows.filter((r) => r.length);
  return rows.length ? [{ type: "inline_keyboard", payload: { buttons: rows } }] : [];
}

/** Человек MAX → «from» Telegram. */
const fromOf = (u) => (u && u.user_id ? {
  id: Number(u.user_id),
  first_name: u.first_name || u.name || "",
  last_name: u.last_name || "",
  username: u.username || "",
  is_bot: !!u.is_bot,
} : null);

function createMaxApi({ fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  // Положительные ID групп (на случай, если MAX их выдаст): им — chat_id.
  const groups = new Set();
  // Текст отправленных сообщений: правка только кнопок у MAX — это правка
  // сообщения целиком, текст подставляем свой (последние 2000 сообщений).
  const texts = new Map();
  const remember = (mid, body) => {
    if (!mid || !body || body.text == null) return;
    texts.delete(mid);
    texts.set(mid, { text: body.text, format: body.format });
    if (texts.size > 2000) texts.delete(texts.keys().next().value);
  };

  const target = (chatId) => {
    const n = Number(chatId);
    return n < 0 || groups.has(n) ? { chat_id: String(n) } : { user_id: String(n) };
  };

  async function req(token, method, path, { query = {}, body } = {}) {
    const qs = new URLSearchParams(query).toString();
    let lastErr = null;
    for (const base of BASES) {
      let resp;
      try {
        resp = await doFetch(`${base}/${path}${qs ? `?${qs}` : ""}`, {
          method,
          headers: { Authorization: token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // Нет связи с этим адресом — пробуем запасной.
        lastErr = (e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.name || e.message)) || String(e);
        continue;
      }
      // Старого или нового адреса нет (404 на сам адрес) — следующий.
      const data = await resp.json().catch(() => ({}));
      const status = resp.status || 200;
      if (status === 404 && !data.code && BASES.length > 1 && base !== BASES[BASES.length - 1]) { lastErr = "404"; continue; }
      if (status >= 400 || (data && data.success === false)) {
        throw new Error(`MAX ${method} ${path}: ${data.code || status}${data.message ? ` ${data.message}` : ""}`);
      }
      return data;
    }
    console.error(`max ${method} ${path}: нет связи: ${lastErr}`);
    throw new MaxUnreachable(`MAX недоступен: ${lastErr}`);
  }

  function messageBody(p) {
    const body = {};
    if (p.text != null) body.text = String(p.text);
    if (p.parse_mode === "HTML") body.format = "html";
    const kb = keyboardOf(p.reply_markup);
    if (kb !== undefined) body.attachments = kb;
    if (p.reply_to_message_id) body.link = { type: "reply", mid: String(p.reply_to_message_id) };
    if (p.disable_notification) body.notify = false;
    return body;
  }

  /** Вызов в виде Telegram Bot API → API MAX. Ответ — тоже в виде Telegram. */
  async function call(token, method, p = {}) {
    switch (method) {
      case "getMe": {
        const me = await req(token, "GET", "me");
        return { id: Number(me.user_id), username: me.username || "", first_name: me.name || "", is_bot: true };
      }
      case "setWebhook": {
        // Бот — только этого заведения: прежние подписки на другие адреса снимаем.
        const cur = await req(token, "GET", "subscriptions").catch(() => ({ subscriptions: [] }));
        for (const s of cur.subscriptions || []) {
          if (s && s.url && s.url !== p.url) await req(token, "DELETE", "subscriptions", { query: { url: s.url } }).catch(() => {});
        }
        await req(token, "POST", "subscriptions", { body: { url: p.url, update_types: UPDATE_TYPES, ...(p.secret_token ? { secret: p.secret_token } : {}) } });
        return true;
      }
      case "deleteWebhook": {
        const cur = await req(token, "GET", "subscriptions").catch(() => ({ subscriptions: [] }));
        for (const s of cur.subscriptions || []) if (s && s.url) await req(token, "DELETE", "subscriptions", { query: { url: s.url } }).catch(() => {});
        return true;
      }
      case "getWebhookInfo": {
        const cur = await req(token, "GET", "subscriptions");
        const list = (cur.subscriptions || []).filter((s) => s && s.url);
        const s = list.find((x) => p.want && x.url === p.want) || list[0] || {};
        return { url: s.url || "", allowed_updates: [] };
      }
      case "setMyCommands":
        await req(token, "PATCH", "me", { body: { commands: (p.commands || []).map((c) => ({ name: c.command, description: c.description })) } });
        return true;
      case "getChat": {
        const c = await req(token, "GET", `chats/${encodeURIComponent(String(p.chat_id))}`);
        return { id: Number(c.chat_id || p.chat_id), title: c.title || "", type: "group", is_forum: false };
      }
      case "createForumTopic":
        throw new Error("MAX: у групп нет тем");
      case "sendMessage":
      case "sendLocation": {
        const body = method === "sendLocation"
          ? { attachments: [{ type: "location", latitude: Number(p.latitude), longitude: Number(p.longitude) }] }
          : messageBody(p);
        if (method === "sendLocation" && p.disable_notification) body.notify = false;
        const query = { ...target(p.chat_id), ...(p.disable_web_page_preview ? { disable_link_preview: "true" } : {}) };
        const r = await req(token, "POST", "messages", { query, body });
        const mid = r && r.message && r.message.body && r.message.body.mid;
        remember(mid, body);
        return { message_id: mid || "", chat: { id: Number(p.chat_id) } };
      }
      case "editMessageText": {
        const body = messageBody(p);
        await req(token, "PUT", "messages", { query: { message_id: String(p.message_id) }, body });
        remember(String(p.message_id), body);
        return true;
      }
      case "editMessageReplyMarkup": {
        const had = texts.get(String(p.message_id));
        const body = { ...(had ? { text: had.text, ...(had.format ? { format: had.format } : {}) } : {}), attachments: keyboardOf(p.reply_markup) || [] };
        await req(token, "PUT", "messages", { query: { message_id: String(p.message_id) }, body });
        return true;
      }
      case "editMessageLiveLocation":
        await req(token, "PUT", "messages", {
          query: { message_id: String(p.message_id) },
          body: { attachments: [{ type: "location", latitude: Number(p.latitude), longitude: Number(p.longitude) }] },
        });
        return true;
      case "stopMessageLiveLocation":
        return true; // в MAX точка не «живая» — останавливать нечего
      case "answerCallbackQuery":
        // Без текста отвечать не нужно; с текстом — всплывающее уведомление.
        if (!p.text) return true;
        await req(token, "POST", "answers", { query: { callback_id: String(p.callback_query_id) }, body: { notification: String(p.text).slice(0, 200) } });
        return true;
      default:
        throw new Error(`MAX: ${method} не поддерживается`);
    }
  }

  /** Чат сообщения MAX → «chat» Telegram: личный — ID человека, группа — ID чата. */
  function chatOf(m, user) {
    const rec = (m && m.recipient) || {};
    if (rec.chat_type && rec.chat_type !== "dialog") {
      const id = Number(rec.chat_id);
      if (id > 0) groups.add(id);
      return { id, type: rec.chat_type === "channel" ? "channel" : "group" };
    }
    const who = user || (m && m.sender);
    return { id: Number((who && who.user_id) || rec.user_id || 0), type: "private" };
  }

  /** Событие MAX → обновление вида Telegram (или null — не для бота заведения). */
  function toTgUpdate(u) {
    if (!u || typeof u !== "object") return null;
    if (u.update_type === "message_created" && u.message) {
      const m = u.message;
      if (m.sender && m.sender.is_bot) return null;
      return {
        message: {
          message_id: (m.body && m.body.mid) || "",
          chat: chatOf(m),
          from: fromOf(m.sender),
          text: (m.body && m.body.text) || "",
        },
      };
    }
    if (u.update_type === "bot_started" && u.user) {
      // «Начать» в боте; payload — из ссылки вида …?start=<код>.
      const payload = String(u.payload || "").trim();
      return {
        message: {
          message_id: "",
          chat: { id: Number(u.user.user_id), type: "private" },
          from: fromOf(u.user),
          text: payload ? `/start ${payload}` : "/start",
        },
      };
    }
    if (u.update_type === "message_callback" && u.callback) {
      const cb = u.callback;
      const m = u.message || null;
      return {
        callback_query: {
          id: cb.callback_id,
          from: fromOf(cb.user),
          data: cb.payload || "",
          message: m ? { message_id: (m.body && m.body.mid) || "", chat: chatOf(m, cb.user) } : null,
        },
      };
    }
    return null;
  }

  return { call, toTgUpdate, keyboardOf };
}

module.exports = { createMaxApi, keyboardOf, MaxUnreachable, UPDATE_TYPES };
