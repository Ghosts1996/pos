"use strict";
// Гости: согласие на рекламные сообщения, сегменты, «Вернуть гостя»
// (guest-marketing.js) и правила базы для новых полей профиля.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { createLocalDb } = require("./local-db");
const { compile } = require("./rules-engine");
const gm = require("./guest-marketing");
const { HttpError } = require("./test-helpers");

const { Timestamp } = admin.firestore;
const DAY = 24 * 3600 * 1000;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TID = "t1";
const CHAIN_TID = "p1";
const CHAIN = "ch1";
// 14:00 по Москве — окно рассылки.
const NOON = Date.UTC(2026, 10, 9, 11);

function harness({ clock = NOON } = {}) {
  const store = createLocalDb({ admin });
  let t = clock;
  const audit = [];
  const roles = {
    [`${TID}:owner`]: "owner", [`${TID}:mgr`]: "manager", [`${TID}:emp`]: "employee",
    [`${CHAIN_TID}:pointOwner`]: "owner", [`chain:${CHAIN}:chainOwner`]: "owner",
  };
  const deps = {
    db: () => store, admin,
    verifyAuth: async (req) => { if (!req.uid) throw new HttpError(401, "нет входа"); return { uid: req.uid }; },
    parseJsonBody: async (req) => req.body || {},
    sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
    HttpError,
    requireTenantRole: async (tid, uid, allowed) => {
      if (!allowed.includes(roles[`${tid}:${uid}`])) throw new HttpError(403, "Недостаточно прав в этом заведении");
    },
    requireChainRole: async (cid, uid, allowed) => {
      if (!allowed.includes(roles[`chain:${cid}:${uid}`])) throw new HttpError(403, "Недостаточно прав в сети");
    },
    writeAuditLog: async (e) => { audit.push(e); },
    clientIp: () => "5.6.7.8",
    now: () => t,
    log: { log() {}, error() {} },
  };
  const mod = gm.createGuestMarketing(deps);
  const call = async (fn, req) => {
    const res = {};
    try { await fn({ headers: { "user-agent": "Test/1.0" }, ...req }, res); } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      res.code = e.status; res.body = { error: e.message };
    }
    return res;
  };
  return {
    store, mod, audit,
    consent: (uid, body) => call(mod.handleConsent, { uid, body: { tenantId: TID, ...body } }),
    segments: (uid, tenantId = TID) => call(mod.handleSegments, { uid, body: { tenantId } }),
    save: (uid, settings, tenantId = TID) => call(mod.handleCampaign, { uid, body: { tenantId, settings } }),
    setNow: (ms) => { t = ms; },
    now: () => t,
  };
}

async function seedVenue(store, { tz = "Europe/Moscow", sub = "active" } = {}) {
  await store.doc(`tenants/${TID}`).set({ name: "Кафе Тест", status: "active" });
  await store.doc(`tenants/${TID}/settings/general`).set({ timezone: tz });
  await store.doc(`tenants/${TID}/meta/venueProfile`).set({ venueType: "cafe" });
  await store.doc(`tenants/${TID}/branding/config`).set({ appName: "Кафе у дома" });
  await store.doc(`subscriptions/${TID}`).set({ status: sub });
}

/** Гость: dAgo — сколько дней назад был, consent — согласие (с записью на сервере). */
async function guest(h, uid, { dAgo = 40, visits = 3, spent = 6000, consent = true, evidence = true, extra = {}, root = `tenants/${TID}`, key = `t_${TID}` } = {}) {
  await h.store.doc(`${root}/clients/${uid}`).set({
    name: `Имя ${uid}`, phone: "+79001112233", visits, totalSpent: spent, bonusBalance: 100,
    lastVisitAt: Timestamp.fromMillis(h.now() - dAgo * DAY), createdAt: Timestamp.fromMillis(h.now() - 400 * DAY),
    ...(consent ? { adsConsent: true } : {}), ...extra,
  });
  if (consent && evidence) await h.store.doc(`adsConsents/${key}__${uid}`).set({ on: true, events: [] });
}

