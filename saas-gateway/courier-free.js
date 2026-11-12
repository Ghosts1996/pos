"use strict";
/**
 * Свободные курьеры (docs/delivery.md, раздел 20): курьер регистрируется
 * сам, не от заведения, и возит заказы заведений, которые его приняли.
 *
 * Как устроено.
 *  • Учётка — та же коллекция couriers, root = "free". Вход — телефон и
 *    пароль (на сервере — только scrypt), восстановление — код на почту.
 *  • Курьер — самозанятый или ИП: ИНН сверяем с ФНС (npd-check.js).
 *  • Заведение (или сеть) само включает «Свободных курьеров» в кабинете:
 *    ставка за доставку и за километр, радиус, через сколько минут заказ
 *    виден свободным, кого пускать — только одобренных или всех проверенных.
 *  • Курьер находит заведения рядом (или открывает ссылку заведения) и жмёт
 *    «Хочу возить»: так он принимает условия заведения. Заведение одобряет
 *    заявку (или она одобряется сама — режим «все проверенные»).
 *  • Заказы свободному курьеру — только оплаченные заранее или с оплатой по
 *    QR через банк заведения: чужие наличные он не возит. Назначить заказ
 *    свободному курьеру нельзя — он берёт сам (и вправе не брать).
 *  • Деньги курьеру платит заведение напрямую; платформа их не принимает.
 *    Сколько заведение должно — счётчик owed.<корень>, выплату отмечает
 *    заведение в кабинете.
 *
 * Данные курьера — оператор платформа: согласие с датой, адресом и
 * браузером хранится в учётке; удаление — сам курьер, с актом владельцу.
 */
const crypto = require("crypto");
const { innValid } = require("./npd-check");

const FREE_ROOT = "free";
const FREE_RULES_VER = 1;
const FREE_NO_BASE = 1000; // номера свободных — с 1001: не путаются с курьерами заведений
const FREE_MAX_ACTIVE = 4;
const NEARBY_KM = 30;
const MAX_LINKS = 30;
const NPD_RECHECK_MS = 7 * 24 * 3600 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const TRANSPORTS = { foot: "пешком", bike: "велосипед или самокат", auto: "автомобиль или мотоцикл" };
const TAX = { npd: "самозанятый", ip: "индивидуальный предприниматель" };
const LINK_LABEL = { pending: "заявка ждёт ответа", approved: "работаю", declined: "заявка отклонена", blocked: "доступ закрыт заведением", left: "" };
const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>.]{2,24}$/;
const ROOT_RE = /^[tc]_[A-Za-z0-9_-]{1,64}$/;
const COURIER_PD = [
  "фамилия, имя, отчество", "номер телефона", "адрес электронной почты", "ИНН и налоговый статус",
  "вид транспорта", "местоположение телефона во время смены", "сведения о поездках и начислениях",
];

const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Настройки «Свободных курьеров» из courierSettings/{корень}. */
function freeSettings(raw) {
  const s = raw || {};
  const f = s.free && typeof s.free === "object" ? s.free : {};
  return {
    on: s.freeOn === true,
    mode: f.mode === "all" ? "all" : "approved",
    radiusKm: num(f.radiusKm, 5, 1, 30),
    delayMin: Math.round(num(f.delayMin, 0, 0, 120)),
    ratePerTrip: Math.round(num(f.ratePerTrip, 0, 0, 100000) * 100) / 100,
    ratePerKm: Math.round(num(f.ratePerKm, 0, 0, 10000) * 100) / 100,
    agreedAt: s.freeAgreedAt || null,
  };
}

function hashPass(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, (e, key) => (e ? reject(e) : resolve(`s1$${salt.toString("base64url")}$${key.toString("base64url")}`)));
  });
}

