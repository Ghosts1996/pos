"use strict";
// Партнёрская программа (partners.js): приглашения с согласием, закрепление
// клиента, начисления с оплат после налога и комиссии, выплаты, бот.

const assert = require("assert");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { createPartners, computeAccrual, maskEmail, cleanCode, translit, payoutCalc, innOk, cleanDetails, receiptDue, ndflDue } = require("./partners");
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
  const npd = { status: true, down: false }; // ответ ФНС о статусе самозанятого
  const npdCalls = [];
  const auth = {
    getUserByEmail: async (email) => {
      if (!users.has(email)) throw Object.assign(new Error("нет"), { code: "auth/user-not-found" });
      return { uid: users.get(email), email };
    },
    createUser: async ({ email }) => { users.set(email, `u_${email}`); return { uid: `u_${email}` }; },
    getUser: async (uid) => ({ uid, metadata: { creationTime: new Date(created.get(uid) ?? clock).toUTCString() } }),
    generatePasswordResetLink: async (email) => `https://reset/${email}`,
  };
  const deps = {
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
      if (url.includes("statusnpd")) {
        npdCalls.push(JSON.parse(opts.body));
        if (npd.down) throw new Error("timeout");
        return { ok: true, status: 200, json: async () => ({ status: npd.status, message: npd.status ? "является плательщиком НПД" : "не является плательщиком НПД" }) };
      }
      const method = url.split("/").pop();
      tg.push({ method, body: JSON.parse(opts.body || "{}") });
      const result = { getMe: { id: 1, username: "zalpos_partners_bot" }, sendMessage: { message_id: 1 } }[method] ?? true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    },
    now: () => clock,
  };
  const partners = createPartners(deps);
  const call = async (fn, req) => { await fn(req, {}); return sent.body; };
  const hh = { partners, deps, store, mails, tg, sent, users, created, npd, npdCalls, tick: (ms) => { clock += ms; }, now: () => clock };
  hh.call = call;
  hh.addManager = (body) => call(hh.partners.handleAdminSave, { uid: "sa", body: { email: "anna@zalpos.ru", name: "Анна Петрова", percent: 20, ...body } });
  return hh;
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
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, expected: 2684.98, note: "перевод на карту", npdManual: true } });
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
    h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, npdManual: true } }, {}),
    h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, npdManual: true } }, {}),
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

