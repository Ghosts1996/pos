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

  /* Районы на карте: заливка выбранных (золото), контур остальных; клик по
     району — opts.onArea(id), по пустому месту — opts.onClick(lat, lng). */
  function areaFeatures(areas) {
    return {
      type: "FeatureCollection",
      features: (areas || []).filter((a) => Array.isArray(a.rings) && a.rings.length).map((a) => ({
        type: "Feature",
        properties: { id: String(a.id), on: a.on ? 1 : 0, here: a.here ? 1 : 0 },
        // Кольца районов — внешние и дыры вперемешку: MultiPolygon из колец по одному;
        // заливка «чётное-нечётное» у MapLibre нет, дыры (анклавы) рисуются поверх.
        geometry: { type: "MultiPolygon", coordinates: a.rings.map((r) => [r]) },
      })),
    };
  }
  function paintAreas(rec) {
    const map = rec.api && rec.api.map;
    if (!map || !rec.areas) return;
    const apply = () => {
      const data = areaFeatures(rec.areas);
      const src = map.getSource("zal-areas");
      if (src) { src.setData(data); return; }
      map.addSource("zal-areas", { type: "geojson", data });
      // Под подписями улиц и маршрутом — названия остаются читаемыми.
      const before = map.getLayer("zal-route-case") ? "zal-route-case" : map.getLayer("roads_labels") ? "roads_labels" : undefined;
      map.addLayer({ id: "zal-areas-fill", type: "fill", source: "zal-areas",
        paint: { "fill-color": ["case", ["==", ["get", "on"], 1], "#D9B66C", "#8A8F98"], "fill-opacity": ["case", ["==", ["get", "on"], 1], 0.32, 0.05] } }, before);
      map.addLayer({ id: "zal-areas-line", type: "line", source: "zal-areas",
        paint: { "line-color": ["case", ["==", ["get", "on"], 1], "#B08A3E", "#8A8F98"], "line-width": ["case", ["==", ["get", "on"], 1], 2, 1], "line-opacity": 0.85 } }, before);
    };
    if (map.isStyleLoaded()) apply(); else map.once("idle", apply);
    if (!rec.areaHook) {
      rec.areaHook = true;
      // Сменилась тема — стиль перезагрузился, слои районов нужно вернуть.
      map.on("styledata", () => { if (rec.areas && !map.getSource("zal-areas")) setTimeout(() => paintAreas(rec), 0); });
      map.on("click", (e) => {
        const hit = map.getLayer("zal-areas-fill") ? map.queryRenderedFeatures(e.point, { layers: ["zal-areas-fill"] }) : [];
        if (hit.length && rec.onArea) {
          // Самый маленький район под пальцем (поселение внутри «остальной части»).
          const ids = hit.map((f) => String(f.properties.id));
          const pick = (rec.areas || []).filter((a) => ids.includes(String(a.id))).sort((x, y) => (x.areaKm2 || 0) - (y.areaKm2 || 0))[0];
          if (pick) return rec.onArea(String(pick.id));
        }
        if (rec.onClick) rec.onClick(e.lngLat.lat, e.lngLat.lng);
      });
    }
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
      if (!list.length && !opts.center) return null;
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
      const c = list[0] || opts.center;
      const api = window.ZalMap.create(box, {
        base: BASE, info: deps.info, workerUrl: deps.workerUrl,
        center: { lat: c.lat, lng: c.lng }, zoom: 14, theme: opts.theme,
      });
      if (!api) return null;
      rec = { box, api, fitKey: "" };
      maps.set(key, rec);
    }
    rec.api.setMarkers(list);
    rec.onClick = typeof opts.onClick === "function" ? opts.onClick : null;
    rec.onArea = typeof opts.onArea === "function" ? opts.onArea : null;
    if (opts.areas) { rec.areas = opts.areas; paintAreas(rec); }
    // Камера — когда появились новые точки (не на каждое обновление, иначе
    // карта прыгает, пока человек её двигает).
    const fitKey = opts.fitKey || list.map((m) => m.id).sort().join("|");
    if (fitKey !== rec.fitKey) {
      rec.fitKey = fitKey;
      const pts = opts.fitPoints && opts.fitPoints.length ? opts.fitPoints : list;
      if (pts.length) setTimeout(() => rec.api.fit(pts, { padding: opts.padding || 48, maxZoom: opts.maxZoom || 16 }), 50);
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
