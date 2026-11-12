"use strict";
/**
 * Проверка статуса самозанятого (плательщика налога на профессиональный
 * доход) по ИНН — открытый сервис ФНС «Проверить статус налогоплательщика
 * НПД» (npd.nalog.ru/check-status). Бесплатный, без ключа; ФНС разрешает
 * не больше 2 запросов в минуту с одного адреса — поэтому запросы идут
 * по очереди с паузой, а ответ запоминается.
 *
 * Ответ: { ok: true } — самозанятый на дату проверки; { ok: false } — нет;
 * { ok: null } — сервис не ответил (проверим позже). Сам ИНН сверяется по
 * контрольным цифрам заранее — неверный номер в ФНС не уходит.
 */
const NPD_URL = "https://statusnpd.nalog.ru/api/v1/tracker/taxpayer_status";
const GAP_MS = 31 * 1000;
const KEEP_MS = 12 * 3600 * 1000;

/** ИНН физлица или ИП: 12 цифр и две контрольные. */
function innValid(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{12}$/.test(s) || /^0+$/.test(s)) return false;
  const d = s.split("").map(Number);
  const sum = (w) => w.reduce((a, k, i) => a + k * d[i], 0) % 11 % 10;
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

const dayOf = (ms) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10); // дата по Москве

function createNpdCheck({ fetchFn = typeof fetch === "function" ? fetch : null, now = () => Date.now(), gapMs = GAP_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const known = new Map(); // ИНН → { ok, message, at }
  const waiting = new Map(); // ИНН → запрос в очереди
  let chain = Promise.resolve();
  let lastAt = 0;

  async function ask(inn) {
    if (!fetchFn) return { ok: null, message: "Проверка недоступна" };
    const pause = lastAt + gapMs - now();
    if (pause > 0) await wait(pause);
    lastAt = now();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const res = await fetchFn(NPD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inn, requestDate: dayOf(now()) }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let json = {};
      try { json = await res.json(); } catch (_) { /* пустой ответ */ }
      if (res.ok && typeof json.status === "boolean") {
        return { ok: json.status, message: String(json.message || "").slice(0, 300) };
      }
      // 422 — ФНС не знает такой ИНН: это ответ «нет», а не сбой.
      if (res.status === 422 && /validation/i.test(String(json.code || ""))) {
        return { ok: false, message: "ФНС не нашла такой ИНН" };
      }
      return { ok: null, message: `Сервис ФНС ответил ${res.status}` };
    } catch (e) {
      return { ok: null, message: "Сервис ФНС не ответил" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** → { ok: true | false | null, message, at }. Не бросает. */
  function check(inn, { fresh = false } = {}) {
    const key = String(inn || "").trim();
    if (!innValid(key)) return Promise.resolve({ ok: false, message: "ИНН указан неверно", at: now() });
    const hit = known.get(key);
    if (hit && !fresh && now() - hit.at < KEEP_MS) return Promise.resolve(hit);
    // Тот же ИНН уже стоит в очереди — второй запрос в ФНС не нужен.
    if (waiting.has(key)) return waiting.get(key);
    const run = chain.then(async () => {
      const again = known.get(key);
      if (again && !fresh && now() - again.at < KEEP_MS) return again;
      const r = { ...(await ask(key)), at: now() };
      if (r.ok !== null) {
        known.set(key, r);
        if (known.size > 5000) known.clear();
      }
      return r;
    }).finally(() => { waiting.delete(key); });
    waiting.set(key, run);
    chain = run.catch(() => {});
    return run;
  }

  return { check };
}

module.exports = { createNpdCheck, innValid, NPD_URL };
