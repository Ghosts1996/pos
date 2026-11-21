"use strict";
// ФГИС «Меркурий» (Россельхознадзор): входящие ветеринарные сертификаты (ВСД)
// и их гашение прямо из кабинета ZalPOS («Склад» → «Меркурий»).
//
// Ветис.API, версия 2.1 (действующая; схемы сверены по классам, сгенерированным
// из официальных XSD: порядок и пространства имён элементов важны — SOAP-сервис
// их проверяет):
//   POST https://api.vetrf.ru/platform/services/2.1/ApplicationManagementService
//   (тест: https://api2.vetrf.ru:8002/…), HTTP Basic — логин и пароль доступа
//   к API из письма Ветис, в теле — apiKey и issuerId (GUID хозяйствующего
//   субъекта). Заявка асинхронная: submitApplicationRequest → applicationId →
//   receiveApplicationResult, пока статус не COMPLETED / REJECTED.
// Операции:
//   getVetDocumentListRequest  — входящие оформленные ВСД площадки (INCOMING/CONFIRMED);
//   getVetDocumentByUuidRequest — свежие данные ВСД перед гашением;
//   processIncomingConsignmentRequest — гашение «принято полностью»
//     (ACCEPT_ALL, соответствует документам и ветосмотру): партия, отправитель,
//     получатель, транспорт и ТТН переносятся из самого ВСД без изменений —
//     «Меркурий» требует совпадения с исходным документом.
// Расхождения (недовес, возврат, отказ) здесь не оформляются: для них —
// «Меркурий.ХС» или сервис поставщика (кабинет так и пишет).
//
// Настройки точки — mercury/{точка} (закрыто правилами, клиенты не читают):
// логин, пароль и ключ API — зашифрованы ключом бота; GUID хозяйствующего
// субъекта и площадки, логин пользователя «Меркурий.ХС», контур (боевой/тест).
// Раз в час (если включено) новые входящие ВСД — владельцу в бот: гасить их
// нужно в течение рабочего дня; виденные — в mercuryState/{точка}.

const crypto = require("crypto");

const NS = {
  soapenv: "http://schemas.xmlsoap.org/soap/envelope/",
  ws: "http://api.vetrf.ru/schema/cdm/application/ws-definitions",
  app: "http://api.vetrf.ru/schema/cdm/application",
  merc: "http://api.vetrf.ru/schema/cdm/mercury/g2b/applications/v2",
  vd: "http://api.vetrf.ru/schema/cdm/mercury/vet-document/v2",
  dt: "http://api.vetrf.ru/schema/cdm/dictionary/v2",
  bs: "http://api.vetrf.ru/schema/cdm/base",
};
const SERVICE_ID = "mercury-g2b.service:2.1";
const ENDPOINTS = {
  prod: "https://api.vetrf.ru/platform/services/2.1/ApplicationManagementService",
  test: "https://api2.vetrf.ru:8002/platform/services/2.1/ApplicationManagementService",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Небольшой XML: разбор с пространствами имён и обратная запись ----------
// Ответы Ветис.API — обычный SOAP (без DTD); партию из ВСД нужно перенести в
// запрос гашения как есть, поэтому храним дерево с URI пространств, а при
// записи даём свои префиксы.

const ENT = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e] ?? m;
});
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");

