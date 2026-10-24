"use strict";

// Вход и данные проекта платформы — через saas-gateway на этом же сервере
// (POST /internal/platform, общий секрет PII_INTERNAL_TOKEN). Он знает, где
// они сейчас: свой вход и свой сервер данных в РФ или (пока не переключены)
// Firebase. Так pii-gateway не обращается к Google сам.
//
// Не настроено (нет секрета) или saas-gateway не отвечает — как раньше:
// Firebase Admin проекта платформы. Токены своего входа Firebase не
// проверит, поэтому для них запасного пути нет.

const OWN_KID = "zalpos-1";

function isOwnToken(token) {
  try {
    const head = JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString());
    return !!head && head.kid === OWN_KID;
  } catch (_) {
    return false;
  }
}

/**
 * @param url         адрес saas-gateway (http://127.0.0.1:8081)
 * @param token       PII_INTERNAL_TOKEN
 * @param admin       firebase-admin
 * @param firebaseApp () => приложение Firebase платформы или null
 */
function createPlatform({ url, token, admin, firebaseApp, fetchImpl = fetch, timeoutMs = 10000 }) {
  const enabled = !!(url && token);
  const base = String(url || "").replace(/\/+$/, "");

  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;

  function toWire(v) {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Timestamp) return { __ts: v.toMillis() };
    if (v instanceof Date) return { __ts: v.getTime() };
    // Из FieldValue здесь пишется только serverTimestamp().
    if (v instanceof FieldValue) return { __op: "now" };
    if (Array.isArray(v)) return v.map(toWire);
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
    return out;
  }
  function fromWire(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(fromWire);
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "__ts" && typeof v.__ts === "number") return Timestamp.fromMillis(v.__ts);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromWire(x);
    return out;
  }

  class Unreachable extends Error {}

  async function call(body) {
    let res;
    try {
      res = await fetchImpl(`${base}/internal/platform`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pii-Internal": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Unreachable(`saas-gateway недоступен: ${e.message || e}`);
    }
    let j = {};
    try { j = await res.json(); } catch (_) {}
    if (res.status === 403) throw new Unreachable("saas-gateway не принял секрет PII_INTERNAL_TOKEN");
    // Старая версия saas-gateway (ещё без /internal/platform) или чужой сервис на порту.
    if (res.status === 404 || res.status === 405) throw new Unreachable(`saas-gateway без /internal/platform (${res.status})`);
    if (!res.ok) throw Object.assign(new Error(j.error || `saas-gateway ответил ${res.status}`), { status: res.status });
    return j;
  }

  function fallbackFirestore() {
    const app = firebaseApp();
    if (!app) throw new Error("pii-gateway не подключён к проекту платформы");
    return admin.firestore(app);
  }

  /** Подмножество Firestore Admin, которым пользуется pii-gateway. */
  function snap(path, exists, data) {
    const id = path.slice(path.lastIndexOf("/") + 1);
    return { id, exists, ref: { path, id }, data: () => (exists ? fromWire(data) : undefined) };
  }
  function docRef(path) {
    return {
      path,
      id: path.slice(path.lastIndexOf("/") + 1),
      async get() {
        try {
          const j = await call({ op: "get", path });
          return snap(path, !!j.exists, j.data);
        } catch (e) {
          if (!(e instanceof Unreachable)) throw e;
          console.warn(`platform: ${e.message} — читаю Firestore напрямую`);
          return fallbackFirestore().doc(path).get();
        }
      },
      async set(data, opts) {
        try {
          await call({ op: "set", path, data: toWire(data), merge: !!(opts && opts.merge) });
        } catch (e) {
          if (!(e instanceof Unreachable)) throw e;
          console.warn(`platform: ${e.message} — пишу в Firestore напрямую`);
          await fallbackFirestore().doc(path).set(data, opts || {});
        }
      },
    };
  }
  function queryOf(col, where) {
    return {
      where: (f, op, v) => queryOf(col, [...where, [f, op, v]]),
      doc: (id) => docRef(`${col}/${id}`),
      async get() {
        try {
          const j = await call({ op: "query", col, where: where.map(([f, op, v]) => [f, op, toWire(v)]) });
          const docs = (j.docs || []).map((d) => snap(`${col}/${d.id}`, true, d.data));
          return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
        } catch (e) {
          if (!(e instanceof Unreachable)) throw e;
          console.warn(`platform: ${e.message} — читаю Firestore напрямую`);
          let q = fallbackFirestore().collection(col);
          for (const [f, op, v] of where) q = q.where(f, op, v);
          return q.get();
        }
      },
    };
  }
  const remoteDb = { doc: docRef, collection: (col) => queryOf(col, []) };

  return {
    enabled,
    /** Хранилище платформы (свой сервер или Firestore — решает saas-gateway). */
    firestore() {
      return enabled ? remoteDb : fallbackFirestore();
    },
    /** Проверка ID-токена входа платформы. */
    async verifyIdToken(idToken) {
      if (enabled) {
        try {
          return (await call({ op: "verify", token: idToken })).decoded;
        } catch (e) {
          if (!(e instanceof Unreachable) || isOwnToken(idToken)) throw e;
          console.warn(`platform: ${e.message} — проверяю вход в Firebase напрямую`);
        }
      }
      const app = firebaseApp();
      if (!app) throw new Error("pii-gateway не подключён к проекту платформы");
      return app.auth().verifyIdToken(idToken);
    },
    /** Подключён ли проект платформы хоть как-то. */
    available() {
      return enabled || !!firebaseApp();
    },
  };
}

module.exports = { createPlatform, isOwnToken };