test("бот: кнопки меню, приглашение в два шага, новая ссылка кнопкой", async () => {
  const h = harness();
  const { code: oldCode } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleAdminBot, { uid: "sa", body: { token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll" } });
  const { url } = await h.call(h.partners.handleTgLink, anna);
  const chat = { id: 778, type: "private" };
  const msg = (text) => h.partners._onMessage({ chat, text });
  const last = () => h.tg[h.tg.length - 1].body;
  // Не подключён — кнопка на кабинет.
  await msg("привет");
  assert.strictEqual(last().reply_markup.inline_keyboard[0][0].url, "https://zalpos.ru/#/partner");
  await msg(`/start pl_${url.match(/pl_([a-f0-9]+)/)[1]}`);
  const kb = last().reply_markup.keyboard.flat().map((b) => b.text);
  assert.deepStrictEqual(kb, ["💼 Мой доход", "👥 Клиенты", "📨 Пригласить заведение", "🔗 Моя ссылка", "✍️ Текст для клиента", "📋 Приглашения", "💸 Выплаты", "❓ Помощь"]);
  assert.ok(last().reply_markup.is_persistent);
  await msg("💼 Мой доход");
  assert.match(last().text, /Ваш доход/);
  await msg("👥 Клиенты");
  assert.match(last().text, /Пока нет закреплённых клиентов/);
  // Приглашение: кнопка → почта → подтверждение согласия.
  await msg("📨 Пригласить заведение");
  assert.match(last().text, /Напишите почту владельца/);
  await msg("не почта");
  assert.match(last().text, /Нужна почта владельца/);
  await msg("Owner@Cafe.ru Кафе Лето");
  assert.match(last().text, /owner@cafe\.ru<\/b> \(«Кафе Лето»\)/);
  await h.partners._onCallback({ id: "q", data: "pinv_yes", message: { chat, message_id: 5 } });
  assert.ok(h.tg.some((c) => c.method === "editMessageReplyMarkup" && c.body.message_id === 5));
  assert.match(last().text, /Приглашение отправлено/);
  assert.strictEqual(h.mails[h.mails.length - 1].to, "owner@cafe.ru");
  // После отправки обычный текст — не приглашение.
  await msg("owner2@cafe.ru");
  assert.match(last().text, /Бот менеджеров ZalPOS/);
  // Ссылка: «Поделиться» и «Новая ссылка» с подтверждением.
  await msg("🔗 Моя ссылка");
  assert.match(last().text, new RegExp(`\\?p=${oldCode}`));
  assert.match(last().reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/share\/url\?url=/);
  await h.partners._onCallback({ id: "q", data: "plink_new", message: { chat, message_id: 6 } });
  assert.match(last().text, /Создать новую ссылку/);
  await h.partners._onCallback({ id: "q", data: "plink_yes", message: { chat, message_id: 7 } });
  assert.match(last().text, /Новая ссылка готова/);
  assert.doesNotMatch(last().text, new RegExp(`p=${oldCode}\\b`));
  await h.partners._onCallback({ id: "q", data: "pmenu_income", message: { chat } });
  assert.match(last().text, /Ваш доход/);
  // Приглашения: статус и сколько дней осталось.
  await msg("📋 Приглашения");
  assert.match(last().text, /Приглашения<\/b> \(1\)/);
  assert.match(last().text, /ждёт регистрации, осталось 30 дн\./);
  // Текст для клиента: со ссылкой, без сравнений; другой вариант.
  await msg("✍️ Текст для клиента");
  assert.match(last().text, /zalpos\.ru\/\?p=ANNAPETROV/);
  assert.doesNotMatch(last().text, /лучш|самый|№\s?1|дешевле|чем у/i);
  assert.match(last().reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/share\/url\?url=.*&text=/);
  const first = last().text;
  await h.partners._onCallback({ id: "q", data: "ppitch_1", message: { chat } });
  assert.notStrictEqual(last().text, first);
  // Выплаты.
  await msg("💸 Выплаты");
  assert.match(last().text, /Доступно к выплате: <b>0 ₽<\/b>/);
  assert.match(last().text, /Выплат пока не было/);
});

test("бот: доход по месяцам, выплаты списком, напоминание о продлении один раз", async () => {
  const h = harness();
  const { id: pid } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleAdminBot, { uid: "sa", body: { token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll" } });
  const { url } = await h.call(h.partners.handleTgLink, anna);
  const chat = { id: 779, type: "private" };
  const msg = (text) => h.partners._onMessage({ chat, text });
  const last = () => h.tg[h.tg.length - 1].body;
  await msg(`/start pl_${url.match(/pl_([a-f0-9]+)/)[1]}`);
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "new@cafe.ru", consent: true } });
  await h.partners.attachOwner({ uid: "owner1", email: "new@cafe.ru", venueName: "Кафе Лето" });
  const day = 86400000;
  await h.partners.onPayment({ invId: 1, ownerUid: "owner1", amount: 14900, venueName: "Кафе Лето", paidUntil: h.now() + 10 * day });
  await new Promise((r) => setImmediate(r));
  await msg("💼 Мой доход");
  assert.match(last().text, /За октябрь 2026: <b>2\s684,98 ₽<\/b>/);
  assert.match(last().text, /За сентябрь 2026: 0 ₽/);
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, amount: 2684.98, note: "СБП", npdManual: true } });
  await msg("💸 Выплаты");
  assert.match(last().text, /— <b>2\s684,98 ₽<\/b> · СБП/);
  await msg("👥 Клиенты");
  assert.match(last().text, /оплачено до /);
  // Далеко до конца — не напоминаем; за 3 дня — один раз; после окончания — ещё раз нет.
  assert.strictEqual(await h.partners.remindRenewals(), 0);
  h.tick(8 * day);
  const before = h.tg.length;
  assert.strictEqual(await h.partners.remindRenewals(), 1);
  assert.match(h.tg[h.tg.length - 1].body.text, /У «Кафе Лето» подписка до/);
  assert.strictEqual(h.tg[h.tg.length - 1].body.chat_id, 779);
  assert.strictEqual(await h.partners.remindRenewals(), 0);
  assert.strictEqual(h.tg.length, before + 1);
  await msg("👥 Клиенты");
  assert.match(last().text, /⏰ подписка до/);
});

