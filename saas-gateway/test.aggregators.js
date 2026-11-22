"use strict";
// Яндекс Еда и Купер (aggregators.js): ключи из кабинета, токен Яндекса,
// меню без табака/кальянов/алкоголя/весового, стоп-лист, заказ → заказ с
// собой на кассе (цены из меню, без ПДн, комментарий вычищен), повтор не
// дублирует, статус кассы → статус Яндекса, отмена агрегатором; Купер.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-"));
const PORT = 8098;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "agg-secret-key-0123456789abcdef0123",
});
const assert = require("assert/strict");
const server = require("./server.js");
const store = server.localDataStore();
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);

function req(method, p, { token, body, raw, headers = {} } = {}) {
  const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": raw !== undefined ? "application/x-www-form-urlencoded" : "application/json",
        ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch (_) {} resolve({ status: res.statusCode, json: j, raw: out }); });
    });
    r.on("error", reject);
    r.end(payload);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let failed = 0;
  try {
    const sign = async (email) => (await req("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
    const me = await sign("owner-a@test.ru");
    const other = await sign("other-a@test.ru");
    await set("tenants/a1", { name: "Пицца", status: "active", ownerUserId: me.uid, timezone: "Europe/Moscow" });
    await set(`tenantMembers/a1_${me.uid}`, { tenantId: "a1", userId: me.uid, role: "owner", status: "active" });
    await set("tenants/a1/meta/venueProfile", { deliveryEnabled: true });
    await set("tenants/a1/settings/orderCounter", { last: 7 });
    await set("tenants/a1/menuCategories/c1", { name: "Пицца", order: 1 });
    await set("tenants/a1/menuCategories/c2", { name: "Кальяны", kind: "hookah" });
    await set("tenants/a1/menuCategories/c3", { name: "Пиво" });
    await set("tenants/a1/menuItems/marg", { name: "Маргарита", price: 590, categoryId: "c1", weight: 450, modifierGroups: [{ name: "Борт", min: 0, max: 1, options: [{ name: "Сырный", price: 90 }] }] });
    await set("tenants/a1/menuItems/pep", { name: "Пепперони", price: 690, categoryId: "c1", available: false });
    await set("tenants/a1/menuItems/hook", { name: "Кальян", price: 1500, categoryId: "c2" });
    await set("tenants/a1/menuItems/beer", { name: "Пиво светлое", price: 300, categoryId: "c3" });
    await set("tenants/a1/menuItems/cheese", { name: "Сыр", price: 1290, categoryId: "c1", byWeight: true });

    // Кабинет: только владелец/админ, секрет — один раз.
    assert.equal((await req("POST", "/aggregatorLink", { token: other.idToken, body: { tenantId: "a1", kind: "yandex" } })).status, 403);
    let r = await req("POST", "/aggregatorLink", { token: me.idToken, body: { tenantId: "a1", kind: "yandex", action: "create" } });
    assert.equal(r.status, 200, r.raw);
    const { url, clientId, secret } = r.json;
    assert.ok(secret && clientId && url.endsWith(`/agg/yandex/${clientId}`));
    assert.equal((await req("POST", "/aggregatorLink", { token: me.idToken, body: { tenantId: "a1", kind: "yandex" } })).json.secret, "", "секрет второй раз не показываем");
    const base = `/agg/yandex/${clientId}`;

    // Токен Яндекса
    assert.equal((await req("POST", `${base}/security/oauth/token`, { raw: `client_id=${clientId}&client_secret=wrong&grant_type=client_credentials` })).status, 401);
    r = await req("POST", `${base}/security/oauth/token`, { raw: `client_id=${clientId}&client_secret=${secret}&grant_type=client_credentials&scope=read write` });
    assert.equal(r.status, 200, r.raw);
    const tok = r.json.access_token;
    assert.equal((await req("GET", `${base}/menu/${clientId}/composition`)).status, 401, "без токена — нельзя");

    // Меню и стоп-лист
    r = await req("GET", `${base}/menu/${clientId}/composition`, { token: tok });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.json.items.map((i) => i.id).sort(), ["marg", "pep"], "без кальянов, алкоголя и весового");
    const marg = r.json.items.find((i) => i.id === "marg");
    assert.equal(marg.modifierGroups[0].modifiers[0].id, "marg~0~0");
    r = await req("GET", `${base}/menu/${clientId}/availability`, { token: tok });
    assert.deepEqual(r.json.items, [{ itemId: "pep", stock: 0 }]);

    // Заказ
    const order = { eatsId: "220122-555", restaurantId: clientId, comment: "Позвоните +7 900 123-45-67, домофон 5",
      deliveryInfo: { clientName: "Иван", phoneNumber: "+79001234567", courierArrivementDate: "2026-11-22T19:30:00+03:00" },
      paymentInfo: { paymentType: "CARD", itemsCost: 1270 },
      items: [{ id: "marg", name: "Маргарита", quantity: 2, price: 590, modifications: [{ id: "marg~0~0", name: "Сырный", quantity: 1, price: 90 }] },
        { id: "hook", name: "Кальян", quantity: 1, price: 1500 }] };
    r = await req("POST", `${base}/order`, { token: tok, body: order });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.result, "OK");
    const sid = r.json.orderId;
    const s = (await doc(`tenants/a1/sessions/${sid}`).get()).data();
    assert.equal(s.source, "yandex_eda");
    assert.equal(s.orderNo, 8);
    assert.equal(s.payMethod, "aggregator");
    assert.equal(s.deliveryStatus, "new");
    assert.equal(s.appTotal, 1360, "цены из меню: (590 + 90) × 2, кальян не продаётся");
    assert.ok(!JSON.stringify(s).includes("Иван") && !JSON.stringify(s).includes("900 123"), "без имени и телефона гостя");
    assert.ok(s.deliveryComment.includes("домофон 5"));
    const go = (await store.collection("tenants/a1/guestOrders").get()).docs.map((d) => d.data());
    assert.equal(go.length, 1);
    assert.deepEqual(go[0].items.map((i) => [i.menuItemId, i.qty, i.price, i.mods]), [["marg", 2, 680, ["Сырный"]]]);
    // Повтор того же заказа — не дублируем.
    r = await req("POST", `${base}/order`, { token: tok, body: order });
    assert.equal(r.json.orderId, sid);
    assert.equal((await store.collection("tenants/a1/guestOrders").get()).docs.length, 1);

    // Статус: касса двигает заказ — Яндекс видит.
    assert.equal((await req("GET", `${base}/order/${sid}/status`, { token: tok })).json.status, "NEW");
    await doc(`tenants/a1/sessions/${sid}`).update({ deliveryStatus: "cooking" });
    assert.equal((await req("GET", `${base}/order/${sid}/status`, { token: tok })).json.status, "COOKING");
    await doc(`tenants/a1/sessions/${sid}`).update({ deliveryStatus: "ready" });
    assert.equal((await req("GET", `${base}/order/${sid}/status`, { token: tok })).json.status, "READY");
    // Отмена Яндексом — касса получает сигнал.
    r = await req("DELETE", `${base}/order/${sid}`, { token: tok, body: { eatsId: "220122-555", comment: "Клиент передумал" } });
    assert.equal(r.status, 200, r.raw);
    assert.equal((await doc(`tenants/a1/sessions/${sid}`).get()).data().deliveryStatus, "cancelled");
    assert.ok((await store.collection("tenants/a1/waiterCalls").get()).docs.some((d) => /Яндекс Еда отменила заказ №8/.test(d.data().comment)));
    assert.equal((await req("GET", `${base}/order/nope/status`, { token: tok })).status, 404);

    // Выключены «с собой и доставка» — заказ не принимаем.
    await set("tenants/a1/meta/venueProfile", { deliveryEnabled: false });
    r = await req("POST", `${base}/order`, { token: tok, body: { ...order, eatsId: "x-2" } });
    assert.equal(r.status, 409);
    await set("tenants/a1/meta/venueProfile", { deliveryEnabled: true });

    // Купер
    r = await req("POST", "/aggregatorLink", { token: me.idToken, body: { tenantId: "a1", kind: "kuper", action: "create" } });
    const kbase = new URL(r.json.url).pathname.replace(/^\/saas/, "");
    const ktok = r.json.secret;
    assert.equal((await req("POST", kbase, { body: { id: "K1", items: [] } })).status, 401);
    r = await req("POST", kbase, { token: ktok, body: { event: "order.created", order: { id: "K-100", items: [{ external_id: "marg", quantity: 1 }], comment: "без лука" } } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.number, 9);
    const ks = (await doc(`tenants/a1/sessions/${r.json.orderId}`).get()).data();
    assert.equal(ks.source, "kuper");
    assert.equal((await req("GET", `${kbase}/orders/K-100`, { token: ktok })).json.status, "new");
    await req("POST", kbase, { token: ktok, body: { event: "order.canceled", order: { id: "K-100", cancel_reason: "нет курьера" } } });
    assert.equal((await doc(`tenants/a1/sessions/${r.json.orderId}`).get()).data().deliveryStatus, "cancelled");

    // Новые ключи — старые не работают; отключение.
    r = await req("POST", "/aggregatorLink", { token: me.idToken, body: { tenantId: "a1", kind: "yandex", action: "rotate" } });
    assert.notEqual(r.json.clientId, clientId);
    assert.equal((await req("POST", `${base}/security/oauth/token`, { raw: `client_id=${clientId}&client_secret=${secret}` })).status, 404);
    assert.equal((await req("GET", `${base}/order/${sid}/status`, { token: tok })).status, 404, "старый адрес не работает");
    r = await req("POST", "/aggregatorLink", { token: me.idToken, body: { tenantId: "a1", kind: "kuper", action: "disable" } });
    assert.equal(r.json.connected, false);
  } catch (e) {
    failed++;
    console.error(e);
  }
  if (failed) { console.error("aggregators: ОШИБКИ"); process.exit(1); }
  console.log("aggregators: ok");
  process.exit(0);
})();
