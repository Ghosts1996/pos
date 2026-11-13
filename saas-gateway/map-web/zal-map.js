/* Своя карта ZalPOS в браузере: курьер, кабинет, гость.
 *
 *   ZalMap.load(base)  → Promise<info | null>   (null — карты на сервере нет)
 *   ZalMap.create(el, {base, info, theme, center, zoom, bounds}) → карта:
 *     .setMarkers([{id, lat, lng, kind: me|venue|guest|courier, label, heading}])
 *     .setRoute([[lat, lng], ...] | null)
 *     .fit([{lat, lng}, ...], {padding})   .follow(on)   .setTheme(light|dark)
 *     .covers(lat, lng)  .resize()  .destroy()
 *
 * Нужны maplibre-gl-csp.js и map-style.js с того же адреса. Движение точек
 * плавное (без рывков при каждом обновлении геолокации), подписи по-русски,
 * тёмная тема — по настройке телефона. */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  const KIND_CLASS = { me: "zm-me", venue: "zm-venue", guest: "zm-guest", courier: "zm-courier" };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function themeNow() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const loading = new Map();
  function load(base) {
    const b = String(base || "").replace(/\/+$/, "");
    if (loading.has(b)) return loading.get(b);
    const p = (async () => {
      if (!window.maplibregl || !window.ZalMapStyle) return null;
      try {
        const res = await fetch(`${b}/info`, { cache: "no-cache" });
        if (!res.ok) return null;
        const info = await res.json();
        if (!info || !info.tiles) return null;
        try { if (!window.maplibregl.supported || window.maplibregl.supported()) { /* ок */ } } catch (_) { /* старый API */ }
        return info;
      } catch (_) {
        return null;
      }
    })();
    // Неудача не запоминается навсегда: при следующем открытии — новая попытка.
    p.then((v) => { if (!v) setTimeout(() => loading.delete(b), 60000); });
    loading.set(b, p);
    return p;
  }

  /**
   * Участки карты и шрифты — через свой протокол «zalmap://»: MapLibre
   * запрашивает их из основной страницы, а не из своего потока. Так их видит
   * service worker приложения: скачанная карта города и просмотренные участки
   * открываются из телефона, без интернета. Нет связи — пустой участок.
   */
  let protocolOn = false;
  function useProtocol() {
    if (protocolOn || !window.maplibregl || typeof window.maplibregl.addProtocol !== "function") return protocolOn;
    window.maplibregl.addProtocol("zalmap", async (params, abort) => {
      const url = `${location.protocol}//${params.url.slice("zalmap://".length)}`;
      try {
        const res = await fetch(url, { signal: abort && abort.signal });
        if (res.status === 204 || !res.ok) return { data: new ArrayBuffer(0) };
        return { data: await res.arrayBuffer(), cacheControl: res.headers.get("Cache-Control"), expires: res.headers.get("Expires") };
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        return { data: new ArrayBuffer(0) };
      }
    });
    protocolOn = true;
    return true;
  }

  function styleFor(base, info, theme) {
    const b = String(base).replace(/\/+$/, "");
    // Свой протокол — только для адреса того же сайта (http/https).
    const viaProto = /^https?:\/\//.test(b) && b.startsWith(location.protocol) && useProtocol();
    const root = viaProto ? `zalmap://${b.replace(/^https?:\/\//, "")}` : b;
    return window.ZalMapStyle.buildStyle({
      theme,
      tilesUrl: `${root}/tiles/{z}/{x}/{y}.mvt?v=${info.tiles.v}`,
      glyphsUrl: `${root}/fonts/{fontstack}/{range}.pbf`,
      info: info.tiles,
    });
  }

  function routeLayers(map, theme) {
    if (!map.getSource("zal-route")) {
      map.addSource("zal-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    const dark = theme === "dark";
    const w = ["interpolate", ["exponential", 1.5], ["zoom"], 10, 3, 14, 6, 17, 11, 19, 18];
    const wc = ["interpolate", ["exponential", 1.5], ["zoom"], 10, 5, 14, 9, 17, 15, 19, 24];
    if (!map.getLayer("zal-route-case")) {
      // Маршрут: светлая тема — чёрная линия с золотой сердцевиной на белой
      // обводке; тёмная — золотая линия на чёрной обводке.
      const core = ["interpolate", ["exponential", 1.5], ["zoom"], 10, 1, 14, 2, 17, 3.5, 19, 6];
      map.addLayer({ id: "zal-route-case", type: "line", source: "zal-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#050506" : "#FFFFFF", "line-width": wc, "line-opacity": 0.96 } }, "roads_labels");
      map.addLayer({ id: "zal-route", type: "line", source: "zal-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#D9B66C" : "#141414", "line-width": w } }, "roads_labels");
      map.addLayer({ id: "zal-route-core", type: "line", source: "zal-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#F7E2AE" : "#D9B66C", "line-width": core, "line-opacity": 0.9 } }, "roads_labels");
    }
  }

  function markerEl(m) {
    const el = document.createElement("div");
    el.className = `zm-pin ${KIND_CLASS[m.kind] || "zm-guest"}`;
    el.setAttribute("aria-label", m.label || "");
    if (m.kind === "me" || m.kind === "courier") {
      el.innerHTML = `<i class="zm-halo"></i><i class="zm-arrow"></i><b class="zm-dot"></b>${m.kind === "courier" && m.label ? `<span class="zm-tag">${esc(m.label)}</span>` : ""}`;
    } else {
      el.innerHTML = `<span class="zm-badge">${esc(m.label || "")}</span><i class="zm-stem"></i>`;
    }
    return el;
  }

  function create(el, opts = {}) {
    const ml = window.maplibregl;
    const base = String(opts.base || "").replace(/\/+$/, "");
    const info = opts.info;
    if (!ml || !info || !info.tiles) return null;
    if (opts.workerUrl !== false) {
      try { ml.setWorkerUrl(opts.workerUrl || `${base}/maplibre-gl-csp-worker.js`); } catch (_) { /* уже задан */ }
    }
    let theme = opts.theme || themeNow();
    const c = opts.center || { lat: info.tiles.center[1], lng: info.tiles.center[0] };
    // Границы — район города, где работает курьер (opts.bounds), а не все
    // районы сразу: карта не уезжает в пустоту между городами.
    const b = Array.isArray(opts.bounds) && opts.bounds.length === 4 ? opts.bounds : info.tiles.bounds;
    // Карта всей России пересекает 180-й меридиан (Чукотка): её границы —
    // весь пояс от −180 до 180. Такие рамки с запасом выходят за ±180, и
    // MapLibre не рисует ничего (пустой фон). С картой страны рамок нет —
    // отдалить дальше страны не даёт minZoom; у района города — в пределах ±180.
    const wide = !b || b[2] - b[0] >= 300;
    const clampLng = (v) => Math.max(-180, Math.min(180, v));
    const clampLat = (v) => Math.max(-85, Math.min(85, v));
    const maxBounds = wide ? null : [[clampLng(b[0] - 0.6), clampLat(b[1] - 0.4)], [clampLng(b[2] + 0.6), clampLat(b[3] + 0.4)]];
    const map = new ml.Map({
      container: el,
      style: styleFor(base, info, theme),
      center: [c.lng, c.lat],
      zoom: opts.zoom || 13,
      // С картой всей России — можно отдалить до страны целиком.
      minZoom: info.tiles.countryMaxzoom ? 3 : 9,
      maxZoom: 19,
      ...(maxBounds ? { maxBounds } : {}),
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: opts.rotate === true,
      touchPitch: false,
      fadeDuration: reduceMotion() ? 0 : 200,
      cooperativeGestures: false,
      renderWorldCopies: false,
    });
    map.touchZoomRotate.disableRotation();
    // Вся Россия: подробно (до домов) — в районах городов, вне их карта
    // страны до масштаба countryMaxzoom: дальше не приближаем, а не рисуем пустоту.
    const detail = (info.areas || []).map((a) => a.bbox).filter((b) => Array.isArray(b) && b.length === 4);
    const cmz = Number(info.tiles.countryMaxzoom) || 0;
    if (cmz && detail.length) {
      const limitZoom = () => {
        const c = map.getCenter();
        const inside = detail.some((b) => c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3]);
        const mz = inside ? 19 : Math.max(cmz, map.getMinZoom() + 1);
        if (map.getMaxZoom() !== mz) map.setMaxZoom(mz);
      };
      map.on("moveend", limitZoom);
      limitZoom();
    }
    map.addControl(new ml.AttributionControl({ compact: true, customAttribution: "© OpenStreetMap" }), "bottom-left");

    const markers = new Map(); // id → {marker, el, cur:{lat,lng}, to, from, t0, kind}
    let routeData = null;
    let followOn = false;
    let lastFit = null;
    let userMoved = false;
    let anim = 0;
    let ready = false;
    const onReady = [];

    map.on("load", () => {
      ready = true;
      routeLayers(map, theme);
      if (routeData) map.getSource("zal-route").setData(routeData);
      onReady.splice(0).forEach((f) => f());
    });
    // Пользователь сам двигает карту — перестаём следовать за курьером.
    map.on("dragstart", () => { userMoved = true; if (followOn) { followOn = false; if (opts.onFollow) opts.onFollow(false); } });

    map.on("zoomstart", (e) => { if (e && e.originalEvent) userMoved = true; });
    const whenReady = (f) => (ready ? f() : onReady.push(f));

    // Окно карты меняется (шторка заказов, поворот телефона) — холст карты
    // подстраивается сразу; если человек карту не двигал — вид пересчитывается.
    let roTimer = 0;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      map.resize();
      clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        if (followOn) { const me = markers.get("me"); if (me) map.jumpTo({ center: [me.cur.lng, me.cur.lat] }); }
        else if (lastFit && !userMoved) fit(lastFit.points, { ...lastFit.opts, animate: false });
      }, 120);
    }) : null;
    if (ro) ro.observe(el);

    function tick() {
      anim = 0;
      const now = performance.now();
      let more = false;
      for (const m of markers.values()) {
        if (!m.to) continue;
        const k = Math.min(1, (now - m.t0) / m.dur);
        const e = 1 - (1 - k) * (1 - k);
        const lat = m.from.lat + (m.to.lat - m.from.lat) * e;
        const lng = m.from.lng + (m.to.lng - m.from.lng) * e;
        m.cur = { lat, lng };
        m.marker.setLngLat([lng, lat]);
        if (k < 1) more = true;
        else m.to = null;
      }
      const me = markers.get("me");
      if (followOn && me) map.jumpTo({ center: [me.cur.lng, me.cur.lat] });
      if (more) anim = requestAnimationFrame(tick);
    }

    function setMarkers(list) {
      const ids = new Set();
      for (const m of list || []) {
        if (!m || !Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
        const id = String(m.id || `${m.kind}:${m.lat},${m.lng}`);
        ids.add(id);
        let rec = markers.get(id);
        if (rec && rec.kind !== m.kind) { rec.marker.remove(); markers.delete(id); rec = null; }
        if (!rec) {
          const node = markerEl(m);
          const marker = new ml.Marker({ element: node, anchor: m.kind === "me" || m.kind === "courier" ? "center" : "bottom" }).setLngLat([m.lng, m.lat]).addTo(map);
          rec = { marker, el: node, cur: { lat: m.lat, lng: m.lng }, to: null, kind: m.kind, label: m.label };
          markers.set(id, rec);
        } else {
          if (rec.label !== m.label) {
            rec.label = m.label;
            const badge = rec.el.querySelector(".zm-badge, .zm-tag");
            if (badge) badge.textContent = m.label || "";
          }
          const d = Math.abs(rec.cur.lat - m.lat) + Math.abs(rec.cur.lng - m.lng);
          if (d > 1e-7) {
            // Плавный переезд; большой скачок (> ~2 км) — сразу.
            if (reduceMotion() || d > 0.03) { rec.cur = { lat: m.lat, lng: m.lng }; rec.to = null; rec.marker.setLngLat([m.lng, m.lat]); }
            else { rec.from = { ...rec.cur }; rec.to = { lat: m.lat, lng: m.lng }; rec.t0 = performance.now(); rec.dur = 900; if (!anim) anim = requestAnimationFrame(tick); }
          }
        }
        const arrow = rec.el.querySelector(".zm-arrow");
        if (arrow) {
          const h = m.heading == null ? NaN : Number(m.heading);
          arrow.hidden = !Number.isFinite(h);
          if (Number.isFinite(h)) arrow.style.transform = `rotate(${Math.round(h)}deg)`;
        }
        rec.el.classList.toggle("zm-stale", !!m.stale);
        rec.el.classList.toggle("zm-active", !!m.active);
      }
      for (const [id, rec] of markers) if (!ids.has(id)) { rec.marker.remove(); markers.delete(id); }
      if (followOn && markers.get("me") && !anim) tick();
    }

    function setRoute(line) {
      routeData = {
        type: "FeatureCollection",
        features: Array.isArray(line) && line.length > 1
          ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.map(([la, lo]) => [lo, la]) } }]
          : [],
      };
      whenReady(() => { const s = map.getSource("zal-route"); if (s) s.setData(routeData); });
    }

    // Отступы не должны съедать окно карты: иначе точки «не помещаются» и
    // карта отъезжает на всю область.
    function safePadding(padding) {
      const W = el.clientWidth || 300, H = el.clientHeight || 300;
      const p = typeof padding === "number" ? { top: padding, bottom: padding, left: padding, right: padding } : { top: 0, bottom: 0, left: 0, right: 0, ...padding };
      const kv = Math.min(1, (H * 0.5) / Math.max(1, p.top + p.bottom));
      const kh = Math.min(1, (W * 0.5) / Math.max(1, p.left + p.right));
      return { top: Math.round(p.top * kv), bottom: Math.round(p.bottom * kv), left: Math.round(p.left * kh), right: Math.round(p.right * kh) };
    }

    function fit(points, opts2 = {}) {
      const { padding = 60, maxZoom = 16.5, minZoom = 11.5, animate = true } = opts2;
      const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (!pts.length) return;
      followOn = false;
      lastFit = { points: pts, opts: opts2 };
      userMoved = false;
      const dur = animate && !reduceMotion() ? 600 : 0;
      const pad = safePadding(padding);
      if (pts.length === 1) { map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.min(maxZoom, 15.5), duration: dur }); return; }
      let w = 180, s = 90, e = -180, n = -90;
      for (const p of pts) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
      let cam = null;
      try { cam = map.cameraForBounds([[w, s], [e, n]], { padding: pad, maxZoom }); } catch (_) { /* слишком маленькое окно */ }
      if (!cam) return;
      // Точки далеко друг от друга — не показываем полстраны: держим город,
      // в центре — первая точка (курьер или заведение).
      if (cam.zoom < minZoom) { map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: minZoom, duration: dur }); return; }
      try { map.fitBounds([[w, s], [e, n]], { padding: pad, maxZoom, duration: dur }); } catch (_) { /* окно слишком маленькое */ }
    }

    function follow(on, zoom = 16.5) {
      followOn = !!on;
      const me = markers.get("me");
      if (followOn && me) map.easeTo({ center: [me.cur.lng, me.cur.lat], zoom: Math.max(map.getZoom(), zoom), duration: reduceMotion() ? 0 : 500 });
      if (opts.onFollow) opts.onFollow(followOn);
    }

    function setTheme(t) {
      if (t === theme) return;
      theme = t;
      ready = false;
      map.setStyle(styleFor(base, info, theme));
      map.once("styledata", () => { ready = true; routeLayers(map, theme); if (routeData) map.getSource("zal-route").setData(routeData); });
    }

    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const onScheme = () => { if (!opts.theme) setTheme(themeNow()); };
    if (mq && mq.addEventListener) mq.addEventListener("change", onScheme);

    function covers(lat, lng) {
      return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
    }

    return {
      map,
      setMarkers,
      setRoute,
      fit,
      follow,
      following: () => followOn,
      setTheme,
      covers,
      resize: () => map.resize(),
      destroy() {
        if (anim) cancelAnimationFrame(anim);
        if (ro) ro.disconnect();
        clearTimeout(roTimer);
        if (mq && mq.removeEventListener) mq.removeEventListener("change", onScheme);
        map.remove();
      },
    };
  }

  window.ZalMap = { load, create, themeNow };
})();