test("выплаты: расчёт НДФЛ, ИНН, реквизиты, срок чека", () => {
  assert.deepStrictEqual(payoutCalc(2684.98, "npd"), { gross: 2684.98, ndfl: 0, net: 2684.98 });
  assert.deepStrictEqual(payoutCalc(2684.98, "ip"), { gross: 2684.98, ndfl: 0, net: 2684.98 });
  // НДФЛ — в полных рублях: 2684,98 × 13% = 349,05 → 349.
  assert.deepStrictEqual(payoutCalc(2684.98, "person"), { gross: 2684.98, ndfl: 349, net: 2335.98 });
  assert.ok(innOk("500100732259"));
  assert.ok(!innOk("500100732250"));
  assert.ok(!innOk("7707083893"), "ИНН организации — не подходит");
  const d = cleanDetails({ phone: "8 (900) 123-45-67", bank: " Сбербанк ", fullName: "Петрова Анна Сергеевна", inn: "500100732259" });
  assert.deepStrictEqual(d, { method: "sbp", phone: "+79001234567", bank: "Сбербанк", fullName: "Петрова Анна Сергеевна", inn: "500100732259" });
  assert.throws(() => cleanDetails({ ...d, phone: "+1 202 555 0100" }), /Телефон/);
  assert.throws(() => cleanDetails({ ...d, fullName: "Anna" }), /ФИО/);
  assert.throws(() => cleanDetails({ ...d, inn: "123" }), /ИНН/);
  // Выплата 24.10 → чек до 9 ноября 23:59 по Москве.
  assert.strictEqual(new Date(receiptDue(Date.UTC(2026, 9, 24, 12))).toISOString(), "2026-11-09T20:59:59.000Z");
  // 31.12 23:30 по Москве — уже январь? Нет, ещё декабрь → до 9 января.
  assert.strictEqual(new Date(receiptDue(Date.UTC(2026, 11, 31, 20, 30))).toISOString(), "2027-01-09T20:59:59.000Z");
});

