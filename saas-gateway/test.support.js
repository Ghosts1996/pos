"use strict";
// ИИ-бот поддержки: триггеры, обезличивание, поиск по инструкции и весь
// путь обращения — клиент в Telegram, тема сотрудников, ответ человека,
// кабинет, обучение, удаление данных. Telegram и ИИ — подделки.
const assert = require("assert");
const crypto = require("crypto");
const { fakeDb, admin, HttpError } = require("./test-helpers");
const sb = require("./support-bot");
const { encrypt, decrypt } = require("./telegram");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- чистые функции

test("слова-триггеры зовут человека, вопросы о кассе — нет", () => {
  for (const t of ["позовите оператора", "Хочу поговорить с человеком", "нужен специалист", "оператор", "соедините с оператором",
    "верните деньги за подписку", "списали деньги дважды", "подам в суд", "напишу жалобу", "не помогло", "хочу удалить мой аккаунт",
    "ДА СКОЛЬКО МОЖНО ЖДАТЬ ВЫ ВООБЩЕ РАБОТАЕТЕ"]) {
    assert.ok(sb.humanTrigger(t), `должен звать человека: ${t}`);
  }
  for (const t of ["как сделать возврат чека", "оператор фискальных данных не принимает чек", "посуда не списывается",
    "за столом 3 человека", "нужно добавить сотрудника", "как посмотреть жалобы гостей", "как удалить данные гостя",
    "отправил в судомойку", "как вернуть оплату гостю по карте", "не собирается APK",
    "как ответить на претензию гостя", "нужен ли юрист для лицензии на алкоголь", "как подать уведомление в роскомнадзор",
    "что грозит от роспотребнадзора за уголок потребителя", "гость оставил жалобу на официанта"]) {
    assert.strictEqual(sb.humanTrigger(t), "", `не должен звать человека: ${t}`);
  }
  assert.ok(sb.isUrgent("Срочно! касса не открывается, гости ждут"));
});

test("короткие фразы без ИИ", () => {
  assert.strictEqual(sb.smallTalk("Спасибо!"), "thanks");
  assert.strictEqual(sb.smallTalk("ок"), "ack");
  assert.strictEqual(sb.smallTalk("Добрый день"), "hello");
  assert.strictEqual(sb.smallTalk("добрый день, не работает касса"), "");
});

test("секреты находятся и скрываются, персональные данные — маскируются для ИИ", () => {
  assert.deepStrictEqual(sb.secretKinds("пароль: qwerty12"), ["пароль"]);
  assert.deepStrictEqual(sb.secretKinds("пароль не подходит"), []);
  assert.deepStrictEqual(sb.secretKinds("забыл пароль от кабинета"), []);
  assert.deepStrictEqual(sb.secretKinds("карта 4111 1111 1111 1111"), ["номер карты"]);
  assert.deepStrictEqual(sb.secretKinds("номер заказа 1234 5678 9012 3456"), [], "не карта, если не сходится контрольная цифра");
  assert.deepStrictEqual(sb.secretKinds("токен 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll"), ["токен бота"]);
  assert.ok(!sb.maskSecrets("пароль: qwerty12").includes("qwerty12"));
  const s = sb.scrubPii("звоните +7 (999) 123-45-67 или 89991234567, почта a.b@mail.ru, @ivan_petrov, ИНН 7701234567");
  for (const leak of ["999", "a.b@mail.ru", "ivan_petrov", "7701234567"]) assert.ok(!s.includes(leak), `утекло ${leak}: ${s}`);
});

test("маркер оператора в ответе ИИ", () => {
  const r = sb.parseAiReply("**Подключаю** специалиста.\n[[ОПЕРАТОР: возврат денег]]");
  assert.deepStrictEqual(r, { text: "Подключаю специалиста.", md: "**Подключаю** специалиста.", escalate: true, reason: "возврат денег", docs: [] });
  assert.strictEqual(sb.parseAiReply("Готово").escalate, false);
  const d = sb.parseAiReply("Нужны согласия.\n[[ДОКУМЕНТ: consent-staff]]\n[[ДОКУМЕНТ: нет-такого]] [[ДОКУМЕНТ: consent-staff]]");
  assert.deepStrictEqual(d.docs, ["consent-staff"]);
  assert.strictEqual(d.text, "Нужны согласия.");
});

test("сотрудники из панели и ссылка на тему", () => {
  assert.deepStrictEqual(sb.parseStaff("123456789 Иван\n987654321, 123456789 дубль\nмусор"), [{ id: 123456789, name: "Иван" }, { id: 987654321, name: "" }]);
  assert.strictEqual(sb.topicLink(-1001234567890, 42), "https://t.me/c/1234567890/42");
  assert.strictEqual(sb.topicLink(-12345, 42), "");
});

test("инструкция находится по вопросу", async () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "saas", "console", "guide.js"), "utf8");
  const { GUIDE } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
  const docs = sb.guideDocs(GUIDE);
  assert.ok(docs.length > 30, `статей: ${docs.length}`);
  const top = sb.rankDocs("как поставить кассу на андроид планшет", docs, 3);
  assert.ok(top.length && top.some((d) => /Android/i.test(d.title)), top.map((d) => d.title).join(" | "));
  const msgs = sb.buildMessages({ venue: "Подписка: оплачена", guide: top, history: [{ authorRole: "owner", text: "мой телефон +79991234567" }] });
  assert.strictEqual(msgs[0].role, "system");
  assert.ok(!JSON.stringify(msgs).includes("9991234567"));
});

