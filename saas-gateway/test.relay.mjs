// Ретранслятор Telegram (Cloudflare Worker): что пропускает и куда.
import assert from "node:assert/strict";
import worker from "./telegram-relay-worker.js";

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return new Response("ok", { status: 200 });
};
const env = { RELAY_SECRET: "s3cret" };
const req = (path, init = {}) => worker.fetch(new Request(`https://relay.example.workers.dev${path}`, init), env);
let n = 0;
const ok = (name, fn) => fn().then(() => { n++; }, (e) => { console.error("FAIL", name, e); process.exitCode = 1; });

await ok("без секрета — 404", async () => {
  assert.equal((await req("/wrong/bot1:abc/getMe")).status, 404);
  assert.equal((await req("/bot1:abc/getMe")).status, 404);
  assert.equal(calls.length, 0);
});
await ok("секрет не задан в настройках — 404 всем", async () => {
  const r = await worker.fetch(new Request("https://x.workers.dev//bot1:abc/getMe"), {});
  assert.equal(r.status, 404);
});
await ok("Bot API — на api.telegram.org с телом", async () => {
  const r = await req("/s3cret/bot123:AA-b_c/sendMessage", { method: "POST", body: '{"chat_id":1}', headers: { "Content-Type": "application/json" } });
  assert.equal(r.status, 200);
  const c = calls.pop();
  assert.equal(c.url, "https://api.telegram.org/bot123:AA-b_c/sendMessage");
  assert.equal(new TextDecoder().decode(c.init.body), '{"chat_id":1}');
});
await ok("не Bot API — 404", async () => {
  assert.equal((await req("/s3cret/file/bot1:a/x")).status, 404);
  assert.equal((await req("/s3cret/../admin")).status, 404);
  assert.equal(calls.length, 0);
});
await ok("вебхук — на сервер с подписью Telegram", async () => {
  const r = await req("/s3cret/hook/tenant_A-1", { method: "POST", body: '{"update_id":5}', headers: { "X-Telegram-Bot-Api-Secret-Token": "hs" } });
  assert.equal(r.status, 200);
  const c = calls.pop();
  assert.equal(c.url, "https://pii.zalpos.ru/saas/tgHook/tenant_A-1");
  assert.equal(c.init.headers["X-Telegram-Bot-Api-Secret-Token"], "hs");
  assert.equal(new TextDecoder().decode(c.init.body), '{"update_id":5}');
});
await ok("вебхук: только POST и только имя заведения", async () => {
  assert.equal((await req("/s3cret/hook/tenant")).status, 404);
  assert.equal((await req("/s3cret/hook/a/b", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await req("/s3cret/hook/a%2F..", { method: "POST", body: "{}" })).status, 404);
  assert.equal(calls.length, 0);
});
console.log(`relay: ${n} проверок`);
