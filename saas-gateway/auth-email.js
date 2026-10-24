"use strict";

/**
 * Письма входа, смены пароля и подтверждения почты в оформлении ZalPOS.
 *
 * Ссылку делает вход платформы (свой или Firebase Admin), письмо уходит
 * через SMTP платформы — см. handleSendAuthEmail в server.js. Ссылки
 * Firebase ведут на страницы самого кабинета (brandAuthLink).
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
  return renderLetter({ ...l, link, siteUrl });
}

/** Письмо с паролем для входа в личный кабинет. */
function passwordLetter(password, { siteUrl = "https://zalpos.ru/" } = {}) {
  return renderLetter({
    subject: "Пароль для входа в ZalPOS",
    title: "Ваш пароль для входа",
    lead: "Пароль для входа в личный кабинет ZalPOS — по кнопке «Войти по паролю», без письма на почту:",
    code: password,
    button: "Открыть личный кабинет",
    link: `${siteUrl}#/login`,
    note: "Сохраните пароль в надёжном месте и удалите это письмо. Сменить пароль можно в «Настройках» личного кабинета.",
    siteUrl,
    hideRawLink: true,
  });
}

/**
 * Приглашение заведения от менеджера партнёрской программы. Кто приглашает
 * и почему пришло письмо — в самом письме; «Это не я» — отказ от писем
 * (ст. 18 38-ФЗ: рассылка — только с согласия получателя).
 */
function partnerInviteLetter({ managerName, venueName = "", link, optOutLink, trialDays = 7, siteUrl = "https://zalpos.ru/" }) {
  const who = managerName ? `${managerName}, менеджер ZalPOS,` : "Менеджер ZalPOS";
  return renderLetter({
    subject: "Приглашение в ZalPOS",
    title: venueName ? `Приглашение для «${venueName}»` : "Приглашение в ZalPOS",
    lead: `${who} приглашает вас попробовать ZalPOS — кассу и управление заведением: зал, склад, брони, лояльность гостей и приложение гостя. Первые ${trialDays} дней бесплатно, карта не нужна.`,
    button: "Зарегистрироваться",
    link,
    note: "Вы получили это письмо, потому что сообщили этот адрес менеджеру и согласились получить приглашение. Регистрация ни к чему не обязывает, подписку оформляете только вы сами.",
    siteUrl,
    footer: optOutLink ? { text: "Согласия на это письмо не было — больше не присылать приглашения", link: optOutLink } : null,
  });
}

/** Менеджера добавили в партнёрскую программу — задать пароль и войти. */
function partnerWelcomeLetter({ name, link, siteUrl = "https://zalpos.ru/" }) {
  return renderLetter({
    subject: "Кабинет менеджера ZalPOS",
    title: name ? `${name}, вас добавили в партнёрскую программу` : "Вас добавили в партнёрскую программу",
    lead: "Задайте пароль — и откройте кабинет менеджера: личная ссылка для клиентов, приглашения по почте, клиенты и ваш доход.",
    button: "Задать пароль и войти",
    link,
    note: "Если вы не ждали этого письма, просто удалите его.",
    siteUrl,
  });
}

/** Уведомление о безопасности: выданы права администратора платформы. */
function superAdminGrantedLetter({ byEmail = "", siteUrl = "https://zalpos.ru/" } = {}) {
  return renderLetter({
    subject: "Доступ к панели платформы ZalPOS",
    title: "Вам открыт доступ к панели платформы",
    lead: `${byEmail ? `Администратор ${byEmail}` : "Администратор платформы"} выдал вашей учётной записи права администратора платформы ZalPOS: заведения, тарифы, менеджеры, поддержка и безопасность.`,
    button: "Открыть панель",
    link: `${siteUrl}#/admin`,
    note: "Если вы не ожидали этого письма, ответьте в поддержку в личном кабинете — доступ снимут. Никому не сообщайте пароль: сотрудники ZalPOS его не спрашивают.",
    siteUrl,
    hideRawLink: true,
  });
}