test("база знаний: инструкция, статьи поддержки и частые вопросы кабинета находятся по вопросам клиентов", async () => {
  const bot = sb.createSupportBot({ db: () => ({}), admin, debounceMs: 0 });
  const n = await bot.loadGuide();
  const docs = bot._state.guide;
  assert.ok(n > 100 && docs.some((d) => d.kind === "faq") && docs.some((d) => d.kind === "kb"), `документов: ${n}`);
  const top = (q) => sb.rankDocs(q, docs, 3).map((d) => d.title).join(" | ");
  for (const [q, want] of [
    ["как установить кассу на айфон", /iPhone/], ["нужна ли лицензия на алкоголь", /Алкоголь/], ["можно ли курить кальян в кафе", /Кальяны и табак/],
    ["какие документы нужны по персональным данным сотрудников", /Персональные данные/], ["как подать уведомление в ркн", /Роскомнадзор/],
    ["не устанавливается apk на xiaomi", /Android: не устанавливается/], ["сколько стоит тариф", /Тарифы/], ["нужен ли акт за подписку", /акты/],
    ["что должно быть в уголке потребителя", /Права гостя|документы/], ["честный знак пиво разливное", /Честный знак/],
    ["как подключить оплату по сбп гостям", /Онлайн-оплата гостей|способы оплаты/], ["заказы яндекс еда", /Яндекс Еды/],
  ]) assert.ok(want.test(top(q)), `${q} → ${top(q)}`);
});

test("документы Word: настоящий docx с реквизитами заведения и ZalPOS", () => {
  const docsMod = require("./support-docs");
  const zlib = require("zlib");
  const unzip = (buf) => {
    const out = {};
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
      const csize = buf.readUInt32LE(i + 18);
      const nlen = buf.readUInt16LE(i + 26);
      const elen = buf.readUInt16LE(i + 28);
      const name = buf.slice(i + 30, i + 30 + nlen).toString("utf8");
      const data = zlib.inflateRawSync(buf.slice(i + 30 + nlen + elen, i + 30 + nlen + elen + csize));
      assert.strictEqual(docsMod.crc32(data), buf.readUInt32LE(i + 14), `CRC ${name}`);
      out[name] = data.toString("utf8");
      i += 30 + nlen + elen + csize;
    }
    return out;
  };
  const venue = { name: "Колибри", sellerName: "ООО «Колибри»", sellerInn: "7701234567", sellerOgrn: "1157746000000", sellerAddress: "г. Москва, ул. Ленина, 1" };
  for (const d of docsMod.DOCS) {
    const r = docsMod.buildDoc(d.id, { venue, platform: { fullName: "Иванов Иван Иванович", inn: "500100732259", ogrnip: "304500116000157", address: "г. Москва" } });
    const files = unzip(r.buffer);
    assert.ok(files["[Content_Types].xml"] && files["_rels/.rels"] && files["word/document.xml"], d.id);
    assert.ok(r.filename.endsWith(".docx") && r.filled);
    assert.ok(files["word/document.xml"].includes("Колибри"), `${d.id}: нет реквизитов заведения`);
  }
  const consent = unzip(docsMod.buildDoc("consent-staff", { venue, platform: { fullName: "Иванов Иван Иванович", inn: "500100732259" } }).buffer)["word/document.xml"];
  assert.ok(consent.includes("ОГРН 1157746000000") && consent.includes("Иванов Иван Иванович") && consent.includes("по поручению"));
  const blank = docsMod.buildDoc("order-pdn", {});
  assert.strictEqual(blank.filled, false);
  assert.strictEqual(docsMod.buildDoc("нет-такого", {}), null);
});

