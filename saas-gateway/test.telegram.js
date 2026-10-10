"use strict";
// Сценарии Telegram-ботов заведений на имитации Firestore и Telegram:
// изоляция заведений, привязка чатов, карточки доставки без ПДн, кнопки
// статусов, отчёты, сигналы, смены, страница адреса.
process.env.TELEGRAM_SECRET_KEY = "sim-key";
// Копия чеков бота — во временной папке, не в проекте.
const cacheDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "tg-cache-"));
process.env.TELEGRAM_CACHE_DIR = cacheDir;
const assert = require("assert");
const { Readable } = require("stream");
const tgmod = require("./telegram.js");

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
const sent = [];
let msgId = 100;
const fetchImpl = async (url, opts) => {
  const [, token, method] = url.match(/bot([^/]+)\/(\w+)$/);
  const body = JSON.parse(opts.body);
  sent.push({ token, method, body });
  if (method === "getMe") {
    const k = token.slice(0, 3);
    const [id, username] = { 111: [111, "venue_a_bot"], 222: [222, "venue_b_bot"] }[k] || [Number(k), `bot${k}_bot`];
    return { json: async () => ({ ok: true, result: { id, username } }) };
  }
  return { json: async () => ({ ok: true, result: { message_id: ++msgId } }) };
};

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const mkReq = (body, headers = {}, url = "/") => { const r = Readable.from([Buffer.from(JSON.stringify(body))]); r.headers = { authorization: "Bearer x", ...headers }; r.url = url; return r; };
const mkRes = () => { const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b; } }; return r; };
const deps = {
  db, admin,
  // admin2 — администратор только точки C2 сети.
  verifyAuth: async (req) => ({ uid: req.headers.authorization === "Bearer admin2" ? "admin2" : "owner1" }),
  parseJsonBody: async (req) => { let s = ""; for await (const c of req) s += c; return JSON.parse(s); },
  readBody: async (req) => { let s = ""; for await (const c of req) s += c; return s; },
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  HttpError,
  requireTenantRole: async (t, uid) => { if (uid !== "owner1" && !(uid === "admin2" && t === "C2")) throw new HttpError(403, "no"); },
  publicUrl: "https://pii.zalpos.ru/saas",
  fetchImpl,
};
const tg = tgmod.createTelegram(deps);
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  store.set("tenants/A", { name: "Кафе А", timezone: "Europe/Moscow" });
  store.set("tenants/B", { name: "Бар Б", timezone: "Europe/Moscow" });
  store.set("tenants/A/tables/t1", { name: "Стол 1", activeSessionIds: ["x"] });
  store.set("tenants/A/tables/t2", { name: "Стол 2", activeSessionIds: [] });
  tg.start();

  // Подключение ботов двух заведений
  let res = mkRes();
  await tg.handleSetup(mkReq({ tenantId: "A", token: "111111:" + "a".repeat(35) }), res);
  assert.equal(res.code, 200); assert.equal(res.body.username, "venue_a_bot");
  const cfgA = store.get("telegramBots/A");
  assert.ok(cfgA.tokenEnc.startsWith("v1:") && !cfgA.tokenEnc.includes("aaaa"), "токен зашифрован");
  res = mkRes();
  await tg.handleSetup(mkReq({ tenantId: "B", token: "222222:" + "b".repeat(35) }), res);
  res = mkRes();
  await assert.rejects(tg.handleSetup(mkReq({ tenantId: "B", token: "111111:" + "c".repeat(35) }), res), /уже подключён к другому/);
  await tick();

  // Хук с чужим секретом — 403
  res = mkRes();
  await tg.handleHook(mkReq({ message: {} }, { "x-telegram-bot-api-secret-token": store.get("telegramBots/B").hookSecret }), res, "A");
  assert.equal(res.code, 403, "секрет заведения Б не пускает в бота А");

  // Без списка «Кто управляет ботом» ссылку привязки не выдаём
  res = mkRes();
  await assert.rejects(tg.handleLinkCode(mkReq({ tenantId: "A", kind: "owner" }), res), /Telegram ID/);
  // Неверный ID — понятная ошибка
  await assert.rejects(tg.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: "олег", role: "owner" }] }), mkRes()), /не Telegram ID/);
  // Владелец А вписывает свой ID и ID повара
  res = mkRes();
  await tg.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: "501", name: "Олег", role: "owner" }, { id: 601, name: "Повар", role: "staff" }, { id: "501", role: "staff" }] }), res);
  assert.deepEqual(res.body.allowed, [{ id: 501, name: "Олег", role: "owner" }, { id: 601, name: "Повар", role: "staff" }], "повтор ID отброшен");
  await tick();

  // Владелец А привязывает личный чат и группу
  res = mkRes();
  await tg.handleLinkCode(mkReq({ tenantId: "A", kind: "owner" }), res);
  const ownerCode = res.body.link.split("start=")[1];
  res = mkRes();
  await tg.handleLinkCode(mkReq({ tenantId: "A", kind: "staff" }), res);
  const staffCode = res.body.link.split("startgroup=")[1];
  const hookA = (update) => tg.handleHook(mkReq(update, { "x-telegram-bot-api-secret-token": store.get("telegramBots/A").hookSecret }), mkRes(), "A");
  // Пересланная ссылка не сработает у чужого: его ID нет в списке
  sent.length = 0;
  await hookA({ message: { chat: { id: 502, type: "private", first_name: "Чужой" }, from: { id: 502 }, text: `/start ${ownerCode}` } });
  assert.ok(sent.some((m) => m.body.chat_id === 502 && /Ваш Telegram ID: 502/.test(m.body.text)), "чужому — его ID и как получить доступ");
  // Сотрудник из списка не может подключить группу
  await hookA({ message: { chat: { id: -901, type: "supergroup", title: "Левая" }, from: { id: 601 }, text: `/start@venue_a_bot ${staffCode}` } });
  await hookA({ message: { chat: { id: 501, type: "private", first_name: "Олег" }, from: { id: 501 }, text: `/start ${ownerCode}` } });
  await hookA({ message: { chat: { id: -900, type: "supergroup", title: "Кухня А" }, from: { id: 501 }, text: `/start@venue_a_bot ${staffCode}` } });
  await tick();
  assert.deepEqual(store.get("telegramBots/A").ownerChats, [{ id: 501, name: "" }], "имя из Telegram не храним");
  assert.equal(store.get("telegramBots/A").staffChat.id, -900);
  // Код А не работает в боте Б
  const hookB = (update) => tg.handleHook(mkReq(update, { "x-telegram-bot-api-secret-token": store.get("telegramBots/B").hookSecret }), mkRes(), "B");
  res = mkRes();
  await tg.handleLinkCode(mkReq({ tenantId: "A", kind: "owner" }), res);
  await hookB({ message: { chat: { id: 777, type: "private" }, from: { id: 777 }, text: `/start ${res.body.link.split("start=")[1]}` } });
  assert.equal((store.get("telegramBots/B").ownerChats || []).length, 0, "код заведения А не привязывает чат к Б");

  // Новый заказ доставки в А → карточка в группу А без ПДн
  sent.length = 0;
  store.set("tenants/A/sessions/s1abcd", { tableId: "takeaway", status: "active", orderType: "delivery", deliveryStatus: "new",
    guestTag: "Иван", customerPhone: "+79001112233", deliveryAddress: "ул. Ленина 1", orderItems: [{ name: "Пицца", price: 500, qty: 2 }], startTime: new Date() });
  fire(); await tick(); await tick();
  const card = sent.find((m) => m.method === "sendMessage" && m.body.chat_id === -900);
  assert.ok(card, "карточка ушла в группу А");
  assert.ok(!/Иван|\+7900|Ленина/.test(card.body.text), "в карточке нет ПДн гостя");
  assert.ok(card.token.startsWith("111"), "карточка отправлена ботом А");
  assert.equal(card.body.reply_markup.inline_keyboard[0][0].callback_data, "s:s1abcd:accepted");
  assert.ok(sent.every((m) => m.body.chat_id !== 777), "в чаты Б ничего не ушло");

  // Человек из группы, которого нет в списке, кнопку нажать не может
  sent.length = 0;
  await hookA({ callback_query: { id: "q0", from: { id: 700, first_name: "Гость группы" }, data: "s:s1abcd:accepted", message: { chat: { id: -900 }, message_id: 101 } } });
  assert.equal(store.get("tenants/A/sessions/s1abcd").deliveryStatus, "new", "чужое нажатие не меняет статус");
  const denied = sent.find((m) => m.method === "answerCallbackQuery");
  assert.ok(denied.body.show_alert && /700/.test(denied.body.text), "чужому — его ID во всплывающем окне");
  // Кнопка «Принять» из группы → статус в базе
  await hookA({ callback_query: { id: "q1", from: { id: 601, first_name: "Повар" }, data: "s:s1abcd:accepted", message: { chat: { id: -900 }, message_id: 101 } } });
  assert.equal(store.get("tenants/A/sessions/s1abcd").deliveryStatus, "accepted");
  // Повторное нажатие того же шага не проходит
  await hookA({ callback_query: { id: "q2", from: { id: 601, first_name: "Повар" }, data: "s:s1abcd:accepted", message: { chat: { id: -900 }, message_id: 101 } } });
  assert.equal(store.get("tenants/A/sessions/s1abcd").deliveryStatus, "accepted");
  const ans = sent.filter((m) => m.method === "answerCallbackQuery").pop();
  assert.match(ans.body.text, /уже/);
  // Кнопка из чужого чата — нет доступа
  await hookA({ callback_query: { id: "q3", from: { id: 601 }, data: "s:s1abcd:cooking", message: { chat: { id: 12345 }, message_id: 101 } } });
  assert.equal(store.get("tenants/A/sessions/s1abcd").deliveryStatus, "accepted");
  await tick(); await tick();
  assert.ok(sent.some((m) => m.method === "editMessageText" && /Принят/.test(m.body.text)), "карточка обновилась");

  // Отчёт «Посадка» владельцу А
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "🪑 Посадка" } });
  const rep = sent.find((m) => m.method === "sendMessage" && m.body.chat_id === 501);
  assert.match(rep.body.text, /занято 1 из 2/);

  // Выручка: те же цифры, что X-отчёт кассы. Чек пробит только что, а часы
  // кассы спешат на 2 минуты — он всё равно в отчёте. Отменённая доставка
  // выручкой не считается.
  const nowMs = Date.now();
  store.set("tenants/A/meta/shiftState", { openShiftId: "sh1" });
  store.set("tenants/A/shifts/sh1", { status: "open", openedAt: new TS(nowMs - 3600000) });
  store.set("tenants/A/sessions/paid1", { status: "closed", tableId: "t2", closedAt: new TS(nowMs + 120000),
    orderItems: [{ name: "чаша", price: 500, qty: 8 }], paymentCard: 1500, paymentCash: 2500 });
  store.set("tenants/A/sessions/cxl1", { status: "cancelled", tableId: "takeaway", orderType: "delivery", deliveryStatus: "cancelled",
    closedAt: new TS(nowMs - 60000), orderItems: [{ name: "Пицца", price: 700, qty: 1 }] });
  // Чеки приходят в копию на сервере подпиской.
  fire(); await tick();
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "💰 Выручка сегодня" } });
  const revText = sent.find((m) => m.body.chat_id === 501).body.text;
  assert.match(revText, /Кафе А/, "видно, какое заведение");
  assert.match(revText, /Выручка сегодня \(с 6:00\): 4\s000 ₽/);
  assert.match(revText, /Чеков закрыто: 1/);
  assert.match(revText, /Наличные 2\s500 ₽ · карта 1\s500 ₽/);
  assert.match(revText, /Смена кассы с \d\d:\d\d: 4\s000 ₽ · чеков 1/);
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "🧾 Средний чек" } });
  assert.match(sent.find((m) => m.body.chat_id === 501).body.text, /Средний чек сегодня: 4\s000 ₽ \(1 чек\.\)/);
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "🍽 Кухня · Бар · Кальяны" } });
  assert.match(sent.find((m) => m.body.chat_id === 501).body.text, /Кухня: 4\s000 ₽ · 100%/);
  for (const k of ["meta/shiftState", "shifts/sh1", "sessions/paid1", "sessions/cxl1"]) store.delete(`tenants/A/${k}`);
  fire(); await tick();
  // Посторонний в личке бота А отчёт не получит, а сотрудник из списка — тоже
  sent.length = 0;
  await hookA({ message: { chat: { id: 999, type: "private" }, from: { id: 999 }, text: "💰 Выручка сегодня" } });
  assert.ok(!/Выручка/.test(sent[0].body.text) && /999/.test(sent[0].body.text), "посторонний не видит выручку, видит свой ID");
  sent.length = 0;
  await hookA({ message: { chat: { id: 601, type: "private" }, from: { id: 601 }, text: "💰 Выручка сегодня" } });
  assert.ok(/сотрудников/.test(sent[0].body.text), "сотруднику отчёты не положены");
  // /id — любому, свой ID
  sent.length = 0;
  await hookA({ message: { chat: { id: 888, type: "private" }, from: { id: 888 }, text: "/id" } });
  assert.match(sent[0].body.text, /Ваш Telegram ID: 888/);

  // Закрытие заказа → карточка закрыта
  sent.length = 0;
  store.set("tenants/A/sessions/s1abcd", { ...store.get("tenants/A/sessions/s1abcd"), status: "closed" });
  fire(); await tick(); await tick();
  assert.ok(sent.some((m) => /закрыт на кассе/.test(m.body.text || "")));
  assert.ok(!store.has("telegramBots/A/cards/s1abcd"));
  // Сигнал журнала и начало смены — владельцу А
  sent.length = 0;
  store.set("tenants/A/employees/e1", { name: "Анна", position: "waiter" });
  await new Promise((r) => setTimeout(r, 5));
  store.set("tenants/A/auditLog/a1", { action: "closed_without_payment", tableName: "Стол 1", amount: 1500, employeeName: "Анна", details: { reason: "ушли" }, createdAt: new TS(Date.now()) });
  store.set("tenants/A/staffShifts/sh1", { employeeId: "e1", employeeName: "Анна", status: "open", startedAt: new TS(Date.now()) });
  fire(); await tick(); await tick();
  assert.ok(sent.some((m) => m.body.chat_id === 501 && /закрыт без оплаты на 1\s500.*— официант/.test(m.body.text)), "сигнал о закрытии без оплаты — с должностью");
  const shiftMsg = sent.find((m) => m.body.chat_id === 501 && /Начал смену: официант в/.test(m.body.text));
  assert.ok(shiftMsg, "начало смены — должность вместо имени");
  assert.ok(sent.every((m) => !JSON.stringify(m.body).includes("Анна")), "имени сотрудника в Telegram нет");
  // «👤 Кто» — имя на странице нашего сервера по подписанной ссылке.
  const whoLink = shiftMsg.body.reply_markup.inline_keyboard[0][0].url;
  res = mkRes();
  await tg.handleWho({ url: whoLink.replace(/^https?:\/\/[^/]+(\/saas)?/, "") }, res);
  assert.equal(res.code, 200); assert.match(res.body, /Анна/); assert.match(res.body, /официант/);
  res = mkRes();
  await tg.handleWho({ url: whoLink.replace(/^https?:\/\/[^/]+(\/saas)?/, "").replace("t=A", "t=B") }, res);
  assert.equal(res.code, 403, "ссылка заведения А не открывает данные Б");
  const alertMsg = sent.find((m) => m.body.chat_id === 501 && /без оплаты/.test(m.body.text));
  res = mkRes();
  await tg.handleWho({ url: alertMsg.body.reply_markup.inline_keyboard[0][0].url.replace(/^https?:\/\/[^/]+(\/saas)?/, "") }, res);
  assert.equal(res.code, 200); assert.match(res.body, /Кто:<\/b> Анна/);
  // Отчёт «Текущая смена» — должности и ссылка, без имён.
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "👥 Текущая смена" } });
  const team = sent.find((m) => m.method === "sendMessage" && m.body.chat_id === 501);
  assert.ok(/официант/.test(team.body.text) && /staffWho/.test(team.body.text) && !/Анна/.test(team.body.text), "смена без имён");
  // Курьер из группы: кнопки — должность и время смены, в карточке — без имени.
  store.set("tenants/A/sessions/s2zzzz", { tableId: "takeaway", status: "active", orderType: "delivery", deliveryStatus: "cooking",
    orderItems: [{ name: "Суп", price: 300, qty: 1 }], startTime: new Date() });
  fire(); await tick(); await tick();
  sent.length = 0;
  await hookA({ callback_query: { id: "c1", from: { id: 601, first_name: "Повар" }, data: "c:s2zzzz", message: { chat: { id: -900 }, message_id: 105 } } });
  const kb = sent.find((m) => m.method === "editMessageReplyMarkup");
  assert.ok(kb && /официант/.test(JSON.stringify(kb.body)) && !/Анна/.test(JSON.stringify(kb.body)), "в кнопках курьера нет имён");
  await hookA({ callback_query: { id: "c2", from: { id: 601, first_name: "Повар" }, data: "k:s2zzzz:e1", message: { chat: { id: -900 }, message_id: 105 } } });
  await tick(); await tick();
  assert.equal(store.get("tenants/A/sessions/s2zzzz").courierSet, true, "отметка «курьер назначен»");
  assert.ok(sent.some((m) => /Курьер назначен/.test(m.body.text || "")), "карточка: курьер назначен");
  assert.ok(sent.every((m) => !JSON.stringify(m.body).includes("Анна")), "имени курьера в Telegram нет");
  // Управляющий из списка подключается без ссылки: открыл бота — «Запустить»
  await tg.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: 501, name: "Олег", role: "owner" }, { id: 601, name: "Повар", role: "staff" }, { id: 503, name: "Ира", role: "owner" }] }), mkRes());
  await tick();
  sent.length = 0;
  await hookA({ message: { chat: { id: 503, type: "private", first_name: "Ира" }, from: { id: 503 }, text: "/start" } });
  await tick();
  assert.ok(store.get("telegramBots/A").ownerChats.some((c) => c.id === 503), "чат управляющего привязан по ID");
  assert.ok(sent.some((m) => m.body.chat_id === 503 && /подключено/.test(m.body.text)));
  // Сотрудник так не подключится к отчётам
  await hookA({ message: { chat: { id: 601, type: "private", first_name: "Повар" }, from: { id: 601 }, text: "/start" } });
  await tick();
  assert.ok(!store.get("telegramBots/A").ownerChats.some((c) => c.id === 601), "сотрудник не получает отчёты");

  // Владелец убрал себя из списка — личный чат больше ничего не получает
  res = mkRes();
  await tg.handleAccess(mkReq({ tenantId: "A", allowed: [{ id: 601, name: "Повар", role: "staff" }] }), res);
  await tick();
  assert.deepEqual(store.get("telegramBots/A").ownerChats, [], "чаты владельца и управляющей отвязаны");
  sent.length = 0;
  await hookA({ message: { chat: { id: 501, type: "private" }, from: { id: 501 }, text: "💰 Выручка сегодня" } });
  assert.ok(!/Выручка сегодня:/.test(sent[0].body.text), "без доступа отчётов нет");
  // Бот, подключённый до списка доступа: владельцы чатов — в списке сами
  assert.deepEqual(tgmod.allowedList({ ownerChats: [{ id: 42, name: "Ира" }] }), [{ id: 42, name: "Ира", role: "owner" }]);

  // Страница адреса: верная подпись — адрес, неверная — 403
  const key = require("crypto").createHash("sha256").update("sim-key").digest();
  const exp = Date.now() + 60000;
  const k = tgmod.addressSig(key, "A", "s1abcd", exp);
  res = mkRes();
  await tg.handleAddress({ url: `/deliveryAddress?t=A&s=s1abcd&e=${exp}&k=${k}` }, res);
  assert.equal(res.code, 200); assert.match(res.body, /Ленина/);
  res = mkRes();
  await tg.handleAddress({ url: `/deliveryAddress?t=B&s=s1abcd&e=${exp}&k=${k}` }, res);
  assert.equal(res.code, 403, "подпись заведения А не открывает адрес в Б");

  // ================= Сеть: один бот на все точки, переключение точек
  const H = 3600000;
  const TZ = "Europe/Moscow";
  store.set("chains/ch1", { name: "Ромашка" });
  store.set("tenants/C1", { name: "Центр", chainId: "ch1", timezone: TZ });
  store.set("tenants/C2", { name: "Арбат", chainId: "ch1", timezone: TZ });
  store.set("tenants/C1/tables/t1", { name: "Стол 1", activeSessionIds: [] });
  store.set("tenants/C2/tables/t1", { name: "Стол 1", activeSessionIds: ["z"] });
  store.set("tenants/C2/tables/t2", { name: "Стол 2", activeSessionIds: [] });
  res = mkRes();
  await tg.handleSetup(mkReq({ tenantId: "C1", token: "333333:" + "c".repeat(35) }), res);
  assert.equal(res.code, 200);
  await tick(); await tick();
  // Кабинет второй точки видит бота сети, второго бота не заводит
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "C2" }), res);
  assert.equal(res.body.configured, true);
  assert.deepEqual(res.body.chain, { name: "Ромашка", points: ["Арбат", "Центр"], home: "Центр", separate: [] });
  await assert.rejects(tg.handleStatus(mkReq({ tenantId: "C2" }, { authorization: "Bearer admin2" }), mkRes()), /другой точке/,
    "администратор одной точки не управляет ботом всей сети");
  await tg.handleAccess(mkReq({ tenantId: "C2", allowed: [{ id: 701, name: "Влад", role: "owner" }, { id: 702, name: "Повар", role: "staff" }] }), mkRes());
  await tick();
  assert.equal(store.get("telegramBots/C1").allowed.length, 2);
  assert.ok(!store.has("telegramBots/C2"), "у точки сети нет второго бота");
  const hookC = (update) => tg.handleHook(mkReq(update, { "x-telegram-bot-api-secret-token": store.get("telegramBots/C1").hookSecret }), mkRes(), "C1");
  const toOwner = () => sent.filter((m) => m.method === "sendMessage" && m.body.chat_id === 701);
  const ask = async (text) => {
    fire(); await tick();
    sent.length = 0;
    await hookC({ message: { chat: { id: 701, type: "private" }, from: { id: 701 }, text } });
    return toOwner().pop().body;
  };
  let body = await ask("/start");
  assert.match(body.text, /сеть «Ромашка» \(2 точки\)/);
  assert.equal(body.reply_markup.keyboard[0][0].text, "📍 Все точки", "сверху — выбор точки, по умолчанию вся сеть");

  // «Все точки»: выручка сети и по точкам; забытая смена кассы — предупреждение
  const nowC = Date.now();
  store.set("tenants/C1/sessions/p1", { status: "closed", tableId: "t1", closedAt: new TS(nowC - 60000), orderItems: [{ name: "Чай", price: 500, qty: 2 }], paymentCash: 1000 });
  store.set("tenants/C2/sessions/p2", { status: "closed", tableId: "t1", closedAt: new TS(nowC - 60000),
    orderItems: [{ name: "Чай", price: 500, qty: 3, kind: "bar" }, { name: "Суп", price: 1000, qty: 1 }], paymentCard: 2500 });
  store.set("tenants/C1/meta/shiftState", { openShiftId: "old" });
  store.set("tenants/C1/shifts/old", { status: "open", openedAt: new TS(nowC - 30 * H) });
  body = await ask("💰 Выручка сегодня");
  assert.match(body.text, /Сеть «Ромашка» — все точки/);
  assert.match(body.text, /Выручка сегодня \(с 6:00\): 3\s500 ₽/);
  assert.match(body.text, /📍 Арбат: 2\s500 ₽ · 1 чек\. · открыто 0 · касса закрыта/);
  assert.match(body.text, /📍 Центр: 1\s000 ₽ · 1 чек\./);
  assert.match(body.text, /• Центр: смена кассы не закрыта с \d\d\.\d\d \d\d:\d\d/);
  body = await ask("🏆 нет такой");
  assert.match(body.text, /Выберите отчёт/);
  body = await ask("🧾 Средний чек");
  assert.match(body.text, /Средний чек сегодня: 1\s750 ₽ \(2 чек\.\)/);
  body = await ask("🍽 Кухня · Бар · Кальяны");
  assert.match(body.text, /Кухня: 2\s000 ₽ · 57%/);
  assert.match(body.text, /Бар: 1\s500 ₽ · 43%/);
  body = await ask("🪑 Посадка");
  assert.match(body.text, /📍 Арбат\n🪑 Посадка: занято 1 из 2/);
  assert.match(body.text, /📍 Центр\n🪑 Посадка: занято 0 из 1/);

  // Выбор точки: кнопка «📍», только владельцу
  body = await ask("📍 Все точки");
  assert.deepEqual(body.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ["p:all", "p:C2", "p:C1"]);
  assert.match(body.reply_markup.inline_keyboard[0][0].text, /^✅/);
  sent.length = 0;
  await hookC({ callback_query: { id: "p0", from: { id: 702 }, data: "p:C2", message: { chat: { id: 701 }, message_id: 300 } } });
  assert.equal((store.get("telegramBots/C1").views || {})["701"], undefined, "сотрудник точку владельцу не переключит");
  await hookC({ callback_query: { id: "p1", from: { id: 701 }, data: "p:C2", message: { chat: { id: 701 }, message_id: 300 } } });
  await tick();
  assert.equal(store.get("telegramBots/C1").views["701"], "C2", "выбор точки запомнен");
  assert.equal(toOwner().pop().body.reply_markup.keyboard[0][0].text, "📍 Арбат");
  body = await ask("💰 Выручка сегодня");
  assert.match(body.text, /🏠 Арбат/);
  assert.match(body.text, /Выручка сегодня \(с 6:00\): 2\s500 ₽/);
  assert.ok(!/3\s500/.test(body.text), "только выбранная точка");
  assert.match(body.text, /Касса закрыта/);
  body = await ask("/point");
  assert.match(body.reply_markup.inline_keyboard[1][0].text, /^✅ Арбат/);

  // «Ещё отчёты» по выбранной точке
  body = await ask("📊 Ещё отчёты");
  const moreKeys = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(moreKeys, ["r:yesterday", "r:week", "r:top", "r:stock", "r:bookings", "r:voids", "r:reviews"]);
  const more = async (key) => {
    fire(); await tick();
    sent.length = 0;
    await hookC({ callback_query: { id: `r-${key}`, from: { id: 701 }, data: `r:${key}`, message: { chat: { id: 701 }, message_id: 301 } } });
    return toOwner().pop().body.text;
  };
  let text = await more("top");
  assert.match(text, /^📍 Арбат\n🏆 Топ продаж сегодня:\n1\. Чай — 3 шт · 1\s500 ₽\n2\. Суп — 1 шт · 1\s000 ₽$/);
  store.set("tenants/C2/inventoryItems/i1", { name: "Молоко", quantity: 0.5, minQuantity: 2, unit: "l" });
  store.set("tenants/C2/inventoryItems/i2", { name: "Сахар", quantity: 5, minQuantity: 1, unit: "kg" });
  store.set("tenants/C2/inventoryItems/i3", { name: "Старое", quantity: 0, minQuantity: 1, unit: "pcs", active: false });
  text = await more("stock");
  assert.match(text, /Заканчивается \(1\):\n• Молоко: 0,5 л \(минимум 2 л\)/);
  const soon = new TS(Date.now() + 60000);
  store.set("tenants/C2/reservations/b1", { startTime: soon, status: "confirmed", guestsCount: 4, tableName: "Стол 2", guestName: "Пётр", phone: "+79005556677" });
  store.set("tenants/C2/reservations/b2", { startTime: soon, status: "new", guestsCount: 2 });
  store.set("tenants/C2/reservations/b3", { startTime: soon, status: "noShow", guestsCount: 3 });
  store.set("tenants/C2/reservations/b4", { startTime: soon, status: "cancelled", guestsCount: 5 });
  text = await more("bookings");
  assert.match(text, /Брони сегодня: 2 · гостей 6/);
  assert.match(text, /Ждут подтверждения: 1/);
  assert.match(text, /Стол 2 · 4 гост\. · подтверждена/);
  assert.ok(!/Пётр|7900555/.test(text), "в бронях нет имён и телефонов");
  body = await ask("🪑 Посадка");
  assert.match(body.text, /Броней сегодня: 2 · ближайшая в \d\d:\d\d/);
  store.set("tenants/C2/reviews/v1", { rating: 5, text: "Супер", createdAt: new TS(Date.now() - H) });
  store.set("tenants/C2/reviews/v2", { rating: 2, text: "Плохо, звоните 89001234567", createdAt: new TS(Date.now() - 2 * H) });
  store.set("tenants/C2/reviews/v3", { rating: 1, text: "Старый", createdAt: new TS(Date.now() - 10 * 24 * H) });
  text = await more("reviews");
  assert.match(text, /Отзывы за 7 дней: 2 · средняя оценка 3,5/);
  assert.match(text, /Оценок 3 и ниже: 1/);
  assert.ok(!/8900|Плохо/.test(text), "тексты отзывов — только в кабинете");

  // Касса сейчас: сколько должно быть наличных — как X-отчёт
  store.set("tenants/C2/meta/shiftState", { openShiftId: "s2" });
  store.set("tenants/C2/shifts/s2", { status: "open", openedAt: new TS(Date.now() - 2 * H), openingCash: 5000 });
  store.set("tenants/C2/sessions/p3", { status: "closed", tableId: "t2", closedAt: new TS(Date.now() - 30000), orderItems: [{ name: "Пирог", price: 1200, qty: 1 }], paymentCash: 1200, tipsCash: 100 });
  store.set("tenants/C2/sessions/p4", { status: "closed", tableId: "t2", closedAt: new TS(Date.now() - 20000), orderItems: [{ name: "Пирог", price: 1200, qty: 1 }], paymentCash: 1200, refunded: true });
  store.set("tenants/C2/cashOps/o1", { shiftId: "s2", type: "collection", amount: 1000 });
  store.set("tenants/C2/cashOps/o2", { shiftId: "s2", type: "payout", amount: 200, cancelled: true });
  store.set("tenants/C2/cashOps/o3", { shiftId: "old", type: "deposit", amount: 9999 });
  body = await ask("💵 Касса сейчас");
  assert.match(body.text, /На начало смены: 5\s000 ₽/);
  assert.match(body.text, /\+ наличные продажи: 1\s200 ₽/);
  assert.match(body.text, /\+ чаевые наличными: 100 ₽/);
  assert.match(body.text, /− инкассация: 1\s000 ₽/);
  assert.ok(!/выплаты|внесения/.test(body.text), "отменённая выплата и чужая смена не считаются");
  assert.match(body.text, /= должно быть в кассе: 5\s300 ₽/);
  assert.match(body.text, /Безнал за смену: карта 2\s500 ₽/);

  // Неделя: по дням и сравнение с прошлой неделей
  const dayStart = tgmod.businessDayStart(new Date(), TZ).getTime();
  store.set("tenants/C2/sessions/w0", { status: "closed", tableId: "t2", closedAt: new TS(dayStart - 8 * 24 * H + H), orderItems: [{ name: "Чай", price: 1000, qty: 1 }], paymentCash: 1000 });
  store.set("tenants/C2/sessions/w1", { status: "closed", tableId: "t2", closedAt: new TS(dayStart - 24 * H + H), orderItems: [{ name: "Чай", price: 300, qty: 1 }], paymentCash: 300,
    guestTag: "Иван", customerPhone: "+79001112233", deliveryAddress: "ул. Ленина 1" });
  let before = closedReads;
  text = await more("week");
  assert.ok(closedReads > before, "прошедшие сутки — один раз из Firestore");
  assert.match(text, /\(сегодня\) — 3\s700 ₽ · 2 чек\./);
  assert.match(text, /Итого: 4\s000 ₽ · 3 чек\./);
  assert.match(text, /К прошлым 7 дням \(1\s000 ₽\): \+300%/);
  // Копия на сервере: повторные отчёты чеки из Firestore заново не читают.
  before = closedReads;
  assert.match(await more("week"), /Итого: 4\s000 ₽ · 3 чек\./);
  assert.match((await ask("💰 Выручка сегодня")).text, /Выручка сегодня \(с 6:00\): 3\s700 ₽/);
  await more("top");
  await ask("💵 Касса сейчас");
  assert.equal(closedReads, before, "неделя, выручка, топ и касса — из копии на сервере");
  // Новый чек приходит в копию подпиской — отчёт видит его сразу.
  store.set("tenants/C2/sessions/p5", { status: "closed", tableId: "t2", closedAt: new TS(Date.now() - 10000), orderItems: [{ name: "Чай", price: 100, qty: 1 }], paymentCash: 100 });
  assert.match((await ask("💰 Выручка сегодня")).text, /Выручка сегодня \(с 6:00\): 3\s800 ₽/);
  assert.equal(closedReads, before);
  // Возврат вчерашнего чека — копия обновилась, без перечитывания дня.
  store.set("tenants/C2/sessions/w1", { ...store.get("tenants/C2/sessions/w1"), refunded: true, refundedAt: new TS(Date.now()) });
  fire(); await tick();
  assert.match(await more("yesterday"), /Выручка: 0 ₽/);
  store.set("tenants/C2/sessions/w1", { ...store.get("tenants/C2/sessions/w1"), refunded: false, refundedAt: null });
  fire(); await tick(); await tick();
  assert.match(await more("yesterday"), /Выручка: 300 ₽/, "отмена возврата — тоже");
  store.delete("tenants/C2/sessions/p5");
  // Прошедшие сутки — в файле на сервере, без имён, телефонов и адресов.
  await new Promise((r) => setTimeout(r, 1200));
  const saved = require("fs").readFileSync(require("path").join(cacheDir, "C2.json"), "utf8");
  assert.ok(JSON.parse(saved).days.length >= 13 && /"w0"/.test(saved), "прошедшие сутки — в файле");
  assert.ok(!/Иван|79001112233|Ленина/.test(saved), "в копии нет данных гостей");
  text = await more("yesterday");
  assert.match(text, /Арбат — итоги/);
  assert.match(text, /Выручка: 300 ₽/);

  // Сигналы и смены точки — владельцу сети, с названием точки
  sent.length = 0;
  store.set("tenants/C2/employees/e7", { name: "Ольга", position: "bartender" });
  store.set("tenants/C2/employees/e8", { name: "Игорь", position: "universal" });
  await new Promise((r) => setTimeout(r, 5));
  store.set("tenants/C2/auditLog/v1", { action: "order_item_voided", tableName: "Стол 1", amount: 300, employeeName: "Ольга",
    details: { item: "Суп", qty: 1, reason: "гость передумал" }, createdAt: new TS(Date.now()) });
  store.set("tenants/C2/staffShifts/w1", { employeeId: "e7", employeeName: "Ольга", status: "open", startedAt: new TS(Date.now() + 1000) });
  store.set("tenants/C2/staffShifts/w0", { employeeId: "e8", employeeName: "Игорь", status: "open", startedAt: new TS(Date.now() - 18 * H) });
  fire(); await tick(); await tick();
  assert.ok(toOwner().some((m) => /^⚠️ Арбат\. Стол 1: отменена позиция «Суп» ×1 на 300 ₽\. Причина: гость передумал — бармен$/.test(m.body.text)), "сигнал точки сети");
  assert.ok(toOwner().some((m) => /^🟢 Арбат — начал смену: бармен в \d\d:\d\d$/.test(m.body.text)), "смена точки сети");
  assert.ok(toOwner().every((m) => !/Игорь|Ольга/.test(m.body.text)), "старая смена — без сигнала, имён нет");
  assert.ok(store.get("telegramBots/C1").auditCursors.C2, "курсор журнала — свой у точки");
  text = await more("voids");
  assert.match(text, /Отменено позиций, которые уже готовили: 1 на 300 ₽/);
  assert.match(text, /Причины: гость передумал ×1/);
  body = await ask("👥 Текущая смена");
  assert.match(body.text, /Касса открыта с \d\d:\d\d/);
  assert.match(body.text, /• универсал, с [\d. :]+ ⚠️ не закрыта/);
  assert.match(body.text, /• бармен, с \d\d:\d\d\n/);
  assert.match(body.text, /больше 16 часов/);
  assert.ok(!/Игорь|Ольга/.test(body.text));

  // Обратно на «Все точки»: разделы по точкам
  await hookC({ callback_query: { id: "p2", from: { id: 701 }, data: "p:all", message: { chat: { id: 701 }, message_id: 302 } } });
  await tick();
  body = await ask("💵 Касса сейчас");
  assert.match(body.text, /🏢 Сеть «Ромашка» — все точки/);
  assert.match(body.text, /📍 Арбат\n💵 Касса, смена с/);
  assert.match(body.text, /📍 Центр\n💵 Касса, смена с \d\d\.\d\d/);
  assert.match(body.text, /⚠️ Смена кассы не закрыта/);
  text = await more("top");
  assert.match(text, /Сеть «Ромашка» — топ продаж сегодня:\n1\. Чай — 5 шт · 2\s500 ₽\n2\. Пирог — 1 шт · 1\s200 ₽/);
  text = await more("week");
  assert.match(text, /Итого: 5\s000 ₽ · 4 чек\./);
  assert.match(text, /📍 Арбат: 4\s000 ₽\n📍 Центр: 1\s000 ₽/);
  text = await more("yesterday");
  assert.match(text, /Сеть «Ромашка» — итоги/);
  assert.match(text, /📍 Арбат: 300 ₽ · 1 чек\./);
  assert.match(text, /📍 Центр: продаж не было/);
  assert.match(text, /• Центр: смена кассы не закрыта/);

  // Группы: общая группа сети и своя группа точки
  res = mkRes();
  await tg.handleLinkCode(mkReq({ tenantId: "C1", kind: "staff" }), res);
  sent.length = 0;
  await hookC({ message: { chat: { id: -951, type: "supergroup", title: "Кухня Центр" }, from: { id: 701 }, text: `/start ${res.body.link.split("startgroup=")[1]}` } });
  assert.ok(sent.some((m) => m.body.chat_id === -951 && /Центр.*\n*.*точек сети, у которых нет своей группы/s.test(m.body.text)));
  await tick(); await tick(); await tick();
  assert.equal(store.get("telegramBots/C1").staffChat.id, -951);
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "C2" }), res);
  assert.equal(res.body.staffChat, "Кухня Центр");
  assert.equal(res.body.staffChatShared, true, "у Арбата своей группы нет — общая");
  sent.length = 0;
  store.set("tenants/C2/sessions/d1", { tableId: "takeaway", status: "active", orderType: "delivery", deliveryStatus: "new",
    orderItems: [{ name: "Суп", price: 300, qty: 1 }], startTime: new Date() });
  fire(); await tick(); await tick();
  const cardD1 = sent.find((m) => m.method === "sendMessage" && m.body.chat_id === -951);
  assert.ok(cardD1 && /^📍 Арбат\n🛵 Доставка №/.test(cardD1.body.text), "заказ точки без группы — в общую, с названием точки");
  assert.equal(store.get("telegramBots/C1/cards/d1").tenantId, "C2");
  res = mkRes();
  await tg.handleLinkCode(mkReq({ tenantId: "C2", kind: "staff" }), res);
  await hookC({ message: { chat: { id: -952, type: "supergroup", title: "Кухня Арбат" }, from: { id: 701 }, text: `/start ${res.body.link.split("startgroup=")[1]}` } });
  await tick(); await tick(); await tick();
  assert.equal(store.get("telegramBots/C1").staffChats.C2.id, -952);
  assert.equal(store.get("telegramBots/C1").staffChat.id, -951, "общая группа на месте");
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "C2" }), res);
  assert.equal(res.body.staffChat, "Кухня Арбат");
  assert.equal(res.body.staffChatShared, false);
  sent.length = 0;
  store.set("tenants/C2/sessions/d2", { tableId: "takeaway", status: "active", orderType: "takeaway", deliveryStatus: "new",
    orderItems: [{ name: "Чай", price: 200, qty: 1 }], startTime: new Date() });
  store.set("tenants/C1/sessions/d3", { tableId: "takeaway", status: "active", orderType: "takeaway", deliveryStatus: "new",
    orderItems: [{ name: "Чай", price: 200, qty: 1 }], startTime: new Date() });
  fire(); await tick(); await tick();
  const cardsTo = (chat) => sent.filter((m) => m.method === "sendMessage" && m.body.chat_id === chat).map((m) => m.body.text);
  assert.ok(cardsTo(-952).some((t) => /^📍 Арбат\n🥡 С собой/.test(t)), "заказ Арбата — в группу Арбата");
  assert.ok(cardsTo(-951).some((t) => /^📍 Центр\n🥡 С собой/.test(t)), "заказ Центра — в группу Центра");
  assert.ok(!cardsTo(-951).some((t) => /Арбат/.test(t)), "в группу Центра заказы Арбата больше не идут");
  // Повар нажимает кнопку в группе Арбата — статус меняется в Арбате
  await hookC({ callback_query: { id: "d2a", from: { id: 702 }, data: "s:d2:accepted", message: { chat: { id: -952 }, message_id: 1 } } });
  assert.equal(store.get("tenants/C2/sessions/d2").deliveryStatus, "accepted");
  assert.equal(store.get("tenants/C1/sessions/d3").deliveryStatus, "new");

  // Сеть, где раньше у точек были свои боты: точка со своим ботом остаётся
  // за ним, точка без бота — за ботом с наименьшим id. Дублей нет.
  store.set("tenants/L1", { name: "Лес 1", timezone: TZ });
  store.set("tenants/L2", { name: "Лес 2", timezone: TZ });
  await tg.handleSetup(mkReq({ tenantId: "L1", token: "444444:" + "d".repeat(35) }), mkRes());
  await tg.handleSetup(mkReq({ tenantId: "L2", token: "555555:" + "e".repeat(35) }), mkRes());
  store.set("chains/ch2", { name: "Лес" });
  for (const t of ["L1", "L2"]) store.set(`tenants/${t}`, { ...store.get(`tenants/${t}`), chainId: "ch2" });
  store.set("tenants/L3", { name: "Лес 3", chainId: "ch2", timezone: TZ });
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L1" }), res);
  assert.deepEqual(res.body.chain, { name: "Лес", points: ["Лес 1", "Лес 3"], home: "Лес 1", separate: ["Лес 2"] });
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L2" }), res);
  assert.equal(res.body.chain, null, "у точки со своим ботом — свой бот, как раньше");
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L3" }), res);
  assert.equal(res.body.chain.home, "Лес 1");
  // Кабинет точки со своим ботом предлагает перейти на бот сети,
  // бот сети показывает, какие точки пока со своими ботами.
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L2" }), res);
  assert.deepEqual(res.body.chainBot, { username: "bot444_bot", home: "Лес 1", name: "Лес" });
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L1" }), res);
  assert.deepEqual(res.body.chain.separate, ["Лес 2"]);
  assert.equal(res.body.chainBot, null);
  await tg.handleAccess(mkReq({ tenantId: "L1", allowed: [{ id: 801, name: "Влад", role: "owner" }] }), mkRes());
  await tg.handleAccess(mkReq({ tenantId: "L2", allowed: [{ id: 801, name: "Влад", role: "staff" }, { id: 802, name: "Повар", role: "staff" }] }), mkRes());
  await assert.rejects(tg.handleJoinChain(mkReq({ tenantId: "L1" }), mkRes()), /и есть бот сети/);
  await assert.rejects(tg.handleJoinChain(mkReq({ tenantId: "L3" }), mkRes()), /уже на боте сети/);
  res = mkRes();
  await tg.handleJoinChain(mkReq({ tenantId: "L2" }), res);
  assert.deepEqual(res.body, { ok: true, username: "bot444_bot" });
  await tick(); await tick();
  assert.ok(!store.has("telegramBots/L2"), "бот точки отключён");
  assert.ok(sent.some((m) => m.token.startsWith("555") && m.method === "deleteWebhook"));
  assert.deepEqual(store.get("telegramBots/L1").allowed, [{ id: 801, name: "Влад", role: "owner" }, { id: 802, name: "Повар", role: "staff" }],
    "список доступа объединён, права бота сети не понижены");
  res = mkRes();
  await tg.handleStatus(mkReq({ tenantId: "L2" }), res);
  assert.equal(res.body.username, "bot444_bot");
  assert.deepEqual(res.body.chain, { name: "Лес", points: ["Лес 1", "Лес 2", "Лес 3"], home: "Лес 1", separate: [] });
  // Бот сети уже показывает точку — без ожидания пересчёта точек
  sent.length = 0;
  await tg.handleHook(mkReq({ message: { chat: { id: 801, type: "private" }, from: { id: 801 }, text: "/start" } },
    { "x-telegram-bot-api-secret-token": store.get("telegramBots/L1").hookSecret }), mkRes(), "L1");
  assert.ok(sent.some((m) => m.body.chat_id === 801 && /сеть «Лес» \(3 точки\)/.test(m.body.text)));

  // Итоги сети в 10:00 — чистая функция
  const cs = tgmod.buildChainSummary({ chainName: "Ромашка", label: "за 09.10", points: [
    { name: "Арбат", sessions: [{ status: "closed", orderItems: [{ name: "Чай", price: 100, qty: 2 }], paymentCash: 200 }], audit: [] },
    { name: "Центр", sessions: [], audit: [{ action: "order_item_voided", amount: 50 }], notes: ["смена кассы не закрыта с 02.10 12:57"] },
  ] });
  assert.match(cs, /^📊 Сеть «Ромашка» — итоги за 09\.10/);
  assert.match(cs, /Выручка: 200 ₽\nЧеков: 1 · средний чек 200 ₽\nОплаты: наличные 200 ₽/);
  assert.match(cs, /📍 Арбат: 200 ₽ · 1 чек\. · средний 200 ₽\n📍 Центр: продаж не было/);
  assert.match(cs, /• Центр: удалено позиций: 1 на 50 ₽\n• Центр: смена кассы не закрыта с 02\.10 12:57/);
  assert.equal(tgmod.staleCashText(new Date(Date.now() - 2 * H), TZ), null);
  assert.match(tgmod.staleCashText(new Date(Date.now() - 30 * H), TZ), /^смена кассы не закрыта с \d\d\.\d\d \d\d:\d\d/);
  assert.equal(tgmod.menuKeyboard().keyboard[0][0].text, "💰 Выручка сегодня", "у одиночного заведения — без кнопки точки");
  assert.equal(tgmod.menuKeyboard("Арбат").keyboard[0][0].text, "📍 Арбат");

  // Перезапуск сервера: прошедшие сутки берутся из файла, не из Firestore.
  const tg2 = tgmod.createTelegram(deps);
  tg2.start();
  await tick(); await tick(); await tick();
  before = closedReads;
  sent.length = 0;
  await tg2.handleHook(mkReq({ callback_query: { id: "rw", from: { id: 701 }, data: "r:week", message: { chat: { id: 701 }, message_id: 1 } } },
    { "x-telegram-bot-api-secret-token": store.get("telegramBots/C1").hookSecret }), mkRes(), "C1");
  const weekAfter = sent.filter((m) => m.method === "sendMessage" && m.body.chat_id === 701).pop().body.text;
  assert.match(weekAfter, /Итого: 5\s000 ₽ · 4 чек\./);
  assert.equal(closedReads, before, "после перезапуска неделя — из файла на сервере");
  require("fs").rmSync(cacheDir, { recursive: true, force: true });
  console.log("SIM OK");
  process.exit(0);
})().catch((e) => { console.error("SIM FAIL", e); process.exit(1); });
