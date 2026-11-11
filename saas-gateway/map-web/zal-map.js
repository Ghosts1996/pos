/* Своя карта ZalPOS в браузере: курьер, кабинет, гость.
 *
 *   ZalMap.load(base)  → Promise<info | null>   (null — карты на сервере нет)
 *   ZalMap.create(el, {base, info, theme, center, zoom}) → карта:
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

  function styleFor(base, info, theme) {
    const b = String(base).replace(/\/+$/, "");
    return window.ZalMapStyle.buildStyle({
      theme,
      tilesUrl: `${b}/tiles/{z}/{x}/{y}.mvt?v=${info.tiles.v}`,
      glyphsUrl: `${b}/fonts/{fontstack}/{range}.pbf`,
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
      map.addLayer({ id: "zal-route-case", type: "line", source: "zal-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#0B1E45" : "#FFFFFF", "line-width": wc, "line-opacity": 0.95 } }, "roads_labels");
      map.addLayer({ id: "zal-route", type: "line", source: "zal-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#5B8CFF" : "#2B6BF3", "line-width": w } }, "roads_labels");
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
    const b = info.tiles.bounds;
    const map = new ml.Map({
      container: el,
      style: styleFor(base, info, theme),
      center: [c.lng, c.lat],
      zoom: opts.zoom || 13,
      minZoom: 8,
      maxZoom: 19,
      maxBounds: [[b[0] - 0.6, b[1] - 0.4], [b[2] + 0.6, b[3] + 0.4]],
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: opts.rotate === true,
      touchPitch: false,
      fadeDuration: reduceMotion() ? 0 : 200,
      cooperativeGestures: false,
      renderWorldCopies: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new ml.AttributionControl({ compact: true, customAttribution: "© OpenStreetMap" }), "bottom-left");

    const markers = new Map(); // id → {marker, el, cur:{lat,lng}, to, from, t0, kind}
    let routeData = null;
    let followOn = false;
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
    map.on("dragstart", () => { if (followOn) { followOn = false; if (opts.onFollow) opts.onFollow(false); } });

    const whenReady = (f) => (ready ? f() : onReady.push(f));

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

    function fit(points, { padding = 60, maxZoom = 16.5, animate = true } = {}) {
      const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (!pts.length) return;
      followOn = false;
      const dur = animate && !reduceMotion() ? 600 : 0;
      if (pts.length === 1) { map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.min(maxZoom, 15.5), duration: dur }); return; }
      let w = 180, s = 90, e = -180, n = -90;
      for (const p of pts) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
      try { map.fitBounds([[w, s], [e, n]], { padding, maxZoom, duration: dur }); } catch (_) { /* слишком маленькое окно */ }
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
        if (mq && mq.removeEventListener) mq.removeEventListener("change", onScheme);
        map.remove();
      },
    };
  }

  window.ZalMap = { load, create, themeNow };
})();