test("выплаты: запрос менеджера — ожидание 14 дней, минимум, заморозка, выплата по запросу, чек, отклонение, удержание за возврат", async () => {
  const admins = [];
  const h = harness();
  h.partners = createPartners({ ...h.deps, notifyAdmins: (x) => admins.push(x) });
  const { id: pid } = await h.addManager({ taxStatus: "person" });
  const anna = { uid: "u_anna@zalpos.ru" };
  const call = (fn, body = {}) => h.call(fn, { ...anna, body });
  await call(h.partners.handleAcceptTerms, { accept: true });
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "a@cafe.ru", consent: true } });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  await h.partners.onPayment({ invId: "p1", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  const day = 86400000;
  let dash = await call(h.partners.handleDashboard);
  assert.strictEqual(dash.summary.available, 0);
  assert.strictEqual(dash.summary.hold, 2684.98);
  // Рано: деньги ждут 14 дней; без реквизитов — нельзя.
  await assert.rejects(h.partners.handlePayoutRequest({ ...anna, body: {} }, {}), (e) => e.status === 412 && /реквизиты/.test(e.message));
  await call(h.partners.handlePayoutDetails, { phone: "+79001234567", bank: "Т-Банк", fullName: "Петрова Анна Сергеевна", inn: "500100732259" });
  dash = await call(h.partners.handleDashboard);
  assert.strictEqual(dash.partner.payoutDetails, "СБП +7 *** ***-45-67 · Т-Банк · Петрова А. С.");
  await assert.rejects(h.partners.handlePayoutRequest({ ...anna, body: {} }, {}), (e) => e.status === 400 && /от 1\s000 ₽/.test(e.message));
  h.tick(14 * day + 1);
  // Вторая оплата — свежая, в запрос не попадёт.
  await h.partners.onPayment({ invId: "p2", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  dash = await call(h.partners.handleDashboard);
  assert.strictEqual(dash.summary.available, 2684.98);
  assert.deepStrictEqual(dash.summary.calc, { gross: 2684.98, ndfl: 349, net: 2335.98 });
  const r = await call(h.partners.handlePayoutRequest);
  assert.deepStrictEqual([r.gross, r.ndfl, r.net], [2684.98, 349, 2335.98]);
  assert.match(admins[admins.length - 1], /Запрос выплаты.*\n.*2\s335,98 ₽.*НДФЛ 349 ₽/);
  assert.match(admins[admins.length - 1], /\+79001234567 · Т-Банк · Петрова Анна Сергеевна · ИНН 500100732259/);
  await assert.rejects(h.partners.handlePayoutRequest({ ...anna, body: {} }, {}), (e) => e.status === 409);
  // Пока запрос открыт — начисление из него не снять; админ видит полные реквизиты.
  await assert.rejects(h.partners.handleAdminReverse({ uid: "sa", body: { accrualId: "p1" } }, {}), (e) => e.status === 409);
  let list = await h.call(h.partners.handleAdminList, { uid: "sa" });
  assert.strictEqual(list.partners[0].request.fullDetails.phone, "+79001234567");
  // Отклонение возвращает сумму в «доступно».
  await h.call(h.partners.handleAdminPayoutReject, { uid: "sa", body: { requestId: r.id, reason: "проверьте банк" } });
  dash = await call(h.partners.handleDashboard);
  assert.strictEqual(dash.request, null);
  assert.strictEqual(dash.summary.available, 2684.98);
  // Запрос заново и выплата по нему: свежая вторая оплата остаётся невыплаченной.
  const r2 = await call(h.partners.handlePayoutRequest);
  h.tick(15 * day);
  dash = await call(h.partners.handleDashboard);
  assert.strictEqual(dash.summary.available, 2684.98, "вторая оплата созрела, но в запрос не входит");
  assert.strictEqual(dash.summary.requested, 2684.98);
  const paid = await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: r2.id, note: "СБП" } });
  assert.deepStrictEqual([paid.amount, paid.ndfl, paid.net], [2684.98, 349, 2335.98]);
  await assert.rejects(h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, requestId: r2.id } }, {}), (e) => e.status === 409);
  dash = await call(h.partners.handleDashboard);
  assert.deepStrictEqual([dash.summary.paid, dash.summary.unpaid, dash.summary.available], [2684.98, 2684.98, 2684.98]);
  assert.strictEqual(dash.payouts[0].net, 2335.98);
  // Клиенту вернули первую (уже выплаченную) оплату — удержание из следующей.
  await h.call(h.partners.handleAdminReverse, { uid: "sa", body: { accrualId: "p1" } });
  await assert.rejects(h.partners.handleAdminReverse({ uid: "sa", body: { accrualId: "p1" } }, {}), (e) => e.status === 409);
  dash = await call(h.partners.handleDashboard);
  assert.deepStrictEqual([dash.summary.total, dash.summary.paid, dash.summary.available], [2684.98, 2684.98, 0]);
  assert.strictEqual(dash.summary.canRequest, false);
});