test("оформление: карточка заведения с разделами и списком проблем, Markdown ИИ → HTML", () => {
  const now = Date.parse("2026-10-17T19:30:00Z");
  const info = {
    id: "BoOue", name: "Колибри <Лаунж>", slug: "kolibri", status: "active", chain: true,
    sub: { plan: "Сеть", status: "active", until: Date.parse("2027-04-30T12:00:00Z"), cancelAtPeriodEnd: true },
    devices: { active: 12, disabled: 0, platforms: ["windows", "android"], lastSeen: now - 3600 * 1000, stale: 11 },
    builds: [{ key: "guest/android", status: "success", at: now }, { key: "pos/windows", status: "failed", at: now, error: "нет места" }],
    bot: { username: "kolibri_bot", ownerChat: true, staffChat: false }, aiEnabled: false,
    setup: { kassa: "", terminal: "терминал банка", terminalBanks: 0, onlinePay: "off", seller: false, printer: "", egais: false, delivery: true, menuItems: 0, tables: 6 },
  };
  const card = sb.venueCard(info, { staff: true, now });
  for (const want of ["🏪 <b>Колибри &lt;Лаунж&gt;</b>", "💳 <b>Подписка</b>", "до 30 апреля 2027", "Автопродление выключено", "Последний вход: сегодня в 21:30",
    "❌ Касса Windows — ошибка", "<i>нет места</i>", "✅ Карта зала — 6 столов", "❌ Меню — пусто", "❌ Онлайн-касса 54-ФЗ — не подключена",
    "⚠️ <b>Что требует внимания</b>", "1. Касса Windows: сборка с ошибкой", "ID: <code>BoOue</code>"]) assert.ok(card.includes(want), `нет «${want}» в\n${card}`);
  assert.ok(!sb.venueCard(info, { now }).includes("BoOue"), "клиенту не показываем внутренний ID");
  const brief = sb.venueBrief(info, now);
  assert.ok(!/<[a-z]/.test(brief) && brief.includes("Меню пустое") && brief.length < card.length);
  assert.strictEqual(sb.venueIssues({ ...info, sub: { status: "expired" } }, now)[0].startsWith("Подписка не оплачена"), true);
  assert.strictEqual(sb.fmtWhen(now - 86400000, now).startsWith("вчера"), true);
  assert.strictEqual(sb.mdToHtml("**Готово** <script>\n- шаг `Админ`\n### Итог"), "<b>Готово</b> &lt;script&gt;\n• шаг <code>Админ</code>\n<b>Итог</b>");
  assert.strictEqual(sb.venueCard("строка <b>"), "строка &lt;b&gt;");
});

test("ИИ на паузе после человека и при ожидании человека", () => {
  const now = Date.now();
  assert.strictEqual(sb.aiPaused({}, now), false);
  assert.strictEqual(sb.aiPaused({ escalated: true }, now), true);
  assert.strictEqual(sb.aiPaused({ aiPausedUntil: now + 1000 }, now), true);
  assert.strictEqual(sb.aiPaused({ aiPausedUntil: now - 1000 }, now), false);
  assert.strictEqual(sb.aiPaused({ aiMode: "off" }, now), true);
});


// ---------------------------------------------------------------- ИИ: ключи и модели

test("ИИ: старые настройки, автовыбор моделей, сложность вопроса, разбор ошибок", () => {
  const ai = require("./support-ai");
  const legacy = ai.normalizeProviders({ vendor: "tooken", baseUrl: "https://tooken.club/v1", model: "gpt-4o-mini", keyEnc: "v1:x" });
  assert.deepStrictEqual([legacy[0].id, legacy[0].light, legacy[0].heavy, legacy[0].format], ["p1", "gpt-4o-mini", "gpt-4o", "openai"]);
  assert.strictEqual(ai.normalizeProviders({ providers: [{ vendor: "anthropic", keyEnc: "k" }] })[0].format, "anthropic");
  assert.deepStrictEqual(ai.pickModels(["text-embedding-3-small", "gpt-4o-2024-08-06", "gpt-4o", "gpt-4o-mini", "whisper-1"], "custom"), { light: "gpt-4o-mini", heavy: "gpt-4o" });
  assert.deepStrictEqual(ai.pickModels(["claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-opus-4-1"], "custom"), { light: "claude-haiku-4-5-20251001", heavy: "claude-sonnet-4-5" });
  assert.deepStrictEqual(ai.pickModels(["deepseek-chat", "deepseek-reasoner"], "deepseek"), { light: "deepseek-chat", heavy: "deepseek-reasoner" });
  assert.strictEqual(ai.needsHeavy("как добавить официанта"), false);
  assert.strictEqual(ai.needsHeavy("нужна ли лицензия на алкоголь и какой штраф"), true);
  assert.strictEqual(ai.needsHeavy("сравни тарифы и посчитай, что выгоднее"), true);
  assert.strictEqual(ai.needsHeavy("ок", [{ authorRole: "ai" }, { authorRole: "ai" }, { authorRole: "ai" }]), true);
  assert.strictEqual(ai.classifyError(402, "").kind, "exhausted");
  assert.strictEqual(ai.classifyError(400, "Your credit balance is too low").kind, "exhausted");
  assert.strictEqual(ai.classifyError(403, "insufficient_quota").kind, "exhausted");
  assert.strictEqual(ai.classifyError(401, "Invalid API key").kind, "auth");
  assert.strictEqual(ai.classifyError(404, "model not found").kind, "model");
  assert.strictEqual(ai.classifyError(429, "slow down").kind, "rate");
  assert.strictEqual(ai.classifyError(502, "").kind, "down");
  const a = ai.toAnthropic([{ role: "system", content: "S1" }, { role: "system", content: "S2" }, { role: "assistant", content: "привет" }, { role: "user", content: "?" }]);
  assert.strictEqual(a.system, "S1\n\nS2");
  assert.strictEqual(a.messages[0].role, "user");
});

