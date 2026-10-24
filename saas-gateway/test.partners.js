"use strict";
// Партнёрская программа (partners.js): приглашения с согласием, закрепление
// клиента, начисления с оплат после налога и комиссии, выплаты, бот.

const assert = require("assert");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { createPartners, computeAccrual, maskEmail, cleanCode, translit } = require("./partners");
const { HttpError } = require("./test-helpers");

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function harness({ existingEmails = [] } = {}) {
  const store = createLocalDb({ admin });
  const users = new Map(); // email → uid
  for (const e of existingEmails) users.set(e, `u_${e}`);
  const mails = [];
  const tg = [];
  const sent = {};
  let clock = Date.UTC(2026, 9, 24, 12);
  const key = crypto.randomBytes(32);
  const created = new Map(); // uid → когда создан аккаунт (по умолчанию — «сейчас»)
  const auth = {
    getUserByEmail: async (email) => {
      if (!users.has(email)) throw Object.assign(new Error("нет"), { code: "auth/user-not-found" });
      return { uid: users.get(email), email };
    },
    createUser: async ({ email }) => { users.set(email, `u_${email}`); return { uid: `u_${email}` }; },
    getUser: async (uid) => ({ uid, metadata: { creationTime: new Date(created.get(uid) ?? clock).toUTCString() } }),
    generatePasswordResetLink: async (email) => `https://reset/${email}`,
  };
  const partners = createPartners({
    db: () => null, store: () => store, admin, auth: () => auth,
    verifyAuth: async (req) => ({ uid: req.uid, email: req.email || "" }),
    parseJsonBody: async (req) => req.body || {},
    sendJson: (res, code, obj) => { sent.code = code; sent.body = obj; },
    HttpError,
    requireSuperAdmin: async (d) => { if (!d || d.uid !== "sa") throw new HttpError(403, "только супер-админ"); },
    mailer: () => ({ send: async (m) => { mails.push(m); } }),
    siteUrl: "https://zalpos.ru/", publicUrl: "https://pii.zalpos.ru/saas",
    secretKey: () => key,
    encrypt: (k, t) => Buffer.from(t).toString("base64"), decrypt: (k, t) => Buffer.from(t, "base64").toString(),
    fetchImpl: async (url, opts) => {
      const method = url.split("/").pop();
      tg.push({ method, body: JSON.parse(opts.body || "{}") });
      const result = { getMe: { id: 1, username: "zalpos_partners_bot" }, sendMessage: { message_id: 1 } }[method] ?? true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    },
    now: () => clock,
  });
  const call = async (fn, req) => { await fn(req, {}); return sent.body; };
  const addManager = async (body) => call(partners.handleAdminSave, { uid: "sa", body: { email: "anna@zalpos.ru", name: "Анна Петрова", percent: 20, ...body } });
  return { partners, store, mails, tg, sent, call, addManager, users, created, tick: (ms) => { clock += ms; }, now: () => clock };
}

test("расчёт: процент от суммы после налога и комиссии; комиссия — из уведомления или из настроек", () => {
  assert.deepStrictEqual(computeAccrual({ gross: 14900, fee: null, taxPct: 6, feePct: 3.9, percent: 20 }),
    { gross: 14900, fee: 581.1, tax: 894, base: 13424.9, percent: 20, amount: 2684.98 });
  assert.strictEqual(computeAccrual({ gross: 1000, fee: 35, taxPct: 6, feePct: 3.9, percent: 10 }).amount, 90.5);
  assert.strictEqual(computeAccrual({ gross: 100, fee: 200, taxPct: 6, feePct: 0, percent: 50 }).amount, 0, "база не уходит в минус");
  assert.strictEqual(maskEmail("Anna@Mail.ru"), "an***@mail.ru");
  assert.strictEqual(cleanCode(translit("Анна Петрова")), "ANNAPETROVA");
});