test("выплаты: самозанятый — чек из «Мой налог», бот: запрос кнопкой и чек ссылкой", async () => {
  const admins = [];
  const h = harness();
  h.partners = createPartners({ ...h.deps, notifyAdmins: (x) => admins.push(x), platformLegal: async () => ({ fullName: "Бикоев Константин Николаевич", inn: "151211052290" }) });
  const { id: pid } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleAdminBot, { uid: "sa", body: { token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll" } });
  const { url } = await h.call(h.partners.handleTgLink, anna);
  const chat = { id: 780, type: "private" };
  const msg = (text) => h.partners._onMessage({ chat, text });
  const cb = (data) => h.partners._onCallback({ id: "q", data, message: { chat, message_id: 1 } });
  const last = () => h.tg[h.tg.length - 1].body;
  await msg(`/start pl_${url.match(/pl_([a-f0-9]+)/)[1]}`);
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "a@cafe.ru", consent: true } });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  await h.partners.onPayment({ invId: "p1", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  h.tick(15 * 86400000);
  await h.call(h.partners.handlePayoutDetails, { ...anna, body: { phone: "9001234567", bank: "Сбербанк", fullName: "Петрова Анна", inn: "500100732259" } });
  await msg("💸 Выплаты");
  assert.match(last().text, /Доступно к выплате: <b>2\s684,98 ₽<\/b>/);
  assert.strictEqual(last().reply_markup.inline_keyboard[0][0].callback_data, "ppay_ask");
  await cb("ppay_ask");
  assert.match(last().text, /Запросить выплату <b>2\s684,98 ₽<\/b>\?\nПеревод — на СБП/);
  await cb("ppay_yes");
  assert.match(last().text, /Запрос отправлен: <b>2\s684,98 ₽/);
  await msg("💸 Выплаты");
  assert.match(last().text, /Запрос отправлен/);
  assert.strictEqual(last().reply_markup.inline_keyboard[0][0].callback_data, "ppay_cancel");
  const { partners: [pa] } = await h.call(h.partners.handleAdminList, { uid: "sa" });
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: pa.request.id } });
  assert.match(last().text, /Выплата отправлена: 2\s684,98 ₽/);
  assert.match(last().text, /чек в «Мой налог» на 2\s684,98 ₽: покупатель — ИП Бикоев Константин Николаевич, ИНН 151211052290/);
  assert.match(last().text, /до 09\.12\.2026/, "выплата 08.11 — чек до 9 декабря");
  await msg("💸 Выплаты");
  assert.match(last().text, /Нужен чек из «Мой налог»/);
  // Напоминание о чеке: рано — нет; через 3 дня — раз; за 2 дня до срока — ещё раз.
  assert.strictEqual(await h.partners.remindReceipts(), 0);
  h.tick(3 * 86400000 + 1);
  assert.strictEqual(await h.partners.remindReceipts(), 1);
  assert.match(last().text, /Нужен чек из «Мой налог» за выплату 2\s684,98 ₽/);
  assert.strictEqual(await h.partners.remindReceipts(), 0);
  h.tick(27 * 86400000);
  assert.strictEqual(await h.partners.remindReceipts(), 1);
  assert.strictEqual(await h.partners.remindReceipts(), 0);
  // Неправильная ссылка — отказ; правильная — прикреплена, админу сообщение.
  await msg("https://lknpd.nalog.ru/что-то");
  assert.match(last().text, /Нужна ссылка на чек/);
  await msg("https://lknpd.nalog.ru/api/v1/receipt/500100732259/200abc1234/print");
  assert.match(last().text, /Чек прикреплён к выплате 2\s684,98 ₽/);
  assert.match(admins[admins.length - 1], /Чек от Анна Петрова/);
  const list = await h.call(h.partners.handleAdminList, { uid: "sa" });
  assert.strictEqual(list.partners[0].receiptsMissing, 0);
  await msg("💸 Выплаты");
  assert.match(last().text, /чек ✓/);
});