/** Уведомление о безопасности: права администратора платформы сняты. */
function superAdminRevokedLetter({ siteUrl = "https://zalpos.ru/" } = {}) {
  return renderLetter({
    subject: "Доступ к панели платформы ZalPOS закрыт",
    title: "Доступ к панели платформы закрыт",
    lead: "Права администратора платформы ZalPOS для вашей учётной записи сняты, открытые сеансы завершены. Ваши заведения работают как раньше — в личный кабинет войдите заново.",
    note: "Если это ошибка, обратитесь к администратору платформы.",
    siteUrl,
  });
}

/** Уведомление о безопасности: к кабинету менеджера подключили Telegram. */
function partnerTelegramLetter({ username = "", siteUrl = "https://zalpos.ru/" } = {}) {
  return renderLetter({
    subject: "Telegram подключён к кабинету менеджера ZalPOS",
    title: "Подключён Telegram",
    lead: `К вашему кабинету менеджера ZalPOS подключён Telegram${username ? ` @${username}` : ""}. Теперь кабинет открывается из бота без пароля.`,
    button: "Открыть кабинет",
    link: `${siteUrl}#/partner`,
    note: "Если это были не вы — войдите в кабинет по паролю, нажмите «Переподключить» и напишите в поддержку.",
    siteUrl,
    hideRawLink: true,
  });
}

/** Уведомление о безопасности: пароль изменён. */
function passwordChangedLetter({ siteUrl = "https://zalpos.ru/" } = {}) {
  return renderLetter({
    subject: "Пароль ZalPOS изменён",
    title: "Пароль изменён",
    lead: "Пароль для входа в ZalPOS только что изменён. Входы на других устройствах завершены — там нужно войти заново.",
    button: "Войти в ZalPOS",
    link: `${siteUrl}#/login`,
    note: "Если вы не меняли пароль, сразу восстановите его по ссылке «Забыли пароль?» на странице входа и напишите в поддержку.",
    siteUrl,
    hideRawLink: true,
  });
}

/**
 * Ссылка Firebase (…firebaseapp.com/__/auth/action?mode=…&oobCode=…) →
 * страница самого кабинета: смена пароля и подтверждение почты открываются
 * в оформлении ZalPOS на zalpos.ru, без страницы Google. Свои ссылки
 * платформы (#/auth?…) не меняются.
 */
function brandAuthLink(link, siteUrl = "https://zalpos.ru/") {
  let u;
  try { u = new URL(String(link)); } catch (_) { return link; }
  if (!u.pathname.endsWith("/__/auth/action")) return link;
  const mode = u.searchParams.get("mode");
  const code = u.searchParams.get("oobCode");
  if (!mode || !code) return link;
  const base = String(siteUrl).replace(/\/?$/, "/");
  let cont = null;
  try { cont = new URL(u.searchParams.get("continueUrl") || base); } catch (_) { cont = new URL(base); }
  if (mode === "signIn") {
    // Вход по ссылке Firebase узнаёт по параметрам запроса; хеш — экран кабинета.
    const q = new URLSearchParams({ apiKey: u.searchParams.get("apiKey") || "", oobCode: code, mode: "signIn", lang: "ru" });
    return `${cont.origin}${cont.pathname}?${q}${cont.hash || "#/"}`;
  }
  if (mode === "resetPassword" || mode === "verifyEmail") {
    const back = u.searchParams.get("continueUrl");
    return `${base}#/auth?mode=${mode}&code=${encodeURIComponent(code)}${back ? `&continueUrl=${encodeURIComponent(back)}` : ""}`;
  }
  return link;
}

