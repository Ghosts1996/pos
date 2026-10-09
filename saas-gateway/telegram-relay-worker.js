/**
 * Ретранслятор Telegram для Cloudflare Workers — на случай, когда сервер в
 * РФ и Telegram не видят друг друга напрямую. Работает в обе стороны:
 *
 *   /<секрет>/bot<токен>/<метод>  → api.telegram.org (сервер пишет в Telegram)
 *   /<секрет>/hook/<заведение>    → HOOK_TARGET/<заведение> (Telegram присылает
 *                                   нажатия кнопок и сообщения на сервер)
 *
 * Как включить — пошагово в saas/README.md («Telegram через Cloudflare»):
 * Worker с этим кодом, секрет RELAY_SECRET в его настройках, адрес
 * https://<имя>.<аккаунт>.workers.dev/<RELAY_SECRET> — в секрет GitHub
 * TELEGRAM_RELAY_URL, дальше сервер настраивается задачей обслуживания.
 *
 * Без секрета в пути отвечает 404 — чужим не пригодится. Ничего не хранит и
 * не логирует; подпись вебхука (X-Telegram-Bot-Api-Secret-Token) проверяет
 * сам сервер.
 */
const HOOK_TARGET = "https://pii.zalpos.ru/saas/tgHook";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, secret, ...rest] = url.pathname.split("/");
    if (!env.RELAY_SECRET || secret !== env.RELAY_SECRET) return notFound();

    if (rest[0] === "hook") {
      if (request.method !== "POST" || rest.length !== 2 || !/^[\w-]{1,128}$/.test(rest[1])) return notFound();
      const target = `${(env.HOOK_TARGET || HOOK_TARGET).replace(/\/+$/, "")}/${rest[1]}`;
      return fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "",
        },
        body: await request.arrayBuffer(),
      });
    }

    if (!/^bot\d+:[\w-]+$/.test(rest[0] || "")) return notFound();
    return fetch(`https://api.telegram.org/${rest.join("/")}${url.search}`, {
      method: request.method,
      headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
    });
  },
};

function notFound() {
  return new Response("Not found", { status: 404 });
}
