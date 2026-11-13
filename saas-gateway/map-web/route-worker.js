/* Маршруты своей карты без связи — в потоке браузера курьера.
 * Тот же поиск пути, что на сервере (map-graph.js): сеть дорог района
 * скачана в телефон заранее (кнопка «Скачать карту города» или само на Wi-Fi).
 * Сообщения: { id, op: "load", buf, area } → { id, ok, bounds };
 *            { id, op: "route", points, mode } → ответ как у сервера (/route). */
"use strict";
self.module = { exports: {} };
self.require = { main: null };
importScripts("map-graph.js");
const G = self.module.exports;
let graph = null;
let area = "";

self.onmessage = (e) => {
  const msg = e.data || {};
  const reply = (body) => self.postMessage({ id: msg.id, ...body });
  try {
    if (msg.op === "load") {
      graph = G.loadGraph(new Uint8Array(msg.buf));
      area = String(msg.area || "");
      return reply({ ok: true, area, bounds: graph.bounds });
    }
    if (msg.op === "route") {
      if (!graph) return reply({ ok: false, reason: "nograph" });
      const pts = (msg.points || []).slice(0, 6);
      if (!pts.every((p) => G.contains(graph, p.lat, p.lng))) return reply({ ok: false, reason: "nomap" });
      const mode = G.MODES.includes(msg.mode) ? msg.mode : "auto";
      let r = G.route(graph, pts, mode);
      // Велосипедом не проехать (лестницы, пешеходные зоны) — как на сервере: пешком, быстрее в 2,2 раза.
      if (!r.ok && r.reason === "noroute" && mode === "bike") {
        const f = G.route(graph, pts, "foot");
        if (f.ok) r = { ...f, mode: "bike", s: Math.round(f.s * 0.45), legs: (f.legs || []).map((l) => ({ m: l.m, s: Math.round(l.s * 0.45) })), viaFoot: true };
      }
      return reply({ ...r, offline: true });
    }
    reply({ ok: false, reason: "op" });
  } catch (err) {
    reply({ ok: false, reason: "error", message: String((err && err.message) || err) });
  }
};
