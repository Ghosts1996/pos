"use strict";

const crypto = require("crypto");

/**
 * Перевод заведения на хранение персональных данных только в РФ
 * (meta/venueProfile.piiMode: 'mirror' → 'rf'). Делает супер-админ, по шагам:
 *
 *  status   — режим, ход переноса, кассы заведения и их сборки;
 *  copy     — имена, телефоны и адреса из Firestore — в справочник в РФ
 *             (pii-gateway, pii_seed: только дописывает пустое, записанное
 *             в РФ не трогает). Firestore не меняется, повторять можно;
 *  switch   — режим rf: кассы, веб-гость и сервер перестают писать имена и
 *             телефоны в Firestore. Только после copy и когда все кассы на
 *             сборке, которая это умеет (devices.piiReady);
 *  scrub    — не раньше чем через сутки после switch: из Firestore
 *             убирается то, что сверено со справочником, а «кто сделал» по
 *             имени становится ссылкой staff:<id>. Несверенное остаётся
 *             (его можно дописать повторным copy). dryRun — только подсчёт.
 *
 * Каждый шаг читает все записи заведения (как бэкап) — у крупных заведений
 * это заметная часть дневной квоты чтений Firestore.
 *  rollback — обратно в mirror (запасной выход: касса берёт имена из
 *             справочника и в этом режиме, если в документе их нет).
 *
 * copy и scrub идут в фоне; ход и итог — в tenants/{id}/meta/piiMigration.
 */

// Уровень справочника, который касса сообщает в devices/{uid}.piiReady
// (StaffDeviceService.piiLevel).
const READY_LEVEL = 1;
const SCRUB_AFTER_MS = 24 * 3600 * 1000;

// Не имя человека, а служебная отметка в поле «кто сделал».
const SERVICE_WHO = /^(auto|telegram|guest|system|server|гость|система|бот|сервер)$/i;
// Заглушка после обезличивания гостя (saas-gateway anonymizeGuestData).
const PLACEHOLDERS = new Set(["Гость (данные удалены)", "Гость", "Всей смене", "Смене"]);

/**
 * Где в Firestore лежат персональные данные заведения и куда они уходят
 * в справочнике (pii-gateway/vault.js). Повторяет toMap() моделей кассы,
 * где в режиме rf поле не пишется (Pd.mirror) или пишется ссылкой (Pd.who).
 *
 *  contacts  — поля записи → её контакт в справочнике (вид, id документа);
 *              owner — чей это контакт (гость потом видит его сам);
 *  guestCopy — [поле, поле uid]: имя гостя, касса берёт его из профиля;
 *  staffName — [поле, поле id]: имя сотрудника рядом с его id;
 *  who       — «кто сделал»: имя → staff:<id>; whoId — поле, где id уже есть.
 */
const SPEC = {
  reservations: {
    contacts: [{ kind: "reservation", map: { guestName: "name", phone: "phone" }, owner: "clientUid" }],
    who: ["handledBy"],
  },
  waitlist: {
    contacts: [{ kind: "waitlist", map: { guestName: "name", phone: "phone" }, owner: "clientUid" }],
  },
  discountCards: {
    contacts: [{ kind: "card", map: { guestName: "name", notes: "extra.notes" } }],
  },
  sessions: {
    contacts: [
      {
        kind: "delivery",
        map: {
          customerName: "name", customerPhone: "phone", deliveryAddress: "address",
          deliveryComment: "extra.comment", courierName: "extra.courierName", courierPhone: "extra.courierPhone",
        },
        owner: "clientUid",
      },
      { kind: "session", map: { guestContact: "extra.guestContact" } },
    ],
    staffName: [["employeeName", "employeeId"]],
    who: ["cancelledBy"],
  },
  guestOrders: { guestCopy: [["guestName", "clientUid"]], who: ["doneBy", "handledBy"] },
  waiterCalls: { guestCopy: [["guestName", "clientUid"]], who: ["handledBy"] },
  reviews: { guestCopy: [["guestName", "clientUid"]] },
  cashOps: { staffName: [["employeeName", "employeeId"]], who: ["cancelledBy"] },
  staffShifts: { staffName: [["employeeName", "employeeId"]], who: ["editedBy", "cancelledBy"], whoId: { editedBy: "editedById" } },
  payrollAdjustments: { staffName: [["employeeName", "employeeId"]], who: ["createdBy", "cancelledBy"] },
  inventoryMovements: { staffName: [["employeeName", "employeeId"]] },
  inventoryCounts: { who: ["startedBy", "closedBy"] },
  shifts: { who: ["openedBy", "closedBy"], whoId: { openedBy: "openedById" } },
  giftCards: { who: ["issuedBy"] },
  tips: { staffName: [["employeeName", "employeeId"]], teamMembers: true },
  auditLog: { who: ["employeeName", "details.employee", "details.approvedBy"] },
};

