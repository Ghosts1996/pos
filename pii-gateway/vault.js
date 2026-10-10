"use strict";

/**
 * Справочник персональных данных заведения — только здесь, в РФ.
 *
 * В Firestore (серверы Google) остаются идентификаторы: uid гостя, id
 * сотрудника, id брони или чека. Имена, телефоны и адреса лежат в этой
 * базе, а касса держит их копию у себя на устройстве и берёт оттуда
 * (метод обезличивания «введение идентификаторов»). Что где:
 *
 *   guest_profiles  — гость (id = uid), у сети одна запись на все точки;
 *   staff_profiles  — сотрудник (id = id документа employees);
 *   contact_records — контакт записи: бронь, лист ожидания, заказ с собой
 *                     и доставка, подпись и контакт чека, дисконтная карта.
 *
 * Запросы (поле kind в теле, как у остальных операций шлюза):
 *   pii_sync   — всё, что изменилось после курсора (касса, страницами);
 *   pii_lookup — записи по id;
 *   pii_put    — записать или поправить (null — не трогать поле);
 *   pii_erase  — стереть значения (строка остаётся — так касса узнаёт
 *                об удалении при следующей синхронизации);
 *   pii_search — гости по телефону или имени;
 *   pii_phone  — чей это номер (замена phoneIndex в Firestore);
 *   pii_seed   — перенос из Firestore перед переключением заведения:
 *                только дописывает пустое (saas-gateway, pii-migrate.js).
 *
 * Кто что может: персонал заведения (tenantMembers) — всё в своём
 * заведении; гость — только свой профиль и свои контакты, а из
 * сотрудников — имена тех, кто сейчас на смене (meta/tipsTeam), чтобы
 * выбрать, кому оставить чаевые; saas-gateway — всё (заголовок
 * X-Pii-Internal с общим секретом, см. update-server.sh).
 */

const crypto = require("crypto");

const CONTACT_KINDS = ["reservation", "waitlist", "delivery", "session", "card"];
const STAFF_ROLES = ["owner", "admin", "manager", "employee"];
const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Что ещё хранится у контакта, кроме имени, телефона и адреса.
const EXTRA_KEYS = {
  delivery: ["comment", "courierName", "courierPhone", "guestTag", "guestContact"],
  session: ["comment", "courierName", "courierPhone", "guestTag", "guestContact"],
  card: ["notes"],
  reservation: [],
  waitlist: [],
};
// Гость сам может указать только пожелания к заказу; курьер и подпись
// чека — дело персонала.
const GUEST_EXTRA_KEYS = ["comment"];

const LIMITS = { name: 200, phone: 40, address: 300, extra: 500 };
const PAGE = 1000;

class VaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Значение поля из запроса: undefined/null — «не трогать». */
function field(v, max) {
  if (v === undefined || v === null) return null;
  return String(v).trim().slice(0, max);
}

function phoneDigits(v) {
  const d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") return `7${d.slice(1)}`;
  if (d.length === 10 && d[0] === "9") return `7${d}`;
  return d;
}

/** Похоже на номер: 10–15 цифр — как phoneOk в правилах Firestore. */
function phoneOk(v) {
  const n = String(v == null ? "" : v).replace(/\D/g, "").length;
  return n >= 10 && n <= 15;
}

/**
 * Профиль гостя в Firestore: номер записан в РФ. В режиме rf самого номера
 * в профиле нет, а правила базы пускают за стол только гостя с номером —
 * они смотрят на эту отметку. Ставит только сервер: гостю её писать нельзя.
 * Профиль не создаём — только отмечаем существующий.
 */
async function markPhoneOnFile(db, path, onFile) {
  const ref = db.doc(path);
  if (!(await ref.get()).exists) return;
  await ref.set({ phoneOnFile: !!onFile }, { merge: true });
}

/** Допустимые доп. поля контакта. null — удалить ключ. */
function cleanExtra(kind, raw, guest) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new VaultError(400, "extra — объект");
  const allowed = guest ? EXTRA_KEYS[kind].filter((k) => GUEST_EXTRA_KEYS.includes(k)) : EXTRA_KEYS[kind];
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.includes(k)) throw new VaultError(400, `поле ${k} нельзя записать`);
    out[k] = v === null ? null : String(v).trim().slice(0, LIMITS.extra);
  }
  return Object.keys(out).length ? out : null;
}