test("менеджер: добавление, письмо «задайте пароль», код ссылки, правка; только супер-админ", async () => {
  const h = harness();
  const r = await h.addManager({});
  assert.ok(r.ok && r.code === "ANNAPETROVA" && r.mailed);
  assert.match(h.mails[0].subject, /Кабинет менеджера/);
  assert.match(h.mails[0].text, /https:\/\/reset\/anna@zalpos\.ru/);
  await assert.rejects(h.partners.handleAdminSave({ uid: "x", body: { email: "b@b.ru", percent: 10 } }, {}), /супер-админ/);
  await assert.rejects(h.addManager({}), /уже есть/);
  await assert.rejects(h.partners.handleAdminSave({ uid: "sa", body: { email: "c@c.ru", percent: 150 } }, {}), /от 0 до 100/);
  const me = await h.call(h.partners.handleMe, { uid: "u_anna@zalpos.ru" });
  assert.strictEqual(me.partner.link, "https://zalpos.ru/?p=ANNAPETROVA");
  assert.strictEqual(me.partner.percent, 20);
  await h.call(h.partners.handleAdminSave, { uid: "sa", body: { id: me.partner.id, name: "Анна", percent: 25, months: 12, code: "anna1" } });
  const me2 = await h.call(h.partners.handleMe, { uid: "u_anna@zalpos.ru" });
  assert.strictEqual(me2.partner.percent, 25);
  assert.strictEqual(me2.partner.code, "ANNA1");
  assert.strictEqual((await h.call(h.partners.handleMe, { uid: "stranger" })).partner, null);
});

test("приглашение: только с согласием и после правил; письмо — кто приглашает и отказ; действующего клиента нельзя", async () => {
  const h = harness({ existingEmails: ["old@cafe.ru"] });
  await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "new@cafe.ru", consent: true } }, {}), /правила/);
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "new@cafe.ru" } }, {}), /согласился/);
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "old@cafe.ru", consent: true } }, {}), /уже есть аккаунт/);
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "anna@zalpos.ru", consent: true } }, {}), /Себя/);
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "New@Cafe.ru", venueName: "Кафе Лето", consent: true } });
  const letter = h.mails[h.mails.length - 1];
  assert.strictEqual(letter.to, "new@cafe.ru");
  assert.match(letter.text, /Анна Петрова, менеджер ZalPOS/);
  assert.match(letter.text, /согласились получить приглашение/);
  const invite = letter.text.match(/invite=([a-f0-9]{32})/)[1];
  const optOut = letter.text.match(/(https:\/\/pii\.zalpos\.ru\/saas\/partnerOptOut\?i=[a-f0-9]+&k=[a-f0-9]+)/)[1];
  // Журнал согласия.
  const rec = (await h.store.collection("partnerInvites").doc(invite).get()).data();
  assert.ok(rec.consent === true && rec.consentAt && /согласился/.test(rec.consentText));
  // Повтор в тот же день — нет; другой менеджер — нет.
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "new@cafe.ru", consent: true } }, {}), /уже отправлено сегодня/);
  await h.addManager({ email: "ivan@zalpos.ru", name: "Иван" });
  await h.call(h.partners.handleAcceptTerms, { uid: "u_ivan@zalpos.ru", body: { accept: true } });
  await assert.rejects(h.partners.handleInvite({ uid: "u_ivan@zalpos.ru", body: { email: "new@cafe.ru", consent: true } }, {}), /другой менеджер/);
  // Подстановка почты при регистрации.
  const info = await h.call(h.partners.handleInviteInfo, { body: { invite } });
  assert.ok(info.ok && info.email === "new@cafe.ru" && info.code === "ANNAPETROVA");
  // Отказ от писем: дальше на эту почту не пишем.
  let html = "";
  const u = new URL(optOut);
  await h.partners.handleOptOut({ url: `${u.pathname}${u.search}` }, { writeHead: () => {}, end: (b) => { html = b; } });
  assert.match(html, /больше приходить не будут/);
  h.tick(25 * 3600 * 1000);
  await assert.rejects(h.partners.handleInvite({ ...anna, body: { email: "new@cafe.ru", consent: true } }, {}), /отказался/);
  // Поддельная подпись — ничего не меняет.
  await h.partners.handleOptOut({ url: `/partnerOptOut?i=${"a".repeat(32)}&k=${"0".repeat(32)}` }, { writeHead: () => {}, end: (b) => { html = b; } });
  assert.match(html, /неверна/);
});