const data = async (h, p) => (await h.store.doc(p).get()).data();

// --------------------------------------------------------- проверка текста

test("текст: табак, кальяны и алкоголь — нельзя; виноград, ромашка и безалкогольное — можно", () => {
  for (const bad of ["Ждём на кальян!", "Новый табак уже здесь", "Скидка на вино", "Пиво в подарок", "Бокал игристого",
    "Ром и кола", "Лучший кофе в городе", "Мы № 1", "Заходите: https://x.ru", "Подробнее на site.ru", "Hookah night"]) {
    assert.ok(gm.textProblem(bad), `должно быть нельзя: ${bad}`);
  }
  for (const ok of ["Скучаем по вам! Дарим 300 бонусов", "Виноградный сок и ромашковый чай", "Безалкогольный глинт… нет: лимонад",
    "Мы улучшили меню — приходите", "Ждём вас снова"]) {
    assert.strictEqual(gm.textProblem(ok), null, `должно быть можно: ${ok}`);
  }
  assert.match(gm.textProblem("кальянная вечеринка"), /15-ФЗ/);
  assert.match(gm.textProblem("вино"), /О рекламе/);
});

test("настройки приводятся к допустимым: дни из списка, бонусы 0–5000, длина текста", () => {
  const s = gm.normalizeSettings({ enabled: "yes", afterDays: 7, repeatDays: 999, bonus: 99999, title: "x".repeat(100), text: "  a\n\tb  " });
  assert.deepStrictEqual(s, { enabled: false, afterDays: 30, repeatDays: 60, bonus: 5000, title: "x".repeat(60), text: "a b" });
  assert.strictEqual(gm.normalizeSettings({ bonus: -5 }).bonus, 0);
  assert.strictEqual(gm.normalizeSettings({ afterDays: "45" }).afterDays, 45);
  assert.deepStrictEqual(gm.REPEAT_DAYS, [30, 60, 90], "владелец выбирает: раз в 30, 60 или 90 дней");
  assert.strictEqual(gm.normalizeSettings({ repeatDays: 30 }).repeatDays, 30);
  assert.strictEqual(gm.normalizeSettings({ repeatDays: 180 }).repeatDays, 60, "180 больше нет — по умолчанию 60");
  assert.deepStrictEqual(gm.normalizeSettings({}), { ...gm.DEFAULTS });
  assert.ok(gm.settingsProblem({ ...gm.DEFAULTS, title: "" }));
  assert.strictEqual(gm.settingsProblem({ ...gm.DEFAULTS }), null, "текст по умолчанию допустим");
});

// --------------------------------------------------------------- согласие

test("согласие: только свой профиль, запись с датой, IP и браузером; отказ стирает IP и браузер", async () => {
  const h = harness();
  await seedVenue(h.store);
  assert.strictEqual((await h.consent(null, { on: true })).code, 401);
  assert.strictEqual((await h.consent("g1", { on: true })).code, 404, "без профиля — сначала сохранить профиль");
  await h.store.doc(`tenants/${TID}/clients/g1`).set({ name: "Аня", visits: 0 });
  assert.strictEqual((await h.consent("g1", { on: "да" })).code, 400);

  const on = await h.consent("g1", { on: true, source: "web", edition: gm.ADS_EDITION });
  assert.strictEqual(on.code, 200, JSON.stringify(on.body));
  const prof = await data(h, `tenants/${TID}/clients/g1`);
  assert.strictEqual(prof.adsConsent, true);
  assert.strictEqual(prof.adsConsentEdition, gm.ADS_EDITION);
  assert.strictEqual(prof.name, "Аня", "остальной профиль не тронут");
  let ev = await data(h, `adsConsents/t_${TID}__g1`);
  assert.strictEqual(ev.on, true);
  assert.deepStrictEqual(ev.events.map((e) => [e.on, e.source, e.ip, e.ua]), [[true, "web", "5.6.7.8", "Test/1.0"]]);

  const off = await h.consent("g1", { on: false });
  assert.strictEqual(off.code, 200);
  assert.strictEqual((await data(h, `tenants/${TID}/clients/g1`)).adsConsent, false);
  ev = await data(h, `adsConsents/t_${TID}__g1`);
  assert.strictEqual(ev.on, false);
  assert.strictEqual(ev.events.length, 2);
  assert.ok(ev.events.every((e) => e.ip === undefined && e.ua === undefined), "после отказа нет IP и браузера");
  assert.ok(ev.events[0].at && ev.events[0].edition, "даты и редакции остались");
});

