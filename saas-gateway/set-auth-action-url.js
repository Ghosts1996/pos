"use strict";

/**
 * Меняет адрес ссылки в письмах Firebase (Authentication → Templates →
 * Action URL) через Identity Toolkit API — когда консоль Firebase отвечает
 * только «An error occurred updating action URL», здесь видна настоящая
 * причина. Ключ сервиса берётся из /etc/saas-gateway.env
 * (FIREBASE_SERVICE_ACCOUNT_B64), запускать от root:
 *
 *   cd /opt/saas-gateway && node set-auth-action-url.js https://zalpos.ru/__/auth/action
 */

const fs = require("fs");
const admin = require("firebase-admin");

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const text = fs.readFileSync("/etc/saas-gateway.env", "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
  }
  return "";
}

async function main() {
  const url = process.argv[2];
  if (!url || !/^https:\/\/[^/]+\/__\/auth\/action$/.test(url)) {
    console.error("Укажите адрес вида https://zalpos.ru/__/auth/action");
    process.exit(1);
  }
  const b64 = envValue("FIREBASE_SERVICE_ACCOUNT_B64");
  if (!b64) throw new Error("нет FIREBASE_SERVICE_ACCOUNT_B64 в /etc/saas-gateway.env");
  const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const { access_token: token } = await admin.credential.cert(sa).getAccessToken();
  const api = `https://identitytoolkit.googleapis.com/admin/v2/projects/${sa.project_id}/config`;

  const res = await fetch(`${api}?updateMask=notification.sendEmail.callbackUri`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ notification: { sendEmail: { callbackUri: url } } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Firebase отказал (${res.status}): ${json.error?.message || JSON.stringify(json)}`);
    process.exit(1);
  }
  console.log(`Готово: ссылки в письмах теперь ведут на ${json.notification?.sendEmail?.callbackUri || url}`);
}

main().catch((e) => {
  console.error("Ошибка:", e.message || e);
  process.exit(1);
});