test("закрепление: по приглашению (та же почта, 30 дней) или по ссылке; первый — навсегда; не первый объект владельца — нет", async () => {
  const h = harness();
  await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "a@cafe.ru", consent: true } });
  // По приглашению.
  let r = await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  assert.deepStrictEqual(r, { partnerId: r.partnerId, source: "invite" });
  // Повторно — не перезакрепляется (даже по другой ссылке).
  await h.addManager({ email: "ivan@zalpos.ru", name: "Иван", code: "IVAN" });
  assert.strictEqual(await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", code: "IVAN" }), null);
  // По ссылке.
  r = await h.partners.attachOwner({ uid: "owner2", email: "b@cafe.ru", code: "ivan", venueName: "Бар Б" });
  assert.strictEqual(r.source, "link");
  // Владелец уже с заведениями — не закрепляем.
  assert.strictEqual(await h.partners.attachOwner({ uid: "owner3", email: "c@cafe.ru", code: "IVAN", firstVenue: false }), null);
  // Менеджер сам себе — нет.
  assert.strictEqual(await h.partners.attachOwner({ uid: "u_ivan@zalpos.ru", email: "ivan@zalpos.ru", code: "IVAN" }), null);
  // Приглашение старше 30 дней не действует.
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "late@cafe.ru", consent: true } });
  h.tick(31 * 24 * 3600 * 1000);
  assert.strictEqual(await h.partners.attachOwner({ uid: "owner4", email: "late@cafe.ru" }), null);
  // Почта в истёкших и использованных приглашениях — скрытая.
  assert.ok(await h.partners.sweepInvites() >= 1);
  const left = (await h.store.collection("partnerInvites").get()).docs.map((d) => d.data().email);
  assert.ok(left.every((e) => e.includes("***")), left.join(","));
  // Остановленный менеджер новых клиентов не получает.
  const ivan = (await h.store.collection("partners").where("code", "==", "IVAN").get()).docs[0];
  await h.call(h.partners.handleAdminSave, { uid: "sa", body: { id: ivan.id, name: "Иван", percent: 10, status: "stopped" } });
  assert.strictEqual(await h.partners.attachOwner({ uid: "owner5", email: "e@cafe.ru", code: "IVAN" }), null);
});

test("начисления: с каждой оплаты, повтор уведомления — один раз, тестовая — нет; срок; выплата и возврат", async () => {
  const h = harness();
  await h.addManager({ months: 12 });
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleAdminSettings, { uid: "sa", body: { taxPct: 6, feePct: 3.9 } });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", code: "ANNAPETROVA", venueName: "Кафе А" });
  let a = await h.partners.onPayment({ invId: 101, ownerUid: "owner1", amount: 14900, fee: NaN, purpose: "subscription", venueName: "Кафе А", planName: "Бизнес" });
  assert.strictEqual(a.amount, 2684.98);
  assert.strictEqual(await h.partners.onPayment({ invId: 101, ownerUid: "owner1", amount: 14900 }), null, "повтор уведомления");
  assert.strictEqual(await h.partners.onPayment({ invId: 102, ownerUid: "owner1", amount: 14900, test: true }), null, "тестовая");
  assert.strictEqual(await h.partners.onPayment({ invId: 103, ownerUid: "чужой", amount: 14900 }), null, "не закреплён");
  a = await h.partners.onPayment({ invId: 104, ownerUid: "owner1", amount: 1000, fee: 35, purpose: "renewal" });
  assert.strictEqual(a.amount, 181); // (1000 − 35 − 60) × 20%
  let d = await h.call(h.partners.handleDashboard, anna);
  assert.strictEqual(d.summary.unpaid, 2865.98);
  assert.strictEqual(d.clients[0].venueName, "Кафе А");
  assert.strictEqual(d.clients[0].planName, "Бизнес");
  assert.ok(!JSON.stringify(d.clients).includes("a@cafe.ru"), "почту владельца менеджер не видит");
  // Возврат денег клиенту — начисление снимается.
  const refund = d.accruals.find((x) => x.amount === 181);
  await h.call(h.partners.handleAdminReverse, { uid: "sa", body: { accrualId: refund.id } });
  d = await h.call(h.partners.handleDashboard, anna);
  assert.strictEqual(d.summary.unpaid, 2684.98);
  // Выплата: сумма должна совпасть с тем, что видит админ.
  const pid = d.partner.id;
  await assert.rejects(h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, expected: 1 } }, {}), /изменилась/);
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, expected: 2684.98, note: "перевод на карту" } });
  d = await h.call(h.partners.handleDashboard, anna);
  assert.deepStrictEqual([d.summary.unpaid, d.summary.paid], [0, 2684.98]);
  assert.strictEqual(d.payouts[0].note, "перевод на карту");
  await assert.rejects(h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid } }, {}), /Невыплаченных/);
  // Через 12 месяцев (срок менеджера) начисления прекращаются.
  h.tick(13 * 31 * 24 * 3600 * 1000);
  assert.strictEqual(await h.partners.onPayment({ invId: 105, ownerUid: "owner1", amount: 14900 }), null);
  // Чужому менеджеру и не менеджеру кабинет закрыт.
  await assert.rejects(h.partners.handleDashboard({ uid: "stranger" }, {}), /не подключены/);
});