test("согласие гостя сети — в общем профиле сети; удаление данных — отказ без IP", async () => {
  const h = harness();
  await h.store.doc(`tenants/${CHAIN_TID}`).set({ name: "Точка", status: "active", chainId: CHAIN });
  await h.store.doc(`chains/${CHAIN}/clients/g2`).set({ name: "Б", visits: 1 });
  const r = await h.consent("g2", { on: true, tenantId: CHAIN_TID });
  assert.strictEqual(r.code, 200);
  assert.strictEqual((await data(h, `chains/${CHAIN}/clients/g2`)).adsConsent, true);
  assert.ok(await data(h, `adsConsents/c_${CHAIN}__g2`));
  await h.mod.forgetConsent("chain", CHAIN, "g2");
  const ev = await data(h, `adsConsents/c_${CHAIN}__g2`);
  assert.strictEqual(ev.on, false);
  assert.ok(ev.events.every((e) => !e.ip && !e.ua));
  assert.strictEqual(ev.events[ev.events.length - 1].source, "deleted");
});

test("согласие: не больше 30 переключений в час", async () => {
  const h = harness();
  await seedVenue(h.store);
  await h.store.doc(`tenants/${TID}/clients/g1`).set({ visits: 0 });
  let r;
  for (let i = 0; i < 31; i++) r = await h.consent("g1", { on: i % 2 === 0 });
  assert.strictEqual(r.code, 429);
  h.setNow(h.now() + 3601 * 1000);
  assert.strictEqual((await h.consent("g1", { on: true })).code, 200);
});

// --------------------------------------------------------------- сегменты

test("сегменты: новые, постоянные, давно не были, ушли; без имён и телефонов; права", async () => {
  const h = harness();
  await seedVenue(h.store);
  await guest(h, "new1", { dAgo: 3, visits: 1, spent: 1000, consent: false });
  await guest(h, "reg1", { dAgo: 10, visits: 5, spent: 20000 });
  await guest(h, "reg2", { dAgo: 30, visits: 2, spent: 3000, consent: false });
  await guest(h, "lap1", { dAgo: 45, visits: 4, spent: 8000 });
  await guest(h, "lost1", { dAgo: 200, visits: 2, spent: 2000 });
  await guest(h, "none1", { visits: 0, spent: 0, consent: false, extra: { lastVisitAt: null } });
  await guest(h, "anon", { extra: { anonymized: true } });
  await h.store.doc(`tenants/${TID}/clients/bday`).set({ visits: 1, totalSpent: 1000, lastVisitAt: Timestamp.fromMillis(h.now() - DAY), birthdayMonth: 11 });

  assert.strictEqual((await h.segments("emp")).code, 403, "сотруднику — нет");
  const r = await h.segments("mgr");
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const s = r.body.stats;
  assert.deepStrictEqual(s.segments, { new: 2, regular: 2, lapsing: 1, lost: 1, noVisits: 1 });
  assert.strictEqual(s.total, 7, "обезличенные не считаются");
  assert.strictEqual(s.ads, 3);
  assert.deepStrictEqual(s.segmentsAds, { new: 0, regular: 1, lapsing: 1, lost: 1, noVisits: 0 });
  assert.strictEqual(s.birthdays, 1);
  assert.strictEqual(s.eligible, 2, "подарок сейчас положен lap1 и lost1 — согласны и не были 30+ дней");
  assert.strictEqual(s.avgCheck, Math.round((1000 + 20000 + 3000 + 8000 + 2000 + 1000) / (1 + 5 + 2 + 4 + 2 + 1)));
  assert.strictEqual(r.body.canEdit, false, "менеджер смотрит, но не меняет");
  assert.strictEqual(r.body.hookah, false);
  const text = JSON.stringify(r.body);
  for (const leak of ["Имя", "+7900", "new1", "reg1"]) assert.ok(!text.includes(leak), `нет «${leak}»`);
  assert.strictEqual((await h.segments("owner")).body.canEdit, true);
});