async function checkPass(password, stored) {
  const m = /^s1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const again = await hashPass(password, Buffer.from(m[1], "base64url"));
  const a = Buffer.from(again);
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const passProblem = (p) => {
  const s = String(p || "");
  if (s.length < 8) return "Пароль — не короче 8 символов";
  if (s.length > 100) return "Пароль слишком длинный";
  if (/^(\d)\1+$/.test(s) || /^(12345678|87654321|password|qwertyui)/i.test(s)) return "Пароль слишком простой — придумайте другой";
  return "";
};

function createFreeCouriers(core) {
  const {
    db, couriersCol, settingsRef, tenantRef, HttpError, parseJsonBody, sendJson, now, ts, del, ms, sha, clean,
    cached, forget, pointsOf, staffCtx, courierByToken, authFailed, activeOf, systemRelease, shiftEndPatch,
    FieldValue, normalizePhone, distanceM, dayStartMs, hooks, npd, publicUrl, posFreshMs,
  } = core;

  const isFree = (c) => !!c && c.root === FREE_ROOT;
  const label = (c) => (isFree(c) ? `Свободный курьер №${c.no}` : `Курьер №${c.no}`);
  const linkOf = (c, root) => (c.roots && c.roots[root]) || null;
  const stOf = (c, root) => { const l = linkOf(c, root); return l ? String(l.st || "") : ""; };
  const ipOf = (req) => String((req.headers && req.headers["x-real-ip"]) || (req.socket && req.socket.remoteAddress) || "");

  const settingsOf = (root) => cached(`fs:${root}`, 20000, async () => freeSettings((await settingsRef(root).get()).data()));
  const openRoots = () => cached("froots", 20000, async () => {
    const snap = await db().collection("courierSettings").where("freeOn", "==", true).get();
    return snap.docs.filter((d) => ROOT_RE.test(d.id)).map((d) => ({ root: d.id, ...freeSettings(d.data()) }));
  });
  const allFree = () => cached("fall", 10000, async () =>
    (await couriersCol().where("root", "==", FREE_ROOT).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.deletedAt));
  const forgetFree = () => { forget("fall"); forget("froots"); forget("fs:"); };

  /** Ограничение частоты: n раз за окно на ключ. */
  function limiter(max, windowMs, message) {
    const hits = new Map();
    return (key) => {
      const hit = hits.get(key);
      if (hit && hit.until > now()) {
        if (hit.n >= max) throw new HttpError(429, message);
        hit.n += 1;
      } else {
        hits.set(key, { n: 1, until: now() + windowMs });
      }
      if (hits.size > 5000) for (const [k, v] of hits) if (v.until <= now()) hits.delete(k);
    };
  }

  // ------------------------------------------------------------ точки и условия

  /** Название корня для курьера: заведение или «сеть из N точек». */
  async function rootCard(root, s = null) {
    const set = s || (await settingsOf(root));
    const points = await pointsOf(root);
    const first = points[0] || {};
    return {
      root,
      title: points.length > 1 ? `${first.name} и ещё ${points.length - 1}` : String(first.name || "Заведение"),
      points: points.map((p) => ({ id: p.id, name: p.name, address: p.address, pos: p.venuePos || null })),
      on: set.on, mode: set.mode, radiusKm: set.radiusKm,
      ratePerTrip: set.ratePerTrip, ratePerKm: set.ratePerKm,
    };
  }

  /**
   * Точки, где работает свободный курьер: заведения, которые его приняли.
   * Выключенные «свободные курьеры» остаются в списке, пока у курьера их
   * заказ, — новые заказы оттуда просто не предлагаются (offering).
   */
  async function scope(c) {
    const out = [];
    for (const [root, link] of Object.entries(c.roots || {})) {
      if (!link || link.st !== "approved" || !ROOT_RE.test(root)) continue;
      const s = await settingsOf(root);
      for (const p of await pointsOf(root)) {
        out.push({ ...p, free: s, offering: s.on, payAtDoor: { cash: false, card: false, qr: !!(p.payAtDoor && p.payAtDoor.qr) } });
      }
    }
    return out;
  }

  const freshPos = (c) => (c.pos && now() - ms(c.pos.at) < posFreshMs ? c.pos : null);

  /**
   * Можно ли предложить заказ свободному курьеру. → "" или причина.
   * money — { toCollect } из moneyOf.
   */
  function offerProblem(c, point, s, money) {
    if (!point.offering) return "Заведение сейчас не принимает свободных курьеров";
    if (money.toCollect > 0.005 && !point.payAtDoor.qr) return "Заказ не оплачен заранее, а оплаты по QR у заведения нет";
    const pos = freshPos(c);
    if (!pos) return "Включите геолокацию: заказы видны, когда приложение знает, где вы";
    if (point.venuePos && distanceM(pos, point.venuePos) > point.free.radiusKm * 1000) return `Вы дальше ${point.free.radiusKm} км от заведения`;
    if (s.courierStage !== "returned" && now() - ms(s.startTime) < point.free.delayMin * 60000) return "Заказ пока предлагают курьерам заведения";
    return "";
  }

  /** Выход на линию: условия приняты, ФНС не ответила «не самозанятый». */
  function shiftProblem(c) {
    if (!c.rulesAt) return "Сначала примите условия для курьеров";
    if (c.taxStatus === "npd" && c.npd && c.npd.ok === false) {
      return "ФНС не подтвердила статус самозанятого по вашему ИНН. Встаньте на учёт в приложении «Мой налог» и нажмите «Проверить ещё раз» в профиле";
    }
    return "";
  }

  // ------------------------------------------------------------ проверка ФНС

  /** Проверить статус самозанятого в фоне и записать в учётку. */
  function queueNpd(id, inn, fresh = false) {
    if (!npd) return Promise.resolve(null);
    return npd.check(inn, { fresh }).then(async (r) => {
      const ref = couriersCol().doc(id);
      const cur = (await ref.get()).data();
      if (!cur || cur.deletedAt || cur.inn !== inn) return null;
      await ref.update({ npd: { ok: r.ok, message: clean(r.message, 200), at: ts(r.at || now()) } });
      forget("fall");
      // Ждал подтверждения ФНС в заведениях «всех проверенных» — теперь принят.
      if (r.ok === true) await autoApprove({ id, ...cur, npd: { ok: true } }).catch(() => {});
      return r;
    }).catch((e) => { console.error(`free courier npd (${id}): ${e.message}`); return null; });
  }

  async function autoApprove(c) {
    for (const [root, link] of Object.entries(c.roots || {})) {
      if (!link || link.st !== "pending" || link.auto !== true) continue;
      const s = await settingsOf(root);
      if (s.on && s.mode === "all") await couriersCol().doc(c.id).update({ [`roots.${root}.st`]: "approved", [`roots.${root}.at`]: ts() });
    }
    forget("fall");
  }

  // ------------------------------------------------------------ регистрация и вход

  // 20 в час с адреса: у мобильных операторов один адрес на многих людей.
  const regLimit = limiter(20, 3600 * 1000, "Слишком много регистраций с этого адреса — попробуйте через час");
  const resetLimit = limiter(5, 3600 * 1000, "Слишком много запросов кода — попробуйте через час");
  const signFails = new Map(); // телефон → { n, until }
  let regChain = Promise.resolve();

  async function issueToken(ref, c, device) {
    const token = crypto.randomBytes(32).toString("base64url");
    if (c && c.tokenHash) forget(`tok:${c.tokenHash}`);
    await ref.update({ tokenHash: sha(token), tokenAt: ts(), lastSeenAt: ts(), device: clean(device, 80) });
    return token;
  }

  async function byPhone(phone) {
    const snap = await couriersCol().where("phone", "==", phone).get();
    const d = snap.docs.find((x) => { const v = x.data() || {}; return v.root === FREE_ROOT && !v.deletedAt; });
    return d ? { ref: d.ref, c: { id: d.id, ...d.data() } } : null;
  }

  async function handleRegister(req, res) {
    const body = await parseJsonBody(req);
    const name = clean(body.name, 80);
    if (name.split(" ").filter((w) => w.length >= 2).length < 2) throw new HttpError(400, "Укажите фамилию и имя полностью — как в «Мой налог»");
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, "Проверьте телефон: нужен российский номер, +7 и 10 цифр");
    const email = clean(body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Укажите почту — на неё придёт код, если забудете пароль");
    const bad = passProblem(body.password);
    if (bad) throw new HttpError(400, bad);
    const taxStatus = TAX[body.taxStatus] ? String(body.taxStatus) : "";
    if (!taxStatus) throw new HttpError(400, "Выберите статус: самозанятый или ИП");
    const inn = String(body.inn || "").replace(/\D/g, "");
    if (!innValid(inn)) throw new HttpError(400, "Проверьте ИНН: 12 цифр, как в «Мой налог» или в свидетельстве");
    const transport = TRANSPORTS[body.transport] ? String(body.transport) : "";
    if (!transport) throw new HttpError(400, "Выберите, на чём возите заказы");
    if (body.adult !== true) throw new HttpError(400, "Возить заказы можно с 18 лет — подтвердите возраст");
    if (body.rules !== true) throw new HttpError(400, "Примите условия для курьеров");
    if (body.pd !== true) throw new HttpError(400, "Нужно согласие на обработку персональных данных");
    // Считаем заявки, прошедшие проверку: опечатки в форме лимит не тратят.
    regLimit(ipOf(req));
    const passHash = await hashPass(body.password);
    const token = crypto.randomBytes(32).toString("base64url");
    // По очереди: два одновременных запроса не заведут одного человека дважды.
    const run = regChain.then(async () => {
      if (await byPhone(phone)) throw new HttpError(409, "Курьер с таким телефоном уже зарегистрирован — войдите по телефону и паролю");
      const sameInn = (await couriersCol().where("inn", "==", inn).get()).docs.some((d) => (d.data() || {}).root === FREE_ROOT && !(d.data() || {}).deletedAt);
      if (sameInn) throw new HttpError(409, "Курьер с таким ИНН уже зарегистрирован");
      let no = 0;
      await db().runTransaction(async (tx) => {
        const s = (await tx.get(settingsRef(FREE_ROOT))).data() || {};
        no = (Math.trunc(Number(s.lastNo)) || 0) + 1;
        tx.set(settingsRef(FREE_ROOT), { lastNo: no }, { merge: true });
      });
      const ref = couriersCol().doc();
      const ua = clean(req.headers && req.headers["user-agent"], 200);
      await ref.set({
        root: FREE_ROOT, free: true, no: FREE_NO_BASE + no, name, phone, email, inn, taxStatus, transport,
        medBook: body.medBook === true, points: [], roots: {}, owed: {}, enabled: true, onShift: false,
        cashOnHand: 0, odometerM: 0, createdAt: ts(), createdBy: "self", passHash,
        rulesAt: ts(), rulesVer: FREE_RULES_VER, pdAt: ts(), pdIp: ipOf(req), pdUa: ua,
        // Согласие на геолокацию входит в условия — отдельного экрана не будет.
        consentAt: ts(),
        npd: { ok: null, message: taxStatus === "npd" ? "Проверяем в ФНС" : "", at: ts() },
        tokenHash: sha(token), tokenAt: ts(), lastSeenAt: ts(), device: clean(body.device, 80),
      });
      return { id: ref.id, no: FREE_NO_BASE + no };
    });
    regChain = run.catch(() => {});
    const made = await run;
    forget("fall");
    queueNpd(made.id, inn);
    sendJson(res, 200, { token, courier: { no: made.no, name, free: true } });
  }

  async function handleSignin(req, res) {
    const body = await parseJsonBody(req);
    const phone = normalizePhone(body.phone);
    const wrong = () => {
      authFailed(req);
      return new HttpError(403, "Неверный телефон или пароль");
    };
    if (!phone || typeof body.password !== "string" || !body.password) throw wrong();
    const lock = signFails.get(phone);
    if (lock && lock.until > now() && lock.n >= 10) throw new HttpError(429, "Слишком много неверных паролей — попробуйте через 15 минут или восстановите пароль");
    const found = await byPhone(phone);
    const ok = found && found.c.passHash ? await checkPass(body.password, found.c.passHash) : (await hashPass(body.password), false);
    if (!ok) {
      if (lock && lock.until > now()) lock.n += 1;
      else signFails.set(phone, { n: 1, until: now() + 15 * 60 * 1000 });
      if (signFails.size > 5000) for (const [k, v] of signFails) if (v.until <= now()) signFails.delete(k);
      throw wrong();
    }
    signFails.delete(phone);
    if (found.c.enabled === false) throw new HttpError(403, "Учётная запись закрыта. Напишите в поддержку ZalPOS");
    const token = await issueToken(found.ref, found.c, body.device);
    sendJson(res, 200, { token, courier: { no: found.c.no, name: found.c.name, free: true } });
  }

  /** Забыли пароль: код на почту из учётки. Ответ одинаковый — есть учётка или нет. */
  async function handleReset(req, res) {
    const body = await parseJsonBody(req);
    resetLimit(ipOf(req));
    const phone = normalizePhone(body.phone);
    const found = phone ? await byPhone(phone) : null;
    if (found && found.c.email && found.c.enabled !== false) {
      const code = String(crypto.randomInt(100000, 1000000));
      await found.ref.update({ resetHash: sha(`${found.c.id}:${code}`), resetExp: ts(now() + RESET_TTL_MS), resetTries: 0 });
      const mailer = hooks().mailer ? hooks().mailer() : null;
      if (mailer) {
        await mailer.send({
          to: found.c.email,
          subject: "Код для нового пароля — курьер ZalPOS",
          text: [
            `Код: ${code}`,
            "",
            "Введите его в приложении курьера ZalPOS, чтобы задать новый пароль. Код действует 15 минут.",
            "Если вы не просили код — ничего не делайте: пароль останется прежним.",
          ].join("\n"),
        }).catch((e) => console.error(`free courier reset mail: ${e.message}`));
      } else {
        console.warn("free courier reset: почта не настроена — код не отправлен");
      }
    }
    sendJson(res, 200, { ok: true, note: "Если телефон зарегистрирован, код отправлен на почту из учётной записи. Действует 15 минут" });
  }

  async function handleResetConfirm(req, res) {
    const body = await parseJsonBody(req);
    const phone = normalizePhone(body.phone);
    const code = String(body.code || "").replace(/\D/g, "");
    const bad = passProblem(body.password);
    if (bad) throw new HttpError(400, bad);
    const found = phone ? await byPhone(phone) : null;
    const wrong = () => { authFailed(req); return new HttpError(403, "Код неверный или устарел — запросите новый"); };
    if (!found || !found.c.resetHash || ms(found.c.resetExp) < now() || (Number(found.c.resetTries) || 0) >= 5) throw wrong();
    if (found.c.resetHash !== sha(`${found.c.id}:${code}`)) {
      await found.ref.update({ resetTries: FieldValue.increment(1) });
      throw wrong();
    }
    if (found.c.enabled === false) throw new HttpError(403, "Учётная запись закрыта. Напишите в поддержку ZalPOS");
    await found.ref.update({ passHash: await hashPass(body.password), resetHash: del(), resetExp: del(), resetTries: del() });
    signFails.delete(phone);
    const token = await issueToken(found.ref, found.c, body.device);
    sendJson(res, 200, { token, courier: { no: found.c.no, name: found.c.name, free: true } });
  }

  // ------------------------------------------------------------ профиль курьера

  async function freeByToken(req) {
    const c = await courierByToken(req);
    if (!isFree(c)) throw new HttpError(403, "Это раздел для курьеров, которые зарегистрировались сами");
    return c;
  }

  const npdDto = (c) => ({
    status: c.taxStatus || "npd",
    label: TAX[c.taxStatus] || "",
    ok: c.npd && typeof c.npd.ok === "boolean" ? c.npd.ok : null,
    message: (c.npd && c.npd.message) || "",
    at: c.npd ? ms(c.npd.at) : 0,
  });

  async function profileOf(c) {
    const venues = [];
    for (const [root, link] of Object.entries(c.roots || {})) {
      if (!link || !ROOT_RE.test(root) || link.st === "left") continue;
      const card = await rootCard(root).catch(() => null);
      if (!card || !card.points.length) continue;
      venues.push({ ...card, st: link.st, stLabel: LINK_LABEL[link.st] || "", at: ms(link.at), owed: Math.max(0, Math.round(Number((c.owed || {})[root]) || 0)) });
    }
    venues.sort((a, b) => (a.st === "approved" ? 0 : 1) - (b.st === "approved" ? 0 : 1) || b.at - a.at);
    return {
      no: c.no, name: c.name, phone: c.phone, email: c.email || "", inn: c.inn || "",
      transport: c.transport || "auto", medBook: c.medBook === true,
      tax: npdDto(c), shiftProblem: shiftProblem(c),
      venues, owedTotal: venues.reduce((a, v) => a + v.owed, 0),
      rulesVer: c.rulesVer || 0,
    };
  }

  async function handleProfile(req, res) {
    const c = await freeByToken(req);
    // Давно не проверяли в ФНС или сервис не ответил — проверим ещё раз.
    if (c.taxStatus === "npd" && (!c.npd || c.npd.ok === null || now() - ms(c.npd.at) > NPD_RECHECK_MS)) queueNpd(c.id, c.inn, true);
    sendJson(res, 200, await profileOf(c));
  }

  async function handleUpdate(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    const patch = {};
    if (body.transport !== undefined) {
      if (!TRANSPORTS[body.transport]) throw new HttpError(400, "Выберите, на чём возите заказы");
      patch.transport = String(body.transport);
    }
    if (body.medBook !== undefined) patch.medBook = body.medBook === true;
    if (body.email !== undefined) {
      const email = clean(body.email, 254).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, "Проверьте почту");
      patch.email = email;
    }
    if (body.password !== undefined) {
      if (!(await checkPass(String(body.oldPassword || ""), c.passHash))) { authFailed(req); throw new HttpError(403, "Текущий пароль неверный"); }
      const bad = passProblem(body.password);
      if (bad) throw new HttpError(400, bad);
      patch.passHash = await hashPass(body.password);
    }
    if (Object.keys(patch).length) { await couriersCol().doc(c.id).update(patch); forget("fall"); }
    sendJson(res, 200, { ok: true });
  }

  const recheckLimit = limiter(3, 3600 * 1000, "ФНС уже проверяли недавно — попробуйте через час");
  async function handleRecheck(req, res) {
    const c = await freeByToken(req);
    if (c.taxStatus !== "npd") return sendJson(res, 200, { ok: true, tax: npdDto(c) });
    recheckLimit(c.id);
    await couriersCol().doc(c.id).update({ npd: { ok: null, message: "Проверяем в ФНС", at: ts() } });
    queueNpd(c.id, c.inn, true);
    sendJson(res, 200, { ok: true, tax: { ...npdDto(c), ok: null, message: "Проверяем в ФНС" } });
  }

  /** Заведения рядом, которые принимают свободных курьеров. */
  async function handleNearby(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const here = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng) ? { lat, lng } : null;
    if (!here) throw new HttpError(400, "Разрешите геолокацию, чтобы найти заведения рядом");
    const out = [];
    for (const s of await openRoots()) {
      const card = await rootCard(s.root, s).catch(() => null);
      if (!card) continue;
      const dists = card.points.filter((p) => p.pos).map((p) => distanceM(here, p.pos));
      if (!dists.length) continue;
      const distM = Math.round(Math.min(...dists));
      if (distM > NEARBY_KM * 1000) continue;
      const st = stOf(c, s.root);
      out.push({ ...card, distM, inRadius: distM <= s.radiusKm * 1000, st: st === "left" ? "" : st, stLabel: LINK_LABEL[st] || "" });
    }
    out.sort((a, b) => a.distM - b.distM);
    sendJson(res, 200, { venues: out.slice(0, 50) });
  }

  /** Карточка заведения по ссылке из кабинета (#v=<корень>). */
  async function handleVenue(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    const root = String(body.root || "");
    if (!ROOT_RE.test(root)) throw new HttpError(400, "Ссылка заведения неверна");
    const s = await settingsOf(root);
    if (!s.on) throw new HttpError(404, "Это заведение сейчас не принимает свободных курьеров");
    const card = await rootCard(root, s);
    if (!card.points.length) throw new HttpError(404, "Заведение не найдено");
    const st = stOf(c, root);
    sendJson(res, 200, { venue: { ...card, distM: null, inRadius: true, st: st === "left" ? "" : st, stLabel: LINK_LABEL[st] || "" } });
  }

  /** «Хочу возить»: курьер принимает условия заведения. */
  async function handleApply(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    const root = String(body.root || "");
    if (!ROOT_RE.test(root)) throw new HttpError(400, "Не указано заведение");
    const s = await settingsOf(root);
    if (!s.on) throw new HttpError(409, "Это заведение сейчас не принимает свободных курьеров");
    const cur = linkOf(c, root);
    if (cur && cur.st === "blocked") throw new HttpError(403, "Заведение закрыло вам доступ");
    if (cur && (cur.st === "approved" || cur.st === "pending")) return sendJson(res, 200, { ok: true, st: cur.st });
    if (cur && cur.st === "declined" && now() - ms(cur.at) < 24 * 3600 * 1000) throw new HttpError(409, "Заведение отклонило заявку — повторить можно через сутки");
    if (Object.values(c.roots || {}).filter((l) => l && l.st !== "left").length >= MAX_LINKS) throw new HttpError(409, `Заведений — не больше ${MAX_LINKS}: сначала уйдите из лишних`);
    const problem = shiftProblem(c);
    if (problem) throw new HttpError(409, problem);
    const verified = c.taxStatus === "npd" && c.npd && c.npd.ok === true;
    const auto = s.mode === "all";
    const st = auto && verified ? "approved" : "pending";
    await couriersCol().doc(c.id).update({
      [`roots.${root}`]: { st, at: ts(), auto, ratePerTrip: s.ratePerTrip, ratePerKm: s.ratePerKm, rulesVer: FREE_RULES_VER },
    });
    forget("fall");
    sendJson(res, 200, { ok: true, st });
  }

  async function handleLeave(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    const root = String(body.root || "");
    const cur = linkOf(c, root);
    if (!cur || cur.st === "left") return sendJson(res, 200, { ok: true });
    if (cur.st === "blocked") throw new HttpError(409, "Заведение закрыло доступ — запись останется, чтобы заявку нельзя было подать снова");
    const ids = new Set((await pointsOf(root)).map((p) => p.id));
    if ((await activeOf(c)).some((a) => ids.has(a.t))) throw new HttpError(409, "Сначала завершите заказы этого заведения");
    await couriersCol().doc(c.id).update({ [`roots.${root}.st`]: "left", [`roots.${root}.at`]: ts() });
    forget("fall");
    sendJson(res, 200, { ok: true });
  }

  /**
   * Курьер удаляет учётку: имя, телефон, почта, ИНН и пароль стираются,
   * поездки остаются за номером (отчёты заведений сходятся). Владельцу
   * платформы — акт об уничтожении персональных данных.
   */
  async function handleDelete(req, res) {
    const c = await freeByToken(req);
    const body = await parseJsonBody(req);
    if (!(await checkPass(String(body.password || ""), c.passHash))) { authFailed(req); throw new HttpError(403, "Пароль неверный"); }
    if ((await activeOf(c)).length) throw new HttpError(409, "Сначала завершите заказы");
    const end = c.onShift ? await shiftEndPatch(c) : {};
    if (c.tokenHash) forget(`tok:${c.tokenHash}`);
    await couriersCol().doc(c.id).update({
      ...end,
      name: `Курьер №${c.no}`, phone: "", email: "", inn: "", enabled: false, deletedAt: ts(),
      passHash: del(), tokenHash: del(), tokenAt: del(), device: del(), pos: del(), npd: del(),
      pdIp: del(), pdUa: del(), resetHash: del(), resetExp: del(), resetTries: del(),
    });
    forgetFree();
    const papers = hooks().papers;
    if (papers) {
      Promise.resolve(papers.destruction([{
        subject: `Курьер №${c.no} (исполнитель, зарегистрирован самостоятельно), телефон ***${String(c.phone || "").slice(-4)}, идентификатор ${c.id}`,
        categories: COURIER_PD,
      }], { reason: "Требование субъекта персональных данных об уничтожении его данных (удаление учётной записи курьера)" })).catch(() => {});
    }
    sendJson(res, 200, { ok: true });
  }

  // ------------------------------------------------------------ кабинет заведения

  const freeLink = (root) => `${publicUrl}/courier/#v=${root}`;

  /** Свободные курьеры, связанные с корнем, — с цифрами за сегодня. */
  async function linkedOf(ctx, tz) {
    const { day } = dayStartMs(now(), tz);
    const pointIds = new Set((await pointsOf(ctx.root)).map((p) => p.id));
    const out = [];
    for (const c of await allFree()) {
      const link = linkOf(c, ctx.root);
      if (!link || link.st === "left") continue;
      const trips = link.st === "approved" || link.st === "blocked"
        ? (await couriersCol().doc(c.id).collection("trips").where("day", "==", day).get()).docs.map((d) => d.data())
          .filter((x) => x.root === ctx.root && x.result === "done" && (ctx.full || x.tenantId === ctx.tenantId))
        : [];
      out.push({
        id: c.id, no: c.no, name: c.name || "", phone: c.phone || "", inn: c.inn || "",
        tax: npdDto(c), transport: TRANSPORTS[c.transport] || "", medBook: c.medBook === true,
        st: link.st, at: ms(link.at), auto: link.auto === true,
        onShift: c.onShift === true, lastSeenAt: ms(c.lastSeenAt),
        orders: Object.keys(c.active || {}).filter((k) => pointIds.has(k.split("__")[0])).length,
        owed: Math.max(0, Math.round(Number((c.owed || {})[ctx.root]) || 0)),
        today: { trips: trips.length, earned: Math.round(trips.reduce((a, x) => a + (Number(x.earned) || 0), 0)) },
      });
    }
    const order = { pending: 0, approved: 1, declined: 2, blocked: 3 };
    return out.sort((a, b) => (order[a.st] - order[b.st]) || (b.at - a.at));
  }

  async function handleAdminGet(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const s = await settingsOf(ctx.root);
    const points = await pointsOf(ctx.root);
    const tz = (points[0] && points[0].tz) || "Europe/Moscow";
    sendJson(res, 200, {
      full: ctx.full, chain: !!ctx.chainId,
      settings: { on: s.on, mode: s.mode, radiusKm: s.radiusKm, delayMin: s.delayMin, ratePerTrip: s.ratePerTrip, ratePerKm: s.ratePerKm, agreed: !!s.agreedAt },
      points: points.map((p) => ({ id: p.id, name: p.name, pos: p.venuePos || null, qr: !!(p.payAtDoor && p.payAtDoor.qr) })),
      link: freeLink(ctx.root),
      couriers: await linkedOf(ctx, tz),
      rulesVer: FREE_RULES_VER,
    });
  }

  async function handleAdminSave(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    if (!ctx.full) throw new HttpError(403, "Свободных курьеров сети включает владелец сети");
    const cur = await settingsOf(ctx.root);
    const on = body.on === true;
    const mode = body.mode === "all" ? "all" : "approved";
    const perTrip = Number(body.ratePerTrip);
    const perKm = Number(body.ratePerKm);
    if (!(perTrip >= 0 && perTrip <= 100000)) throw new HttpError(400, "Ставка за доставку — от 0 до 100 000 ₽");
    if (!(perKm >= 0 && perKm <= 10000)) throw new HttpError(400, "Ставка за километр — от 0 до 10 000 ₽");
    const radiusKm = Number(body.radiusKm);
    if (!(radiusKm >= 1 && radiusKm <= 30)) throw new HttpError(400, "Радиус — от 1 до 30 км");
    const delayMin = Number(body.delayMin);
    if (!(delayMin >= 0 && delayMin <= 120)) throw new HttpError(400, "Задержка — от 0 до 120 минут");
    if (on) {
      if (!(perTrip + perKm > 0)) throw new HttpError(400, "Укажите, сколько платите курьеру: за доставку или за километр");
      if (!cur.agreedAt && body.agree !== true) throw new HttpError(400, "Подтвердите условия работы со свободными курьерами");
      if (!(await pointsOf(ctx.root)).some((p) => p.venuePos)) throw new HttpError(409, "Отметьте место заведения на карте — иначе курьеры рядом вас не найдут");
    }
    await settingsRef(ctx.root).set({
      freeOn: on,
      free: { mode, radiusKm: Math.round(radiusKm * 10) / 10, delayMin: Math.round(delayMin), ratePerTrip: Math.round(perTrip * 100) / 100, ratePerKm: Math.round(perKm * 100) / 100 },
      ...(on && !cur.agreedAt ? { freeAgreedAt: ts(), freeAgreedBy: ctx.uid, freeRulesVer: FREE_RULES_VER } : {}),
      freeUpdatedAt: ts(), freeUpdatedBy: ctx.uid,
    }, { merge: true });
    forgetFree();
    sendJson(res, 200, { ok: true });
  }

  /** Место заведения на карте — вручную (без него курьеры рядом точку не найдут). */
  async function handleAdminPos(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    // Россия с запасом: защита от перепутанных широты и долготы.
    if (!(lat >= 41 && lat <= 82 && ((lng >= 19 && lng <= 180) || (lng >= -180 && lng <= -168)))) {
      throw new HttpError(400, "Проверьте координаты: сначала широта, потом долгота — например 59.9358, 30.3259");
    }
    await tenantRef(ctx.tenantId).collection("settings").doc("delivery").set({
      venuePos: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }, venuePosManual: true,
    }, { merge: true });
    forget("points:");
    if (hooks().posChanged) Promise.resolve(hooks().posChanged(ctx.tenantId)).catch(() => {});
    sendJson(res, 200, { ok: true });
  }

  async function linkedCourier(ctx, courierId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(courierId || ""))) throw new HttpError(400, "Не указан курьер");
    const d = await couriersCol().doc(courierId).get();
    const c = d.data();
    if (!c || c.root !== FREE_ROOT || !linkOf(c, ctx.root) || linkOf(c, ctx.root).st === "left") throw new HttpError(404, "Курьер не найден");
    return { id: d.id, ...c };
  }

  /** Заявка курьера: принять, отклонить, закрыть доступ, вернуть доступ. */
  async function handleAdminDecide(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    if (!ctx.full) throw new HttpError(403, "Свободных курьеров сети принимает владелец сети");
    const c = await linkedCourier(ctx, body.courierId);
    const st = linkOf(c, ctx.root).st;
    const ref = couriersCol().doc(c.id);
    const set = (next) => ref.update({ [`roots.${ctx.root}.st`]: next, [`roots.${ctx.root}.at`]: ts(), [`roots.${ctx.root}.by`]: ctx.uid });
    switch (String(body.decision || "")) {
      case "approve":
        if (st !== "pending" && st !== "declined") throw new HttpError(409, "Заявка уже рассмотрена");
        if (c.deletedAt || c.enabled === false) throw new HttpError(409, "Курьер удалил учётную запись");
        await set("approved");
        break;
      case "decline":
        if (st !== "pending") throw new HttpError(409, "Заявка уже рассмотрена");
        await set("declined");
        break;
      case "block": {
        if (st === "blocked") break;
        const ids = new Set((await pointsOf(ctx.root)).map((p) => p.id));
        const busy = (await activeOf(c)).filter((b) => ids.has(b.t));
        const held = busy.filter((b) => b.x.courierStage !== "toVenue");
        if (held.length) throw new HttpError(409, `У курьера ваши заказы в пути: ${held.length}. Закрыть доступ можно, когда он их вручит или вернёт`);
        for (const b of busy) await systemRelease(c, b.t, b.s, `↩️ ${label(c)}: заведение закрыло доступ — заказ снова свободен`);
        await set("blocked");
        break;
      }
      case "unblock":
        if (st !== "blocked") throw new HttpError(409, "Доступ не закрыт");
        await set("approved");
        break;
      default:
        throw new HttpError(400, "Неизвестное действие");
    }
    forget("fall");
    sendJson(res, 200, { ok: true });
  }

  /** Заведение отметило выплату курьеру (деньги идут мимо платформы). */
  async function handleAdminPaid(req, res) {
    const body = await parseJsonBody(req);
    const ctx = await staffCtx(req, body);
    if (!ctx.full) throw new HttpError(403, "Выплаты свободным курьерам сети отмечает владелец сети");
    const c = await linkedCourier(ctx, body.courierId);
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!(amount > 0)) throw new HttpError(400, "Укажите сумму");
    const ref = couriersCol().doc(c.id);
    let left = 0;
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() || {};
      const owed = Math.round((Number((cur.owed || {})[ctx.root]) || 0) * 100) / 100;
      if (amount > owed + 0.005) throw new HttpError(409, `К выплате этому курьеру — ${Math.round(owed)} ₽`);
      left = Math.max(0, Math.round((owed - amount) * 100) / 100);
      tx.update(ref, { [`owed.${ctx.root}`]: left });
    });
    await ref.collection("payouts").add({ root: ctx.root, tenantId: ctx.tenantId, amount, by: ctx.uid, at: ts() });
    forget("fall");
    sendJson(res, 200, { ok: true, owed: left });
  }

  /** Выплаты курьеру от заведений — для страницы «Доход». */
  async function payoutsOf(c, limit = 20) {
    const docs = (await couriersCol().doc(c.id).collection("payouts").orderBy("at", "desc").limit(limit).get()).docs;
    const names = new Map();
    const out = [];
    for (const d of docs) {
      const x = d.data() || {};
      if (!names.has(x.root)) names.set(x.root, ((await rootCard(x.root).catch(() => null)) || {}).title || "Заведение");
      out.push({ venue: names.get(x.root), amount: Number(x.amount) || 0, at: ms(x.at) });
    }
    return out;
  }

  /** Сколько заявок ждёт ответа заведения. */
  const pendingCount = async (root) => (await allFree()).filter((c) => stOf(c, root) === "pending").length;

  /** Кто везёт заказ — заведению (сторона договора с курьером). */
  const brief = (courierId) => cached(`fbrief:${courierId}`, 30000, async () => {
    const c = (await couriersCol().doc(courierId).get()).data();
    return c && c.root === FREE_ROOT ? { name: c.name || "", phone: c.phone || "" } : null;
  });

  /** Сторож: раз в неделю и после сбоя сервиса — перепроверить самозанятых, кто на линии. */
  async function sweep() {
    if (!npd) return;
    const list = (await allFree()).filter((c) => c.taxStatus === "npd" && c.enabled !== false && c.inn
      && (!c.npd || c.npd.ok === null || now() - ms(c.npd.at) > NPD_RECHECK_MS)
      && now() - ms(c.lastSeenAt) < 24 * 3600 * 1000);
    if (list[0]) await queueNpd(list[0].id, list[0].inn, true);
  }

  return {
    isFree, label, scope, offerProblem, shiftProblem, profileOf, payoutsOf, brief, pendingCount, sweep, settingsOf, npdDto,
    handleRegister, handleSignin, handleReset, handleResetConfirm,
    handleProfile, handleUpdate, handleRecheck, handleNearby, handleVenue, handleApply, handleLeave, handleDelete,
    handleAdminGet, handleAdminSave, handleAdminPos, handleAdminDecide, handleAdminPaid,
  };
}

module.exports = { createFreeCouriers, freeSettings, hashPass, checkPass, FREE_ROOT, FREE_RULES_VER, FREE_MAX_ACTIVE, FREE_NO_BASE, COURIER_PD };
