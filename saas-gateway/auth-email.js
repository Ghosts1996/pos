"use strict";

/**
 * Письма входа, смены пароля и подтверждения почты в оформлении ZalPOS.
 *
 * Firebase отправляет такие письма своим шаблоном, текст которого в его
 * консоли не меняется. Поэтому ссылку делает Firebase Admin (ровно ту же,
 * что прислал бы сам Firebase), а письмо уходит через SMTP платформы —
 * см. handleSendAuthEmail в server.js.
 *
 * Вёрстка — таблицами и встроенными стилями: так письмо одинаково
 * выглядит в Яндекс Почте, Mail.ru, Gmail и Outlook.
 */

const LETTERS = {
  signIn: {
    subject: "Вход в ZalPOS",
    title: "Вход в личный кабинет",
    lead: "Нажмите кнопку, чтобы войти в ZalPOS. Пароль не нужен.",
    button: "Войти в ZalPOS",
    note: "Ссылка одноразовая. Если вы не запрашивали вход, просто удалите это письмо: без ссылки в кабинет никто не попадёт.",
  },
  passwordReset: {
    subject: "Новый пароль для ZalPOS",
    title: "Смена пароля",
    lead: "Мы получили запрос на смену пароля для входа в ZalPOS. Нажмите кнопку и задайте новый пароль.",
    button: "Задать новый пароль",
    note: "Если вы не запрашивали смену пароля, ничего не делайте: пароль останется прежним.",
  },
  verifyEmail: {
    subject: "Подтвердите почту для ZalPOS",
    title: "Подтверждение почты",
    lead: "Подтвердите, что это ваш адрес: на него будут приходить ссылки для входа, уведомления об оплате и важные события заведения.",
    button: "Подтвердить почту",
    note: "Если вы не регистрировались в ZalPOS, просто удалите это письмо.",
  },
};

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** { subject, text, html } письма [type] со ссылкой [link]. */
function authEmailLetter(type, link, { siteUrl = "https://zalpos.ru/" } = {}) {
  const l = LETTERS[type];
  if (!l) throw new Error(`неизвестный тип письма: ${type}`);
  const site = siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const text = [
    l.title,
    "",
    l.lead,
    "",
    `${l.button}: ${link}`,
    "",
    l.note,
    "",
    "—",
    `ZalPOS — касса и управление заведением. ${siteUrl}`,
    "Письмо отправлено автоматически, отвечать на него не нужно.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(l.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#EEF2F8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(l.lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF2F8;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr>
          <td style="background:#0B1630;border-radius:16px 16px 0 0;padding:22px 32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
            <span style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:0.2px;">Zal<span style="color:#59A6FF;">POS</span></span>
          </td>
        </tr>
        <tr>
          <td style="background:#FFFFFF;border-radius:0 0 16px 16px;padding:32px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16213A;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:#0B1630;">${esc(l.title)}</h1>
            <p style="margin:0 0 26px;font-size:16px;line-height:1.55;color:#3A4763;">${esc(l.lead)}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#2F6FED" style="border-radius:12px;">
                  <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:15px 30px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;">${esc(l.button)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:26px 0 0;font-size:14px;line-height:1.5;color:#5B6784;">${esc(l.note)}</p>
            <p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #E3E8F2;font-size:12px;line-height:1.5;color:#8A94AD;">
              Кнопка не открывается? Скопируйте ссылку в адресную строку браузера:<br>
              <a href="${esc(link)}" target="_blank" style="color:#2F6FED;word-break:break-all;">${esc(link)}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:1.5;color:#8A94AD;">
            ZalPOS — касса и управление заведением · <a href="${esc(siteUrl)}" style="color:#8A94AD;">${esc(site)}</a><br>
            Письмо отправлено автоматически, отвечать на него не нужно.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  return { subject: l.subject, text, html };
}

/**
 * Отправка через SMTP платформы (переменные SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS, MAIL_FROM в /etc/saas-gateway.env). null — почта не
 * настроена или не установлен nodemailer: тогда письма отправляет Firebase.
 */
function createMailer(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (e) {
    console.error("auth-email: nodemailer не установлен — выполните npm install в /opt/saas-gateway");
    return null;
  }
  const port = Number(env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.MAIL_FROM || `ZalPOS <${env.SMTP_USER}>`;
  return {
    send: ({ to, subject, text, html }) => transport.sendMail({ from, to, subject, text, html }),
  };
}

module.exports = { authEmailLetter, createMailer, AUTH_EMAIL_TYPES: Object.keys(LETTERS) };