test("бухгалтерия: сроки НДФЛ, сумма прописью, акт за месяц", () => {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  let d = ndflDue(Date.UTC(2026, 9, 10, 9));
  assert.deepStrictEqual([iso(d.noticeBy), iso(d.payBy)], ["2026-10-25", "2026-10-28"]);
  d = ndflDue(Date.UTC(2026, 9, 24, 9));
  assert.deepStrictEqual([iso(d.noticeBy), iso(d.payBy)], ["2026-11-03", "2026-11-05"]);
  d = ndflDue(Date.UTC(2026, 11, 25, 9));
  assert.ok(d.yearEnd);
  const { rubWords, actBlocks } = require("./partner-contract");
  assert.strictEqual(rubWords(2684.98), "две тысячи шестьсот восемьдесят четыре");
  assert.strictEqual(rubWords(1021), "одна тысяча двадцать один");
  const act = JSON.stringify(actBlocks({
    platform: { fullName: "Бикоев Константин Николаевич", inn: "151211052290", ogrnip: "326150000028364" },
    partner: { name: "Анна", taxStatus: "npd" }, details: { fullName: "Петрова Анна Сергеевна", inn: "500100732259" },
    number: "ANNA-2026", year: 2026, month: 10,
    rows: [{ venueName: "Кафе А", paidAt: Date.UTC(2026, 9, 5), gross: 14900, base: 13424.9, amount: 2684.98 },
      { venueName: "Кафе Б", paidAt: Date.UTC(2026, 9, 20), gross: -14900, base: -13424.9, amount: -2684.98, clawback: true }],
  }));
  assert.match(act, /АКТ № ANNA-2026-10/);
  assert.match(act, /Петрова Анна Сергеевна, ИНН 500100732259, применяющий/);
  assert.match(act, /по 31\.10\.2026/);
  assert.match(act, /Кафе Б — возврат клиенту/);
  assert.match(act, /Общая сумма вознаграждения за период: 0,00 руб\. \(ноль руб\. 00 коп\.\)/);
});

test("ФНС: не самозанятый — запрос и выплата не проходят; ФНС молчит — только с ручной проверкой", async () => {
  const admins = [];
  const h = harness();
  h.partners = createPartners({ ...h.deps, notifyAdmins: (x) => admins.push(x) });
  const { id: pid } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "a@cafe.ru", consent: true } });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  await h.partners.onPayment({ invId: "p1", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  h.tick(15 * 86400000);
  await h.call(h.partners.handlePayoutDetails, { ...anna, body: { phone: "9001234567", bank: "Сбербанк", fullName: "Петрова Анна", inn: "500100732259" } });
  h.npd.status = false;
  await assert.rejects(h.partners.handlePayoutRequest({ ...anna, body: {} }, {}), (e) => e.status === 412 && /статус самозанятого на .* не подтверждён/.test(e.message));
  assert.deepStrictEqual(h.npdCalls[h.npdCalls.length - 1], { inn: "500100732259", requestDate: "2026-11-08" });
  h.npd.status = true;
  h.tick(11 * 60 * 1000); // кэш ответа — 10 минут
  const r = await h.call(h.partners.handlePayoutRequest, { ...anna, body: {} });
  assert.match(admins[admins.length - 1], /ФНС: самозанятый на сегодня/);
  assert.match(admins[admins.length - 1], /Назначение платежа: Вознаграждение по договору № ANNAPETROVA-2026 об оказании услуг по привлечению клиентов за октябрь 2026 г\. НДС не облагается/);
  // Ко дню перевода статус потерян — нельзя.
  h.tick(11 * 60 * 1000);
  h.npd.status = false;
  await assert.rejects(h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, requestId: r.id } }, {}), (e) => e.status === 409 && /не самозанятый/.test(e.message));
  // ФНС не отвечает — 428, с подтверждением ручной проверки — проходит.
  h.npd.down = true;
  h.tick(11 * 60 * 1000);
  await assert.rejects(h.partners.handleAdminPayout({ uid: "sa", body: { partnerId: pid, requestId: r.id } }, {}), (e) => e.status === 428);
  const paid = await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: r.id, npdManual: true } });
  assert.match(paid.purpose, /договору № ANNAPETROVA-2026/);
  // Номер договора не меняется после новой ссылки.
  h.npd.down = false;
  await h.call(h.partners.handleNewLink, { ...anna, body: {} });
  const dash = await h.call(h.partners.handleDashboard, { ...anna, body: {} });
  assert.ok(!dash.partner.link.includes("ANNAPETROVA?") && !dash.partner.link.endsWith("=ANNAPETROVA"));
  const { purpose } = dash.payouts[0];
  assert.match(purpose, /ANNAPETROVA-2026/);
});