test("бот: подключение по ссылке из кабинета, /income, /clients, /invite с подтверждением согласия, уведомление об оплате", async () => {
  const h = harness();
  await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleAdminBot, { uid: "sa", body: { token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll" } });
  assert.ok(h.tg.some((c) => c.method === "setWebhook" && /\/tgHook\/_partners$/.test(c.body.url)));
  const { url } = await h.call(h.partners.handleTgLink, anna);
  const code = url.match(/start=pl_([a-f0-9]+)/)[1];
  const chat = { id: 777, type: "private" };
  const msg = (text) => h.partners._onMessage({ chat, text });
  await h.partners._onMessage({ chat: { id: 555, type: "private" }, text: "/income" });
  assert.match(h.tg[h.tg.length - 1].body.text, /для менеджеров/);
  await msg(`/start pl_${code}`);
  assert.match(h.tg[h.tg.length - 1].body.text, /Telegram подключён/);
  await msg("/invite new@cafe.ru Кафе Лето");
  const ask = h.tg[h.tg.length - 1].body;
  assert.match(ask.text, /согласился/);
  assert.strictEqual(ask.reply_markup.inline_keyboard[0][0].callback_data, "pinv_yes");
  await h.partners._onCallback({ id: "q", data: "pinv_yes", message: { chat } });
  assert.match(h.tg[h.tg.length - 1].body.text, /Приглашение отправлено/);
  assert.strictEqual(h.mails[h.mails.length - 1].to, "new@cafe.ru");
  await h.partners.attachOwner({ uid: "owner1", email: "new@cafe.ru", venueName: "Кафе Лето" });
  assert.match(h.tg[h.tg.length - 1].body.text, /Новый клиент: «Кафе Лето»/);
  await h.partners.onPayment({ invId: 9, ownerUid: "owner1", amount: 14900, venueName: "Кафе Лето" });
  await new Promise((r) => setImmediate(r));
  assert.match(h.tg[h.tg.length - 1].body.text, /Оплата от «Кафе Лето»: 14\s900 ₽/);
  await msg("/income");
  assert.match(h.tg[h.tg.length - 1].body.text, /К выплате: <b>2\s684,98 ₽<\/b>/);
  await msg("/clients");
  assert.match(h.tg[h.tg.length - 1].body.text, /Кафе Лето/);
  await msg("/link");
  assert.match(h.tg[h.tg.length - 1].body.text, /\?p=ANNAPETROVA/);
});

test("логика: давний аккаунт не закрепляется, двойная «Выплачено» — одна выплата, удалённого менеджера можно вернуть", async () => {
  const h = harness();
  const { id: pid, code } = await h.addManager({});
  await h.call(h.partners.handleAcceptTerms, { uid: "u_anna@zalpos.ru", body: { accept: true } });
  // Аккаунт создан 40 дней назад, точек не было — это не новый клиент.
  h.created.set("oldOwner", h.now() - 40 * 24 * 3600 * 1000);
  assert.strictEqual(await h.partners.attachOwner({ uid: "oldOwner", email: "old@cafe.ru", code, venueName: "Старое" }), null);
  assert.ok(await h.partners.attachOwner({ uid: "newOwner", email: "new@cafe.ru", code, venueName: "Новое" }));
  await h.partners.onPayment({ invId: "p1", ownerUid: "newOwner", amount: 1000 });
  await h.partners.onPayment({ invId: "p2", ownerUid: "newOwner", amount: 1000 });
  const both = await Promise.allSettled([
    h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid } }, {}),
    h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid } }, {}),
  ]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"], "вторая выплата — «нет невыплаченных»");
  assert.strictEqual((await h.store.collection("partnerPayouts").get()).size, 1);
  // Удалили и добавили снова той же почтой — тот же менеджер, код и история.
  await h.call(h.partners.handleAdminSave, { uid: "sa", body: { id: pid, name: "Анна", percent: 20, status: "removed" } });
  const back = await h.addManager({ percent: 25 });
  assert.strictEqual(back.id, pid);
  assert.strictEqual(back.code, code);
  assert.strictEqual(back.restored, true);
  const me = await h.call(h.partners.handleMe, { uid: "u_anna@zalpos.ru" });
  assert.strictEqual(me.partner.status, "active");
  assert.strictEqual(me.partner.percent, 25);
  assert.strictEqual(me.summary.clients, 1);
});