// Цвета и шрифты — как у сайта (saas/console/console.css): бумага, медь,
// чернильная кнопка, заголовки с засечками. Шрифты не подгружаем (письмо не
// должно ходить на сторонние серверы): Cormorant, если установлен, иначе Georgia.
const C = {
  bg: "#F3EEE6", card: "#FBF8F3", border: "#DFD5C5", text: "#1D1A16", muted: "#736A5D",
  primary: "#A4502A", soft: "#F1E1D3", ink: "#1D1A16", onInk: "#FBF8F3", faint: "#A99E8E",
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const SERIF = "'Cormorant Garamond',Cormorant,Georgia,'Times New Roman',serif";

function renderLetter({ subject, title, lead, code, button, link, note, siteUrl, hideRawLink = false, footer = null }) {
  const l = { subject, title, lead, button, note };
  const site = siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const text = [
    l.title,
    "",
    l.lead,
    ...(code ? ["", code] : []),
    ...(button && link ? ["", `${l.button}: ${link}`] : []),
    ...(l.note ? ["", l.note] : []),
    ...(footer ? ["", `${footer.text}: ${footer.link}`] : []),
    "",
    "—",
    `ZalPOS — касса и управление заведением. ${siteUrl}`,
    "Письмо отправлено автоматически, отвечать на него не нужно.",
  ].join("\n");

  const buttonHtml = button && link ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">
              <tr>
                <td align="center" bgcolor="${C.ink}" style="border-radius:12px;">
                  <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:15px 30px;font-family:${SANS};font-size:16px;font-weight:600;color:${C.onInk};text-decoration:none;border-radius:12px;">${esc(l.button)}</a>
                </td>
              </tr>
            </table>` : "";

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(l.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(l.lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
  <tr>
    <td align="center" style="padding:36px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">
        <tr>
          <td style="padding:0 6px 22px;">
            <div style="font-family:${SERIF};font-size:30px;font-weight:600;line-height:1;color:${C.text};letter-spacing:0.2px;">Zal<i style="color:${C.primary};">POS</i></div>
            <div style="width:28px;height:1px;line-height:1px;font-size:1px;background:${C.primary};margin-top:12px;">&nbsp;</div>
          </td>
        </tr>
        <tr>
          <td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:34px 32px 30px;font-family:${SANS};color:${C.text};">
            <h1 style="margin:0 0 14px;font-family:${SERIF};font-size:30px;line-height:1.12;font-weight:600;color:${C.text};">${esc(l.title)}</h1>
            <p style="margin:0 0 26px;font-size:16px;line-height:1.6;color:${C.muted};">${esc(l.lead)}</p>
            ${code ? `<div style="margin:0 0 26px;padding:16px;border-radius:12px;background:${C.soft};text-align:center;font-family:Menlo,Consolas,'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:1px;color:${C.text};">${esc(code)}</div>` : ""}${buttonHtml}
            ${l.note ? `<p style="margin:24px 0 0;font-size:14px;line-height:1.55;color:${C.muted};">${esc(l.note)}</p>` : ""}
            ${footer ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;"><a href="${esc(footer.link)}" target="_blank" style="color:${C.muted};">${esc(footer.text)}</a></p>` : ""}
            ${hideRawLink || !link || !button ? "" : `<p style="margin:24px 0 0;padding-top:18px;border-top:1px solid ${C.border};font-size:12px;line-height:1.55;color:${C.faint};">
              Кнопка не открывается? Скопируйте ссылку в адресную строку браузера:<br>
              <a href="${esc(link)}" target="_blank" style="color:${C.primary};word-break:break-all;">${esc(link)}</a>
            </p>`}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:22px 12px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.faint};">
            ZalPOS — касса и управление заведением · <a href="${esc(siteUrl)}" style="color:${C.muted};text-decoration:none;">${esc(site)}</a><br>
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

module.exports = {
  authEmailLetter, passwordLetter, partnerInviteLetter, partnerWelcomeLetter, superAdminGrantedLetter, superAdminRevokedLetter,
  partnerTelegramLetter, passwordChangedLetter, brandAuthLink, createMailer, AUTH_EMAIL_TYPES: Object.keys(LETTERS) };