test("ИИ: кончились токены у первого ключа — отвечает второй, первый отдыхает; Anthropic тоже", async () => {
  const ai = require("./support-ai");
  let t = 1_000_000;
  const hits = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    hits.push({ url, model: body.model, key: opts.headers.Authorization || opts.headers["x-api-key"] });
    if (url.startsWith("https://a.example")) return { ok: false, status: 402, json: async () => ({ error: { message: "Insufficient balance" } }) };
    if (url.startsWith("https://b.example")) return { ok: false, status: 404, json: async () => ({ error: { message: "model gpt-4o not found" } }) };
    if (url === "https://api.anthropic.com/v1/messages") {
      assert.ok(body.system && body.messages[0].role === "user" && opts.headers["anthropic-version"]);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ Claude" }], usage: { input_tokens: 10, output_tokens: 5 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `ответ ${body.model}` } }], usage: { total_tokens: 7 } }) };
  };
  const switches = [];
  const r = ai.createAiRouter({ fetchImpl, now: () => t, getKey: (p) => `key-${p.id}`, onSwitch: (a, b) => switches.push(`${a.id}>${b.id}`) });
  const providers = ai.normalizeProviders({ providers: [
    { id: "a", vendor: "custom", baseUrl: "https://a.example/v1", light: "m-light", heavy: "m-heavy", keyEnc: "x" },
    { id: "b", vendor: "custom", baseUrl: "https://b.example/v1", light: "gpt-4o-mini", heavy: "gpt-4o", keyEnc: "x" },
    { id: "c", vendor: "anthropic", keyEnc: "x" },
  ] });
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "вопрос" }];
  const first = await r.complete(providers, msgs, { tier: "heavy" });
  assert.strictEqual(first.provider.id, "c");
  assert.strictEqual(first.text, "Ответ Claude");
  assert.strictEqual(first.tokens, 15);
  assert.deepStrictEqual(hits.map((x) => x.model), ["m-heavy", "gpt-4o", "gpt-4o-mini", "claude-sonnet-5-5"], "у b нет сильной модели — пробуем лёгкую");
  assert.strictEqual(r.status.get("a").state, "exhausted");
  assert.deepStrictEqual(switches, ["a>c"]);
  hits.length = 0;
  await r.complete(providers, msgs, { tier: "light" });
  assert.ok(!hits.some((x) => x.url.startsWith("https://a.example")), "ключ с пустым балансом отдыхает");
  t += 7 * 3600 * 1000;
  hits.length = 0;
  await r.complete(providers, msgs, { tier: "light" }).catch(() => {});
  assert.ok(hits[0].url.startsWith("https://a.example"), "через 6 часов ключ пробуем снова");
  await assert.rejects(r.complete(providers.slice(0, 1), msgs), /все ключи недоступны/);
});

// ---------------------------------------------------------------- весь путь

function harness() {
  const { db, store } = fakeDb();
  const calls = [];
  const aiCalls = [];
  const aiReplies = [];
  let msgId = 100;
  let topicId = 500;
  const fetchImpl = async (url, opts) => {
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    const body = isForm
      ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : { file: v.name, size: v.size }]))
      : JSON.parse(opts.body || "{}");
    if (url.endsWith("/chat/completions")) {
      aiCalls.push(body);
      const content = aiReplies.length ? aiReplies.shift() : "1. Откройте «Устройства».\n2. Нажмите «Собрать APK».";
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 120 } }) };
    }
    const method = url.split("/").pop();
    calls.push({ method, body });
    if (method === "sendMessage" && body.parse_mode === "HTML" && flags.failHtml) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    const result = {
      getMe: { id: 999, username: "zalpos_help_bot" },
      getChat: { id: -1001234567890, type: "supergroup", is_forum: true, title: "Поддержка ZalPOS" },
      getChatMember: { status: "administrator", can_manage_topics: true },
      createForumTopic: { message_thread_id: ++topicId },
      sendMessage: { message_id: ++msgId },
    }[method] ?? true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  const flags = { failHtml: false };
  const key = crypto.randomBytes(32);
  const sent = {};
  const bot = sb.createSupportBot({
    db: () => db, admin, HttpError,
    verifyAuth: async (req) => ({ uid: req.uid || "sa" }),
    requireSuperAdmin: async () => ({}),
    requireTenantRole: async (tenantId, uid) => { if (uid !== "owner1") throw new HttpError(403, "нет"); },
    parseJsonBody: async (req) => req.body,
    readBody: async (req) => req.raw,
    sendJson: (res, code, obj) => { sent.code = code; sent.body = obj; },
    publicUrl: "https://pii.example/saas",
    fetchImpl, secretKey: () => key, encrypt, decrypt,
    aiVendors: { tooken: { baseUrl: "https://ai.example/v1", model: "gpt-4o-mini" } },
    venueStatus: async (tid) => `Заведение ${tid}: подписка оплачена; сборка кассы — ошибка: нет места`,
    platformStatus: async () => "Сервер работает",
    recentErrors: () => ["12:00: build failed for t1"],
    docData: async (tid) => ({ venue: tid ? { name: "Колибри", sellerName: "ООО «Колибри»", sellerInn: "7701234567" } : {}, platform: {} }),
    debounceMs: 0,
    guidePath: require("path").join(__dirname, "..", "saas", "console", "guide.js"),
  });
  return { bot, db, store, calls, aiCalls, aiReplies, sent, flags };
}

