"use strict";
// Бот заведения в MAX (max-bot.js + telegram.js с platform "max") на
// имитации базы и API MAX: подключение по токену, вебхук с секретом,
// /id, личный чат владельца, отчёты кнопками, группа сотрудников по коду,
// карточка заказа с кнопками, сигнал владельцу, отключение.
process.env.TELEGRAM_SECRET_KEY = "sim-key";
process.env.MAX_API_BASE = "https://max.test";
const cacheDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "max-cache-"));
process.env.TELEGRAM_CACHE_DIR = cacheDir;
const assert = require("assert");
const { Readable } = require("stream");
const tgmod = require("./telegram.js");
const { keyboardOf, createMaxApi } = require("./max-bot.js");
// ---- мини-Firestore в памяти
const store = new Map(); // path -> data
class TS { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } toDate() { return new Date(this.ms); } }
const val = (v) => (v instanceof TS ? v.ms : v instanceof Date ? v.getTime() : v);
const listeners = [];
let reads = 0;
let closedReads = 0;
function docRef(p) {
  return {
    id: p.split("/").pop(), path: p,
    async get() { const d = store.get(p); return { exists: !!d, id: p.split("/").pop(), ref: docRef(p), data: () => (d ? { ...d } : undefined) }; },
    async set(d) { store.set(p, { ...d }); fire(); },
    async update(d) {
      if (!store.has(p)) throw new Error("no doc " + p);
      // «views.501» — вложенное поле, как в Firestore.
      const next = { ...store.get(p) };
      for (const [k, v] of Object.entries(d)) {
        const parts = k.split(".");
        let o = next;
        for (const part of parts.slice(0, -1)) { o[part] = { ...(o[part] || {}) }; o = o[part]; }
        o[parts[parts.length - 1]] = v;
      }
      store.set(p, next); fire();
    },
    async delete() { store.delete(p); fire(); },
    collection: (c) => colRef(`${p}/${c}`),
    onSnapshot(cb) {
      const l = { doc: p, cb, last: undefined, active: true };
      listeners.push(l);
      run(l);
      return () => { l.active = false; };
    },
  };
}
function colRef(p, filters = []) {
  const q = {
    doc: (id) => docRef(`${p}/${id || Math.random().toString(36).slice(2)}`),
    where: (f, op, v) => colRef(p, [...filters, [f, op, v]]),
    orderBy: () => q, limit: () => q,
    async get(fromListener = false) {
      const docs = [...store.entries()].filter(([k]) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"))
        .filter(([, d]) => filters.every(([f, op, v]) => {
          const a = val(d[f]); const b = val(v);
          return op === "==" ? a === b : op === ">=" ? a >= b : op === "<" ? a < b : op === ">" ? a > b : true;
        }))
        .map(([k, d]) => ({ id: k.split("/").pop(), ref: docRef(k), data: () => ({ ...d }) }));
      // Чтения чеков по closedAt запросом (не подпиской) — для проверки копии.
      if (!fromListener && p.endsWith("/sessions") && filters.some(([f]) => f === "closedAt")) closedReads += Math.max(1, docs.length);
      return { docs, size: docs.length };
    },
    onSnapshot(cb) {
      const l = { q, cb, seen: new Map(), active: true };
      listeners.push(l);
      run(l);
      return () => { l.active = false; };
    },
  };
  return q;
}
async function run(l) {
  if (l.doc) {
    const d = store.get(l.doc);
    const now = d ? JSON.stringify(d) : null;
    if (now === l.last) return;
    l.last = now;
    reads++;
    return l.cb({ exists: !!d, id: l.doc.split("/").pop(), data: () => (d ? { ...d } : undefined) });
  }
  const snap = await l.q.get(true);
  const now = new Map(snap.docs.map((d) => [d.id, JSON.stringify(d.data())]));
  const changes = [];
  for (const d of snap.docs) {
    if (!l.seen.has(d.id)) changes.push({ type: "added", doc: d });
    else if (l.seen.get(d.id) !== now.get(d.id)) changes.push({ type: "modified", doc: d });
  }
  for (const id of l.seen.keys()) if (!now.has(id)) changes.push({ type: "removed", doc: { id, data: () => ({}) } });
  l.seen = now;
  reads += changes.length;
  // Как в Firestore: первый снимок приходит всегда, даже пустой.
  if (changes.length || !l.started) { l.started = true; l.cb({ docChanges: () => changes, docs: snap.docs }); }
}
let firing = false;
function fire() { if (firing) return; firing = true; setImmediate(() => { firing = false; listeners.filter((l) => l.active).forEach(run); }); }
const db = () => ({
  collection: (c) => colRef(c),
  async runTransaction(fn) {
    const tx = { get: (r) => r.get(), update: (r, d) => r.update(d), set: (r, d) => r.set(d), delete: (r) => r.delete() };
    return fn(tx);
  },
});
const admin = { firestore: { Timestamp: { now: () => new TS(Date.now()), fromMillis: (ms) => new TS(ms) }, FieldValue: { serverTimestamp: () => new Date() } } };

// ---- мини-Telegram

// ---- мини-API MAX
const calls = [];
let mid = 0;
let subs = [];
const fetchImpl = async (url, opts = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace(/^\//, "");
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const token = (opts.headers || {}).Authorization;
  calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, token });
  const ok = (data) => ({ status: 200, json: async () => data });
  if (token !== "maxtoken_venue_A_0123456789abcdef") return { status: 401, json: async () => ({ code: "verify.token", message: "Invalid access_token" }) };
  if (path === "me" && method === "GET") return ok({ user_id: 9001, name: "Кафе А", username: "cafe_a_bot", is_bot: true });
  if (path === "me" && method === "PATCH") return ok({ user_id: 9001 });
  if (path === "subscriptions" && method === "GET") return ok({ subscriptions: subs });
  if (path === "subscriptions" && method === "POST") { subs = [{ url: body.url, time: 1 }]; return ok({ success: true }); }
  if (path === "subscriptions" && method === "DELETE") { subs = subs.filter((s) => s.url !== u.searchParams.get("url")); return ok({ success: true }); }
  if (path.startsWith("chats/")) return ok({ chat_id: Number(path.slice(6)), title: "Смена кафе" });
  if (path === "messages" && method === "POST") return ok({ message: { body: { mid: `mid.${++mid}`, text: body.text } } });
  if (path === "messages" && method === "PUT") return ok({ success: true });
  if (path === "answers") return ok({ success: true });
  return { status: 404, json: async () => ({ code: "not.found" }) };
};

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const mkReq = (body, headers = {}) => { const r = Readable.from([Buffer.from(JSON.stringify(body))]); r.headers = { authorization: "Bearer x", ...headers }; return r; };
const mkRes = () => { const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b; } }; return r; };
const deps = {
  db, admin,
  verifyAuth: async () => ({ uid: "owner1" }),
  parseJsonBody: async (req) => { let s = ""; for await (const c of req) s += c; return JSON.parse(s); },
  readBody: async (req) => { let s = ""; for await (const c of req) s += c; return s; },
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  HttpError,
  requireTenantRole: async (t, uid) => { if (uid !== "owner1") throw new HttpError(403, "no"); },
  publicUrl: "https://pii.zalpos.ru/saas",
  fetchImpl,
  platform: "max",
};
const mx = tgmod.createTelegram(deps);
const tick = () => new Promise((r) => setTimeout(r, 40));
const TOKEN = "maxtoken_venue_A_0123456789abcdef";
const sentTo = (q) => calls.filter((c) => c.method === "POST" && c.path === "messages" && (c.query.user_id === String(q) || c.query.chat_id === String(q)));
const lastText = (q) => { const l = sentTo(q); return l.length ? String(l[l.length - 1].body.text || "").replace(/<[^>]+>/g, "") : ""; };