test("договор: услуги (не агентский), реквизиты платформы и менеджера, налоги по статусу, акт", async () => {
  const { contractBlocks, buildPartnerContract, shortName } = require("./partner-contract");
  const text = (st, extra = {}) => contractBlocks({
    platform: { fullName: "Иванов Иван Иванович", ogrnip: "321000000000001", inn: "770000000001", address: "г. Москва", email: "info@zalpos.ru", taxRegime: "npd" },
    partner: { name: "Петрова Анна Сергеевна", email: "anna@x.ru", percent: 20, months: 0, taxStatus: st, ...extra },
    settings: { taxPct: 6, feePct: 3.9 }, number: "ANNA-2026",
  }).map((b) => (typeof b === "string" ? b : b.h || b.c || b.b || b.r || b.l || JSON.stringify(b.table || ""))).join("\n");
  const npd = text("npd");
  assert.match(npd, /возмездного оказания услуг по привлечению клиентов/);
  assert.ok(!/агентск/i.test(npd), "не агентский договор");
  assert.match(npd, /^ДОГОВОР № ANNA-2026/);
  assert.match(npd, /Индивидуальный предприниматель Иванов Иван Иванович, ОГРНИП 321000000000001, ИНН 770000000001, применяющий/);
  assert.match(npd, /20 \(_+\) процентов от каждого платежа/);
  assert.match(npd, /\(на дату заключения Договора — 6%\)/);
  assert.match(npd, /чек в приложении «Мой налог»/);
  assert.match(npd, /не подчиняется правилам внутреннего трудового распорядка/);
  assert.match(npd, /ст\. 18 Федерального закона от 13\.03\.2006 № 38-ФЗ/);
  assert.match(npd, /в течение всего срока действия Договора/);
  assert.match(npd, /ФОРМА АКТА/);
  assert.match(text("person"), /налоговым агентом Исполнителя/);
  assert.match(text("ip"), /ИП Петрова Анна Сергеевна/);
  assert.match(text("npd", { months: 12 }), /в течение 12 \(_+\) месяцев/);
  assert.strictEqual(shortName("Иванов Иван Иванович"), "Иванов И. И.");
  const file = buildPartnerContract({ platform: {}, partner: { name: "А", percent: 10 } });
  assert.strictEqual(file.slice(0, 2).toString(), "PK", "docx — это zip");
});

test("новая ссылка: код меняется, старые ссылки закрепляют, чужой и остановленный менеджер — нет", async () => {
  const h = harness();
  const { id: pid, code: oldCode } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  const r = await h.call(h.partners.handleNewLink, anna);
  assert.ok(r.ok && r.code !== oldCode && r.code.startsWith("ANNAPETROV"));
  assert.strictEqual(r.link, `https://zalpos.ru/?p=${r.code}`);
  // Повтор сразу — отказ; через минуту — ещё один код, все прежние работают.
  await assert.rejects(h.partners.handleNewLink(anna, {}), (e) => e.status === 429);
  h.tick(61 * 1000);
  const r2 = await h.call(h.partners.handleNewLink, anna);
  assert.ok(r2.code !== r.code);
  for (const [i, c] of [oldCode, r.code, r2.code].entries()) {
    const a = await h.partners.attachOwner({ uid: `o${i}`, email: `o${i}@cafe.ru`, code: c, venueName: `Кафе ${i}` });
    assert.deepStrictEqual(a, { partnerId: pid, source: "link" }, c);
  }
  // Прежний код нельзя отдать другому менеджеру.
  await assert.rejects(h.call(h.partners.handleAdminSave, { uid: "sa", body: { email: "ivan@zalpos.ru", name: "Иван", percent: 10 } })
    .then(() => h.call(h.partners.handleAdminSave, { uid: "sa", body: { id: h.sent.body.id, name: "Иван", percent: 10, code: oldCode } })), (e) => e.status === 409);
  // Остановленный менеджер не обновляет ссылку и не закрепляет клиентов.
  await h.call(h.partners.handleAdminSave, { uid: "sa", body: { id: pid, name: "Анна Петрова", percent: 20, status: "stopped" } });
  h.tick(61 * 1000);
  await assert.rejects(h.partners.handleNewLink(anna, {}), (e) => e.status === 403);
  assert.strictEqual(await h.partners.attachOwner({ uid: "o9", email: "o9@cafe.ru", code: oldCode, venueName: "Кафе 9" }), null);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  console.log(`partners: ${passed} из ${passed + failed} проверок`);
  if (failed) process.exit(1);
})();
