"use strict";
/**
 * Карта кода для ИИ-бота поддержки: по каждому файлу проекта — что он делает
 * (комментарии-описания из кода), какие в нём классы и функции и какие
 * надписи видит пользователь (кнопки, экраны). По надписям бот связывает
 * вопрос клиента («не работает «Закрыть стол»») с кодом, который за это
 * отвечает, и понимает, как функция устроена и что она умеет.
 *
 * Самого кода в карте нет — только описания и названия. Всё, что похоже на
 * секрет (ключи, токены, пароли, адреса серверов, IP, почты), вычищается, а
 * файлы с настройками и ключами не читаются вовсе. Клиенту бот названия
 * файлов и устройство программы не называет (см. подсказку в support-bot.js);
 * в теме сотрудников показывает, какие файлы смотрел.
 *
 * Запуск: node build-code-map.js <корень репозитория> <файл.json>
 * (update-server.sh при каждом обновлении сервера).
 */
const fs = require("fs");
const path = require("path");

// Что читаем: приложение (касса и гость), сервер, кабинет, веб гостя.
const ROOTS = [
  ["lib", /\.dart$/],
  ["saas-gateway", /^[^/]+\.js$/],
  ["pii-gateway", /^[^/]+\.js$/],
  ["saas/console", /^[^/]+\.js$/],
  ["saas/guest-web/app", /^[^/]+\.js$/],
];
// Не читаем: ключи и настройки окружения, сгенерированное, тесты, сам бот.
const SKIP = /(firebase_options|google-services|\.g\.dart$|\.freezed\.dart$|generated|(^|\/)test[._]|\.test\.|secret|credential|\.env|support-bot|support-ai|support-kb|support-docs|build-code-map|test-helpers|typograf)/i;

