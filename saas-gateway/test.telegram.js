"use strict";
// Сценарии Telegram-ботов заведений на имитации Firestore и Telegram:
// изоляция заведений, привязка чатов, карточки доставки без ПДн, кнопки
// статусов, отчёты, сигналы, смены, страница адреса.
process.env.TELEGRAM_SECRET_KEY = "sim-key";
const assert = require("assert");
const { Readable } = require("stream");
const tgmod = require("./telegram.js");

// ---- мини-Firestore в памяти
const store = new Map(); // path -> data
class TS { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } toDate() { return new Date(this.ms); } }
const val = (v) => (v instanceof TS ? v.ms : v instanceof Date ? v.getTime() : v);
const listeners = [];
function docRef(p) {
  return {
    id: p.split("/").pop(), path: p,
    async get() { const d = store.get(p); return { exists: !!d, id: p.split("/").pop(), ref: docRef(p), data: () => (d ? { ...d } : undefined) }; },
    async set(d) { store.set(p, { ...d }); fire(); },
    async update(d) { if (!store.has(p)) throw new Error("no doc " + p); store.set(p, { ...store.get(p), ...d }); fire(); },
    async delete() { store.delete(p); fire(); },
    collection: (c) => colRef(`${p}/${c}`),
  };
}
function colRef(p, filters = []) {
  const q = {
    doc: (id) => docRef(`${p}/${id || Math.random().toString(36).slice(2)}`),
    where: (f, op, v) => colRef(p, [...filters, [f, op, v]]),
    orderBy: () => q, limit: () => q,
    async get() {
      const docs = [...store.entries()].filter(([k]) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"))
        .filter(([, d]) => filters.every(([f, op, v]) => {
          const a = val(d[f]); const b = val(v);
          return op === "==" ? a === b : op === ">=" ? a >= b : op === "<" ? a < b : op === ">" ? a > b : true;
        }))
        .map(([k, d]) => ({ id: k.split("/").pop(), ref: docRef(k), data: () => ({ ...d }) }));
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
  const snap = await l.q.get();
  const now = new Map(snap.docs.map((d) => [d.id, JSON.stringify(d.data())]));
  const changes = [];
  for (const d of snap.docs) {
    if (!l.seen.has(d.id)) changes.push({ type: "added", doc: d });
    else if (l.seen.get(d.id) !== now.get(d.id)) changes.push({ type: "modified", doc: d });
  }
  for (const id of l.seen.keys()) if (!now.has(id)) changes.push({ type: "removed", doc: { id, data: () => ({}) } });
  l.seen = now;
  if (changes.length) l.cb({ docChanges: () => changes, docs: snap.docs });
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
  if (method === "getMe") return { json: async () => ({ ok: true, result: { id: token.startsWith("111") ? 111 : 222, username: token.startsWith("111") ? "venue_a_bot" : "venue_b_bot" } }) };
  return { json: async () => ({ ok: true, result: { message_id: ++msgId } }) };
};

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const mkReq = (body, headers = {}, url = "/") => { const r = Readable.from([Buffer.from(JSON.stringify(body))]); r.headers = { authorization: "Bearer x", ...headers }; r.url = url; return r; };
const mkRes = () => { const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b; } }; return r; };
const tg = tgmod.createTelegram({
  db, admin,
  verifyAuth: async () => ({ uid: "owner1" }),
  parseJsonBody: async (req) => { let s = ""; for await (const c of req) s += c; return JSON.parse(s); },
  readBody: async (req) => { let s = ""; for await (const c of req) s += c; return s; },
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  HttpError,
  requireTenantRole: async (t, uid) => { if (uid !== "owner1") throw new HttpError(403, "no"); },
  publicUrl: "https://pii.zalpos.ru/saas",
  fetchImpl,
});
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
  console.log("SIM OK");
  process.exit(0);
})().catch((e) => { console.error("SIM FAIL", e); process.exit(1); });