const GROUP = -1001234567890;
const pm = (text, id = 42, extra = {}) => ({ message: { message_id: Math.floor(Math.random() * 1e6), from: { id, first_name: "Анна", username: "anna" }, chat: { id, type: "private" }, text, ...extra } });
const inTopic = (text, topic, from = { id: 7, first_name: "Мария" }) => ({ message: { message_id: 1, from, chat: { id: GROUP, type: "supergroup", is_forum: true }, is_topic_message: true, message_thread_id: topic, text } });
const tickets = (store) => [...store.entries()].filter(([k]) => /^supportTickets\/[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split("/")[1], ...v }));
const messagesOf = (store, id) => [...store.entries()].filter(([k]) => k.startsWith(`supportTickets/${id}/messages/`)).map(([, v]) => v)
  .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
// Текст сообщения без HTML-оформления Telegram — проверяем смысл, а не теги.
const sends = (calls, chatId) => calls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === Number(chatId))
  .map((c) => ({ ...c, body: { ...c.body, text: String(c.body.text || "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") } }));

async function setup(h) {
  await h.bot.start();
  await h.bot.handleSetup({ body: {
    token: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll",
    ai: { vendor: "tooken", apiKey: "sk-test-key-1234567890abcdef" },
    groupChatId: String(GROUP), staff: "555000111 Константин", workHours: "с 10 до 22 МСК",
  } }, {});
  assert.strictEqual(h.sent.code, 200, JSON.stringify(h.sent.body));
}

test("настройка из панели: токен, ИИ, группа, сотрудники; ключи — зашифрованы", async () => {
  const h = harness();
  await setup(h);
  const cfg = h.store.get("supportBot/config");
  assert.strictEqual(cfg.groupChatId, GROUP);
  assert.deepStrictEqual(cfg.staff, [{ id: 555000111, name: "Константин" }]);
  assert.ok(!JSON.stringify(cfg).includes("AAAbbbCCC") && !JSON.stringify(cfg).includes("sk-test-key"), "секреты в открытом виде");
  assert.ok(h.calls.some((c) => c.method === "setWebhook" && c.body.url.endsWith("/tgHook/_support")));
  assert.strictEqual(h.sent.body.connected, true);
  assert.strictEqual(h.sent.body.group.canManageTopics, true);
  assert.ok(h.sent.body.guideArticles > 30);
});