const PAGE = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Постоянный id для имени из прошлых записей, которого нет среди сотрудников. */
function legacyStaffId(tenantId, name) {
  return `n${crypto.createHash("sha256").update(`${tenantId}:${name}`).digest("hex").slice(0, 20)}`;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

const text = (v) => (typeof v === "string" ? v.trim() : "");
const digits = (v) => String(v || "").replace(/\D/g, "");
const phoneOk = (v) => digits(v).length >= 10 && digits(v).length <= 15;

function createPiiMigrate({ db, admin, pii, HttpError, now = () => Date.now(), log = console }) {
  const FieldValue = admin.firestore.FieldValue;
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  const running = new Set();

  const tenantRef = (t) => db().collection("tenants").doc(t);
  const metaRef = (t) => tenantRef(t).collection("meta").doc("piiMigration");

  /** Все документы коллекции — страницами: чеков бывают десятки тысяч. */
  async function forEachPage(colRef, fn) {
    if (typeof colRef.orderBy !== "function") {
      const snap = await colRef.get();
      if (snap.docs.length) await fn(snap.docs);
      return;
    }
    let last = null;
    for (;;) {
      let q = colRef.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.docs.length) await fn(snap.docs);
      if (snap.docs.length < PAGE) return;
      last = snap.docs[snap.docs.length - 1];
    }
  }

  /** Запись пачками по 400 (лимит пакета Firestore — 500). */
  function writer(dryRun) {
    let batch = null;
    let n = 0;
    const flush = async () => {
      if (batch && n) await batch.commit();
      batch = null;
      n = 0;
    };
    return {
      async op(kind, ref, patch) {
        if (dryRun) return;
        if (typeof db().batch !== "function") {
          await (kind === "delete" ? ref.delete() : ref.update(patch));
          return;
        }
        if (!batch) batch = db().batch();
        if (kind === "delete") batch.delete(ref);
        else batch.update(ref, patch);
        if (++n >= 400) await flush();
      },
      flush,
    };
  }

  async function context(tenantId) {
    if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) throw new HttpError(400, "Не указано заведение");
    const t = await tenantRef(tenantId).get();
    if (!t.exists) throw new HttpError(404, "Заведение не найдено");
    const chainId = String(t.data().chainId || "");
    const venue = (await tenantRef(tenantId).collection("meta").doc("venueProfile").get()).data() || {};
    const meta = (await metaRef(tenantId).get()).data() || {};
    return {
      tenantId,
      chainId,
      name: t.data().name || "",
      loyaltyRoot: chainId ? db().collection("chains").doc(chainId) : tenantRef(tenantId),
      mode: venue.piiMode === "rf" ? "rf" : "mirror",
      meta,
    };
  }

  /** Все точки сети в режиме rf — только тогда трогаем общие профили гостей. */
  async function chainAllRf(ctx) {
    if (!ctx.chainId) return ctx.mode === "rf";
    const points = await db().collection("tenants").where("chainId", "==", ctx.chainId).get();
    for (const p of points.docs) {
      const v = (await p.ref.collection("meta").doc("venueProfile").get()).data() || {};
      if (v.piiMode !== "rf") return false;
    }
    return true;
  }

  /** Сотрудники: id → имя и имя → id (имя из документа или из справочника). */
  async function staffIndex(ctx) {
    const emps = await tenantRef(ctx.tenantId).collection("employees").get();
    let vault = new Map();
    try {
      vault = await pii.lookup(ctx.tenantId, emps.docs.map((d) => ({ k: "staff", id: d.id })));
    } catch (_) { /* справочник недоступен — только имена из документов */ }
    const names = new Map();
    const byName = new Map();
    for (const d of emps.docs) {
      const name = text(d.data().name) || text((vault.get(`staff:${d.id}`) || {}).name);
      if (!name) continue;
      names.set(d.id, name);
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(d.id);
    }
    return {
      employees: emps.docs,
      names,
      /** «Кто сделал» → { id, name, legacy } или null (не трогать). */
      resolve(raw) {
        const v = text(raw);
        if (!v || v.startsWith("staff:") || SERVICE_WHO.test(v)) return null;
        const hit = byName.get(v);
        if (hit && hit.size === 1) return { id: [...hit][0], name: v, legacy: false };
        // Тёзки или бывший сотрудник: своя запись в справочнике под
        // постоянным id — подпись в старых записях не теряется.
        return { id: legacyStaffId(ctx.tenantId, v), name: v, legacy: true };
      },
    };
  }

  // ------------------------------------------------------------- copy

  async function copy(ctx) {
    const items = [];
    const counts = {};
    let filled = 0;
    const add = (item, label) => {
      items.push(item);
      counts[label] = (counts[label] || 0) + 1;
    };
    const send = async (all = false) => {
      while (items.length >= (all ? 1 : 400)) {
        const part = items.splice(0, 400);
        const res = await pii.call({ tenantId: ctx.tenantId, kind: "pii_seed", items: part });
        filled += Number(res.filled) || 0;
      }
    };
    const staff = await staffIndex(ctx);
    const T = tenantRef(ctx.tenantId);

    for (const d of staff.employees) {
      const name = text(d.data().name);
      const phone = text(d.data().phone);
      if (name || phone) add({ k: "staff", id: d.id, fields: { name, phone } }, "staff");
    }
    await send();

    // Гости: у сети профиль общий на все точки — справочник тот же (chain:<id>).
    const phoneMarks = [];
    await forEachPage(ctx.loyaltyRoot.collection("clients"), async (docs) => {
      for (const d of docs) {
        const c = d.data();
        if (c.anonymized === true || !ID_RE.test(d.id)) continue;
        const name = text(c.name);
        const phone = text(c.phone);
        if (name || phone) add({ k: "guest", id: d.id, fields: { name, phone } }, "guests");
        if (phoneOk(phone) && c.phoneOnFile !== true) phoneMarks.push(d.ref);
      }
      await send();
    });

    const guestNames = new Map();
    const staffNames = new Map();
    const legacy = new Map();
    for (const [col, spec] of Object.entries(SPEC)) {
      await forEachPage(T.collection(col), async (docs) => {
        for (const d of docs) {
          if (!ID_RE.test(d.id)) continue;
          const x = d.data();
          for (const c of spec.contacts || []) {
            const fields = {};
            let any = false;
            for (const [src, dst] of Object.entries(c.map)) {
              const v = text(x[src]);
              if (!v || PLACEHOLDERS.has(v)) continue;
              if (dst.startsWith("extra.")) (fields.extra = fields.extra || {})[dst.slice(6)] = v;
              else fields[dst] = v;
              any = true;
            }
            if (!any) continue;
            const by = c.owner && ID_RE.test(text(x[c.owner])) ? text(x[c.owner]) : "";
            add({ k: c.kind, id: d.id, fields, ...(by ? { by } : {}) }, c.kind);
          }
          for (const [field, uidField] of spec.guestCopy || []) {
            const v = text(x[field]);
            const uid = text(x[uidField]);
            if (v && !PLACEHOLDERS.has(v) && ID_RE.test(uid) && !guestNames.has(uid)) guestNames.set(uid, v);
          }
          for (const [field, idField] of spec.staffName || []) {
            const v = text(x[field]);
            const id = text(x[idField]);
            if (v && !PLACEHOLDERS.has(v) && !v.startsWith("staff:") && ID_RE.test(id) && !staffNames.has(id)) staffNames.set(id, v);
          }
          for (const f of spec.who || []) {
            const r = staff.resolve(getPath(x, f));
            if (r && r.legacy) legacy.set(r.id, r.name);
          }
          if (spec.teamMembers && Array.isArray(x.teamMembers)) {
            for (const m of x.teamMembers) {
              if (m && ID_RE.test(text(m.id)) && text(m.name) && !staffNames.has(text(m.id))) staffNames.set(text(m.id), text(m.name));
            }
          }
        }
        await send();
      });
    }
    // Имена из копий — в справочник, только если там пусто.
    for (const [uid, name] of guestNames) add({ k: "guest", id: uid, fields: { name } }, "guestNamesFromRecords");
    for (const [id, name] of staffNames) add({ k: "staff", id, fields: { name } }, "staffNamesFromRecords");
    for (const [id, name] of legacy) add({ k: "staff", id, fields: { name } }, "formerStaff");
    // Подписи из истории ставок сотрудника.
    for (const d of staff.employees) {
      for (const h of Array.isArray(d.data().payHistory) ? d.data().payHistory : []) {
        if (!h || text(h.byId)) continue;
        const r = staff.resolve(h.byName);
        if (r && r.legacy && !legacy.has(r.id)) {
          legacy.set(r.id, r.name);
          add({ k: "staff", id: r.id, fields: { name: r.name } }, "formerStaff");
        }
      }
    }
    await send(true);

    // Номер записан в РФ — по этой отметке гостя пускают за стол в режиме rf.
    const w = writer(false);
    for (const ref of phoneMarks) await w.op("update", ref, { phoneOnFile: true });
    await w.flush();
    return { counts, filled, phoneMarked: phoneMarks.length };
  }

  // ------------------------------------------------------------- scrub

  /** Справочник по ссылкам страницы: Map 'k:id' → запись. */
  async function vaultFor(ctx, refs) {
    const seen = new Set();
    const list = refs.filter((r) => {
      const key = `${r.k}:${r.id}`;
      if (seen.has(key) || !ID_RE.test(r.id)) return false;
      seen.add(key);
      return true;
    });
    return list.length ? pii.lookup(ctx.tenantId, list) : new Map();
  }

  const vaultValue = (rec, dst) => {
    if (!rec) return "";
    if (dst.startsWith("extra.")) return text((rec.extra || {})[dst.slice(6)]);
    return text(rec[dst]);
  };

  async function scrub(ctx, { dryRun }) {
    const staff = await staffIndex(ctx);
    const T = tenantRef(ctx.tenantId);
    const w = writer(dryRun);
    const removed = {};
    const unverified = {};
    const count = (bag, col, n = 1) => { bag[col] = (bag[col] || 0) + n; };

    /** «Кто сделал» → ссылка, если справочник знает имя по этому id. */
    const whoRef = (raw, idHint, vault) => {
      const id = text(idHint);
      if (ID_RE.test(id) && text((vault.get(`staff:${id}`) || {}).name)) return `staff:${id}`;
      const r = staff.resolve(raw);
      if (r && text((vault.get(`staff:${r.id}`) || {}).name)) return `staff:${r.id}`;
      return null;
    };

    for (const [col, spec] of Object.entries(SPEC)) {
      await forEachPage(T.collection(col), async (docs) => {
        // Что спросить у справочника для сверки этой страницы.
        const refs = [];
        for (const d of docs) {
          const x = d.data();
          for (const c of spec.contacts || []) refs.push({ k: c.kind, id: d.id });
          for (const [, uidField] of spec.guestCopy || []) if (text(x[uidField])) refs.push({ k: "guest", id: text(x[uidField]) });
          for (const [, idField] of spec.staffName || []) if (text(x[idField])) refs.push({ k: "staff", id: text(x[idField]) });
          for (const f of spec.who || []) {
            const idField = (spec.whoId || {})[f];
            if (idField && text(x[idField])) refs.push({ k: "staff", id: text(x[idField]) });
            const r = staff.resolve(getPath(x, f));
            if (r) refs.push({ k: "staff", id: r.id });
          }
          if (spec.teamMembers && Array.isArray(x.teamMembers)) {
            for (const m of x.teamMembers) if (m && text(m.id)) refs.push({ k: "staff", id: text(m.id) });
          }
        }
        const vault = await vaultFor(ctx, refs);
        for (const d of docs) {
          const x = d.data();
          const patch = {};
          for (const c of spec.contacts || []) {
            const rec = vault.get(`${c.kind}:${d.id}`);
            for (const [src, dst] of Object.entries(c.map)) {
              const v = text(x[src]);
              if (!v || PLACEHOLDERS.has(v)) continue;
              if (vaultValue(rec, dst)) patch[src] = FieldValue.delete();
              else count(unverified, col);
            }
          }
          for (const [field, uidField] of spec.guestCopy || []) {
            const v = text(x[field]);
            if (!v || PLACEHOLDERS.has(v)) continue;
            if (text((vault.get(`guest:${text(x[uidField])}`) || {}).name)) patch[field] = FieldValue.delete();
            else count(unverified, col);
          }
          for (const [field, idField] of spec.staffName || []) {
            const v = text(x[field]);
            if (!v || PLACEHOLDERS.has(v) || v.startsWith("staff:")) continue;
            if (text((vault.get(`staff:${text(x[idField])}`) || {}).name)) patch[field] = FieldValue.delete();
            else count(unverified, col);
          }
          for (const f of spec.who || []) {
            const raw = getPath(x, f);
            const v = text(raw);
            if (!v || v.startsWith("staff:") || SERVICE_WHO.test(v)) continue;
            const ref = whoRef(raw, x[(spec.whoId || {})[f]], vault);
            if (ref) patch[f] = ref;
            else count(unverified, col);
          }
          if (spec.teamMembers && Array.isArray(x.teamMembers) && x.teamMembers.some((m) => m && text(m.name))) {
            let changed = false;
            const team = x.teamMembers.map((m) => {
              if (!m || !text(m.name) || !text((vault.get(`staff:${text(m.id)}`) || {}).name)) return m;
              changed = true;
              const { name: _drop, ...rest } = m;
              return rest;
            });
            if (changed) patch.teamMembers = team;
            if (team.some((m) => m && text(m.name))) count(unverified, col);
          }
          if (Object.keys(patch).length) {
            count(removed, col);
            await w.op("update", d.ref, patch);
          }
        }
      });
    }

    // Сотрудники: имя и телефон, подписи в истории ставок.
    {
      const vault = await vaultFor(ctx, [
        ...staff.employees.map((d) => ({ k: "staff", id: d.id })),
        ...staff.employees.flatMap((d) => (Array.isArray(d.data().payHistory) ? d.data().payHistory : [])
          .map((h) => (h && text(h.byId) ? { k: "staff", id: text(h.byId) } : null)).filter(Boolean)),
        ...staff.employees.flatMap((d) => (Array.isArray(d.data().payHistory) ? d.data().payHistory : [])
          .map((h) => (h && !text(h.byId) ? staff.resolve(h.byName) : null)).filter(Boolean).map((r) => ({ k: "staff", id: r.id }))),
      ]);
      for (const d of staff.employees) {
        const e = d.data();
        const rec = vault.get(`staff:${d.id}`);
        const patch = {};
        if (text(e.name)) {
          if (vaultValue(rec, "name")) patch.name = FieldValue.delete();
          else count(unverified, "employees");
        }
        if (text(e.phone)) {
          if (vaultValue(rec, "phone")) patch.phone = FieldValue.delete();
          else count(unverified, "employees");
        }
        if (Array.isArray(e.payHistory) && e.payHistory.some((h) => h && text(h.byName))) {
          let changed = false;
          const history = e.payHistory.map((h) => {
            if (!h || !text(h.byName)) return h;
            const id = text(h.byId) || (staff.resolve(h.byName) || {}).id || "";
            if (!id || !text((vault.get(`staff:${id}`) || {}).name)) return h;
            changed = true;
            const { byName: _drop, ...rest } = h;
            return { ...rest, byId: id };
          });
          if (changed) patch.payHistory = history;
          if (history.some((h) => h && text(h.byName))) count(unverified, "employees");
        }
        if (Object.keys(patch).length) {
          count(removed, "employees");
          await w.op("update", d.ref, patch);
        }
      }
    }

    // Кто на смене (для чаевых гостя) — касса пересоберёт без имён.
    {
      const ref = T.collection("meta").doc("tipsTeam");
      const snap = await ref.get();
      const members = snap.exists && snap.data().members && typeof snap.data().members === "object" ? snap.data().members : {};
      const ids = Object.keys(members).filter((id) => members[id] && text(members[id].name));
      if (ids.length) {
        const vault = await vaultFor(ctx, ids.map((id) => ({ k: "staff", id })));
        const patch = {};
        for (const id of ids) {
          if (text((vault.get(`staff:${id}`) || {}).name)) patch[`members.${id}.name`] = FieldValue.delete();
          else count(unverified, "tipsTeam");
        }
        if (Object.keys(patch).length) {
          count(removed, "tipsTeam");
          await w.op("update", ref, patch);
        }
      }
    }

    // Профили гостей и указатели номеров. У сети они общие на все точки —
    // только когда все точки уже в режиме rf.
    let guests = "skipped";
    if (await chainAllRf(ctx)) {
      guests = "done";
      await forEachPage(ctx.loyaltyRoot.collection("clients"), async (docs) => {
        const vault = await vaultFor(ctx, docs.map((d) => ({ k: "guest", id: d.id })));
        for (const d of docs) {
          const c = d.data();
          const rec = vault.get(`guest:${d.id}`);
          const patch = {};
          if (text(c.name)) {
            if (vaultValue(rec, "name")) patch.name = FieldValue.delete();
            else count(unverified, "clients");
          }
          if (text(c.phone)) {
            if (vaultValue(rec, "phone")) {
              patch.phone = FieldValue.delete();
              if (phoneOk(c.phone) && c.phoneOnFile !== true) patch.phoneOnFile = true;
            } else count(unverified, "clients");
          }
          if (Object.keys(patch).length) {
            count(removed, "clients");
            await w.op("update", d.ref, patch);
          }
        }
      });
      // Номер → гость в режиме rf отвечает справочник (pii_phone). Указатель
      // удаляем, только если справочник знает этот номер у этого гостя.
      await forEachPage(ctx.loyaltyRoot.collection("phoneIndex"), async (docs) => {
        const vault = await vaultFor(ctx, docs.map((d) => ({ k: "guest", id: text(d.data().uid) })).filter((r) => r.id));
        for (const d of docs) {
          const rec = vault.get(`guest:${text(d.data().uid)}`);
          if (rec && digits(rec.phone) && digits(rec.phone) === digits(d.id)) {
            count(removed, "phoneIndex");
            await w.op("delete", d.ref);
          } else {
            count(unverified, "phoneIndex");
          }
        }
      });
    }
    await w.flush();
    return { dryRun: !!dryRun, removed, unverified, guests };
  }

  // ------------------------------------------------------------- шаги

  async function devicesOf(ctx) {
    const snap = await tenantRef(ctx.tenantId).collection("devices").get();
    return snap.docs
      .map((d) => {
        const x = d.data();
        return {
          id: d.id,
          name: text(x.deviceName) || text(x.label) || "Устройство",
          platform: text(x.platform),
          status: text(x.status) || "active",
          build: text(String(x.appBuild || "")),
          ready: Number(x.piiReady) >= READY_LEVEL,
          seenAt: x.seenAt && typeof x.seenAt.toMillis === "function" ? x.seenAt.toMillis() : null,
        };
      })
      .filter((d) => d.status === "active");
  }

  const msOf = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);
  const plain = (job) => {
    if (!job || typeof job !== "object") return null;
    const out = {};
    for (const [k, v] of Object.entries(job)) out[k] = msOf(v) ?? v;
    return out;
  };

  async function status(tenantId) {
    const ctx = await context(tenantId);
    const devices = await devicesOf(ctx);
    return {
      tenantId,
      name: ctx.name,
      chainId: ctx.chainId || null,
      mode: ctx.mode,
      running: running.has(tenantId),
      switchedAt: msOf(ctx.meta.switchedAt),
      copy: plain(ctx.meta.copy),
      scrubCheck: plain(ctx.meta.scrubCheck),
      scrub: plain(ctx.meta.scrub),
      devices,
      blocking: devices.filter((d) => !d.ready).length,
      scrubAfter: msOf(ctx.meta.switchedAt) ? msOf(ctx.meta.switchedAt) + SCRUB_AFTER_MS : null,
    };
  }

  /** Фоновая работа: ответ сразу, ход — в meta/piiMigration.<kind>. */
  async function startJob(ctx, kind, by, fn) {
    if (running.has(ctx.tenantId)) throw new HttpError(409, "Для этого заведения уже идёт перенос — дождитесь окончания");
    running.add(ctx.tenantId);
    const startedAt = now();
    try {
      await metaRef(ctx.tenantId).set({ [kind]: { state: "running", startedAt: ts(startedAt), by } }, { merge: true });
    } catch (e) {
      running.delete(ctx.tenantId);
      throw e;
    }
    const done = (async () => {
      try {
        const result = await fn();
        await metaRef(ctx.tenantId).set({
          [kind]: { state: "done", startedAt: ts(startedAt), finishedAt: ts(now()), by, ...result },
        }, { merge: true });
      } catch (e) {
        log.error(`pii-migrate ${kind} ${ctx.tenantId}:`, e && e.message ? e.message : e);
        await metaRef(ctx.tenantId).set({
          [kind]: { state: "failed", startedAt: ts(startedAt), finishedAt: ts(now()), by, error: String((e && e.message) || e).slice(0, 300) },
        }, { merge: true }).catch(() => {});
      } finally {
        running.delete(ctx.tenantId);
      }
    })();
    return { started: true, done };
  }

  async function run(tenantId, action, { by = "", dryRun = false, force = false } = {}) {
    if (!pii.enabled()) throw new HttpError(503, "Справочник в РФ не подключён на сервере (PII_INTERNAL_TOKEN)");
    const ctx = await context(tenantId);
    if (action === "copy") {
      return startJob(ctx, "copy", by, () => copy(ctx));
    }
    if (action === "switch") {
      if (ctx.mode === "rf") throw new HttpError(409, "Заведение уже хранит данные только в РФ");
      if (!ctx.meta.copy || ctx.meta.copy.state !== "done") throw new HttpError(409, "Сначала перенесите данные в РФ (шаг «Перенести»)");
      const devices = await devicesOf(ctx);
      const blocking = devices.filter((d) => !d.ready);
      if (blocking.length && !force) {
        throw new HttpError(409, `Не все кассы обновлены: ${blocking.map((d) => d.name).join(", ")}. Обновите их или отключите неиспользуемые устройства`);
      }
      await tenantRef(tenantId).collection("meta").doc("venueProfile").set({ piiMode: "rf" }, { merge: true });
      await metaRef(tenantId).set({ switchedAt: ts(now()), switchedBy: by, forced: blocking.length > 0 }, { merge: true });
      return { ok: true, mode: "rf", forced: blocking.length > 0 };
    }
    if (action === "scrub") {
      if (ctx.mode !== "rf") throw new HttpError(409, "Сначала переключите заведение на хранение в РФ");
      const switchedAt = msOf(ctx.meta.switchedAt);
      if (!dryRun && !force && (!switchedAt || now() - switchedAt < SCRUB_AFTER_MS)) {
        throw new HttpError(409, "Очистка — не раньше чем через сутки после переключения: кассы должны успеть отправить очередь записей");
      }
      return startJob(ctx, dryRun ? "scrubCheck" : "scrub", by, () => scrub(ctx, { dryRun }));
    }
    if (action === "rollback") {
      if (ctx.mode !== "rf") throw new HttpError(409, "Заведение и так в обычном режиме");
      await tenantRef(tenantId).collection("meta").doc("venueProfile").set({ piiMode: "mirror" }, { merge: true });
      await metaRef(tenantId).set({ rolledBackAt: ts(now()), rolledBackBy: by }, { merge: true });
      return { ok: true, mode: "mirror" };
    }
    throw new HttpError(400, "Неизвестный шаг");
  }

  return { status, run, copy, scrub, SPEC, READY_LEVEL };
}

module.exports = { createPiiMigrate, legacyStaffId, SPEC, READY_LEVEL };