function parseXml(src) {
  const s = String(src || "");
  if (s.length > 20 * 1024 * 1024) throw new Error("ответ слишком большой");
  const root = { local: "#root", ns: "", attrs: [], children: [] };
  const stack = [{ node: root, scope: { xml: "http://www.w3.org/XML/1998/namespace" } }];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) { const t = s.slice(i); if (t.trim()) top().node.children.push(decode(t)); break; }
    if (lt > i) { const t = s.slice(i, lt); if (t.trim() || top().node.children.length) top().node.children.push(decode(t)); }
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt); i = e === -1 ? s.length : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt); top().node.children.push(s.slice(lt + 9, e === -1 ? s.length : e)); i = e === -1 ? s.length : e + 3; continue; }
    if (s[lt + 1] === "?" || s[lt + 1] === "!") { const e = s.indexOf(">", lt); i = e === -1 ? s.length : e + 1; continue; }
    const gt = s.indexOf(">", lt);
    if (gt === -1) throw new Error("обрыв XML");
    if (s[lt + 1] === "/") {
      if (stack.length <= 1) throw new Error("лишний закрывающий тег");
      stack.pop();
      i = gt + 1;
      continue;
    }
    // Тег с атрибутами: значения атрибутов могут содержать «>».
    let j = lt + 1;
    const nameM = /^[^\s/>]+/.exec(s.slice(j, j + 200));
    if (!nameM) throw new Error("плохой тег");
    const qname = nameM[0];
    j += qname.length;
    const raw = [];
    for (;;) {
      while (/\s/.test(s[j])) j++;
      if (s[j] === "/" || s[j] === ">") break;
      const am = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(j, j + 100000));
      if (!am) throw new Error("плохой атрибут");
      raw.push([am[1], decode(am[3] !== undefined ? am[3] : am[4])]);
      j += am[0].length;
    }
    const selfClose = s[j] === "/";
    i = s.indexOf(">", j) + 1;
    const scope = Object.create(top().scope);
    for (const [k, v] of raw) {
      if (k === "xmlns") scope[""] = v;
      else if (k.startsWith("xmlns:")) scope[k.slice(6)] = v;
    }
    const split = (q, isAttr) => {
      const c = q.indexOf(":");
      const p = c === -1 ? "" : q.slice(0, c);
      const local = c === -1 ? q : q.slice(c + 1);
      return { local, ns: c === -1 ? (isAttr ? "" : scope[""] || "") : scope[p] || "" };
    };
    const n = split(qname, false);
    const node = { local: n.local, ns: n.ns, attrs: raw.filter(([k]) => k !== "xmlns" && !k.startsWith("xmlns:")).map(([k, v]) => ({ ...split(k, true), value: v })), children: [] };
    top().node.children.push(node);
    if (!selfClose) stack.push({ node, scope });
  }
  if (stack.length !== 1) throw new Error("XML оборван");
  const el = root.children.find((c) => typeof c === "object");
  if (!el) throw new Error("пустой XML");
  return el;
}

const kids = (n) => (n && n.children ? n.children.filter((c) => typeof c === "object") : []);
const child = (n, local) => kids(n).find((c) => c.local === local) || null;
function find(n, local) {
  if (!n || typeof n !== "object") return null;
  for (const c of kids(n)) { if (c.local === local) return c; const r = find(c, local); if (r) return r; }
  return null;
}
function findAll(n, local, out = []) {
  for (const c of kids(n)) { if (c.local === local) out.push(c); findAll(c, local, out); }
  return out;
}
const text = (n) => (n ? n.children.map((c) => (typeof c === "string" ? c : text(c))).join("").trim() : "");
const path = (n, ...locals) => locals.reduce((x, l) => (x ? child(x, l) : null), n);

/** Узел → XML с нашими префиксами (неизвестные пространства объявляются на месте). */
function writeXml(node) {
  const pref = Object.fromEntries(Object.entries(NS).map(([p, u]) => [u, p]));
  let k = 0;
  const w = (n) => {
    if (typeof n === "string") return escText(n);
    const decl = [];
    const q = (ns, local, isAttr) => {
      if (!ns) return local;
      let p = pref[ns];
      if (!p) { p = `n${++k}`; decl.push(` xmlns:${p}="${escAttr(ns)}"`); }
      return isAttr && !ns ? local : `${p}:${local}`;
    };
    const name = q(n.ns, n.local, false);
    const attrs = n.attrs.map((a) => ` ${a.ns ? q(a.ns, a.local, true) : a.local}="${escAttr(a.value)}"`).join("");
    const inner = n.children.map(w).join("");
    return `<${name}${decl.join("")}${attrs}>${inner}</${name}>`;
  };
  return w(node);
}

