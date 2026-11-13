/*
 * Своя карта ZalPOS для встраивания в любую страницу: кабинет (курьеры
 * «Сейчас»), страница заказа гостя, страница «Адрес и карта» из бота.
 * Без сторонних карт и рекламы — те же тайлы и движок, что у курьера.
 *
 *   <script src="https://pii.zalpos.ru/saas/map/zal-embed.js"></script>
 *   ZalEmbed.mount(элемент, [{ lat, lng, kind: "venue"|"courier"|"guest"|"me", label, id }], { key })
 *   или <div data-zalmap='{"marks":[...]}'></div> — подхватится сам.
 *
 * Карта с одним key живёт одна: страница перерисовала блок — карта
 * переезжает в новый элемент без перезагрузки, метки плавно сдвигаются.
 * Чужой адрес (zalpos.ru): поток карты — из blob (браузер не пускает поток
 * с другого адреса), тайлы — с сервера карты по CORS.
 */
(function () {
  "use strict";
  if (window.ZalEmbed) return;
  const self = document.currentScript && document.currentScript.src;
  const BASE = self ? self.replace(/\/zal-embed\.js(?:\?.*)?$/, "") : "";
  const sameOrigin = BASE.startsWith(location.origin + "/");

  const css = (href) => new Promise((ok) => {
    if (document.querySelector(`link[href="${href}"]`)) return ok();
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.onload = ok;
    l.onerror = ok;
    document.head.appendChild(l);
  });
  const js = (src) => new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => bad(new Error(`не загрузился ${src}`));
    document.head.appendChild(s);
  });

  let ready = null;
  function load() {
    if (ready) return ready;
    ready = (async () => {
      await Promise.all([css(`${BASE}/maplibre-gl.css`), css(`${BASE}/zal-map.css`)]);
      if (!window.maplibregl) await js(`${BASE}/maplibre-gl-csp.js`);
      if (!window.ZalMapStyle) await js(`${BASE}/map-style.js`);
      if (!window.ZalMap) await js(`${BASE}/zal-map.js`);
      let workerUrl = `${BASE}/maplibre-gl-csp-worker.js`;
      if (!sameOrigin) {
        const text = await (await fetch(workerUrl)).text();
        workerUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
      }
      const info = await (await fetch(`${BASE}/info`)).json();
      if (!info || !info.tiles) throw new Error("карта ещё не собрана");
      return { info, workerUrl };
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  const maps = new Map(); // key → { box, api, fitKey }

  function points(marks) {
    return (marks || [])
      .map((m, i) => ({
        id: String(m.id || `${m.kind || "guest"}:${i}`),
        lat: Number(m.lat), lng: Number(m.lng),
        kind: ["venue", "courier", "guest", "me"].includes(m.kind) ? m.kind : "guest",
        label: String(m.label || "").slice(0, 40),
        heading: Number.isFinite(Number(m.heading)) ? Number(m.heading) : null,
      }))
      .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng) && Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180);
  }

  async function mount(slot, marks, opts = {}) {
    if (!slot) return null;
    const key = opts.key || "default";
    const list = points(marks);
    let rec = maps.get(key);
    if (rec && rec.box.parentNode !== slot) {
      slot.textContent = "";
      slot.appendChild(rec.box);
      rec.api.resize();
    }
    if (!rec) {
      if (!list.length) return null;
      const box = document.createElement("div");
      box.className = "zal-embed";
      box.style.cssText = "position:relative;width:100%;height:100%;min-height:200px;border-radius:inherit;overflow:hidden";
      slot.textContent = "";
      slot.appendChild(box);
      let deps;
      try {
        deps = await load();
      } catch (e) {
        box.innerHTML = '<p style="margin:0;padding:16px;font:14px/1.4 system-ui,sans-serif;opacity:.7">Карта временно недоступна</p>';
        return null;
      }
      const c = list[0];
      const api = window.ZalMap.create(box, {
        base: BASE, info: deps.info, workerUrl: deps.workerUrl,
        center: { lat: c.lat, lng: c.lng }, zoom: 14, theme: opts.theme,
      });
      if (!api) return null;
      rec = { box, api, fitKey: "" };
      maps.set(key, rec);
    }
    rec.api.setMarkers(list);
    // Камера — когда появились новые точки (не на каждое обновление, иначе
    // карта прыгает, пока человек её двигает).
    const fitKey = list.map((m) => m.id).sort().join("|");
    if (fitKey !== rec.fitKey) {
      rec.fitKey = fitKey;
      setTimeout(() => rec.api.fit(list, { padding: opts.padding || 48, maxZoom: opts.maxZoom || 16 }), 50);
    }
    return rec.api;
  }

  function auto() {
    document.querySelectorAll("[data-zalmap]").forEach((el, i) => {
      let d = {};
      try { d = JSON.parse(el.getAttribute("data-zalmap")); } catch (_) { return; }
      mount(el, d.marks, { key: d.key || `auto${i}`, theme: d.theme });
    });
  }

  window.ZalEmbed = { mount, base: BASE };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
})();
