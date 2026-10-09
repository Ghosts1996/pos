/**
 * Ретранслятор Telegram Bot API для Cloudflare Workers — на случай, когда с
 * сервера в РФ api.telegram.org недоступен.
 *
 * Как включить:
 *  1. dash.cloudflare.com → Workers & Pages → Create → Worker, вставить этот
 *     файл, Deploy.
 *  2. Settings → Variables → секрет RELAY_SECRET (любая длинная случайная
 *     строка).
 *  3. На сервере в /etc/saas-gateway.env:
 *       TELEGRAM_API_BASE=https://<имя>.<аккаунт>.workers.dev/<RELAY_SECRET>
 *     и перезапустить saas-gateway.
 *
 * Пересылает только запросы вида /<секрет>/bot<токен>/<метод> на
 * api.telegram.org — без секрета в пути отвечает 404, чужим не пригодится.
 * Ничего не хранит и не логирует.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, secret, ...rest] = url.pathname.split("/");
    if (!env.RELAY_SECRET || secret !== env.RELAY_SECRET || !/^bot\d+:[\w-]+$/.test(rest[0] || "")) {
      return new Response("Not found", { status: 404 });
    }
    const target = `https://api.telegram.org/${rest.join("/")}${url.search}`;
    return fetch(target, {
      method: request.method,
      headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
    });
  },
};