// ------------------------------------------------------- настройки рассылки

test("настройки: меняет владелец; включить с запрещённым текстом нельзя, черновик — можно", async () => {
  const h = harness();
  await seedVenue(h.store);
  assert.strictEqual((await h.save("mgr", { enabled: true })).code, 403);
  const bad = await h.save("owner", { enabled: true, title: "Кальянный вечер", text: "Ждём вас" });
  assert.strictEqual(bad.code, 400);
  assert.match(bad.body.error, /15-ФЗ/);
  assert.strictEqual((await h.save("owner", { enabled: false, title: "Кальянный вечер", text: "Ждём вас" })).code, 200);
  const ok = await h.save("owner", { enabled: true, afterDays: 45, bonus: 500, title: "Скучаем", text: "Дарим бонусы — ждём вас" });
  assert.strictEqual(ok.code, 200, JSON.stringify(ok.body));
  const saved = await data(h, `guestCampaigns/t_${TID}`);
  assert.strictEqual(saved.enabled, true);
  assert.strictEqual(saved.afterDays, 45);
  assert.strictEqual(saved.tenantId, TID);
  assert.ok(h.audit.some((a) => a.action === "guestCampaignSaved"));
});

test("рассылку сети настраивает владелец сети, а не владелец точки", async () => {
  const h = harness();
  await h.store.doc(`tenants/${CHAIN_TID}`).set({ name: "Точка", status: "active", chainId: CHAIN });
  assert.strictEqual((await h.save("pointOwner", { enabled: false }, CHAIN_TID)).code, 403);
  const r = await h.save("chainOwner", { enabled: true }, CHAIN_TID);
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual((await data(h, `guestCampaigns/c_${CHAIN}`)).scope, "chain");
});

// ------------------------------------------------------------- рассылка

async function enable(h, settings = {}) {
  const r = await h.save("owner", { enabled: true, afterDays: 30, repeatDays: 90, bonus: 300, title: "Скучаем", text: "Дарим бонусы — ждём вас", ...settings });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
}

test("рассылка: подарок только тем, кто согласен, был у нас и не приходит 30+ дней", async () => {
  const h = harness();
  await seedVenue(h.store);
  await enable(h);
  await guest(h, "yes", { dAgo: 40 });
  await guest(h, "noConsent", { dAgo: 40, consent: false });
  await guest(h, "fakeConsent", { dAgo: 40, evidence: false }); // отметку поставили мимо сервера
  await guest(h, "recent", { dAgo: 10 });
  await guest(h, "yearAgo", { dAgo: 400 });
  await guest(h, "never", { visits: 0 });
  await guest(h, "anon", { dAgo: 40, extra: { anonymized: true } });
  await guest(h, "giftedRecently", { dAgo: 60, extra: { winbackAt: Timestamp.fromMillis(h.now() - 20 * DAY) } });

  const out = await h.mod.runAll();
  assert.deepStrictEqual(out[`t_${TID}`], { sent: 1, left: 0 });
  const p = await data(h, `tenants/${TID}/clients/yes`);
  assert.strictEqual(p.bonusBalance, 400);
  assert.strictEqual(p.winbackTries, 1);
  assert.strictEqual(p.winbackSpent, 6000);
  assert.strictEqual(p.promo.title, "Скучаем");
  assert.strictEqual(p.promo.bonus, 300);
  assert.strictEqual(p.promo.from, "Кафе у дома");
  assert.strictEqual(p.promo.until.toMillis() - p.promo.at.toMillis(), gm.SHOW_DAYS * DAY);
  const ops = (await h.store.collection(`tenants/${TID}/bonusOperations`).get()).docs.map((d) => d.data());
  assert.deepStrictEqual(ops.map((o) => [o.clientUid, o.type, o.amount, o.reason]), [["yes", "accrual", 300, "winback"]]);
  for (const uid of ["noConsent", "fakeConsent", "recent", "yearAgo", "never", "anon", "giftedRecently"]) {
    const d = await data(h, `tenants/${TID}/clients/${uid}`);
    assert.strictEqual(d.promo, undefined, `${uid}: без подарка`);
    assert.strictEqual(d.bonusBalance, 100, `${uid}: бонусы не тронуты`);
  }
  // В тот же день — второй раз не идёт.
  assert.deepStrictEqual((await h.mod.runAll())[`t_${TID}`], { skipped: "today" });
});