// ---- клавиатуры Telegram → MAX
{
  const inline = keyboardOf({ inline_keyboard: [[{ text: "Готов", callback_data: "s:1:ready" }, { text: "Адрес", url: "https://x.ru/a" }], []] });
  assert.deepStrictEqual(inline, [{ type: "inline_keyboard", payload: { buttons: [[
    { type: "callback", text: "Готов", payload: "s:1:ready" }, { type: "link", text: "Адрес", url: "https://x.ru/a" }]] } }]);
  const reply = keyboardOf({ keyboard: [[{ text: "💰 Выручка" }]], resize_keyboard: true });
  assert.deepStrictEqual(reply[0].payload.buttons, [[{ type: "message", text: "💰 Выручка" }]], "кнопки внизу Telegram — кнопки «отправить текст»");
  assert.deepStrictEqual(keyboardOf({ remove_keyboard: true }), [], "убрать клавиатуру");
  assert.deepStrictEqual(keyboardOf({ inline_keyboard: [] }), []);
  assert.strictEqual(keyboardOf(undefined), undefined);
  // События MAX → вид Telegram.
  const a = createMaxApi({ fetchImpl });
  const dm = a.toTgUpdate({ update_type: "message_created", message: { sender: { user_id: 55, name: "Иван" }, recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "m1", text: "/id" } } });
  assert.deepStrictEqual(dm.message.chat, { id: 55, type: "private" }, "личный чат = ID человека, как в Telegram");
  const gr = a.toTgUpdate({ update_type: "message_created", message: { sender: { user_id: 55 }, recipient: { chat_id: -100, chat_type: "chat" }, body: { mid: "m2", text: "hi" } } });
  assert.deepStrictEqual(gr.message.chat, { id: -100, type: "group" });
  const st = a.toTgUpdate({ update_type: "bot_started", user: { user_id: 55 }, payload: "abc" });
  assert.strictEqual(st.message.text, "/start abc");
  const cb = a.toTgUpdate({ update_type: "message_callback", callback: { callback_id: "c1", payload: "r:week", user: { user_id: 55 } },
    message: { recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "m3" } } });
  assert.deepStrictEqual([cb.callback_query.id, cb.callback_query.data, cb.callback_query.message.chat.id, cb.callback_query.message.message_id], ["c1", "r:week", 55, "m3"]);
  assert.strictEqual(a.toTgUpdate({ update_type: "message_created", message: { sender: { user_id: 1, is_bot: true }, recipient: {}, body: {} } }), null, "свои сообщения бота — мимо");
}

