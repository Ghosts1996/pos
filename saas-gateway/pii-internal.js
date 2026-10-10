"use strict";

// Справочник людей в РФ (pii-gateway/vault.js) — запросы от имени сервера.
//
// Telegram-бот, заказ из приложения гостя и страницы по подписанным
// ссылкам читают и пишут имена, телефоны и адреса здесь, а не в Firestore,
// когда заведение переведено на хранение в РФ (meta/venueProfile.piiMode =
// 'rf'). Доступ — по секрету PII_INTERNAL_TOKEN, общему для двух сервисов
// на этом сервере (update-server.sh); без него справочник недоступен, и
// вызовы отдают пустые значения, а не падают.

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function createPiiInternal({ urls, token = process.env.PII_INTERNAL_TOKEN || "", fetchImpl, db } = {}) {
  const doFetch = fetchImpl || fetch;

  async function call(body) {
    if (!token) throw new Error("PII_INTERNAL_TOKEN не задан");
    let lastError = null;
    for (const url of urls) {
      let resp;
      try {
        resp = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pii-Internal": token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        lastError = e;
        continue; // следующий адрес
      }
      let json = {};
      try {
        json = await resp.json();
      } catch (_) { /* пустой ответ */ }
      if (!resp.ok) {
        const err = new Error(json.error || `справочник ответил ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      return json;
    }
    throw lastError || new Error("справочник в РФ недоступен");
  }

  /** Режим заведения: 'rf' — имён в Firestore нет, источник — справочник. */
  const modeCache = new Map(); // tenantId → { at, mode }
  async function mode(tenantId) {
    const hit = modeCache.get(tenantId);
    if (hit && Date.now() - hit.at < 30000) return hit.mode;
    let m = "mirror";
    try {
      const snap = await db().doc(`tenants/${tenantId}/meta/venueProfile`).get();
      if (snap.exists && snap.data().piiMode === "rf") m = "rf";
    } catch (_) { /* прежний режим */ }
    modeCache.set(tenantId, { at: Date.now(), mode: m });
    return m;
  }

  /** Записи справочника: refs = [{ k, id }] → Map 'k:id' → { name, phone, address, extra }. */
  async function lookup(tenantId, refs) {
    const out = new Map();
    const valid = refs.filter((r) => r && ID_RE.test(String(r.id || "")));
    if (!valid.length || !token) return out;
    for (let i = 0; i < valid.length; i += 400) {
      const res = await call({ tenantId, kind: "pii_lookup", refs: valid.slice(i, i + 400) });
      for (const r of res.staff || []) out.set(`staff:${r.id}`, r);
      for (const r of res.guests || []) out.set(`guest:${r.id}`, r);
      for (const r of res.contacts || []) out.set(`${r.k}:${r.id}`, r);
    }
    return out;
  }

  /** Записать: items = [{ k, id, fields }]; asUid — от имени гостя. */
  async function put(tenantId, items, asUid = "") {
    if (!items.length) return;
    await call({ tenantId, kind: "pii_put", items, ...(asUid ? { asUid } : {}) });
  }

  async function erase(tenantId, k, id) {
    await call({ tenantId, kind: "pii_erase", k, id });
  }

  /**
   * Имя сотрудника для страницы на сервере в РФ. raw — что лежит в
   * документе: имя (режим mirror) или ссылка staff:<id> (режим rf);
   * employeeId — если известен отдельно.
   */
  async function staffName(tenantId, raw, employeeId = "") {
    const v = String(raw || "");
    const id = v.startsWith("staff:") ? v.slice(6) : employeeId;
    if (v && !v.startsWith("staff:")) return v;
    if (!id) return "";
    try {
      const rec = (await lookup(tenantId, [{ k: "staff", id }])).get(`staff:${id}`);
      if (rec && rec.name) return rec.name;
    } catch (_) { /* ниже — из документа сотрудника */ }
    try {
      const emp = (await db().doc(`tenants/${tenantId}/employees/${id}`).get()).data();
      if (emp && emp.name) return String(emp.name);
    } catch (_) { /* нет */ }
    return "";
  }

  return { call, mode, lookup, put, erase, staffName, enabled: () => !!token };
}

module.exports = { createPiiInternal };
