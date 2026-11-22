"use strict";
// Накладные из ЭДО автоматически: Диадок (Контур) и СБИС (Тензор).
//
// Владелец один раз вписывает в кабинете (Склад → «Приход по накладной»
// → «ЭДО») доступ к своему ЭДО — логин и пароль (для Диадока ещё ключ
// разработчика API, его выдаёт Контур). Сервер:
//  • показывает входящие УПД за 30 дней (номер, дата, поставщик, сумма) —
//    кабинет скачивает XML выбранных и ведёт их в обычный «Приход по
//    накладной»: сопоставление со складом, средняя себестоимость, защита
//    от повторного проведения (upd-import.js);
//  • раз в час смотрит, не пришло ли новое, — владельцу в бот: «пришла
//    накладная № … от … на … ₽» (один раз на документ). Поставщик — юрлицо,
//    персональных данных тут нет.
//
// API: Диадок — https://diadoc-api.kontur.ru (V3/Authenticate по паролю,
// GetMyOrganizations, V3/GetDocuments, V4/GetEntityContent); СБИС —
// JSON-RPC https://online.sbis.ru (СБИС.Аутентифицировать,
// СБИС.СписокДокументов «ДокОтгрВх», файл вложения по ссылке). С
// настоящими кабинетами ЭДО из песочницы не проверено — первая загрузка
// на месте, по одной накладной.

const DIADOC = process.env.EDO_DIADOC_URL || "https://diadoc-api.kontur.ru";
const SBIS_AUTH = process.env.EDO_SBIS_AUTH_URL || "https://online.sbis.ru/auth/service/";
const SBIS_API = process.env.EDO_SBIS_URL || "https://online.sbis.ru/service/?srv=1";
const ID_RE = /^[A-Za-z0-9_.:@|-]{1,200}$/;
const UTD_TYPES = ["UniversalTransferDocument", "UniversalTransferDocumentRevision", "UniversalCorrectionDocument"];

