"use strict";

/**
 * Режим «Час пик» (Rush Hour Protection). Пятница и суббота с 20:00 до 02:00
 * по местному времени заведений — самая высокая нагрузка на кассы, кухню и
 * курьеров. В эти часы сервер откладывает тяжёлые фоновые задачи (пересчёты,
 * сводки, рассылки «Вернуть гостя», чистки, резервную копию — если свежая
 * уже есть, уход из Firebase, автообучение бота): весь процессор и база — кассе,
 * экранам кухни и курьерам. Оплаты, сроки подписок, сигналы — не трогаются.
 *
 * Заведения живут в разных поясах: час пик идёт, если он идёт хотя бы в одном
 * поясе, где есть заведение. Пояса — из настроек заведений (раз в 6 часов).
 *
 * RUSH_HOUR=off — выключить; RUSH_HOUR=on — считать, что час пик всегда
 * (для проверки).
 */

const DEFAULT_TZ = "Europe/Moscow";
const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** День недели (0 — воскресенье) и час в поясе tz. */
function localClock(now, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(now));
  const wd = DAY[(parts.find((p) => p.type === "weekday") || {}).value];
  const hour = Number((parts.find((p) => p.type === "hour") || {}).value);
  return { wd, hour };
}

/** Пятница/суббота 20:00–23:59 и ночь после них (суббота/воскресенье 00:00–01:59). */
function inRushWindow(now, tz = DEFAULT_TZ) {
  let c;
  try { c = localClock(now, tz); } catch (_) { c = localClock(now, DEFAULT_TZ); }
  if ((c.wd === 5 || c.wd === 6) && c.hour >= 20) return true;
  if ((c.wd === 6 || c.wd === 0) && c.hour < 2) return true;
  return false;
}

function createRushHour({ listTimezones, refreshMs = 6 * 3600 * 1000, env = process.env, log = console.log } = {}) {
  let tzs = [DEFAULT_TZ];
  let loadedAt = 0;
  let loading = null;
  const deferred = new Map(); // имя задачи → сколько раз отложена в это окно
  let wasRush = false;

  async function refresh(now = Date.now()) {
    if (!listTimezones || (now - loadedAt < refreshMs && loadedAt)) return tzs;
    if (loading) return loading;
    loading = (async () => {
      try {
        const list = (await listTimezones()).filter((tz) => {
          try { new Intl.DateTimeFormat("ru", { timeZone: tz }); return true; } catch (_) { return false; }
        });
        tzs = [...new Set([DEFAULT_TZ, ...list])];
        loadedAt = now;
      } catch (e) {
        log(`час пик: пояса заведений не прочитаны (${String(e.message || e).slice(0, 120)}) — считаю по Москве`);
      } finally {
        loading = null;
      }
      return tzs;
    })();
    return loading;
  }

  function isRush(now = Date.now()) {
    const mode = String(env.RUSH_HOUR || "").toLowerCase();
    if (mode === "off") return false;
    if (mode === "on") return true;
    const rush = tzs.some((tz) => inRushWindow(now, tz));
    if (wasRush && !rush && deferred.size) {
      log(`час пик закончился — отложенные задачи идут: ${[...deferred.keys()].join(", ")}`);
      deferred.clear();
    }
    wasRush = rush;
    return rush;
  }

  /** true — задачу сейчас не запускать (час пик); пишет в журнал один раз за окно. */
  function shouldDefer(name, now = Date.now()) {
    if (!isRush(now)) return false;
    if (!deferred.has(name)) log(`час пик: задача «${name}» отложена до 02:00`);
    deferred.set(name, (deferred.get(name) || 0) + 1);
    return true;
  }

  function status(now = Date.now()) {
    return { rush: isRush(now), timezones: tzs.slice(), deferred: [...deferred.keys()] };
  }

  return { refresh, isRush, shouldDefer, status };
}

module.exports = { createRushHour, inRushWindow, DEFAULT_TZ };
