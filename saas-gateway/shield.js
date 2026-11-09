"use strict";

/**
 * Щит saas-gateway — защита API от ботов, сканеров, подбора паролей и
 * выкачки данных. Работает внутри сервиса, без сторонних программ; активные
 * баны переживают перезапуск (файл state/shield.json, только хеши почт).
 *
 *  - Флуд: больше perMinute запросов в минуту с одного адреса — ответ 429 до
 *    конца минуты; больше floodPerMinute — адрес закрыт на 10 минут.
 *  - Сканеры: /.env, /wp-login.php, /phpmyadmin, ../ и т. п. — у ZalPOS таких
 *    адресов нет, их пробуют только взломщики: 404, а с scanStrikes-й
 *    попытки за 10 минут адрес закрыт на час.
 *  - Программы взлома (sqlmap, nikto, nuclei…) по User-Agent — сразу на час.
 *  - Подбор паролей: неверные пароли и коды с одного адреса (authFailsToBan
 *    за 15 минут — бан на 30 минут) и к одной почте с любых адресов
 *    (emailFailsToLock за сутки — вход по паролю для неё закрыт на 12 часов;
 *    владелец входит через «Забыли пароль?» — ссылка на почту). Админам
 *    платформы — тревога в бот поддержки, владельцу почты — письмо.
 *  - Выкачка данных: пользователь прочитал больше readAlert документов за
 *    10 минут — тревога админам; больше readLimit — чтение притормаживается.
 *  Повторный бан того же адреса за сутки — вдвое дольше (до суток).
 *
 * Свои службы (127.0.0.1, частные сети) не ограничиваются. Мобильные
 * операторы сажают много абонентов на один адрес (CGNAT), поэтому пороги
 * с большим запасом, баны короткие, а IPv6 считается по сети /64.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DEFAULT_LIMITS = {
  perMinute: 2000,
  floodPerMinute: 6000,
  scanStrikes: 3,
  authFailsToBan: 25,
  emailFailsToLock: 20,
  emailLockMs: 12 * HOUR,
  readAlert: 100000,
  readLimit: 1000000,
  surgeBansPerHour: 20,
};

const BAN_MS = { flood: 10 * MIN, scan: HOUR, tool: HOUR, auth: 30 * MIN };

// Адреса, которых у ZalPOS нет: их перебирают сканеры уязвимостей.
const SCAN_RE = new RegExp([
  String.raw`/\.(env|git|svn|hg|bzr|aws|ssh|docker|kube|npmrc|htaccess|htpasswd|ds_store|vscode|idea)(/|$|\.)`,
  String.raw`\.(php\d?|phtml|asp|aspx|jsp|jspx|cgi|cfm)$`,
  String.raw`/(wp-admin|wp-login|wp-content|wp-includes|wordpress|xmlrpc|phpmyadmin|myadmin|mysqladmin|adminer|cgi-bin|actuator|server-status|server-info|jolokia|solr|jenkins|manager/html|boaform|hnap1|owa/|autodiscover|telescope|_ignition|vendor/phpunit)`,
  String.raw`(\.\./|\.\.\\|%2e%2e|%252e|/etc/passwd|/proc/self|win\.ini)`,
  String.raw`/(backup|backups|dump|database|site|www|config|db)\.(sql|zip|tar|tgz|gz|bak|7z|rar)$`,
].join("|"), "i");

// Программы для взлома и поиска уязвимостей сами называют себя в User-Agent.
const TOOL_UA_RE = /\b(sqlmap|nikto|nmap|masscan|zgrab|nuclei|acunetix|netsparker|wpscan|dirbuster|gobuster|ffuf|feroxbuster|hydra|w3af|openvas|nessus|jaeles|commix|xsstrike|arachni|whatweb)\b/i;

// Оплаты и вебхуки защищены своими секретами: их не режем никогда, чтобы
// не потерять оплату гостя или сообщение бота.
const NEVER_LIMIT_RE = /^\/(health$|tgHook\/|robokassa|guestPay)/;

/** Ключ адреса для лимитов; "" — свой/частный адрес, не ограничиваем. */
function ipKey(raw) {
  let ip = String(raw || "").trim().toLowerCase();
  if (!ip || ip === "unknown") return "";
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "";
    return ip;
  }
  if (!ip.includes(":")) return "";
  ip = ip.split("%")[0];
  if (ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)) return "";
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((x) => (x || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** ab***@mail.ru — для тревог админам, без полного адреса. */
function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

const emailHash = (email) => crypto.createHash("sha256").update(`zalpos-shield:${String(email || "").trim().toLowerCase()}`).digest("hex").slice(0, 32);

const minutesText = (ms) => {
  const m = Math.max(1, Math.ceil(ms / MIN));
  if (m < 60) return `${m} мин`;
  const h = Math.ceil(m / 60);
  return `${h} ч`;
};

function createShield({
  ipOf = (req) => (req.socket && req.socket.remoteAddress) || "",
  file = null,
  alert = () => {},
  onEmailLocked = () => {},
  limits = {},
  now = () => Date.now(),
  log = (line) => console.warn(line),
} = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const bans = new Map(); // ключ адреса → { until, reason }
  const levels = new Map(); // ключ адреса → { level, at } — повторные баны за сутки
  const rate = new Map(); // ключ адреса → { w, n }
  const strikes = new Map(); // ключ адреса → { n, reset }
  const authIp = new Map(); // ключ адреса → { n, reset }
  const emails = new Map(); // хеш почты → { n, reset, lockedUntil, ips: Set }
  const buckets = new Map(); // `${имя}|${адрес}` → { n, reset }
  const reads = new Map(); // uid → { w, n }
  const alerted = new Map(); // ключ тревоги → когда
  const ring = []; // по часам: { h, blocked, throttled, bans, scans, tools, authFails, locks, readAlerts }

  const keyOf = (req) => ipKey(ipOf(req));

  function bump(field, n = 1) {
    const h = Math.floor(now() / HOUR);
    let b = ring[ring.length - 1];
    if (!b || b.h !== h) {
      b = { h, blocked: 0, throttled: 0, bans: 0, scans: 0, tools: 0, authFails: 0, locks: 0, readAlerts: 0 };
      ring.push(b);
      while (ring.length > 24) ring.shift();
    }
    b[field] += n;
  }

  function sums(hours = 24) {
    const from = Math.floor(now() / HOUR) - hours + 1;
    const out = { blocked: 0, throttled: 0, bans: 0, scans: 0, tools: 0, authFails: 0, locks: 0, readAlerts: 0 };
    for (const b of ring) if (b.h >= from) for (const k of Object.keys(out)) out[k] += b[k];
    return out;
  }

  /** Тревога не чаще раза в everyMs по одному поводу. */
  function alertOnce(key, everyMs, html) {
    const t = now();
    if (t - (alerted.get(key) || 0) < everyMs) return;
    alerted.set(key, t);
    try { alert(html); } catch (_) { /* бот недоступен — останется журнал */ }
  }

  // ---- сохранение: только активные баны и блокировки почт (хеши)
  let saveTimer = null;
  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  /** Записать сейчас (остановка сервиса). */
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!file) return;
    const t = now();
    const data = {
      bans: [...bans].filter(([, b]) => b.until > t).map(([key, b]) => ({ key, until: b.until, reason: b.reason })),
      levels: [...levels].filter(([, l]) => t - l.at < DAY).map(([key, l]) => ({ key, level: l.level, at: l.at })),
      locks: [...emails].filter(([, e]) => e.lockedUntil > t).map(([key, e]) => ({ key, until: e.lockedUntil })),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`shield: не сохранил ${file}: ${e.message || e}`);
    }
  }

  function load() {
    if (!file) return;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return; }
    const t = now();
    for (const b of Array.isArray(j.bans) ? j.bans : []) {
      if (b && typeof b.key === "string" && Number(b.until) > t) bans.set(b.key, { until: Number(b.until), reason: String(b.reason || "") });
    }
    for (const l of Array.isArray(j.levels) ? j.levels : []) {
      if (l && typeof l.key === "string" && t - Number(l.at) < DAY) levels.set(l.key, { level: Number(l.level) || 0, at: Number(l.at) });
    }
    for (const e of Array.isArray(j.locks) ? j.locks : []) {
      if (e && typeof e.key === "string" && Number(e.until) > t) emails.set(e.key, { n: 0, reset: Number(e.until), lockedUntil: Number(e.until), ips: new Set() });
    }
  }
  load();

  function ban(key, reason) {
    const t = now();
    const prev = levels.get(key);
    const level = prev && t - prev.at < DAY ? Math.min(prev.level + 1, 8) : 0;
    levels.set(key, { level, at: t });
    const ms = Math.min((BAN_MS[reason] || 10 * MIN) * 2 ** level, DAY);
    bans.set(key, { until: t + ms, reason });
    bump("bans");
    log(`shield: ${key} закрыт на ${minutesText(ms)} (${reason}${level ? `, повтор ${level + 1}` : ""})`);
    save();
    const hour = sums(1).bans;
    if (hour >= L.surgeBansPerHour) {
      alertOnce("surge", 6 * HOUR, `🛡 <b>Сервер отбивает атаку</b>\nЗа последний час закрыто адресов: ${hour} (сканеры, флуд, подбор паролей). Защита работает сама, данные в порядке — ничего делать не нужно.`);
    }
    return ms;
  }

  /** Сколько ещё закрыт адрес (мс), 0 — открыт. */
  function bannedFor(key) {
    const b = key && bans.get(key);
    if (!b) return 0;
    const left = b.until - now();
    if (left > 0) return left;
    bans.delete(key);
    return 0;
  }

  const blockedAnswer = (left) => ({
    status: 429,
    code: "too-many-requests",
    retryAfter: Math.ceil(left / 1000),
    error: `С вашего адреса было слишком много подозрительных запросов — доступ временно закрыт. Попробуйте через ${minutesText(left)}.`,
  });

  /**
   * Проверка каждого запроса до разбора адреса. null — пропустить, иначе
   * { status, error, code, retryAfter } — ответить и дальше не обрабатывать.
   */
  function gate(req, urlPath) {
    const p = String(urlPath || "/");
    if (NEVER_LIMIT_RE.test(p)) return null;
    const key = keyOf(req);
    if (!key) return null;
    const t = now();

    const left = bannedFor(key);
    if (left) { bump("blocked"); return blockedAnswer(left); }

    if (TOOL_UA_RE.test(String(req.headers["user-agent"] || ""))) {
      bump("tools");
      bump("blocked");
      return blockedAnswer(ban(key, "tool"));
    }

    // Только путь: в параметрах бывают подписи и курсоры, их не трогаем.
    let decoded = String(req.url || "").split("?")[0];
    try { decoded = decodeURIComponent(decoded); } catch (_) { /* кривая кодировка — проверяем как есть */ }
    if (SCAN_RE.test(p) || SCAN_RE.test(decoded)) {
      bump("scans");
      let s = strikes.get(key);
      if (!s || s.reset <= t) { s = { n: 0, reset: t + 10 * MIN }; strikes.set(key, s); }
      s.n += 1;
      if (s.n >= L.scanStrikes) { strikes.delete(key); bump("blocked"); return blockedAnswer(ban(key, "scan")); }
      return { status: 404, error: "адрес не найден", code: "not-found" };
    }

    const w = Math.floor(t / MIN);
    let r = rate.get(key);
    if (!r || r.w !== w) { r = { w, n: 0 }; rate.set(key, r); }
    r.n += 1;
    if (r.n > L.floodPerMinute) { bump("blocked"); return blockedAnswer(ban(key, "flood")); }
    if (r.n > L.perMinute) {
      bump("throttled");
      const wait = (w + 1) * MIN - t;
      return { status: 429, code: "too-many-requests", retryAfter: Math.ceil(wait / 1000), error: "Слишком много запросов подряд — подождите минуту" };
    }
    return null;
  }

  /** Свой лимит для одного действия: true — превышен (отвечать 429). */
  function hit(name, req, max, windowMs) {
    const key = keyOf(req);
    if (!key) return false;
    const t = now();
    const k = `${name}|${key}`;
    let b = buckets.get(k);
    if (!b || b.reset <= t) { b = { n: 0, reset: t + windowMs }; buckets.set(k, b); }
    b.n += 1;
    if (b.n > max) { bump("throttled"); return true; }
    return false;
  }

  /** Сколько ещё закрыт вход по паролю для почты (мс), 0 — открыт. */
  function emailLocked(email) {
    if (!email) return 0;
    const e = emails.get(emailHash(email));
    if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - now();
    if (left > 0) return left;
    emails.delete(emailHash(email));
    return 0;
  }

  /** Неверный пароль или код. email — к какой почте подбирали (если известно). */
  function authFailed(req, email = "") {
    bump("authFails");
    const t = now();
    const key = keyOf(req);
    if (key) {
      let a = authIp.get(key);
      if (!a || a.reset <= t) { a = { n: 0, reset: t + 15 * MIN }; authIp.set(key, a); }
      a.n += 1;
      if (a.n >= L.authFailsToBan) { authIp.delete(key); ban(key, "auth"); }
    }
    const em = String(email || "").trim().toLowerCase();
    if (!em) return;
    const h = emailHash(em);
    let e = emails.get(h);
    if (!e || (e.reset <= t && !(e.lockedUntil > t))) { e = { n: 0, reset: t + DAY, lockedUntil: 0, ips: new Set() }; emails.set(h, e); }
    e.n += 1;
    if (key && e.ips.size < 200) e.ips.add(key);
    if (e.n >= L.emailFailsToLock && !(e.lockedUntil > t)) {
      e.lockedUntil = t + L.emailLockMs;
      e.reset = e.lockedUntil;
      bump("locks");
      log(`shield: вход по паролю для ${maskEmail(em)} закрыт на ${minutesText(L.emailLockMs)} (${e.n} неверных паролей с ${e.ips.size} адресов)`);
      save();
      alertOnce(`lock:${h}`, DAY, `🔐 <b>Подбор пароля</b>\nК почте ${maskEmail(em)} за сутки ${e.n} неверных паролей с ${e.ips.size} адресов. Вход по паролю для неё закрыт на ${minutesText(L.emailLockMs)}; владелец может войти через «Забыли пароль?» (ссылка на почту). Данные в безопасности.`);
      try { onEmailLocked(em); } catch (_) { /* письмо — не главное */ }
    }
  }

  /** Удачный вход, сброс пароля или вход по ссылке — счётчик почты обнуляется. */
  function authOk(email) {
    if (!email) return;
    const h = emailHash(email);
    if (emails.has(h)) { emails.delete(h); save(); }
  }

  /** Учёт прочитанных документов. true — пользователь сейчас приторможен. */
  function noteReads(uid, n) {
    if (!uid || !(n > 0)) return false;
    const w = Math.floor(now() / (10 * MIN));
    let r = reads.get(uid);
    if (!r || r.w !== w) { r = { w, n: 0 }; reads.set(uid, r); }
    r.n += n;
    if (r.n >= L.readAlert && !alerted.has(`read:${uid}:${w}`)) {
      alerted.set(`read:${uid}:${w}`, now());
      bump("readAlerts");
      log(`shield: пользователь ${uid} прочитал ${r.n} документов за 10 минут`);
      alertOnce(`read:${uid}`, 6 * HOUR, `🛡 <b>Необычно много чтений данных</b>\nПользователь <code>${uid}</code> прочитал ${r.n.toLocaleString("ru-RU")} документов за 10 минут. Если это не выгрузка отчёта владельцем — проверьте, чей это вход, и завершите его сеансы в панели.`);
    }
    return r.n > L.readLimit;
  }

  function readThrottled(uid) {
    const r = uid && reads.get(uid);
    return !!r && r.w === Math.floor(now() / (10 * MIN)) && r.n > L.readLimit;
  }

  // Уборка устаревших счётчиков: память не растёт от потока разных адресов.
  function sweep() {
    const t = now();
    const w = Math.floor(t / MIN);
    for (const [k, r] of rate) if (r.w !== w) rate.delete(k);
    for (const m of [strikes, authIp, buckets]) for (const [k, v] of m) if (v.reset <= t) m.delete(k);
    for (const [k, e] of emails) if (e.reset <= t && !(e.lockedUntil > t)) emails.delete(k);
    for (const [k, b] of bans) if (b.until <= t) bans.delete(k);
    for (const [k, l] of levels) if (t - l.at >= DAY) levels.delete(k);
    const rw = Math.floor(t / (10 * MIN));
    for (const [k, r] of reads) if (r.w !== rw) reads.delete(k);
    for (const [k, at] of alerted) if (t - at > DAY) alerted.delete(k);
  }
  const timer = setInterval(sweep, MIN);
  if (timer.unref) timer.unref();

  /** Сводка для админов: что отбито за сутки и что закрыто сейчас. */
  function status() {
    const t = now();
    let bannedNow = 0;
    for (const b of bans.values()) if (b.until > t) bannedNow += 1;
    let lockedNow = 0;
    for (const e of emails.values()) if (e.lockedUntil > t) lockedNow += 1;
    return { day: sums(24), hour: sums(1), bannedNow, lockedNow };
  }

  return { gate, hit, authFailed, authOk, emailLocked, noteReads, readThrottled, status, sweep, ban, bannedFor, flush, stop: () => { clearInterval(timer); if (saveTimer) clearTimeout(saveTimer); } };
}

module.exports = { createShield, ipKey, maskEmail, SCAN_RE, TOOL_UA_RE, DEFAULT_LIMITS, minutesText };