/** Построитель элементов: el("vd:login", "user"), el("merc:delivery", [..]). */
function el(qname, content, attrs = []) {
  const [p, local] = qname.split(":");
  const node = { local, ns: NS[p], attrs, children: [] };
  for (const c of [].concat(content == null ? [] : content)) {
    if (c == null || c === false) continue;
    node.children.push(typeof c === "object" ? c : String(c));
  }
  return node;
}

// ---------- Запросы Ветис.API ----------

function envelope(body) {
  const decl = Object.entries(NS).map(([p, u]) => `xmlns:${p}="${u}"`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope ${decl}><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

const mskIso = (ms) => {
  // Ветис ждёт московское время с поясом (+03:00).
  const d = new Date(ms + 3 * 3600000);
  return `${d.toISOString().slice(0, 19)}+03:00`;
};
const txId = () => `zp${crypto.randomBytes(6).toString("hex")}`;

function submitXml(cfg, data, now) {
  return envelope(writeXml(el("ws:submitApplicationRequest", [
    el("ws:apiKey", cfg.apiKey),
    el("app:application", [
      el("app:serviceId", SERVICE_ID),
      el("app:issuerId", cfg.issuerId),
      el("app:issueDate", mskIso(now)),
      el("app:data", data),
    ]),
  ])));
}

function receiveXml(cfg, applicationId) {
  return envelope(writeXml(el("ws:receiveApplicationResultRequest", [
    el("ws:apiKey", cfg.apiKey), el("ws:issuerId", cfg.issuerId), el("ws:applicationId", applicationId),
  ])));
}

const head = (cfg) => [el("merc:localTransactionId", txId()), el("merc:initiator", el("vd:login", cfg.userLogin))];

function listRequest(cfg, { count = 100, offset = 0 } = {}) {
  return el("merc:getVetDocumentListRequest", [
    ...head(cfg),
    el("bs:listOptions", [el("bs:count", count), el("bs:offset", offset)]),
    el("vd:vetDocumentType", "INCOMING"),
    el("vd:vetDocumentStatus", "CONFIRMED"),
    el("dt:enterpriseGuid", cfg.enterpriseGuid),
  ]);
}

function byUuidRequest(cfg, uuid) {
  return el("merc:getVetDocumentByUuidRequest", [...head(cfg), el("bs:uuid", uuid), el("dt:enterpriseGuid", cfg.enterpriseGuid)]);
}

/**
 * Гашение «принято полностью» по данным самого ВСД (vd:vetDocument).
 * delivery: дата приёмки, отправитель и получатель, партия (vd:batch → vd:consignment),
 * посредник и транспорт как в ВСД, сопроводительные документы — ТТН из ВСД
 * (если есть) и сам сертификат по uuid. deliveryFacts — ветсертификат
 * электронный, документы и ветосмотр соответствуют, принять всё.
 */
function acceptRequest(cfg, vetDocument, now) {
  const uuid = text(child(vetDocument, "uuid"));
  if (!UUID_RE.test(uuid)) throw new Error("у ВСД нет номера (uuid)");
  const cc = child(vetDocument, "certifiedConsignment");
  const batch = cc && child(cc, "batch");
  if (!cc || !batch) throw new Error("в ВСД нет сведений о партии");
  const copy = (n, local, ns = NS.vd) => (n ? { ...n, local, ns } : null);
  const consignment = copy(batch, "consignment");
  consignment.attrs = [];
  // ТТН (тип документа 1) из ссылок ВСД → vd:waybill без relationshipType.
  const ttn = kids(vetDocument).filter((c) => c.local === "referencedDocument").find((r) => text(child(r, "type")) === "1");
  const waybill = ttn ? { local: "waybill", ns: NS.vd, attrs: [], children: kids(ttn).filter((c) => c.local !== "relationshipType") } : null;
  const responsible = el("vd:responsible", el("vd:login", cfg.userLogin));
  return el("merc:processIncomingConsignmentRequest", [
    ...head(cfg),
    el("merc:delivery", [
      el("vd:deliveryDate", mskIso(now)),
      copy(child(cc, "consignor"), "consignor"),
      copy(child(cc, "consignee"), "consignee"),
      consignment,
      copy(child(cc, "broker"), "broker"),
      copy(child(cc, "transportInfo"), "transportInfo"),
      copy(child(cc, "transportStorageType"), "transportStorageType"),
      copy(child(cc, "shipmentRoute"), "shipmentRoute"),
      el("vd:accompanyingForms", [waybill, el("vd:vetCertificate", el("bs:uuid", uuid))]),
    ]),
    el("merc:deliveryFacts", [
      el("vd:vetCertificatePresence", "ELECTRONIC"),
      el("vd:docInspection", [responsible, el("vd:result", "CORRESPONDS")]),
      el("vd:vetInspection", [el("vd:responsible", el("vd:login", cfg.userLogin)), el("vd:result", "CORRESPONDS")]),
      el("vd:decision", "ACCEPT_ALL"),
    ]),
  ]);
}

/** ВСД → строка для кабинета и бота (без лишнего). */
function vetDocSummary(d) {
  const cc = child(d, "certifiedConsignment");
  const batch = cc && child(cc, "batch");
  const consignor = cc && child(cc, "consignor");
  const be = consignor && child(consignor, "businessEntity");
  const ent = consignor && child(consignor, "enterprise");
  const name = text(path(batch, "productItem", "name")) || text(path(batch, "subProduct", "name")) || text(path(batch, "product", "name")) || "Продукция";
  const volume = Number(text(child(batch, "volume"))) || 0;
  const unit = text(path(batch, "unit", "name"));
  const date = (n) => { const f = child(batch, n); if (!f) return ""; const fp = child(f, "firstDate") || f; const y = text(child(fp, "year")), m = text(child(fp, "month")), dd = text(child(fp, "day")); return y ? [dd, m, y].filter(Boolean).map((v) => String(v).padStart(2, "0")).join(".") : text(f); };
  return {
    uuid: text(child(d, "uuid")),
    issueDate: text(child(d, "issueDate")).slice(0, 10),
    issueNumber: text(child(d, "issueNumber")),
    product: name.slice(0, 200),
    volume, unit: unit.slice(0, 20),
    supplier: (text(child(be, "name")) || text(child(ent, "name")) || "Поставщик").slice(0, 200),
    produced: date("dateOfProduction"), expires: date("expiryDate"),
  };
}

// ---------- Клиент ----------

function createMercury(deps) {
  const {
    db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, encrypt, decrypt, secretKey,
    ownerAlert = async () => {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
    endpoints = ENDPOINTS, pollMs = 2500, pollTries = 16,
  } = deps;
  const settingsRef = (tid) => db().collection("mercury").doc(tid);
  const stateRef = (tid) => db().collection("mercuryState").doc(tid);

  async function config(tid) {
    const d = (await settingsRef(tid).get()).data();
    if (!d || !d.loginEnc) return null;
    const dec = (v) => { try { return decrypt(secretKey(), v); } catch (_) { return ""; } };
    return { login: dec(d.loginEnc), password: dec(d.passwordEnc), apiKey: dec(d.apiKeyEnc), issuerId: d.issuerId, enterpriseGuid: d.enterpriseGuid,
      userLogin: d.userLogin, env: d.env === "test" ? "test" : "prod", alerts: d.alerts !== false, enterpriseName: d.enterpriseName || "" };
  }

  async function post(cfg, action, xml) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res, body;
    try {
      res = await fetchImpl(endpoints[cfg.env], {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"`,
          Authorization: `Basic ${Buffer.from(`${cfg.login}:${cfg.password}`).toString("base64")}` },
        body: xml,
      });
      body = await res.text();
    } catch (e) {
      throw new HttpError(502, e.name === "AbortError" ? "«Меркурий» не ответил за 30 секунд — попробуйте позже" : "Нет связи с «Меркурием» — попробуйте позже");
    } finally { clearTimeout(timer); }
    if (res.status === 401 || res.status === 403) throw new HttpError(400, "«Меркурий» не принял логин и пароль API — проверьте их в настройках");
    let doc;
    try { doc = parseXml(body); } catch (_) { throw new HttpError(502, `«Меркурий» ответил непонятно (код ${res.status})`); }
    const fault = find(doc, "Fault");
    if (fault) {
      const msg = text(find(fault, "message")) || text(find(fault, "faultstring")) || "ошибка";
      throw new HttpError(400, `«Меркурий»: ${msg.slice(0, 300)}`);
    }
    return doc;
  }

  /** Заявка → результат (ждём, пока «Меркурий» обработает). */
  async function call(cfg, data) {
    const sub = await post(cfg, "submitApplicationRequest", submitXml(cfg, data, now()));
    const appId = text(find(sub, "applicationId"));
    if (!appId) throw new HttpError(502, "«Меркурий» не принял заявку");
    for (let i = 0; i < pollTries; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const res = await post(cfg, "receiveApplicationResult", receiveXml(cfg, appId));
      const application = find(res, "application");
      const status = text(child(application, "status"));
      if (status === "COMPLETED") return child(application, "result") || application;
      if (status === "REJECTED") {
        const errs = findAll(child(application, "errors") || application, "error").map((e) => {
          const code = (e.attrs.find((a) => a.local === "code") || {}).value;
          return `${code ? `${code}: ` : ""}${text(e)}`;
        }).filter(Boolean);
        throw new HttpError(400, `«Меркурий» отклонил: ${(errs.join("; ") || "без пояснения").slice(0, 600)}`);
      }
    }
    throw new HttpError(504, "«Меркурий» ещё обрабатывает заявку — обновите список через минуту");
  }

  async function list(cfg) {
    const out = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const result = await call(cfg, listRequest(cfg, { count: 100, offset }));
      const listEl = find(result, "vetDocumentList");
      // Только сами ВСД списка: внутри сертификата бывают ссылки на предыдущие.
      const docs = listEl ? kids(listEl).filter((c) => c.local === "vetDocument") : [];
      out.push(...docs);
      const total = Number((listEl && listEl.attrs.find((a) => a.local === "total") || {}).value) || docs.length;
      if (docs.length < 100 || out.length >= total) break;
    }
    return out;
  }

  async function settings(tid, body) {
    const cur = (await settingsRef(tid).get()).data() || {};
    const s = body.settings || {};
    const guid = (v, label) => {
      const x = String(v || "").trim();
      if (!UUID_RE.test(x)) throw new HttpError(400, `${label}: нужен GUID вида 1234abcd-…-…`);
      return x.toLowerCase();
    };
    const patch = {
      issuerId: guid(s.issuerId ?? cur.issuerId, "GUID хозяйствующего субъекта"),
      enterpriseGuid: guid(s.enterpriseGuid ?? cur.enterpriseGuid, "GUID площадки"),
      userLogin: String(s.userLogin ?? cur.userLogin ?? "").trim().slice(0, 80),
      env: s.env === "test" ? "test" : "prod",
      alerts: s.alerts !== false,
      enterpriseName: String(s.enterpriseName ?? cur.enterpriseName ?? "").trim().slice(0, 120),
      updatedAt: admin.firestore.Timestamp.fromMillis(now()),
    };
    if (!patch.userLogin) throw new HttpError(400, "Укажите логин пользователя «Меркурий.ХС»");
    for (const [k, label] of [["login", "логин API"], ["password", "пароль API"], ["apiKey", "ключ API (apiKey)"]]) {
      const v = typeof s[k] === "string" ? s[k].trim() : "";
      if (v) { if (v.length > 300) throw new HttpError(400, `Слишком длинный ${label}`); patch[`${k}Enc`] = encrypt(secretKey(), v); }
      else if (!cur[`${k}Enc`]) throw new HttpError(400, `Укажите ${label}`);
    }
    await settingsRef(tid).set(patch, { merge: true });
    return publicSettings(tid);
  }

  async function publicSettings(tid) {
    const d = (await settingsRef(tid).get()).data();
    if (!d || !d.loginEnc) return { configured: false };
    return { configured: true, issuerId: d.issuerId, enterpriseGuid: d.enterpriseGuid, userLogin: d.userLogin, env: d.env, alerts: d.alerts !== false, enterpriseName: d.enterpriseName || "" };
  }

  async function accept(tid, cfg, uuids, uid) {
    const done = [], failed = [];
    for (const uuid of uuids) {
      try {
        const res = await call(cfg, byUuidRequest(cfg, uuid));
        const vd = find(res, "vetDocument");
        if (!vd) throw new HttpError(404, "ВСД не найден");
        if (text(child(vd, "vetDStatus")) && text(child(vd, "vetDStatus")) !== "CONFIRMED") throw new HttpError(409, "ВСД уже погашен или аннулирован");
        await call(cfg, acceptRequest(cfg, vd, now()));
        done.push({ uuid, ...vetDocSummary(vd) });
      } catch (e) {
        failed.push({ uuid, error: e.message || String(e) });
      }
    }
    if (done.length) {
      await stateRef(tid).set({ accepted: admin.firestore.FieldValue.arrayUnion(...done.map((d) => ({ uuid: d.uuid, product: d.product, supplier: d.supplier, at: now(), by: uid }))) }, { merge: true }).catch(() => {});
    }
    return { done, failed };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    const action = String(body.action || "status");
    if (action === "status") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
      return sendJson(res, 200, await publicSettings(tid));
    }
    if (action === "settings") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
      return sendJson(res, 200, await settings(tid, body));
    }
    if (action === "disconnect") {
      await requireTenantRole(tid, decoded.uid, ["owner", "admin"]);
      await settingsRef(tid).delete();
      return sendJson(res, 200, { configured: false });
    }
    await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
    const cfg = await config(tid);
    if (!cfg) throw new HttpError(412, "Подключите «Меркурий»: впишите доступ к Ветис.API");
    if (action === "list") {
      const docs = (await list(cfg)).map(vetDocSummary).filter((d) => UUID_RE.test(d.uuid));
      await stateRef(tid).set({ seen: docs.map((d) => d.uuid).slice(0, 500), checkedAt: now() }, { merge: true }).catch(() => {});
      return sendJson(res, 200, { docs });
    }
    if (action === "accept") {
      const uuids = [...new Set((Array.isArray(body.uuids) ? body.uuids : []).map(String))].filter((u) => UUID_RE.test(u)).slice(0, 30);
      if (!uuids.length) throw new HttpError(400, "Не выбраны ВСД");
      return sendJson(res, 200, await accept(tid, cfg, uuids, decoded.uid));
    }
    throw new HttpError(400, "Неизвестное действие");
  }

  /** Раз в час: новые входящие ВСД — владельцу в бот (один раз на ВСД). */
  async function runAll() {
    const snap = await db().collection("mercury").get();
    for (const d of snap.docs) {
      const tid = d.id;
      try {
        const cfg = await config(tid);
        if (!cfg || !cfg.alerts) continue;
        const docs = (await list(cfg)).map(vetDocSummary).filter((x) => UUID_RE.test(x.uuid));
        const st = (await stateRef(tid).get()).data() || {};
        const seen = new Set([...(st.seen || []), ...(st.alerted || [])]);
        const fresh = docs.filter((x) => !seen.has(x.uuid));
        if (fresh.length) {
          const lines = fresh.slice(0, 8).map((x) => `• ${x.product} — ${String(x.volume).replace(".", ",")} ${x.unit} (${x.supplier})`);
          await ownerAlert(tid, [`🐄 «Меркурий»: пришло ВСД — ${fresh.length}`, ...lines, fresh.length > 8 ? `… и ещё ${fresh.length - 8}` : "",
            "Погасите их в течение рабочего дня: кабинет → «Склад» → «Меркурий»."].filter(Boolean).join("\n"));
        }
        await stateRef(tid).set({ alerted: docs.map((x) => x.uuid).slice(0, 500), checkedAt: now() }, { merge: true });
      } catch (e) {
        console.error(`saas-gateway: «Меркурий» ${tid}:`, e.message || e);
      }
    }
  }

  return { handle, runAll, list, accept, config };
}

module.exports = { createMercury, parseXml, writeXml, el, listRequest, byUuidRequest, acceptRequest, vetDocSummary, submitXml, receiveXml, NS, SERVICE_ID, ENDPOINTS, find, findAll, child, text };