(async () => {
  store.set("tenants/A", { name: "Кафе А", timezone: "Europe/Moscow" });
  mx.start();

  // ---- подключение: неверный токен, верный токен
  let res = mkRes();
  await assert.rejects(mx.handleSetup(mkReq({ tenantId: "A", token: "123" }), res), /не похоже на токен бота MAX/);
  await assert.rejects(mx.handleSetup(mkReq({ tenantId: "A", token: "maxtoken_wrong_000000000000000" }), res), /MAX не принял токен/);
  res = mkRes();
  await mx.handleSetup(mkReq({ tenantId: "A", token: TOKEN }), res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.username, "cafe_a_bot");
  const cfg = store.get("maxBots/A");
  assert.ok(cfg && cfg.tokenEnc && !JSON.stringify(cfg).includes(TOKEN), "токен в базе только зашифрованным");
  assert.ok(!store.has("telegramBots/A"), "Telegram-бот заведения не трогаем");
  const sub = calls.find((c) => c.method === "POST" && c.path === "subscriptions");
  assert.strictEqual(sub.body.url, "https://pii.zalpos.ru/saas/maxHook/A");
  assert.strictEqual(sub.body.secret, cfg.hookSecret);
  assert.ok(sub.body.update_types.includes("message_callback") && sub.body.update_types.includes("bot_started"));
  assert.ok(calls.every((c) => !c.path.includes(TOKEN) && !Object.values(c.query).includes(TOKEN)), "ключ — только в заголовке");
  await tick();
  const cmds = calls.find((c) => c.method === "PATCH" && c.path === "me");
  assert.ok(cmds && cmds.body.commands.some((c) => c.name === "id" && /MAX ID/.test(c.description)), "команды бота в MAX");

  const hook = (update, secret = store.get("maxBots/A").hookSecret) => {
    const r = mkRes();
    return mx.handleHook(mkReq(update, { "x-max-bot-api-secret": secret }), r, "A").then(() => r);
  };
  // Чужой секрет — 403.
  assert.strictEqual((await hook({ update_type: "bot_started", user: { user_id: 55 } }, "bad")).code, 403);

  // ---- /id: человек узнаёт свой MAX ID
  await hook({ update_type: "bot_started", user: { user_id: 55, name: "Иван" } });
  await tick();
  assert.match(lastText(55), /Ваш MAX ID: 55\. Управлять ботом могут только/);
  assert.match(lastText(55), /Бот в MAX/);
  assert.strictEqual(sentTo(55)[0].query.user_id, "55", "личный чат — параметром user_id");

  // ---- владелец в списке → личный чат подключается по «Начать»
  res = mkRes();
  await mx.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: "55", name: "владелец", role: "owner" }, { id: "66", name: "бармен", role: "staff" }] }), res);
  assert.strictEqual(res.code, 200);
  await assert.rejects(mx.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: "abc" }] }), mkRes()), /не MAX ID/);
  await tick();
  await hook({ update_type: "bot_started", user: { user_id: 55 } });
  await tick();
  assert.match(lastText(55), /Готово: «Кафе А» подключено/);
  const menuMsg = sentTo(55).pop();
  assert.ok(menuMsg.body.attachments[0].payload.buttons.flat().every((b) => b.type === "message"), "меню отчётов — кнопками MAX");
  assert.strictEqual(menuMsg.body.format, "html");
  assert.deepStrictEqual(store.get("maxBots/A").ownerChats.map((c) => c.id), [55]);

  // ---- отчёт кнопкой: нажатие приходит текстом
  const revenueBtn = menuMsg.body.attachments[0].payload.buttons[0][0].text;
  await hook({ update_type: "message_created", message: { sender: { user_id: 55 }, recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "u1", text: revenueBtn } } });
  await tick();
  assert.match(lastText(55), /Выручка|выручка/);

  // ---- «Ещё отчёты» → кнопка callback → ответ
  const moreBtn = menuMsg.body.attachments[0].payload.buttons.flat().find((b) => /Ещё/.test(b.text)).text;
  await hook({ update_type: "message_created", message: { sender: { user_id: 55 }, recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "u2", text: moreBtn } } });
  await tick();
  const more = sentTo(55).pop();
  const weekBtn = more.body.attachments[0].payload.buttons.flat().find((b) => b.payload === "r:week");
  assert.ok(weekBtn && weekBtn.type === "callback");
  await hook({ update_type: "message_callback", callback: { callback_id: "cb1", payload: "r:week", user: { user_id: 55 } }, message: { recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "mid.x" } } });
  await tick();
  assert.match(lastText(55), /недел/i);
  // Чужой человек жмёт кнопку отчётов — «Нет доступа» уведомлением.
  await hook({ update_type: "message_callback", callback: { callback_id: "cb2", payload: "r:week", user: { user_id: 99 } }, message: { recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "mid.x" } } });
  await tick();
  const ans = calls.filter((c) => c.path === "answers").pop();
  assert.deepStrictEqual([ans.query.callback_id, ans.body.notification], ["cb2", "Нет доступа"]);

  // ---- рабочая группа по коду
  res = mkRes();
  await mx.handleLinkCode(mkReq({ tenantId: "A", kind: "staff" }), res);
  assert.match(res.body.command, /^\/start [a-f0-9]{18}$/);
  assert.strictEqual(res.body.link, "https://max.ru/cafe_a_bot");
  // Код в личном чате — не подходит.
  await hook({ update_type: "message_created", message: { sender: { user_id: 55 }, recipient: { chat_id: 777, chat_type: "dialog" }, body: { mid: "u3", text: res.body.command } } });
  await tick();
  assert.match(lastText(55), /отправить в рабочей группе/);
  // Сотрудник (не владелец) в группе — не подключит.
  await hook({ update_type: "message_created", message: { sender: { user_id: 66 }, recipient: { chat_id: -500, chat_type: "chat" }, body: { mid: "g0", text: res.body.command } } });
  await tick();
  assert.match(lastText(-500), /только владелец или управляющий/);
  await hook({ update_type: "message_created", message: { sender: { user_id: 55 }, recipient: { chat_id: -500, chat_type: "chat" }, body: { mid: "g1", text: res.body.command } } });
  await tick();
  assert.deepStrictEqual(store.get("maxBots/A").staffChat, { id: -500, title: "Смена кафе" }, "группа и её название");
  assert.match(lastText(-500), /Группа подключена к «Кафе А»/);
  assert.ok(!/Темы/.test(lastText(-500)), "про темы Telegram в MAX не пишем");
  assert.strictEqual(sentTo(-500).pop().query.chat_id, "-500", "группа — параметром chat_id");
  assert.ok(!calls.some((c) => /createForumTopic/.test(c.path)));

  // ---- заказ с собой → карточка в группе с кнопками, нажатие сотрудника
  await docRef("tenants/A/sessions/s1").set({ status: "active", tableId: "takeaway", orderType: "takeaway", deliveryStatus: "cooking", orderNo: 12,
    orderItems: [{ name: "Чай", price: 300, qty: 1, sent: 1 }], openedAt: new TS(Date.now()) });
  await tick(); await tick();
  const card = sentTo(-500).find((c) => /№12/.test(c.body.text || ""));
  assert.ok(card, "карточка заказа в группе");
  const btns = card.body.attachments[0].payload.buttons.flat();
  const next = btns.find((b) => b.type === "callback" && /^s:s1:/.test(b.payload));
  assert.ok(next, "кнопка следующего шага");
  assert.ok(!/Иван|\+7/.test(card.body.text), "без имён и телефонов");
  await hook({ update_type: "message_callback", callback: { callback_id: "cb3", payload: next.payload, user: { user_id: 66, first_name: "Бармен" } },
    message: { recipient: { chat_id: -500, chat_type: "chat" }, body: { mid: store.get("maxBots/A/cards/s1").messageId } } });
  await tick(); await tick();
  assert.strictEqual(store.get("tenants/A/sessions/s1").deliveryStatus, next.payload.split(":")[2], "статус заказа сменился с кнопки MAX");
  const edit = calls.filter((c) => c.method === "PUT" && c.path === "messages").pop();
  assert.ok(edit && edit.query.message_id === store.get("maxBots/A/cards/s1").messageId, "карточка обновилась правкой сообщения");
  // Чужой в группе жмёт — нет доступа.
  await hook({ update_type: "message_callback", callback: { callback_id: "cb4", payload: next.payload, user: { user_id: 99 } },
    message: { recipient: { chat_id: -500, chat_type: "chat" }, body: { mid: "x" } } });
  await tick();
  assert.match(calls.filter((c) => c.path === "answers").pop().body.notification, /Нет доступа\. Ваш MAX ID: 99/);
  // Заказ выдан — кнопки убираются (текст карточки остаётся).
  await store.get("tenants/A/sessions/s1") && docRef("tenants/A/sessions/s1").update({ deliveryStatus: "done", deliveryOpen: false, status: "closed" });
  await tick(); await tick();
  const strip = calls.filter((c) => c.method === "PUT" && c.path === "messages").pop();
  assert.deepStrictEqual(strip.body.attachments, []);
  assert.ok(strip.body.text && /№12/.test(strip.body.text), "правка кнопок не стирает текст карточки");

  // ---- сигнал владельцу
  assert.strictEqual(await mx.ownerAlert("A", "⚠️ Проверка сигнала"), true);
  await tick();
  assert.match(lastText(55), /Проверка сигнала/);

  // ---- статус и отключение
  res = mkRes();
  await mx.handleStatus(mkReq({ tenantId: "A" }), res);
  assert.strictEqual(res.body.configured, true);
  assert.strictEqual(res.body.staffChat, "Смена кафе");
  res = mkRes();
  await mx.handleUnlink(mkReq({ tenantId: "A" }), res);
  assert.ok(!store.has("maxBots/A"));
  assert.deepStrictEqual(subs, [], "подписка на события снята");
  console.log("max-bot: OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
