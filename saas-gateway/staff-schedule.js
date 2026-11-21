"use strict";
/**
 * График смен (кабинет · «Команда» → «График смен»): сигнал владельцу в бот,
 * если сотрудник не отметил начало смены на кассе через 15 минут после
 * начала по графику. Имя в мессенджер не уходит (это персональные данные,
 * мессенджер — за рубежом): «сотрудник со смены с 10:00», кто именно —
 * в кабинете. Один сигнал на смену (staffScheduleState/{точка}.alerted).
 *
 * Данные: tenants/{t}/staffSchedule/{ГГГГ-ММ-ДД}.shifts = { <id сотрудника>: "10:00–22:00" },
 * факт — tenants/{t}/staffShifts (employeeId, startedAt).
 */

const LATE_MIN = 15;
const WINDOW_H = 3; // после трёх часов опоздания уже не пишем — поздно

/** «10:00–22:00» → минуты начала, null — не разобрали. */
function startMinOf(raw) {
  const m = String(raw || "").match(/^(\d{1,2})[:.](\d{2})\s*[-–—]/) || String(raw || "").match(/^(\d{1,2})\s*[-–—]/);
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] !== undefined ? +m[2] : 0;
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/** Местные дата («ГГГГ-ММ-ДД») и смещение пояса от UTC в мс. */
function localDay(now, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const g = (t) => +(parts.find((p) => p.type === t) || {}).value;
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  const offset = asUtc - Math.floor(now / 60000) * 60000;
  const day = `${g("year")}-${String(g("month")).padStart(2, "0")}-${String(g("day")).padStart(2, "0")}`;
  return { day, offset, y: g("year"), mo: g("month"), d: g("day") };
}

/** Кому пора прислать сигнал: [{emp, startMs, text}]. Чистая функция. */
function overdue({ shifts, startedBy, now, tz, alerted = {} }) {
  const { day, offset, y, mo, d } = localDay(now, tz);
  const out = [];
  for (const [emp, raw] of Object.entries(shifts || {})) {
    const sm = startMinOf(raw);
    if (sm === null) continue;
    const startMs = Date.UTC(y, mo - 1, d, Math.floor(sm / 60), sm % 60) - offset;
    if (now < startMs + LATE_MIN * 60000 || now > startMs + WINDOW_H * 3600e3) continue;
    if (alerted[`${day}_${emp}`]) continue;
    const came = (startedBy[emp] || []).some((ms) => ms >= startMs - 3 * 3600e3);
    if (came) continue;
    out.push({ emp, startMs, key: `${day}_${emp}`, text: String(raw) });
  }
  return { day, list: out };
}

function createStaffSchedule({ db, telegram }) {
  const tenants = () => db().collection("tenants");

  async function checkTenant(tid, t, now = Date.now()) {
    const tz = t.timezone || "Europe/Moscow";
    const { day } = localDay(now, tz);
    const ref = tenants().doc(tid);
    const sched = (await ref.collection("staffSchedule").doc(day).get()).data();
    const shifts = (sched && sched.shifts) || {};
    if (!Object.keys(shifts).length) return 0;
    const stateRef = db().collection("staffScheduleState").doc(tid);
    const state = (await stateRef.get()).data() || {};
    const since = new Date(now - 30 * 3600e3);
    const facts = await ref.collection("staffShifts").where("startedAt", ">=", since).get();
    const startedBy = {};
    for (const f of facts.docs) {
      const x = f.data();
      const ms = x.startedAt && typeof x.startedAt.toMillis === "function" ? x.startedAt.toMillis() : 0;
      if (x.employeeId && ms) (startedBy[x.employeeId] = startedBy[x.employeeId] || []).push(ms);
    }
    const { list } = overdue({ shifts, startedBy, now, tz, alerted: state.alerted || {} });
    if (!list.length) return 0;
    const alerted = { ...(state.alerted || {}) };
    // Старые отметки (старше недели) убираем, чтобы документ не рос.
    const cut = new Date(now - 8 * 86400e3).toISOString().slice(0, 10);
    for (const k of Object.keys(alerted)) if (k.slice(0, 10) < cut) delete alerted[k];
    for (const x of list) {
      alerted[x.key] = true;
      const sm = startMinOf(x.text);
      const hh = `${String(Math.floor(sm / 60)).padStart(2, "0")}:${String(sm % 60).padStart(2, "0")}`;
      await telegram.ownerAlert(tid, `⏰ ${t.name || "Заведение"}: сотрудник по графику со смены с ${hh} не отметил её начало на кассе. Кто именно — кабинет → «Команда» → «График смен».`);
    }
    await stateRef.set({ alerted }, { merge: true });
    return list.length;
  }

  async function runAll(now = Date.now()) {
    const snap = await tenants().where("status", "in", ["active", "trial"]).get();
    let n = 0;
    for (const d of snap.docs) {
      const t = d.data() || {};
      if (t.demo === true || t.isDemo === true) continue;
      try {
        n += await checkTenant(d.id, t, now);
      } catch (e) {
        console.error(`staffSchedule ${d.id}:`, e.message || e);
      }
    }
    return n;
  }

  return { runAll, checkTenant };
}

module.exports = { createStaffSchedule, overdue, startMinOf, localDay };