function micros(row) {
  return String(row.u);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param query      (sql, params) => Promise<{rows}> — Postgres
 * @param firestore  () => Firestore проекта платформы (Admin SDK)
 * @param verifyToken (idToken) => Promise<decoded>
 * @param internalToken секрет для saas-gateway; пусто — внутренний вход закрыт
 */
function createVault({ query, firestore, verifyToken, internalToken = "", cacheMs = 30000 }) {
  const tenantCache = new Map(); // tenantId -> {at, chainId, exists}
  const roleCache = new Map(); // tenantId_uid -> {at, staff}

  async function tenantOf(tenantId) {
    const hit = tenantCache.get(tenantId);
    if (hit && Date.now() - hit.at < cacheMs) return hit;
    const snap = await firestore().doc(`tenants/${tenantId}`).get();
    const info = { at: Date.now(), exists: snap.exists, chainId: snap.exists ? String(snap.data().chainId || "") : "" };
    tenantCache.set(tenantId, info);
    if (tenantCache.size > 5000) tenantCache.clear();
    return info;
  }

  async function isStaff(tenantId, uid) {
    const key = `${tenantId}_${uid}`;
    const hit = roleCache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.staff;
    const snap = await firestore().doc(`tenantMembers/${key}`).get();
    const m = snap.exists ? snap.data() : null;
    const staff = !!m && m.status === "active" && STAFF_ROLES.includes(m.role);
    roleCache.set(key, { at: Date.now(), staff });
    if (roleCache.size > 20000) roleCache.clear();
    return staff;
  }

  /** Кто спрашивает и про какое заведение. */
  async function access(ctx, body) {
    const tenantId = body.tenantId;
    if (typeof tenantId !== "string" || !TENANT_RE.test(tenantId)) throw new VaultError(400, "некорректный tenantId");
    const internal = !!internalToken && safeEqual(ctx.internal, internalToken);
    let uid = "";
    // Сервер пишет запись от имени гостя (заказ из приложения): тогда гость
    // потом видит её сам — как если бы создал её своим токеном.
    if (internal && typeof body.asUid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.asUid)) uid = body.asUid;
    if (!internal) {
      if (!ctx.token) throw new VaultError(401, "нет токена авторизации");
      try {
        uid = (await verifyToken(ctx.token)).uid;
      } catch (e) {
        if (e instanceof VaultError) throw e;
        throw new VaultError(401, "невалидный токен");
      }
    }
    const t = await tenantOf(tenantId);
    if (!t.exists) throw new VaultError(404, "заведение не найдено");
    const staff = internal || (await isStaff(tenantId, uid));
    return { tenantId, chainId: t.chainId, storeKey: t.chainId ? `chain:${t.chainId}` : tenantId, uid, staff, internal };
  }

  function requireStaff(a) {
    if (!a.staff) throw new VaultError(403, "только для персонала заведения");
  }

  // ------------------------------------------------------------ чтение

  const STAFF_COLS = "employee_id AS id, name, phone, (extract(epoch from updated_at) * 1000000)::bigint AS u";
  const GUEST_COLS = "uid AS id, name, phone, (extract(epoch from updated_at) * 1000000)::bigint AS u";
  const CONTACT_COLS = "kind, record_id AS id, name, phone, address, extra, created_by, (extract(epoch from updated_at) * 1000000)::bigint AS u";

  const staffRow = (r) => ({ id: r.id, name: r.name, phone: r.phone, u: micros(r) });
  const guestRow = (r) => ({ id: r.id, name: r.name, phone: r.phone, u: micros(r) });
  const contactRow = (r) => ({ k: r.kind, id: r.id, name: r.name, phone: r.phone, address: r.address, extra: r.extra || {}, u: micros(r) });

  function cursorOf(c) {
    if (!c || typeof c !== "object") return { u: "0", id: "" };
    const u = /^\d{1,20}$/.test(String(c.u || "")) ? String(c.u) : "0";
    return { u, id: typeof c.id === "string" ? c.id.slice(0, 260) : "" };
  }

  /**
   * Всё, что изменилось после курсора, по трём таблицам. Курсор — время
   * изменения в микросекундах и id: страницы не теряют строки с одинаковым
   * временем. Касса начинает каждый заход с небольшим нахлёстом назад
   * (транзакции завершаются не строго по порядку) — повтор ей не вредит.
   */
  async function piiSync(a, body) {
    requireStaff(a);
    const since = body.since && typeof body.since === "object" ? body.since : {};
    const s = cursorOf(since.staff);
    const g = cursorOf(since.guests);
    const c = cursorOf(since.contacts);
    const [staffRows, guestRows, contactRows] = await Promise.all([
      query(
        `SELECT ${STAFF_COLS} FROM staff_profiles
         WHERE tenant_id = $1 AND ((extract(epoch from updated_at) * 1000000)::bigint, employee_id) > ($2::bigint, $3)
         ORDER BY 4, 1 LIMIT ${PAGE}`,
        [a.tenantId, s.u, s.id]
      ),
      query(
        `SELECT ${GUEST_COLS} FROM guest_profiles
         WHERE tenant_id = $1 AND ((extract(epoch from updated_at) * 1000000)::bigint, uid) > ($2::bigint, $3)
         ORDER BY 4, 1 LIMIT ${PAGE}`,
        [a.storeKey, g.u, g.id]
      ),
      query(
        `SELECT ${CONTACT_COLS} FROM contact_records
         WHERE tenant_id = $1 AND ((extract(epoch from updated_at) * 1000000)::bigint, kind || ':' || record_id) > ($2::bigint, $3)
         ORDER BY 8, kind || ':' || record_id LIMIT ${PAGE}`,
        [a.tenantId, c.u, c.id]
      ),
    ]);
    const last = (rows, key) => (rows.length ? { u: micros(rows[rows.length - 1]), id: key(rows[rows.length - 1]) } : null);
    return {
      staff: staffRows.rows.map(staffRow),
      guests: guestRows.rows.map(guestRow),
      contacts: contactRows.rows.map(contactRow),
      cursor: {
        staff: last(staffRows.rows, (r) => r.id) || s,
        guests: last(guestRows.rows, (r) => r.id) || g,
        contacts: last(contactRows.rows, (r) => `${r.kind}:${r.id}`) || c,
      },
      more: staffRows.rows.length === PAGE || guestRows.rows.length === PAGE || contactRows.rows.length === PAGE,
    };
  }

  /** Сотрудники на смене (meta/tipsTeam) — их имена видит гость. */
  async function onShiftIds(tenantId) {
    const snap = await firestore().doc(`tenants/${tenantId}/meta/tipsTeam`).get();
    const members = snap.exists && snap.data().members && typeof snap.data().members === "object" ? snap.data().members : {};
    return new Set(Object.keys(members));
  }

  /** Чек или заказ, который принадлежит гостю (его доставка). */
  async function guestOwnsSession(tenantId, id, uid) {
    const snap = await firestore().doc(`tenants/${tenantId}/sessions/${id}`).get();
    return snap.exists && snap.data().clientUid === uid;
  }

  function parseRefs(body, max) {
    const refs = Array.isArray(body.refs) ? body.refs : [];
    if (refs.length > max) throw new VaultError(400, `не больше ${max} записей за раз`);
    const out = { staff: [], guest: [] };
    for (const k of CONTACT_KINDS) out[k] = [];
    for (const r of refs) {
      if (!r || typeof r !== "object" || typeof r.id !== "string" || !ID_RE.test(r.id) || !(r.k in out)) {
        throw new VaultError(400, "некорректная ссылка на запись");
      }
      if (!out[r.k].includes(r.id)) out[r.k].push(r.id);
    }
    return out;
  }

  async function piiLookup(a, body) {
    const refs = parseRefs(body, a.staff ? 500 : 40);
    const result = { staff: [], guests: [], contacts: [] };

    let staffIds = refs.staff;
    if (!a.staff && staffIds.length) {
      const allowed = await onShiftIds(a.tenantId);
      staffIds = staffIds.filter((id) => allowed.has(id));
    }
    if (staffIds.length) {
      const r = await query(`SELECT ${STAFF_COLS} FROM staff_profiles WHERE tenant_id = $1 AND employee_id = ANY($2)`, [a.tenantId, staffIds]);
      // Гостю — только имя: телефон сотрудника ему ни к чему.
      result.staff = r.rows.map((x) => (a.staff ? staffRow(x) : { id: x.id, name: x.name, phone: "", u: micros(x) }));
    }

    const guestIds = a.staff ? refs.guest : refs.guest.filter((id) => id === a.uid);
    if (guestIds.length) {
      const r = await query(`SELECT ${GUEST_COLS} FROM guest_profiles WHERE tenant_id = $1 AND uid = ANY($2)`, [a.storeKey, guestIds]);
      result.guests = r.rows.map(guestRow);
    }

    for (const kind of CONTACT_KINDS) {
      const ids = refs[kind];
      if (!ids.length) continue;
      const r = await query(`SELECT ${CONTACT_COLS} FROM contact_records WHERE tenant_id = $1 AND kind = $2 AND record_id = ANY($3)`, [a.tenantId, kind, ids]);
      for (const row of r.rows) {
        if (!a.staff && row.created_by !== a.uid) {
          // Доставку для гостя мог записать и кассир — тогда гость видит
          // её, если заказ его (sessions.clientUid).
          if (!(kind === "delivery" || kind === "session") || !(await guestOwnsSession(a.tenantId, row.id, a.uid))) continue;
        }
        result.contacts.push(contactRow(row));
      }
    }
    return result;
  }

  async function piiSearch(a, body) {
    requireStaff(a);
    const q = String(body.q || "").trim().slice(0, 80);
    if (q.length < 2) return { guests: [] };
    const digits = q.replace(/\D/g, "");
    let r;
    if (digits.length >= 3 && digits.length >= q.replace(/[\s()+-]/g, "").length) {
      const d = digits.length >= 10 ? phoneDigits(digits) : digits;
      r = await query(
        `SELECT ${GUEST_COLS} FROM guest_profiles WHERE tenant_id = $1 AND phone LIKE '%' || $2 || '%'
         ORDER BY updated_at DESC LIMIT 30`,
        [a.storeKey, d]
      );
    } else {
      const like = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      r = await query(
        `SELECT ${GUEST_COLS} FROM guest_profiles WHERE tenant_id = $1 AND name ILIKE '%' || $2 || '%'
         ORDER BY updated_at DESC LIMIT 30`,
        [a.storeKey, like]
      );
    }
    return { guests: r.rows.map(guestRow) };
  }

  /** Чей номер: персоналу — uid, гостю — только «занят ли другим». */
  async function piiPhone(a, body) {
    const phone = phoneDigits(body.phone);
    if (phone.length < 10 || phone.length > 15) throw new VaultError(400, "некорректный номер");
    const r = await query(
      `SELECT uid FROM guest_profiles WHERE tenant_id = $1 AND phone = $2 ORDER BY updated_at DESC LIMIT 5`,
      [a.storeKey, phone]
    );
    const uids = r.rows.map((x) => x.uid);
    if (a.staff) return { uid: uids[0] || "", uids };
    return { taken: uids.some((u) => u !== a.uid), mine: uids.includes(a.uid) };
  }

  // ------------------------------------------------------------ запись

  /** Отметка «номер в РФ» в профиле Firestore; осечка записи не отменяет. */
  async function markGuestPhone(a, uid, onFile) {
    const path = a.chainId ? `chains/${a.chainId}/clients/${uid}` : `tenants/${a.tenantId}/clients/${uid}`;
    try {
      await markPhoneOnFile(firestore(), path, onFile);
    } catch (e) {
      console.error(`phoneOnFile: ${(e && e.message) || e}`);
    }
  }

  async function putOne(a, item) {
    const k = item && item.k;
    const id = item && item.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new VaultError(400, "некорректный id");
    const f = item.fields && typeof item.fields === "object" ? item.fields : {};
    const name = field(f.name, LIMITS.name);
    const phone = f.phone === undefined || f.phone === null ? null : phoneDigits(f.phone) || String(f.phone).trim().slice(0, LIMITS.phone);
    const by = a.internal ? a.uid || "server" : a.uid;

    if (k === "staff") {
      requireStaff(a);
      await query(
        `INSERT INTO staff_profiles (tenant_id, employee_id, name, phone, updated_by, updated_at)
         VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, ''), $5, now())
         ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
           name = COALESCE($3, staff_profiles.name), phone = COALESCE($4, staff_profiles.phone),
           updated_by = $5, updated_at = now()`,
        [a.tenantId, id, name, phone, by]
      );
      return;
    }
    if (k === "guest") {
      if (!a.staff && id !== a.uid) throw new VaultError(403, "нельзя писать чужой профиль");
      await query(
        `INSERT INTO guest_profiles (tenant_id, uid, name, phone, updated_at)
         VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, ''), now())
         ON CONFLICT (tenant_id, uid) DO UPDATE SET
           name = COALESCE($3, guest_profiles.name), phone = COALESCE($4, guest_profiles.phone), updated_at = now()`,
        [a.storeKey, id, name, phone]
      );
      if (phone !== null) await markGuestPhone(a, id, phoneOk(phone));
      return;
    }
    if (!CONTACT_KINDS.includes(k)) throw new VaultError(400, "неизвестный вид записи");
    if (!a.staff && (k === "card" || k === "session")) throw new VaultError(403, "только для персонала заведения");
    const address = field(f.address, LIMITS.address);
    const extra = cleanExtra(k, f.extra, !a.staff);
    const r = await query(
      `INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, address, extra, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, ''), COALESCE($5, ''), COALESCE($6, ''), jsonb_strip_nulls(COALESCE($7::jsonb, '{}'::jsonb)), $8, $8, now())
       ON CONFLICT (tenant_id, kind, record_id) DO UPDATE SET
         name = COALESCE($4, contact_records.name),
         phone = COALESCE($5, contact_records.phone),
         address = COALESCE($6, contact_records.address),
         extra = jsonb_strip_nulls(contact_records.extra || COALESCE($7::jsonb, '{}'::jsonb)),
         updated_by = $8, updated_at = now()
       WHERE $9 OR contact_records.created_by = $8
       RETURNING record_id`,
      [a.tenantId, k, id, name, phone, address, extra ? JSON.stringify(extra) : null, by, a.staff]
    );
    if (!r.rows.length) throw new VaultError(403, "эту запись создал другой пользователь");
  }

  async function piiPut(a, body) {
    const items = Array.isArray(body.items) ? body.items : [body];
    if (items.length > (a.staff ? 200 : 5)) throw new VaultError(400, "слишком много записей за раз");
    for (const it of items) await putOne(a, it);
    return { ok: true, count: items.length };
  }

  async function piiErase(a, body) {
    requireStaff(a);
    const k = body.k;
    const id = body.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new VaultError(400, "некорректный id");
    if (k === "staff") {
      await query(`UPDATE staff_profiles SET name = '', phone = '', updated_at = now() WHERE tenant_id = $1 AND employee_id = $2`, [a.tenantId, id]);
    } else if (k === "guest") {
      await query(`UPDATE guest_profiles SET name = '', phone = '', updated_at = now() WHERE tenant_id = $1 AND uid = $2`, [a.storeKey, id]);
      await markGuestPhone(a, id, false);
    } else if (CONTACT_KINDS.includes(k)) {
      await query(
        `UPDATE contact_records SET name = '', phone = '', address = '', extra = '{}'::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND kind = $2 AND record_id = $3`,
        [a.tenantId, k, id]
      );
    } else {
      throw new VaultError(400, "неизвестный вид записи");
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ перенос

  /**
   * Одна запись переноса: заполняет только пустые поля, уже записанное в
   * РФ не трогает (оно новее копии в Firestore). Новая строка получает
   * created_by = by (uid гостя для его брони и заказа — он потом видит её
   * сам) или 'migration'. → 1, если что-то дописано.
   */
  async function seedOne(a, item) {
    const k = item && item.k;
    const id = item && item.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new VaultError(400, "некорректный id");
    const f = item.fields && typeof item.fields === "object" ? item.fields : {};
    const name = field(f.name, LIMITS.name) || "";
    const phone = f.phone === undefined || f.phone === null ? "" : phoneDigits(f.phone) || String(f.phone).trim().slice(0, LIMITS.phone);
    const by = typeof item.by === "string" && ID_RE.test(item.by) ? item.by : "migration";
    if (k === "staff") {
      const r = await query(
        `INSERT INTO staff_profiles (tenant_id, employee_id, name, phone, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, 'migration', now())
         ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
           name = CASE WHEN staff_profiles.name = '' THEN EXCLUDED.name ELSE staff_profiles.name END,
           phone = CASE WHEN staff_profiles.phone = '' THEN EXCLUDED.phone ELSE staff_profiles.phone END,
           updated_at = now()
         WHERE (staff_profiles.name = '' AND EXCLUDED.name <> '') OR (staff_profiles.phone = '' AND EXCLUDED.phone <> '')
         RETURNING employee_id`,
        [a.tenantId, id, name, phone]
      );
      return r.rows.length;
    }
    if (k === "guest") {
      const r = await query(
        `INSERT INTO guest_profiles (tenant_id, uid, name, phone, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, uid) DO UPDATE SET
           name = CASE WHEN guest_profiles.name = '' THEN EXCLUDED.name ELSE guest_profiles.name END,
           phone = CASE WHEN guest_profiles.phone = '' THEN EXCLUDED.phone ELSE guest_profiles.phone END,
           updated_at = now()
         WHERE (guest_profiles.name = '' AND EXCLUDED.name <> '') OR (guest_profiles.phone = '' AND EXCLUDED.phone <> '')
         RETURNING uid`,
        [a.storeKey, id, name, phone]
      );
      return r.rows.length;
    }
    if (!CONTACT_KINDS.includes(k)) throw new VaultError(400, "неизвестный вид записи");
    const address = field(f.address, LIMITS.address) || "";
    const extra = cleanExtra(k, f.extra, false) || {};
    for (const key of Object.keys(extra)) if (extra[key] === null || extra[key] === "") delete extra[key];
    const r = await query(
      `INSERT INTO contact_records (tenant_id, kind, record_id, name, phone, address, extra, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'migration', now())
       ON CONFLICT (tenant_id, kind, record_id) DO UPDATE SET
         name = CASE WHEN contact_records.name = '' THEN EXCLUDED.name ELSE contact_records.name END,
         phone = CASE WHEN contact_records.phone = '' THEN EXCLUDED.phone ELSE contact_records.phone END,
         address = CASE WHEN contact_records.address = '' THEN EXCLUDED.address ELSE contact_records.address END,
         extra = EXCLUDED.extra || contact_records.extra,
         updated_at = now()
       WHERE (contact_records.name = '' AND EXCLUDED.name <> '')
          OR (contact_records.phone = '' AND EXCLUDED.phone <> '')
          OR (contact_records.address = '' AND EXCLUDED.address <> '')
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(EXCLUDED.extra) AS x(key) WHERE NOT contact_records.extra ? x.key)
       RETURNING record_id`,
      [a.tenantId, k, id, name, phone, address, JSON.stringify(extra), by]
    );
    return r.rows.length;
  }

  async function piiSeed(a, body) {
    if (!a.internal) throw new VaultError(403, "только для сервера платформы");
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 500) throw new VaultError(400, "не больше 500 записей за раз");
    let filled = 0;
    for (const it of items) filled += await seedOne(a, it);
    return { ok: true, count: items.length, filled };
  }

  const OPS = {
    pii_seed: piiSeed,
    pii_sync: piiSync,
    pii_lookup: piiLookup,
    pii_put: piiPut,
    pii_erase: piiErase,
    pii_search: piiSearch,
    pii_phone: piiPhone,
  };

  /** → { status, json } */
  async function handle(ctx, body) {
    const op = OPS[body.kind];
    if (!op) return { status: 400, json: { error: "неизвестная операция" } };
    try {
      const a = await access(ctx, body);
      return { status: 200, json: await op(a, body) };
    } catch (e) {
      if (e instanceof VaultError) return { status: e.status, json: { error: e.message } };
      console.error(`${body.kind}: ${e && e.code ? e.code + " " : ""}${(e && e.message) || e}`);
      return { status: 500, json: { error: "ошибка хранилища в РФ" } };
    }
  }

  return { handle, ops: Object.keys(OPS) };
}

module.exports = { createVault, phoneDigits, phoneOk, markPhoneOnFile, CONTACT_KINDS, EXTRA_KEYS, VaultError };
