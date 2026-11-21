// График смен сотрудников — кабинет · «Команда» → «График смен».
// Данные: tenants/{t}/staffSchedule/{ГГГГ-ММ-ДД} = { shifts: { <id сотрудника>: "10:00-22:00" } }.
// Факт — личные смены кассы (staffShifts: employeeId, startedAt, endedAt).
// Сигнал «не вышел по графику» шлёт сервер (saas-gateway/staff-schedule.js).

const pad = (n) => String(n).padStart(2, '0');

/** Ключ дня «ГГГГ-ММ-ДД» по местной дате. */
export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Понедельник недели, в которую входит дата (+ сдвиг в неделях). */
export function weekStart(date, shiftWeeks = 0) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const wd = (d.getDay() + 6) % 7; // пн = 0
  d.setDate(d.getDate() - wd + shiftWeeks * 7);
  return d;
}

/** Семь дат недели с понедельника. */
export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

/**
 * Разбор «10-22», «10:30–23», «9.00 - 18.00», «с 10 до 22». Конец меньше
 * начала — смена через полночь («18-02»). null — пусто или не разобрали.
 * @returns {{start:string,end:string,startMin:number,endMin:number,overnight:boolean,text:string}|null}
 */
export function parseShift(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/^с\s*/, '').replace(/\s*до\s*/, '-');
  if (!t) return null;
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h1 = +m[1], m1 = +(m[2] || 0), h2 = +m[3] === 24 ? 0 : +m[3], m2 = +(m[4] || 0);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const startMin = h1 * 60 + m1;
  let endMin = h2 * 60 + m2;
  if (endMin === startMin) return null;
  const overnight = endMin < startMin;
  if (overnight) endMin += 24 * 60;
  const start = `${pad(h1)}:${pad(m1)}`;
  const end = `${pad(h2)}:${pad(m2)}`;
  // Короткая запись для ячейки: «10–22», «9:30–18».
  const short = (h, mm) => (mm ? `${h}:${pad(mm)}` : `${h}`);
  return { start, end, startMin, endMin, overnight, text: `${short(h1, m1)}–${overnight ? pad(h2) + (m2 ? `:${pad(m2)}` : "") : short(h2, m2)}` };
}

/** Часы смены (через полночь — тоже). */
export function shiftHours(raw) {
  const s = parseShift(raw);
  return s ? (s.endMin - s.startMin) / 60 : 0;
}

/**
 * План против факта за день: опоздание, не вышел, ушёл раньше.
 * facts — личные смены сотрудника, начавшиеся в этот день или до полудня
 * следующего (ночная смена), { start: Date, end: Date|null }.
 * @returns {{status:'ok'|'late'|'absent'|'early'|'future'|'working', lateMin:number, earlyMin:number, fact:string}}
 */
export function planVsFact(day, raw, facts, now = new Date(), graceMin = 10) {
  const s = parseShift(raw);
  if (!s) return null;
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const planStart = new Date(base.getTime() + s.startMin * 60000);
  const planEnd = new Date(base.getTime() + s.endMin * 60000);
  // Факт, который ближе всего к плану: начат за 3 ч до начала и до конца смены.
  const fit = (facts || [])
    .filter((f) => f.start >= new Date(planStart.getTime() - 3 * 3600e3) && f.start < planEnd)
    .sort((a, b) => a.start - b.start)[0];
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!fit) {
    if (now < new Date(planStart.getTime() + graceMin * 60000)) return { status: 'future', lateMin: 0, earlyMin: 0, fact: '' };
    return { status: 'absent', lateMin: 0, earlyMin: 0, fact: '' };
  }
  const lateMin = Math.max(0, Math.round((fit.start - planStart) / 60000));
  const fact = `${hhmm(fit.start)}–${fit.end ? hhmm(fit.end) : '…'}`;
  if (!fit.end) return { status: lateMin > graceMin ? 'late' : 'working', lateMin, earlyMin: 0, fact };
  const earlyMin = Math.max(0, Math.round((planEnd - fit.end) / 60000));
  if (lateMin > graceMin) return { status: 'late', lateMin, earlyMin, fact };
  if (earlyMin > 30) return { status: 'early', lateMin, earlyMin, fact };
  return { status: 'ok', lateMin, earlyMin, fact };
}

/** Итог недели по сотруднику: смен и часов по плану. */
export function weekTotals(days, plan, employeeId) {
  let shifts = 0;
  let hours = 0;
  for (const d of days) {
    const raw = ((plan[dayKey(d)] || {})[employeeId]) || '';
    const h = shiftHours(raw);
    if (h > 0) { shifts++; hours += h; }
  }
  return { shifts, hours: Math.round(hours * 10) / 10 };
}