test("рассылка: ночью и с неактивной подпиской — нет; часы — по поясу заведения", async () => {
  const night = harness({ clock: Date.UTC(2026, 10, 9, 20) }); // 23:00 по Москве
  await seedVenue(night.store);
  await enable(night);
  await guest(night, "g", { dAgo: 40 });
  assert.deepStrictEqual((await night.mod.runAll())[`t_${TID}`], { skipped: "hour" });

  const vl = harness({ clock: Date.UTC(2026, 10, 9, 3) }); // 06:00 Москва = 13:00 Владивосток
  await seedVenue(vl.store, { tz: "Asia/Vladivostok" });
  await enable(vl);
  await guest(vl, "g", { dAgo: 40 });
  assert.strictEqual((await vl.mod.runAll())[`t_${TID}`].sent, 1);

  const unpaid = harness();
  await seedVenue(unpaid.store, { sub: "expired" });
  await enable(unpaid);
  await guest(unpaid, "g", { dAgo: 40 });
  assert.deepStrictEqual((await unpaid.mod.runAll())[`t_${TID}`], { skipped: "subscription" });
});

test("рассылка: не чаще выбранного срока и не больше двух подарков подряд, если гость не пришёл", async () => {
  const h = harness();
  await seedVenue(h.store);
  await enable(h, { repeatDays: 60 });
  await guest(h, "g", { dAgo: 40 });
  const run = async () => {
    await h.store.doc(`guestCampaigns/t_${TID}`).set({ lastRunDay: null }, { merge: true });
    return (await h.mod.runAll())[`t_${TID}`].sent;
  };
  assert.strictEqual(await run(), 1);
  h.setNow(h.now() + 30 * DAY);
  assert.strictEqual(await run(), 0, "через 30 дней — рано");
  h.setNow(h.now() + 31 * DAY);
  assert.strictEqual(await run(), 1, "второй подарок");
  h.setNow(h.now() + 61 * DAY);
  assert.strictEqual(await run(), 0, "третий подряд без визита — нет");

  // Гость пришёл — счётчик начинается заново.
  await h.store.doc(`tenants/${TID}/clients/g`).set({ lastVisitAt: Timestamp.fromMillis(h.now()), visits: 4, totalSpent: 9000 }, { merge: true });
  const st = (await h.segments("owner")).body.stats.campaign;
  assert.deepStrictEqual(st, { sent: 1, returned: 1, revenue: 3000, days: 90 }, "вернулся и принёс 3000 ₽");
  h.setNow(h.now() + 40 * DAY);
  assert.strictEqual(await run(), 1);
  assert.strictEqual((await data(h, `tenants/${TID}/clients/g`)).winbackTries, 1);
  // Раз в 30 дней: через месяц после подарка — снова можно.
  await enable(h, { repeatDays: 30 });
  assert.strictEqual((await data(h, `guestCampaigns/t_${TID}`)).repeatDays, 30);
  h.setNow(h.now() + 29 * DAY);
  assert.strictEqual(await run(), 0, "29 дней — рано");
  h.setNow(h.now() + 2 * DAY);
  assert.strictEqual(await run(), 1, "31 день — второй подарок");
});