test("клиент: приветствие с законным уведомлением и кнопками, вопрос → тема и ответ ИИ без телефона", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("/start"));
  const hello = sends(h.calls, 42)[0];
  assert.ok(/ИИ-ассистент/.test(hello.body.text) && /Политика/.test(hello.body.text) && /\/delete/.test(hello.body.text));
  assert.ok(hello.body.reply_markup.keyboard.flat().some((b) => b.text === "👤 Позвать человека"));

  await h.bot.handleUpdate(pm("Не собирается APK, мой телефон +7 999 123-45-67"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  assert.ok(t && t.topicId && t.no === 1, JSON.stringify(t));
  assert.ok(h.calls.some((c) => c.method === "createForumTopic" && /#1/.test(c.body.name)));
  const card = sends(h.calls, GROUP).find((c) => /Обращение #1/.test(c.body.text));
  assert.ok(card && card.body.reply_markup.inline_keyboard.flat().some((b) => b.text === "🙋 Беру"));
  assert.strictEqual(h.aiCalls.length, 1);
  const prompt = JSON.stringify(h.aiCalls[0].messages);
  assert.ok(!prompt.includes("123-45-67") && prompt.includes("[телефон]"), "телефон ушёл в ИИ");
  assert.ok(prompt.includes("не привязан") && prompt.includes("Сервер работает"), "нет состояния");
  const answer = sends(h.calls, 42).find((c) => /Собрать APK/.test(c.body.text));
  assert.strictEqual(answer.body.parse_mode, "HTML");
  assert.ok(answer && answer.body.reply_markup.inline_keyboard[0].some((b) => b.callback_data === `sb:ok:${t.id}`));
  const roles = messagesOf(h.store, t.id).map((m) => m.authorRole);
  assert.deepStrictEqual(roles, ["owner", "ai"]);
});

test("сотрудник ответил в теме → клиенту, ИИ замолкает", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("Не печатает чек"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  await h.bot.handleUpdate(inTopic("Анна, проверьте бумагу в принтере", t.topicId));
  await h.bot.idle();
  const toClient = sends(h.calls, 42).find((c) => /Мария, ZalPOS/.test(c.body.text));
  assert.ok(toClient, "ответ не дошёл клиенту");
  const after = tickets(h.store)[0];
  assert.ok(after.aiPausedUntil > Date.now() && after.assignee === "Мария" && after.firstResponseAt);
  const aiBefore = h.aiCalls.length;
  await h.bot.handleUpdate(pm("Бумага есть, всё равно молчит"));
  await h.bot.idle();
  assert.strictEqual(h.aiCalls.length, aiBefore, "ИИ влез в разговор человека");
  await h.bot.handleUpdate(inTopic("/ai", t.topicId));
  assert.strictEqual(tickets(h.store)[0].aiPausedUntil, 0);
});

test("«позовите оператора» → 🔴, сигнал сотрудникам, ИИ не отвечает", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("позовите оператора, пожалуйста"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  assert.strictEqual(t.escalated, true);
  assert.strictEqual(h.aiCalls.length, 0);
  assert.ok(h.calls.some((c) => c.method === "editForumTopic" && c.body.name.startsWith("🔴")));
  const staff = sends(h.calls, 555000111)[0];
  assert.ok(staff && /Нужен человек/.test(staff.body.text) && staff.body.reply_markup.inline_keyboard[0][0].url.includes("t.me/c/1234567890/"));
  assert.ok(sends(h.calls, 42).some((c) => /Позвал специалиста/.test(c.body.text) && /с 10 до 22/.test(c.body.text)));
  // Кнопка «Беру» в теме — обращение за сотрудником, клиент узнаёт.
  await h.bot.handleUpdate({ callback_query: { id: "q1", from: { id: 7, first_name: "Мария" }, data: `sb:g:take:${t.id}`, message: { message_id: 3, chat: { id: GROUP } } } });
  await h.bot.idle();
  assert.strictEqual(tickets(h.store)[0].assignee, "Мария");
  assert.ok(sends(h.calls, 42).some((c) => /Мария из поддержки ZalPOS подключился/.test(c.body.text)));
});

test("ИИ сам зовёт человека маркером; пароль удаляется из чата", async () => {
  const h = harness();
  await setup(h);
  h.aiReplies.push("Это вопрос по оплате, подключаю специалиста.\n[[ОПЕРАТОР: оплата подписки]]");
  await h.bot.handleUpdate(pm("Почему счёт за тариф вырос?"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  assert.strictEqual(t.escalated, true);
  assert.strictEqual(t.escalatedReason, "оплата подписки");
  assert.ok(!sends(h.calls, 42).some((c) => /\[\[/.test(c.body.text)), "маркер виден клиенту");

  await h.bot.handleUpdate(pm("пароль: Qwerty123 не подходит"));
  await h.bot.idle();
  assert.ok(h.calls.some((c) => c.method === "deleteMessage"));
  assert.ok(!JSON.stringify([...h.store.values()]).includes("Qwerty123"), "пароль сохранился");
});

test("кабинет: обращение владельца → тема, ответ ИИ в кабинет; ответ из панели → пауза ИИ", async () => {
  const h = harness();
  await setup(h);
  const at = Date.now() - 1000;
  const T = admin.firestore.Timestamp.fromMillis;
  h.store.set("supportTickets/c1", { tenantId: "t1", subject: "Не собирается APK", status: "open", createdBy: "owner1", createdAt: T(at), updatedAt: T(at), lastAuthorRole: "owner" });
  h.store.set("supportTickets/c1/messages/m1", { text: "Нажимаю «Собрать APK» — ошибка", authorUid: "owner1", authorRole: "owner", createdAt: T(at) });
  h.bot.onTicketDoc("c1", h.store.get("supportTickets/c1"));
  await h.bot.idle();
  const t = h.store.get("supportTickets/c1");
  assert.ok(t.topicId && t.channel === "cabinet" && t.no);
  assert.strictEqual(h.aiCalls.length, 1);
  assert.deepStrictEqual(messagesOf(h.store, "c1").map((m) => m.authorRole), ["owner", "ai"]);
  assert.ok(t.syncedAt >= t.updatedAt.toMillis(), "свой ответ примется за новый");
  // Повторное событие о том же — ничего не делает.
  h.bot.onTicketDoc("c1", h.store.get("supportTickets/c1"));
  await h.bot.idle();
  assert.strictEqual(h.aiCalls.length, 1);
  // Ответ из панели супер-админа.
  const at2 = Date.now() + 10;
  h.store.set("supportTickets/c1/messages/m9", { text: "Освободили место, пересоберите", authorUid: "sa", authorRole: "super_admin", createdAt: T(at2) });
  h.store.set("supportTickets/c1", { ...h.store.get("supportTickets/c1"), updatedAt: T(at2 + 1), lastAuthorRole: "super_admin" });
  h.bot.onTicketDoc("c1", h.store.get("supportTickets/c1"));
  await h.bot.idle();
  assert.ok(sends(h.calls, GROUP).some((c) => /Ответ из панели/.test(c.body.text)));
  assert.ok(h.store.get("supportTickets/c1").aiPausedUntil > Date.now());
});

test("обучение: /learn → запись базы без персональных данных, дальше она в подсказке ИИ", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("Касса Windows не видит принтер чеков"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  await h.bot.handleUpdate(inTopic("Установите драйвер принтера и выберите его в «Принтеры»", t.topicId));
  h.aiReplies.push('{"q":"Касса на Windows не видит чековый принтер, звонить Анне +79991234567","a":"1. Установите драйвер. 2. Касса · Админ · «Принтеры» → выберите принтер.","tags":["принтер","windows"]}');
  await h.bot.handleUpdate(inTopic("/learn", t.topicId));
  await h.bot.idle();
  const kb = [...h.store.entries()].filter(([k]) => k.startsWith("supportKnowledge/")).map(([, v]) => v);
  assert.strictEqual(kb.length, 1);
  assert.ok(!kb[0].q.includes("9991234567"), kb[0].q);
  await h.bot.handleUpdate(inTopic("/close", t.topicId));
  await h.bot.idle();
  assert.strictEqual(tickets(h.store)[0].status, "closed");
  assert.ok(sends(h.calls, 42).some((c) => /Оцените/.test(c.body.text)));
  // Новый похожий вопрос — запись базы в подсказке.
  await h.bot.handleUpdate(pm("/new"));
  await h.bot.handleUpdate(pm("Принтер чеков не видит касса на windows"));
  await h.bot.idle();
  const last = h.aiCalls[h.aiCalls.length - 1];
  assert.ok(JSON.stringify(last.messages).includes("Установите драйвер"), "база знаний не попала в подсказку");
});

test("вход из кабинета привязывает заведение; «Моё заведение» показывает состояние", async () => {
  const h = harness();
  await setup(h);
  h.store.set("tenants/t1", { name: "Колибри" });
  await h.bot.handleClientLink({ uid: "owner1", body: { tenantId: "t1" } }, {});
  const url = h.sent.body.url;
  assert.ok(/^https:\/\/t\.me\/zalpos_help_bot\?start=sup_[a-f0-9]{16}$/.test(url), url);
  await h.bot.handleUpdate(pm(`/start ${url.split("start=")[1]}`));
  assert.strictEqual(h.store.get("supportClients/42").tenantId, "t1");
  assert.ok(sends(h.calls, 42).some((c) => /Колибри/.test(c.body.text)));
  await h.bot.handleUpdate(pm("🏪 Моё заведение"));
  assert.ok(sends(h.calls, 42).some((c) => /подписка оплачена/.test(c.body.text)));
  await h.bot.handleUpdate(pm("Почему не собирается касса?"));
  await h.bot.idle();
  const prompt = JSON.stringify(h.aiCalls[h.aiCalls.length - 1].messages);
  assert.ok(prompt.includes("сборка кассы — ошибка: нет места") && prompt.includes("build failed for t1"), "ИИ не видит состояние и ошибки заведения");
  assert.strictEqual(tickets(h.store)[0].tenantId, "t1");
  await assert.rejects(h.bot.handleClientLink({ uid: "stranger", body: { tenantId: "t1" } }, {}), /нет/);
});

test("«Мои данные» → удалить: сообщения клиента стираются", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("Как добавить кальянщика?"));
  await h.bot.idle();
  const [t] = tickets(h.store);
  await h.bot.handleUpdate({ callback_query: { id: "q", from: { id: 42 }, data: "sb:c:forget2", message: { message_id: 9, chat: { id: 42 } } } });
  const msgs = messagesOf(h.store, t.id).filter((m) => m.authorRole === "owner");
  assert.ok(msgs.length && msgs.every((m) => m.text === "[удалено по просьбе клиента]"));
  assert.strictEqual(h.store.has("supportClients/42"), false);
  assert.strictEqual(tickets(h.store)[0].tgChatId, null);
});

test("вебхук с чужим секретом — 403", async () => {
  const h = harness();
  await setup(h);
  let code = 0;
  await h.bot.handleHook({ headers: { "x-telegram-bot-api-secret-token": "чужой" }, raw: "{}" }, { writeHead: (c) => { code = c; }, end: () => {} });
  assert.strictEqual(code, 403);
  const secret = h.store.get("supportBot/config").hookSecret;
  await h.bot.handleHook({ headers: { "x-telegram-bot-api-secret-token": secret }, raw: JSON.stringify(pm("/start")) }, { writeHead: (c) => { code = c; }, end: () => {} });
  assert.strictEqual(code, 200);
});

test("документы: кнопка в меню, ИИ предлагает документ, файл приходит в чат", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("/start"));
  assert.ok(sends(h.calls, 42)[0].body.reply_markup.keyboard.flat().some((b) => b.text === "📄 Документы"));
  await h.bot.handleUpdate(pm("📄 Документы"));
  const menu = sends(h.calls, 42).find((c) => /Документы для заведения/.test(c.body.text));
  assert.ok(menu && menu.body.reply_markup.inline_keyboard.length === 7);
  h.aiReplies.push("Для работников нужно отдельное согласие.\n[[ДОКУМЕНТ: consent-staff]]");
  await h.bot.handleUpdate(pm("Какие бумаги подписать с сотрудниками по персональным данным?"));
  await h.bot.idle();
  const prompt = JSON.stringify(h.aiCalls[h.aiCalls.length - 1].messages);
  assert.ok(prompt.includes("юридический помощник") && prompt.includes("consent-staff") && prompt.includes("Персональные данные"), "подсказка без юриста и знаний");
  const answer = sends(h.calls, 42).find((c) => /отдельное согласие/.test(c.body.text));
  assert.ok(answer.body.reply_markup.inline_keyboard[0][0].callback_data === "sb:doc:consent-staff", JSON.stringify(answer.body.reply_markup));
  await h.bot.handleUpdate({ callback_query: { id: "d1", from: { id: 42 }, data: "sb:doc:consent-staff", message: { message_id: 5, chat: { id: 42 } } } });
  const file = h.calls.find((c) => c.method === "sendDocument");
  assert.ok(file && String(file.body.chat_id) === "42" && /\.docx$/.test(file.body.document.file) && file.body.document.size > 1000, JSON.stringify(file));
  assert.ok(/Реквизиты не заполнены/.test(file.body.caption), "не привязанный клиент — без реквизитов");
});

test("Telegram не принял оформление — то же сообщение уходит простым текстом", async () => {
  const h = harness();
  await setup(h);
  h.flags.failHtml = true;
  await h.bot.handleUpdate(pm("/start"));
  const tries = h.calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === "42");
  assert.strictEqual(tries.length, 2);
  assert.ok(!tries[1].body.parse_mode && !/<b>/.test(tries[1].body.text) && /Здравствуйте/.test(tries[1].body.text));
});

test("админка в боте: кнопка только у админов, настройки кнопками, ввод сотрудника", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleSetup({ body: { admins: "777000111 Константин" } }, {});
  await h.bot.handleUpdate(pm("/start", 777000111));
  const kb = sends(h.calls, 777000111)[0].body.reply_markup.keyboard;
  assert.strictEqual(kb[0][0].text, "⚙️ Админка");
  await h.bot.handleUpdate(pm("/start", 42));
  assert.ok(!sends(h.calls, 42)[0].body.reply_markup.keyboard.flat().some((b) => b.text === "⚙️ Админка"), "у клиента админки нет");
  await h.bot.handleUpdate(pm("⚙️ Админка", 42));
  assert.ok(sends(h.calls, 42).some((c) => /только администраторам/.test(c.body.text)));
  assert.strictEqual(h.aiCalls.length, 0);

  await h.bot.handleUpdate(pm("⚙️ Админка", 777000111));
  const panel = sends(h.calls, 777000111).find((c) => /Админка бота поддержки/.test(c.body.text));
  assert.ok(panel && /Ключи:/.test(panel.body.text) && panel.body.reply_markup.inline_keyboard.length >= 6);
  const cb = (data, from = 777000111) => h.bot.handleUpdate({ callback_query: { id: "a", from: { id: from }, data, message: { message_id: 50, chat: { id: from } } } });
  await cb("sb:a:set:pause:3");
  assert.strictEqual(h.store.get("supportBot/config").humanPauseHours, 3);
  await cb("sb:a:set:mode:light");
  assert.strictEqual(h.store.get("supportBot/config").ai.routing, "light");
  assert.ok(h.store.get("supportBot/config").ai.providers[0].keyEnc, "ключ не потерялся при смене режима");
  await cb("sb:a:ai");
  assert.strictEqual(h.store.get("supportBot/config").aiEnabled, false);
  await cb("sb:a:ai");
  await cb("sb:a:in:staff");
  await h.bot.handleUpdate(pm("888000222 Мария", 777000111));
  assert.deepStrictEqual(h.store.get("supportBot/config").staff.map((x) => x.id), [555000111, 888000222]);
  await cb("sb:a:sd:555000111");
  assert.deepStrictEqual(h.store.get("supportBot/config").staff.map((x) => x.id), [888000222]);
  assert.ok(h.calls.some((c) => c.method === "editMessageText" && /Сотрудники поддержки/.test(c.body.text)));
  const before = JSON.stringify(h.store.get("supportBot/config"));
  await cb("sb:a:set:pause:48", 42);
  assert.strictEqual(JSON.stringify(h.store.get("supportBot/config")), before, "не админ ничего не меняет");
  await cb("sb:a:stats");
  assert.ok(h.calls.some((c) => c.method === "editMessageText" && /Средняя оценка/.test(c.body.text)));
});

test("несколько ключей из панели: порядок, старый ключ сохраняется, сложный вопрос — сильной модели", async () => {
  const h = harness();
  await setup(h);
  const p1 = h.store.get("supportBot/config").ai.providers[0];
  await h.bot.handleSetup({ body: { ai: { routing: "auto", providers: [
    { id: p1.id, vendor: "tooken", light: "gpt-4o-mini", heavy: "gpt-4o" },
    { vendor: "deepseek", apiKey: "sk-deepseek-123456789", light: "deepseek-chat", heavy: "deepseek-reasoner" },
  ] } } }, {});
  const cfg = h.store.get("supportBot/config");
  assert.strictEqual(cfg.ai.providers.length, 2);
  assert.strictEqual(cfg.ai.providers[0].keyEnc, p1.keyEnc, "пустое поле ключа — старый ключ остаётся");
  assert.ok(cfg.ai.providers[1].keyEnc && !JSON.stringify(cfg).includes("sk-deepseek"));
  assert.deepStrictEqual(h.sent.body.ai.providers.map((p) => p.title), ["Tooken Club", "DeepSeek"]);
  await h.bot.handleUpdate(pm("Как добавить официанта?"));
  await h.bot.idle();
  assert.strictEqual(h.aiCalls[h.aiCalls.length - 1].model, "gpt-4o-mini");
  await h.bot.handleUpdate(pm("/new"));
  await h.bot.handleUpdate(pm("Нужна ли лицензия на алкоголь и какой штраф по 171-ФЗ?"));
  await h.bot.idle();
  assert.strictEqual(h.aiCalls[h.aiCalls.length - 1].model, "gpt-4o", "юридический вопрос — сильная модель");
});

test("спасибо и «ок» — без ИИ", async () => {
  const h = harness();
  await setup(h);
  await h.bot.handleUpdate(pm("Спасибо!"));
  await h.bot.handleUpdate(pm("ок"));
  await h.bot.idle();
  assert.strictEqual(h.aiCalls.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`✗ ${name}\n  ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    }
  }
  console.log(`support-bot: ${passed} из ${tests.length} проверок`);
  process.exit(process.exitCode || 0);
})();