const pad = (n) => String(n).padStart(2, "0");
const dmy = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; };
const num = (v) => { const n = Number(String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

/** Документ Диадока → строка списка. */
function diadocSummary(d, boxId) {
  const meta = d.UniversalTransferDocumentMetadata || d.UniversalTransferDocumentRevisionMetadata || {};
  return {
    id: `d|${boxId}|${d.MessageId}|${d.EntityId}`,
    number: String(d.DocumentNumber || meta.DocumentNumber || "").slice(0, 60),
    date: String(d.DocumentDate || meta.DocumentDate || "").slice(0, 20),
    supplier: String(d.CounteragentName || (d.Counteragent && d.Counteragent.Name) || "").slice(0, 160),
    inn: String(d.CounteragentInn || "").slice(0, 12),
    total: num(meta.Total || d.Total),
    type: d.TypeNamedId || d.DocumentType || "",
  };
}

/** Документ СБИС → строка списка (с вложением-УПД). */
function sbisSummary(d) {
  const att = (d["Вложение"] || []).find((a) => /упд|УпдСчф|ДокПрие|ON_NSCHFDOPPR|xml/i.test(`${a["Тип"] || ""} ${(a["Файл"] || {})["Имя"] || ""}`) && (a["Файл"] || {})["Ссылка"]);
  const ka = d["Контрагент"] || {};
  const org = ka["СвЮЛ"] || ka["СвФЛ"] || {};
  return {
    id: `s|${d["Идентификатор"]}`,
    number: String(d["Номер"] || "").slice(0, 60),
    date: String(d["Дата"] || "").slice(0, 20),
    supplier: String(org["Название"] || [org["Фамилия"], org["Имя"]].filter(Boolean).join(" ") || "").slice(0, 160),
    inn: String(org["ИНН"] || "").slice(0, 12),
    total: num(d["Сумма"]),
    fileUrl: att ? String(att["Файл"]["Ссылка"]) : "",
  };
}

function createEdo(deps) {
  const {
    db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, encrypt, decrypt,
    ownerAlert = async () => {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
  } = deps;
  const settingsRef = (tid) => db().collection("edo").doc(tid);
  const stateRef = (tid) => db().collection("edoState").doc(tid);
  const sessions = new Map(); // tid → { token, at }

  async function config(tid) {
    const d = (await settingsRef(tid).get()).data();
    if (!d || !d.loginEnc) return null;
    const dec = (v) => { try { return v ? decrypt(v) : ""; } catch (_) { return ""; } };
    return { provider: d.provider === "sbis" ? "sbis" : "diadoc", login: dec(d.loginEnc), password: dec(d.passwordEnc), apiKey: dec(d.apiKeyEnc),
      alerts: d.alerts !== false, boxId: d.boxId || "", orgName: d.orgName || "" };
  }

  async function request(url, opts, who) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      return await fetchImpl(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      throw new HttpError(502, e.name === "AbortError" ? `${who} не ответил за 30 секунд — попробуйте позже` : `Нет связи с ${who} — попробуйте позже`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------- Диадок

  const ddAuth = (cfg, token) => `DiadocAuth ddauth_api_client_id=${cfg.apiKey}${token ? `,ddauth_token=${token}` : ""}`;

  async function diadocToken(tid, cfg, fresh = false) {
    const s = sessions.get(tid);
    if (!fresh && s && now() - s.at < 50 * 60 * 1000) return s.token;
    const res = await request(`${DIADOC}/V3/Authenticate?type=password`, {
      method: "POST",
      headers: { Authorization: ddAuth(cfg), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ login: cfg.login, password: cfg.password }),
    }, "Диадок");
    const body = await res.text();
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "Диадок не принял логин, пароль или ключ API — проверьте их");
    if (!res.ok || !body.trim()) throw new HttpError(502, `Диадок не пустил (код ${res.status})`);
    const token = body.trim().replace(/^"|"$/g, "");
    sessions.set(tid, { token, at: now() });
    return token;
  }

  async function diadocGet(tid, cfg, pathQ, { raw = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await diadocToken(tid, cfg, attempt > 0);
      const res = await request(`${DIADOC}${pathQ}`, { headers: { Authorization: ddAuth(cfg, token), Accept: raw ? "*/*" : "application/json" } }, "Диадок");
      if (res.status === 401 && attempt === 0) continue; // токен устарел
      if (!res.ok) throw new HttpError(502, `Диадок ответил ошибкой ${res.status}`);
      if (raw) return Buffer.from(await res.arrayBuffer());
      return res.json();
    }
    throw new HttpError(400, "Диадок не принял доступ — проверьте логин и пароль");
  }

  async function diadocBox(tid, cfg) {
    if (cfg.boxId) return cfg.boxId;
    const orgs = await diadocGet(tid, cfg, "/GetMyOrganizations");
    const org = (orgs.Organizations || [])[0];
    const box = org && (org.Boxes || [])[0];
    const boxId = box && (box.BoxIdGuid || box.BoxId);
    if (!boxId) throw new HttpError(400, "В Диадоке не найден ящик организации");
    await settingsRef(tid).set({ boxId: String(boxId), orgName: String(org.FullName || org.ShortName || box.Title || "").slice(0, 160) }, { merge: true });
    return String(boxId);
  }

  async function diadocList(tid, cfg, days) {
    const boxId = await diadocBox(tid, cfg);
    const out = [];
    let after = "";
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ boxId, filterCategory: "Any.Inbound", fromDocumentDate: dmy(now() - days * 86400e3), sortDirection: "Descending" });
      if (after) q.set("afterIndexKey", after);
      const r = await diadocGet(tid, cfg, `/V3/GetDocuments?${q}`);
      const docs = r.Documents || [];
      for (const d of docs) if (UTD_TYPES.includes(d.TypeNamedId || d.DocumentType)) out.push(diadocSummary(d, boxId));
      if (docs.length < 100) break;
      after = docs[docs.length - 1].IndexKey || "";
      if (!after) break;
    }
    return out;
  }

  // ---------------- СБИС

  async function sbisSession(tid, cfg, fresh = false) {
    const s = sessions.get(tid);
    if (!fresh && s && now() - s.at < 50 * 60 * 1000) return s.token;
    const res = await request(SBIS_AUTH, {
      method: "POST",
      headers: { "Content-Type": "application/json-rpc; charset=utf-8" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "СБИС.Аутентифицировать", params: { "Параметр": { "Логин": cfg.login, "Пароль": cfg.password } }, id: 0 }),
    }, "СБИС");
    const j = await res.json().catch(() => ({}));
    if (j.error || !j.result) throw new HttpError(400, `СБИС не пустил: ${String((j.error && (j.error.message || j.error.details)) || "проверьте логин и пароль").slice(0, 200)}`);
    sessions.set(tid, { token: String(j.result), at: now() });
    return String(j.result);
  }

  async function sbisCall(tid, cfg, method, params) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = await sbisSession(tid, cfg, attempt > 0);
      const res = await request(SBIS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json-rpc; charset=utf-8", "X-SBISSessionID": sid },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 0 }),
      }, "СБИС");
      if (res.status === 401 && attempt === 0) continue;
      const j = await res.json().catch(() => ({}));
      if (j.error) {
        if (attempt === 0 && /сесси|авториз/i.test(String(j.error.message || ""))) continue;
        throw new HttpError(502, `СБИС: ${String(j.error.message || j.error.details || "ошибка").slice(0, 200)}`);
      }
      return j.result || {};
    }
    throw new HttpError(400, "СБИС не принял доступ — проверьте логин и пароль");
  }

  async function sbisList(tid, cfg, days) {
    const r = await sbisCall(tid, cfg, "СБИС.СписокДокументов", {
      "Фильтр": { "Тип": "ДокОтгрВх", "ДатаС": dmy(now() - days * 86400e3), "ДатаПо": dmy(now()), "Навигация": { "РазмерСтраницы": "100", "Страница": "0" } },
    });
    return (r["Документ"] || []).map(sbisSummary).filter((d) => d.fileUrl);
  }

  // ---------------- общее

  async function list(tid, cfg, days = 30) {
    const docs = cfg.provider === "sbis" ? await sbisList(tid, cfg, days) : await diadocList(tid, cfg, days);
    const st = (await stateRef(tid).get()).data() || {};
    const posted = new Set(st.posted || []);
    return docs.map((d) => ({ ...d, posted: posted.has(d.id), fileUrl: undefined }));
  }

  async function file(tid, cfg, id) {
    if (!ID_RE.test(id)) throw new HttpError(400, "Неверный документ");
    if (cfg.provider === "sbis") {
      if (!id.startsWith("s|")) throw new HttpError(400, "Неверный документ");
      const r = await sbisCall(tid, cfg, "СБИС.ПрочитатьДокумент", { "Документ": { "Идентификатор": id.slice(2) } });
      const d = sbisSummary(r);
      if (!d.fileUrl || !/^https:\/\/([a-z0-9-]+\.)*(sbis|saby)\.ru\//i.test(d.fileUrl)) throw new HttpError(404, "В документе нет XML-файла УПД");
      const sid = await sbisSession(tid, cfg);
      const res = await request(d.fileUrl, { headers: { "X-SBISSessionID": sid } }, "СБИС");
      if (!res.ok) throw new HttpError(502, `СБИС не отдал файл (код ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }
    const [k, boxId, messageId, entityId] = id.split("|");
    if (k !== "d" || !boxId || !messageId || !entityId) throw new HttpError(400, "Неверный документ");
    const q = new URLSearchParams({ boxId, messageId, entityId });
    return diadocGet(tid, cfg, `/V4/GetEntityContent?${q}`, { raw: true });
  }

  async function settings(tid, body) {
    const cur = (await settingsRef(tid).get()).data() || {};
    const s = body.settings || {};
    const provider = s.provider === "sbis" ? "sbis" : "diadoc";
    const patch = { provider, alerts: s.alerts !== false, updatedAt: admin.firestore.Timestamp.fromMillis(now()) };
    if (provider !== cur.provider) { patch.boxId = admin.firestore.FieldValue.delete(); patch.orgName = admin.firestore.FieldValue.delete(); }
    const need = provider === "diadoc" ? [["login", "логин"], ["password", "пароль"], ["apiKey", "ключ API Диадока"]] : [["login", "логин"], ["password", "пароль"]];
    for (const [k, label] of need) {
      const v = typeof s[k] === "string" ? s[k].trim() : "";
      if (v) { if (v.length > 300) throw new HttpError(400, `Слишком длинный ${label}`); patch[`${k}Enc`] = encrypt(v); }
      else if (!cur[`${k}Enc`] || provider !== cur.provider) throw new HttpError(400, `Укажите ${label}`);
    }
    await settingsRef(tid).set(patch, { merge: true });
    sessions.delete(tid);
    // Проверяем доступ сразу: владелец узнаёт об ошибке здесь, а не через час.
    const cfg = await config(tid);
    try {
      await list(tid, cfg, 3);
    } catch (e) {
      throw new HttpError(e.status || 400, `Сохранено, но ${e.message || "доступ не проверился"}`);
    }
    return publicSettings(tid);
  }

  async function publicSettings(tid) {
    const d = (await settingsRef(tid).get()).data();
    if (!d || !d.loginEnc) return { configured: false };
    return { configured: true, provider: d.provider === "sbis" ? "sbis" : "diadoc", alerts: d.alerts !== false, orgName: d.orgName || "" };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    const action = String(body.action || "status");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
    if (action === "status") return sendJson(res, 200, await publicSettings(tid));
    if (action === "settings") return sendJson(res, 200, await settings(tid, body));
    if (action === "disconnect") {
      await settingsRef(tid).delete();
      sessions.delete(tid);
      return sendJson(res, 200, { configured: false });
    }
    const cfg = await config(tid);
    if (!cfg) throw new HttpError(412, "Подключите ЭДО: впишите доступ к Диадоку или СБИС");
    if (action === "list") {
      const docs = await list(tid, cfg, Math.min(Math.max(Number(body.days) || 30, 1), 90));
      await stateRef(tid).set({ seen: docs.map((d) => d.id).slice(0, 500), checkedAt: now() }, { merge: true }).catch(() => {});
      return sendJson(res, 200, { docs });
    }
    if (action === "file") {
      const buf = await file(tid, cfg, String(body.id || ""));
      if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, "Файл накладной больше 5 МБ");
      return sendJson(res, 200, { id: body.id, xml: buf.toString("base64") });
    }
    if (action === "posted") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => ID_RE.test(x)).slice(0, 50);
      if (ids.length) await stateRef(tid).set({ posted: admin.firestore.FieldValue.arrayUnion(...ids) }, { merge: true });
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(400, "Неизвестное действие");
  }

  /** Раз в час: новые входящие УПД — владельцу в бот (один раз на документ). */
  async function runAll() {
    const snap = await db().collection("edo").get();
    for (const d of snap.docs) {
      const tid = d.id;
      try {
        const cfg = await config(tid);
        if (!cfg || !cfg.alerts) continue;
        const docs = await list(tid, cfg, 7);
        const st = (await stateRef(tid).get()).data() || {};
        const known = new Set([...(st.seen || []), ...(st.alerted || [])]);
        const fresh = docs.filter((x) => !known.has(x.id) && !x.posted);
        // Первый запуск после подключения — не засыпаем старыми накладными.
        if (fresh.length && (st.alerted || st.seen)) {
          const rub = (v) => `${Number(v).toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
          const lines = fresh.slice(0, 8).map((x) => `• № ${x.number || "—"} от ${x.date || "—"}${x.supplier ? ` — ${x.supplier}` : ""}${x.total ? `, ${rub(x.total)}` : ""}`);
          await ownerAlert(tid, [`📄 Пришли накладные в ЭДО: ${fresh.length}`, ...lines, fresh.length > 8 ? `… и ещё ${fresh.length - 8}` : "",
            "Проведите приход: кабинет → «Склад» → «Приход по накладной» → «Из ЭДО»."].filter(Boolean).join("\n"));
        }
        await stateRef(tid).set({ alerted: docs.map((x) => x.id).slice(0, 500), checkedAt: now() }, { merge: true });
      } catch (e) {
        console.error(`saas-gateway: ЭДО ${tid}:`, e.message || e);
      }
    }
  }

  return { handle, runAll, list, file, config };
}

module.exports = { createEdo, diadocSummary, sbisSummary, dmy };