test("рассылка сети: общий профиль гостя, бонусы и запись согласия сети", async () => {
  const h = harness();
  await h.store.doc(`tenants/${CHAIN_TID}`).set({ name: "Точка", status: "active", chainId: CHAIN });
  await h.store.doc(`subscriptions/${CHAIN}`).set({ status: "trial" });
  assert.strictEqual((await h.save("chainOwner", { enabled: true, bonus: 0 }, CHAIN_TID)).code, 200);
  await guest(h, "cg", { dAgo: 50, root: `chains/${CHAIN}`, key: `c_${CHAIN}` });
  assert.strictEqual((await h.mod.runAll())[`c_${CHAIN}`].sent, 1);
  const p = await data(h, `chains/${CHAIN}/clients/cg`);
  assert.strictEqual(p.promo.bonus, 0);
  assert.strictEqual(p.bonusBalance, 100, "без бонусов — только сообщение");
  assert.strictEqual(p.promo.from, "Точка");
  assert.strictEqual((await h.store.collection(`chains/${CHAIN}/bonusOperations`).get()).size, 0);
});

test(`рассылка: не больше ${gm.MAX_PER_DAY} подарков в день, сначала те, кто ушёл недавно`, async () => {
  const h = harness();
  await seedVenue(h.store);
  await enable(h);
  for (let i = 0; i < gm.MAX_PER_DAY + 20; i++) await guest(h, `g${String(i).padStart(3, "0")}`, { dAgo: 31 + i % 300 });
  const r = (await h.mod.runAll())[`t_${TID}`];
  assert.deepStrictEqual(r, { sent: gm.MAX_PER_DAY, left: 20 });
  assert.strictEqual((await data(h, "tenants/t1/clients/g000")).promo.kind, "winback", "31 день — в первых");
});

// --------------------------------------------------------------- правила

test("правила: гость не ставит себе согласие и подарок, а имя менять может; служебные коллекции закрыты", () => {
  const rules = compile(fs.readFileSync(path.join(__dirname, "..", "saas", "firestore.rules"), "utf8"));
  const me = { uid: "g1", token: {} };
  const get = () => null;
  const base = { name: "Аня", visits: 2, bonusBalance: 50 };
  const p = `tenants/${TID}/clients/g1`;
  const ctx = (before, after) => ({ auth: me, resource: before, request: after, get, getAfter: get, now: Date.now() });
  assert.strictEqual(rules.allowed("update", p, ctx(base, { ...base, name: "Аня Б" })), true, "имя — можно");
  for (const f of [{ adsConsent: true }, { promo: { title: "x" } }, { winbackAt: 1 }, { adsConsentAt: 1 }, { winbackTries: 0 }]) {
    assert.strictEqual(rules.allowed("update", p, ctx(base, { ...base, ...f })), false, `update ${Object.keys(f)}`);
    assert.strictEqual(rules.allowed("create", p, ctx(null, { name: "А", ...f })), false, `create ${Object.keys(f)}`);
  }
  assert.strictEqual(rules.allowed("create", p, ctx(null, { name: "А" })), true, "обычный профиль создаётся");
  for (const col of ["guestCampaigns/t_t1", "adsConsents/t_t1__g1"]) {
    for (const m of ["get", "list", "create", "update"]) {
      assert.strictEqual(rules.allowed(m, col, ctx(null, { on: true })), false, `${m} ${col}`);
    }
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e}`);
    }
  }
  console.log(`guest-marketing: ${passed} из ${passed + failed} проверок`);
  if (failed) process.exit(1);
})();
