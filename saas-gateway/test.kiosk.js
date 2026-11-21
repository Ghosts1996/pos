"use strict";
// Киоск самообслуживания (kiosk.js): ссылка из кабинета, меню без табака,
// кальянов и алкоголя, заказ с добавками → чек «с собой» с номером
// (общий счётчик с кассой) и заявка для кассира; без ПДн; смена ключа.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-"));
const PORT = 8090;
Object.assign(process.env, {
  PORT: String(PORT), DATA_BACKEND: "local", AUTH_BACKEND: "own", DATA_DB_FILE: path.join(dir, "data.sqlite"), SUPPORT_DB_FILE: path.join(dir, "support-db.json"),
  AUTH_DB_FILE: path.join(dir, "auth.json"), BACKUP_DIR: path.join(dir, "backups"), DATA_AUTO_MIGRATE: "0", GITHUB_PAT: "",
  TELEGRAM_SECRET_KEY: process.env.TELEGRAM_SECRET_KEY || "kiosk-secret-key-0123456789abcdef",
});
const assert = require("assert/strict");
const server = require("./server.js");
const store = server.localDataStore();
const doc = (p) => store.collection(p.split("/").slice(0, -1).join("/")).doc(p.split("/").pop());
const set = (p, d) => doc(p).set(d);

function req(method, p, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw, headers: res.headers }); });
    });
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  let failed = 0;
  try {
    const sign = async (email) => (await req("POST", "/auth/signup", { body: { email, password: "secret-123456" } })).json;
    const me = await sign("owner-k@test.ru");
    const other = await sign("other-k@test.ru");
    await set("tenants/k1", { name: "Кофейня", status: "active", ownerUserId: me.uid, timezone: "Europe/Moscow" });
    await set(`tenantMembers/k1_${me.uid}`, { tenantId: "k1", userId: me.uid, role: "owner", status: "active" });
    await set("tenants/k1/meta/venueProfile", { deliveryEnabled: true });
    await set("tenants/k1/settings/orderCounter", { last: 51 });
    await set("tenants/k1/menuCategories/c1", { name: "Кофе" });
    await set("tenants/k1/menuCategories/c2", { name: "Кальяны", kind: "hookah" });
    await set("tenants/k1/menuCategories/c3", { name: "Алкоголь" });
    await set("tenants/k1/menuItems/latte", { name: "Латте", price: 220, categoryId: "c1", modifierGroups: [{ name: "Молоко", min: 1, max: 1, options: [{ name: "Обычное", price: 0 }, { name: "Овсяное", price: 60 }] }] });
    await set("tenants/k1/menuItems/hookah", { name: "Кальян", price: 1500, categoryId: "c2" });
    await set("tenants/k1/menuItems/beer", { name: "Пиво", price: 300, categoryId: "c3" });

    assert.equal((await req("POST", "/kioskLink", { token: other.idToken, body: { tenantId: "k1" } })).status, 403);
    let r = await req("POST", "/kioskLink", { token: me.idToken, body: { tenantId: "k1" } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.takeawayOn, true);
    const key = r.json.url.split("#")[1];

    const page = await req("GET", "/kiosk/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /script-src 'self'/);
    r = await req("GET", "/kiosk/menu", { headers: { "X-Kiosk-Key": key } });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.json.items.map((i) => i.name), ["Латте"], "без кальянов и алкоголя");
    assert.equal(r.json.items[0].groups[0].options.length, 2);

    r = await req("POST", "/kiosk/order", { headers: { "X-Kiosk-Key": key }, body: { here: true, items: [{ menuItemId: "latte", qty: 2 }] } });
    assert.equal(r.status, 409, "добавка обязательна");
    r = await req("POST", "/kiosk/order", { headers: { "X-Kiosk-Key": key }, body: { here: true, items: [{ menuItemId: "latte", qty: 2, mods: ["Овсяное"] }, { menuItemId: "beer", qty: 1 }] } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.orderNo, "52", "номер — общий счётчик с кассой");
    assert.equal(r.json.total, 560);
    const sessions = (await store.collection("tenants/k1/sessions").get()).docs.map((d) => d.data());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].source, "kiosk");
    assert.equal(sessions[0].orderType, "takeaway");
    assert.equal(sessions[0].deliveryStatus, "new");
    assert.ok(!("customerPhone" in sessions[0]) && !("customerName" in sessions[0]), "без имени и телефона");
    const orders = (await store.collection("tenants/k1/guestOrders").get()).docs.map((d) => d.data());
    assert.equal(orders[0].items.length, 1, "пиво не попало в заказ");
    assert.equal(orders[0].items[0].price, 280);

    assert.equal((await req("POST", "/kiosk/order", { headers: { "X-Kiosk-Key": "x".repeat(24) }, body: { items: [{ menuItemId: "latte", qty: 1, mods: ["Обычное"] }] } })).status, 404);
    await set("tenants/k1/meta/venueProfile", { deliveryEnabled: false });
    assert.equal((await req("POST", "/kiosk/order", { headers: { "X-Kiosk-Key": key }, body: { items: [{ menuItemId: "latte", qty: 1, mods: ["Обычное"] }] } })).status, 409, "выключены заказы с собой");
    r = await req("POST", "/kioskLink", { token: me.idToken, body: { tenantId: "k1", action: "rotate" } });
    assert.equal((await req("GET", "/kiosk/menu", { headers: { "X-Kiosk-Key": key } })).status, 404, "старая ссылка не работает");
    console.log("kiosk: 1 из 1 проверок");
  } catch (e) {
    failed++;
    console.error("FAIL kiosk", e);
  }
  process.exit(failed ? 1 : 0);
})();