const AREA = [
  [/^lib\/screens\/admin\//, "Касса · экран администратора"],
  [/^lib\/screens\/employee\//, "Касса · экран сотрудника"],
  [/^lib\/screens\//, "Касса · экран"],
  [/^lib\/client\//, "Приложение гостя"],
  [/^lib\/widgets\//, "Касса · элемент интерфейса"],
  [/^lib\/services\/ai\//, "ИИ-помощники"],
  [/^lib\/services\/signals\//, "Звонки и сигналы"],
  [/^lib\/services\//, "Касса · логика"],
  [/^lib\/models\//, "Данные"],
  [/^lib\//, "Касса"],
  [/^saas-gateway\//, "Сервер платформы"],
  [/^pii-gateway\//, "Сервер персональных данных в РФ"],
  [/^saas\/console\//, "Кабинет zalpos.ru"],
  [/^saas\/guest-web\//, "Веб-версия для гостей"],
];

/** Убирает всё, что может быть секретом или внутренним адресом. */
function scrub(text) {
  return String(text || "")
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "")
    .replace(/https?:\/\/[^\s'"`)<>]+/g, (u) => (/^https?:\/\/(zalpos\.ru|www\.zalpos\.ru)(\/|$)/.test(u) ? u : "[адрес]"))
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[адрес]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[почта]")
    .replace(/(?<!\d)(?:\+?7|8)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]+\d{2}[\s-]+\d{2}(?!\d)/g, "[телефон]")
    .replace(/(?<![\d+])\+?[78]\d{10}(?!\d)/g, "[телефон]")
    .replace(/(?<!\d)(\d{12}|\d{10})(?!\d)/g, "[номер]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[ключ]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[ключ]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[ключ]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[ключ]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[ключ]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)['"][^'"]+['"]/gi, "$1[скрыто]");
}

const firstSentence = (t, max = 180) => {
  const s = t.replace(/\s+/g, " ").trim();
  const m = s.match(/^.{20,}?[.!?](\s|$)/);
  const out = (m ? m[0] : s).trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};

/** Комментарии-описания: «///» (Dart) и «/** *\/» или «//» перед объявлениями (JS). */
function docBlocks(src, dart) {
  const blocks = [];
  if (dart) {
    let cur = [];
    for (const line of src.split("\n")) {
      const m = line.match(/^\s*\/\/\/ ?(.*)$/);
      if (m) cur.push(m[1]);
      else {
        if (cur.length) blocks.push({ text: cur.join("\n"), next: line.trim() });
        cur = [];
      }
    }
  } else {
    const re = /\/\*\*([\s\S]*?)\*\/\s*\n?([^\n]*)/g;
    let m;
    while ((m = re.exec(src))) blocks.push({ text: m[1].split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join("\n"), next: m[2].trim() });
    // Первый блок «//» в начале файла — тоже описание.
    const head = src.match(/^(?:"use strict";\s*)?((?:\/\/[^\n]*\n)+)/);
    if (head) blocks.unshift({ text: head[1].split("\n").map((l) => l.replace(/^\/\/ ?/, "")).join("\n"), next: "" });
  }
  return blocks.filter((b) => b.text.trim().length > 15);
}

/** Надписи для пользователя — кириллица в кавычках (кнопки, заголовки, подсказки). */
function uiStrings(src) {
  const out = new Set();
  const re = /(['"`])((?:(?!\1)[^\\\n]){3,70})\1/g;
  let m;
  while ((m = re.exec(src)) && out.size < 60) {
    const s = m[2].trim();
    if (!/[А-Яа-яЁё]{3}/.test(s) || /\$\{|\$[a-z]|\\|^\s*\/\//.test(s)) continue;
    if (/^[а-яё]/.test(s) && s.split(" ").length > 8) continue; // длинные фразы — шум
    out.add(s);
  }
  return [...out];
}

function names(src, dart) {
  const re = dart ? /^(?:abstract\s+|sealed\s+|final\s+)?(?:class|enum|mixin|extension)\s+(\w+)/gm : /^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;
  const out = [];
  let m;
  while ((m = re.exec(src)) && out.length < 25) out.push(m[1] || m[2]);
  return out;
}

function describeFile(rel, src) {
  const dart = rel.endsWith(".dart");
  const blocks = docBlocks(src, dart);
  const area = (AREA.find(([re]) => re.test(rel)) || [null, "Проект"])[1];
  const main = blocks[0] ? blocks[0].text.trim().slice(0, 900) : "";
  const more = blocks.slice(1, 12).map((b) => `• ${b.next ? `${b.next.replace(/[{(].*$/, "").trim().slice(0, 60)} — ` : ""}${firstSentence(b.text)}`);
  const ui = uiStrings(src);
  const text = [
    main,
    more.length ? `Устроено:\n${more.join("\n")}` : "",
    ui.length ? `Надписи на экране: ${ui.slice(0, 40).map((x) => `«${x}»`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
  if (text.length < 40) return null;
  return {
    id: `code:${rel}`,
    file: rel,
    title: `${area} · ${path.basename(rel)}`,
    text: scrub(text).slice(0, 2600),
    kw: scrub(`${names(src, dart).join(" ")} ${rel.replace(/[/_.-]+/g, " ")}`),
  };
}

function walk(dir, base, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|\.|build|tenant-builds|telegram-cache|kb)/.test(e.name)) walk(full, base, acc);
    } else acc.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return acc;
}

/** Карта кода репозитория: [{ id, file, title, text, kw }]. */
function buildCodeMap(repo) {
  const out = [];
  for (const [root, re] of ROOTS) {
    const dir = path.join(repo, root);
    for (const rel of walk(dir, dir)) {
      if (!re.test(rel)) continue;
      const full = `${root}/${rel}`;
      if (SKIP.test(full)) continue;
      let src;
      try {
        src = fs.readFileSync(path.join(dir, rel), "utf8");
      } catch (_) {
        continue;
      }
      const d = describeFile(full, src);
      if (d) out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------- шаблоны настройки
// Справочники из кода приложения → готовые короткие инструкции для бота.
// Пересобираются при каждом обновлении сервера: новый банк или поле в
// приложении — и бот уже знает, куда его вписать.

/** Значения строковых полей конструктора: label: 'a' 'b' → «ab». */
function dartFields(block) {
  const out = {};
  for (const m of block.matchAll(/(\w+):\s*((?:'(?:[^'\\]|\\.)*'\s*)+)/g)) {
    out[m[1]] = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")).join("");
  }
  for (const m of block.matchAll(/(\w+):\s*(true|false)/g)) out[m[1]] = m[2] === "true";
  return out;
}
const RBS_HINT = "СБП включается на стороне банка — тогда гость увидит её на странице оплаты рядом с картой.";
const BANK_SITE = {
  tinkoff: "tbank.ru → Бизнес → Интернет-эквайринг", tinkoff_form: "tbank.ru → Бизнес → Интернет-эквайринг",
  sber: "sberbank.ru → Бизнесу → Интернет-эквайринг", alfa: "alfabank.ru → Бизнесу → Интернет-эквайринг",
  vtb: "vtb.ru → Бизнесу → Интернет-эквайринг", mts: "mtsbank.ru → Бизнесу → Интернет-эквайринг",
  raiffeisen: "raiffeisen.ru → Бизнесу → Приём платежей по СБП", robokassa: "robokassa.com → регистрация магазина (ИП, ООО или самозанятый)",
};

function buildRecipes(repo) {
  const read = (rel) => { try { return fs.readFileSync(path.join(repo, rel), "utf8"); } catch (_) { return ""; } };
  const out = [];
  const pay = read("lib/models/online_pay.dart");
  for (const m of pay.matchAll(/OnlinePayProvider\(([\s\S]*?)\n\s{4}\),/g)) {
    const f = dartFields(m[1].replace(/\$_rbsHint/g, RBS_HINT));
    if (!f.id || !f.label) continue;
    const fields = [f.loginLabel, f.passwordLabel, f.password2Label, f.urlLabel].filter(Boolean);
    out.push({
      id: `recipe:pay:${f.id}`,
      title: `Онлайн-оплата гостей: ${f.label} — как подключить`,
      text: [
        `Гость платит онлайн${f.sbpOnly ? " через СБП" : ""} из приложения или по QR за столом и в заказах доставки.`,
        `1. Подключите у банка интернет-эквайринг (договор)${BANK_SITE[f.id] ? `: ${BANK_SITE[f.id]}` : ""}.`,
        `2. Где взять данные: ${f.hint}`,
        `3. Касса · Админ · **Интеграции** → **Онлайн-оплата гостей** → **Банк**: ${f.label}. Заполните: ${fields.map((x) => `**${x}**`).join(", ")}.${f.hasTestMode ? " Для проверки — флажок тестового режима и тестовые данные банка." : ""}`,
        "4. **Сохранить и проверить подключение** — деньги при проверке не списываются.",
        "5. Касса · Админ · **Профиль заведения** → включите **Гость оплачивает онлайн из приложения** → **Сохранить**.",
      ].join("\n"),
    });
  }
  const banks = [...read("lib/models/terminal_bank.dart").matchAll(/TerminalBank\('[\w-]+',\s*'([^']+)'\)/g)].map((m) => m[1]);
  if (banks.length) {
    out.push({
      id: "recipe:terminal",
      title: "Оплата картой и СБП на терминале банка: какие банки, как настроить",
      text: [
        "Подходит любой терминал любого банка — стационарный, переносной или Tap on Phone. Касса не обязана быть связана с ним кабелем: кассир набирает сумму на терминале, касса спрашивает, прошла ли оплата, и записывает банк в чек и отчёт.",
        `1. Касса · Админ · **Интеграции** → **Терминал оплаты** → **Терминал любого банка**.`,
        `2. **Терминалы каких банков стоят в заведении**: ${banks.join(", ")} или **Другой банк** со своим названием.`,
        "3. Терминал Сбера на Windows-кассе по кабелю — **Сбер — терминал на кассе** (UPOS): сумма уходит на терминал сама.",
        "4. Другой терминал по кабелю на Windows — **Терминал по кабелю — ARCUS 2 и другие**: путь к программе банка и параметры дал банк.",
        "Эквайринг (договор и сам терминал) оформляют в своём банке; ZalPOS комиссию не берёт.",
      ].join("\n"),
    });
  }
  const aggs = [...read("lib/models/aggregator.dart").matchAll(/Aggregator\('[\w-]+',\s*'([^']+)'\)/g)].map((m) => m[1]);
  if (aggs.length) {
    out.push({
      id: "recipe:aggregators",
      title: "Агрегаторы доставки: как учитывать заказы",
      text: [
        `Поддерживаются: ${aggs.join(", ")}.`,
        "1. Касса · Админ · **Интеграции** → **Агрегаторы доставки** → включите нужный и укажите комиссию по договору (для отчёта «к выплате»).",
        "2. В окне оплаты появится способ **Агрегатор**: деньги переведёт агрегатор позже, по своему графику и за вычетом комиссии.",
        "3. Если гость платит в приложении агрегатора, включите **Чек покупателю пробивает агрегатор** — касса свой фискальный чек не печатает.",
        "Договор с агрегатором заключают на его сайте для партнёров.",
      ].join("\n"),
    });
  }
  return out;
}

if (require.main === module) {
  const [repo, outFile] = process.argv.slice(2);
  if (!repo || !outFile) {
    console.error("node build-code-map.js <репозиторий> <файл.json>");
    process.exit(2);
  }
  const map = buildCodeMap(repo);
  const recipes = buildRecipes(repo);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ builtAt: new Date().toISOString(), files: map, recipes }));
  console.log(`карта кода: ${map.length} файлов, шаблонов настройки: ${recipes.length}`);
}

module.exports = { buildCodeMap, buildRecipes, describeFile, scrub, uiStrings };