test("чеки и подтверждение: чужой ИНН и повтор — нет; просроченный чек блокирует новый запрос; «не пришли» — админу; напоминание о запросе; реестр CSV", async () => {
  const admins = [];
  const h = harness();
  h.partners = createPartners({ ...h.deps, notifyAdmins: (x) => admins.push(x) });
  const { id: pid } = await h.addManager({});
  const anna = { uid: "u_anna@zalpos.ru" };
  const call = (fn, body = {}) => h.call(fn, { ...anna, body });
  await call(h.partners.handleAcceptTerms, { accept: true });
  await h.call(h.partners.handleAdminBot, { uid: "sa", body: { token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll" } });
  const { url } = await h.call(h.partners.handleTgLink, anna);
  const chat = { id: 781, type: "private" };
  await h.partners._onMessage({ chat, text: `/start pl_${url.match(/pl_([a-f0-9]+)/)[1]}` });
  await call(h.partners.handleInvite, { email: "a@cafe.ru", consent: true });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  await h.partners.onPayment({ invId: "p1", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  h.tick(15 * 86400000);
  await call(h.partners.handlePayoutDetails, { phone: "9001234567", bank: "Сбербанк", fullName: "Петрова Анна", inn: "500100732259" });
  const r = await call(h.partners.handlePayoutRequest);
  // 6 дней без выплаты — напоминание админу, второй раз в те же сутки — нет.
  h.tick(6 * 86400000);
  assert.strictEqual(await h.partners.remindRequests(), 1);
  assert.match(admins[admins.length - 1], /Запрос выплаты ждёт 6 дн\..*\n.*перевести до/);
  assert.strictEqual(await h.partners.remindRequests(), 0);
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: r.id, note: "СБП" } });
  const msg = h.tg[h.tg.length - 1].body;
  const [got, not] = msg.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  // «Не пришли» — админу; потом «пришли» — отмечено.
  await h.partners._onCallback({ id: "q", data: not, message: { chat, message_id: 3 } });
  assert.match(admins[admins.length - 1], /деньги не пришли/);
  await h.partners._onCallback({ id: "q", data: got, message: { chat, message_id: 3 } });
  assert.match(h.tg[h.tg.length - 1].body.text, /Получение 2\s684,98 ₽ отмечено/);
  let dash = await call(h.partners.handleDashboard);
  assert.ok(dash.payouts[0].receivedAt);
  // Чек: чужой ИНН — нет.
  await assert.rejects(h.partners.handlePayoutReceipt({ ...anna, body: { url: "https://lknpd.nalog.ru/api/v1/receipt/771234567890/20abc12345/print" } }, {}), /выбит на ИНН 771234567890/);
  // Новая оплата созрела, а чек просрочен — новый запрос не пройдёт.
  await h.partners.onPayment({ invId: "p2", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  h.tick(40 * 86400000);
  await assert.rejects(h.partners.handlePayoutRequest({ ...anna, body: {} }, {}), (e) => e.status === 412 && /Сначала прикрепите чек/.test(e.message));
  const good = "https://lknpd.nalog.ru/api/v1/receipt/500100732259/20abc12345/print";
  await call(h.partners.handlePayoutReceipt, { url: good });
  const r2 = await call(h.partners.handlePayoutRequest);
  await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: r2.id } });
  await assert.rejects(h.partners.handlePayoutReceipt({ ...anna, body: { url: good } }, {}), (e) => e.status === 409 && /уже прикреплён/.test(e.message));
  // Реестр выплат.
  let file = null;
  const res = { writeHead: () => {}, end: (b) => { file = b; } };
  await h.partners.handleAdminPayoutsCsv({ uid: "sa", body: { year: 2026 } }, res);
  const csv = file.toString("utf8");
  assert.ok(csv.startsWith("\uFEFF"));
  const rows = csv.trim().split("\r\n");
  assert.strictEqual(rows.length, 3);
  assert.match(rows[1], /"Анна Петрова";"Петрова Анна";"500100732259";"самозанятый";"ANNAPETROVA-2026";"2684,98";"0,00";"2684,98";"";"";"подтверждён \d{4}-\d{2}-\d{2}";"https:\/\/lknpd/);
  assert.match(rows[2], /нет \(срок/);
  // Акт за октябрь — для менеджера и админа.
  await h.partners.handleAct({ ...anna, body: { month: "2026-10" } }, res);
  assert.strictEqual(file.slice(0, 2).toString(), "PK");
  await assert.rejects(h.partners.handleAct({ ...anna, body: { month: "10.2026" } }, res), (e) => e.status === 400);
  await h.partners.handleAdminAct({ uid: "sa", body: { id: pid, month: "2026-11" } }, res);
  assert.strictEqual(file.slice(0, 2).toString(), "PK");
});

test("НДФЛ физлица: в реестре — сроки уведомления и уплаты, админу — напоминание", async () => {
  const admins = [];
  const h = harness();
  h.partners = createPartners({ ...h.deps, notifyAdmins: (x) => admins.push(x) });
  const { id: pid } = await h.addManager({ taxStatus: "person" });
  const anna = { uid: "u_anna@zalpos.ru" };
  await h.call(h.partners.handleAcceptTerms, { ...anna, body: { accept: true } });
  await h.call(h.partners.handleInvite, { ...anna, body: { email: "a@cafe.ru", consent: true } });
  await h.partners.attachOwner({ uid: "owner1", email: "a@cafe.ru", venueName: "Кафе А" });
  await h.partners.onPayment({ invId: "p1", ownerUid: "owner1", amount: 14900, venueName: "Кафе А" });
  h.tick(15 * 86400000); // 08.11
  await h.call(h.partners.handlePayoutDetails, { ...anna, body: { phone: "9001234567", bank: "Сбербанк", fullName: "Петрова Анна", inn: "500100732259" } });
  const r = await h.call(h.partners.handlePayoutRequest, { ...anna, body: {} });
  const calls = h.npdCalls.length;
  const paid = await h.call(h.partners.handleAdminPayout, { uid: "sa", body: { partnerId: pid, requestId: r.id } });
  assert.strictEqual(h.npdCalls.length, calls, "физлицо — ФНС о НПД не спрашиваем");
  assert.strictEqual(paid.ndfl, 349);
  assert.strictEqual(new Date(paid.ndflDue.payBy).toISOString().slice(0, 10), "2026-11-28");
  assert.match(admins[admins.length - 1], /НДФЛ 349 ₽.*\nУведомление об исчисленных суммах — до 25\.11\.2026, уплата ЕНП — до 28\.11\.2026/);
  let file = null;
  await h.partners.handleAdminPayoutsCsv({ uid: "sa", body: {} }, { writeHead: () => {}, end: (b) => { file = b; } });
  assert.match(file.toString(), /"2684,98";"349,00";"2335,98";"25\.11\.2026";"28\.11\.2026"/);
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
