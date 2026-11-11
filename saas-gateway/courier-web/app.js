/* Приложение курьера ZalPOS (docs/delivery.md, раздел 6).
 *
 * Экран как в приложениях такси и доставки: карта на весь экран, поверх —
 * шторка с заказом (тянется вверх и вниз), внизу меню «Заказы · Доход ·
 * Профиль». Маршрут «я → заведение → гость» строится прямо на карте, голос —
 * одной кнопкой в навигаторе.
 *
 * Как устроено:
 *  • вход — по ссылке-приглашению (#i=…) или в демо по коду (#demo=…),
 *    дальше ключ в памяти телефона;
 *  • состояние — с сервера (api/state) каждые 8 с на линии, ответ «без
 *    изменений» короткий;
 *  • нажатия — в очередь: на экране шаг меняется сразу, на сервер уходит,
 *    когда есть связь (порядок сохраняется); ошибка сервера — сообщением;
 *  • геолокация — пачками раз в 10 с, без связи копится в памяти телефона;
 *  • на линии экран не гаснет; новый заказ — звук, вибрация, уведомление;
 *  • карта — встроенная карта Яндекса (маршрут с пробками); без связи —
 *    своя схема: где вы, заведение и гость, с расстояниями.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- утилиты

  const KEY = {
    token: "zc_token", queue: "zc_queue", pings: "zc_pings", order: "zc_order", nav: "zc_nav",
    sound: "zc_sound", seen: "zc_seen", transport: "zc_transport", sheet: "zc_sheet", installSkip: "zc_install_skip",
  };
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* память переполнена — не страшно */ } };
  const drop = (k) => { try { localStorage.removeItem(k); } catch (_) { /* нет доступа */ } };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nbsp = "\u00a0";
  const rub = (n) => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, nbsp)}${nbsp}₽`;
  const kmText = (m) => (m == null ? "" : m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)}${nbsp}м` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",")}${nbsp}км`);
  const minText = (n) => (n < 60 ? `${n}${nbsp}мин` : `${Math.floor(n / 60)}${nbsp}ч${n % 60 ? ` ${n % 60}${nbsp}мин` : ""}`);
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const phoneHref = (p) => { const d = String(p || "").replace(/\D/g, ""); return d ? `tel:+${d.length === 10 ? `7${d}` : d.replace(/^8(\d{10})$/, "7$1")}` : ""; };
  const phoneText = (p) => { const d = String(p || "").replace(/\D/g, "").replace(/^8(\d{10})$/, "7$1"); const m = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(d); return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : p; };
  const plural = (n, a, b, c) => { const m10 = n % 10; const m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const $ = (id) => document.getElementById(id);
  const $app = $("app");
  const $modal = $("modal");
  const $toast = $("toast");

  // Значки — линии 2 px, как в системе телефона.
  const svg = (d, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    phone: (c) => svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>', c),
    nav: (c) => svg('<polygon points="3 11 22 2 13 21 11 13 3 11"/>', c),
    copy: (c) => svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', c),
    more: (c) => svg('<circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/>', c),
    box: (c) => svg('<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>', c),
    list: (c) => svg('<path d="M3 6h18M3 12h18M3 18h12"/>', c),
    wallet: (c) => svg('<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/><path d="M21 11h-4a2 2 0 0 0 0 4h4a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z"/>', c),
    user: (c) => svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', c),
    locate: (c) => svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>', c),
    refresh: (c) => svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>', c),
    check: (c) => svg('<polyline points="20 6 9 17 4 12"/>', c),
    pin: (c) => svg('<path d="M12 22s7-7.4 7-13a7 7 0 0 0-14 0c0 5.6 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/>', c),
    store: (c) => svg('<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M10 20v-5h4v5"/>', c),
    cash: (c) => svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>', c),
    card: (c) => svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>', c),
    qr: (c) => svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>', c),
    warn: (c) => svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', c),
    bell: (c) => svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>', c),
    sound: (c) => svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>', c),
    sun: (c) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', c),
    download: (c) => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', c),
    logout: (c) => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', c),
    clock: (c) => svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', c),
    route: (c) => svg('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>', c),
    shield: (c) => svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', c),
    flag: (c) => svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>', c),
  };

  const NAVS = {
    yandexmaps: { label: "Яндекс Карты", note: "откроется приложение, если установлено, иначе сайт" },
    yandexnavi: { label: "Яндекс Навигатор", note: "голосом; нужно приложение Навигатор" },
    dgis: { label: "2ГИС", note: "приложение или сайт 2ГИС" },
  };
  const TRANSPORT = {
    auto: { label: "Авто", rtt: "auto", mPerMin: 380, dgis: "car" },
    bike: { label: "Вело", rtt: "bc", mPerMin: 250, dgis: "bike" },
    foot: { label: "Пешком", rtt: "pd", mPerMin: 80, dgis: "pedestrian" },
  };
  const ROAD_FACTOR = 1.3;
  const FAIL = [
    ["no_answer", "Не открывают, не отвечают"],
    ["wrong_address", "Неверный адрес"],
    ["refused", "Гость отказался от заказа"],
    ["other", "Другая причина"],
  ];
  const STAGE = {
    toVenue: { chip: "blue", label: "Еду в заведение", step: 0 },
    onWay: { chip: "green", label: "Везу гостю", step: 1 },
    arrived: { chip: "amber", label: "У двери", step: 2 },
    failed: { chip: "red", label: "Не удалось вручить", step: 2 },
  };
  const METHOD = { cash: "наличными", card: "картой", qr: "по QR", online: "онлайн", prepaid: "оплачен заранее" };
  const WAIT_HINT_MS = 10 * 60 * 1000;
  const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  // ---------------------------------------------------------------- состояние

  const S = {
    token: load(KEY.token, ""),
    data: null,
    v: "",
    view: "orders",
    list: "",
    focus: "",
    sheet: load(KEY.sheet, "peek"),
    online: navigator.onLine !== false,
    queue: load(KEY.queue, []),
    pings: load(KEY.pings, []),
    order: load(KEY.order, []),
    nav: load(KEY.nav, "yandexmaps"),
    transport: load(KEY.transport, "auto"),
    sound: load(KEY.sound, true),
    seenFree: new Set(load(KEY.seen, [])),
    newFree: new Set(),
    gone: new Set(),
    mineKeys: null,
    pendingTakes: new Set(),
    modal: null,
    fatal: "",
    lastSync: 0,
    syncing: false,
    flushing: false,
    retryAt: 0,
    geo: { watch: null, error: 0, fix: null, lastBuffered: null },
    wake: null,
    install: null,
    reg: null,
    audio: null,
    map: { url: "", key: "", at: 0, from: null },
    hist: null,
    histDay: "",
    histAt: 0,
  };
  if (!NAVS[S.nav]) S.nav = "yandexmaps";
  if (!TRANSPORT[S.transport]) S.transport = "auto";

  // ---------------------------------------------------------------- сервер

  async function api(op, body = {}) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    let res;
    try {
      res = await fetch(`api/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
        cache: "no-store",
      });
    } catch (e) {
      const err = new Error("Нет связи с сервером");
      err.network = true;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json = {};
    try { json = await res.json(); } catch (_) { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error(json.error || `Ошибка сервера (${res.status})`);
      err.status = res.status;
      err.network = res.status >= 500 || res.status === 429;
      throw err;
    }
    setOnline(true);
    return json;
  }

  function setOnline(v) {
    if (S.online === v) return;
    S.online = v;
    render();
    if (v) { flush(); flushPings(); }
  }

  function signedOut(message) {
    S.token = "";
    S.data = null;
    S.fatal = message || "";
    S.map = { url: "", key: "", at: 0, from: null };
    drop(KEY.token);
    stopGeo();
    releaseWake();
    render();
  }

  // ---------------------------------------------------------------- вход

  async function login(code, demo = false) {
    $app.innerHTML = `<div class="boot"><div class="spinner" aria-hidden="true"></div><p>${demo ? "Входим в демо…" : "Входим по приглашению…"}</p></div>`;
    try {
      const r = demo
        ? await api("demo", { code, device: deviceName() })
        : await api("login", { invite: code, device: deviceName() });
      S.token = r.token;
      save(KEY.token, r.token);
      S.fatal = "";
      S.view = "orders";
      toast(`Добро пожаловать, курьер №${r.courier.no}!`, "ok");
    } catch (e) {
      S.fatal = e.message;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  function deviceName() {
    const ua = navigator.userAgent || "";
    const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
    if (m) return `Android · ${m[1].trim()}`.slice(0, 80);
    if (/iPhone|iPad/.test(ua)) return "iPhone";
    return "Браузер";
  }

  // ---------------------------------------------------------------- данные

  async function refresh(force = false) {
    if (!S.token || S.syncing) return;
    S.syncing = true;
    S.lastSync = Date.now(); // и при неудаче — следующая попытка по расписанию, а не каждую секунду
    try {
      const r = await api("state", force ? {} : { v: S.v });
      S.lastSync = Date.now();
      if (!r.same) {
        const prev = S.data;
        S.data = r;
        S.v = r.v;
        reconcile(prev, r);
        if (r.me.onShift) startShiftServices();
        else stopGeo();
        render();
      } else {
        updateLive();
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) return signedOut(e.message);
      if (e.network) setOnline(false);
    } finally {
      S.syncing = false;
    }
  }

  /** Новые свободные — звук; назначили или сняли заказ — сообщение. */
  function reconcile(prev, next) {
    // Нажатия в очереди ещё не дошли — показываем их результат поверх ответа.
    for (const q of S.queue) applyLocal(q, next);
    const freeIds = next.free.map((f) => f.key);
    const fresh = next.me.onShift ? freeIds.filter((k) => !S.seenFree.has(k)) : [];
    if (prev && fresh.length) {
      const f = next.free.find((x) => x.key === fresh[0]);
      alertNew(fresh.length === 1
        ? `Новый заказ${f && f.payout ? ` · ${rub(f.payout)}` : ""}: ${(f && f.street) || "доставка"}`
        : `Новых заказов: ${fresh.length}`);
    }
    if (fresh.length) S.newFree = new Set(fresh);
    S.seenFree = new Set(freeIds);
    save(KEY.seen, freeIds.slice(-200));
    const mine = new Set(next.mine.map((m) => m.key));
    if (S.mineKeys) {
      for (const m of next.mine) {
        if (!S.mineKeys.has(m.key) && !S.pendingTakes.has(m.key)) {
          alertNew(`Заведение назначило вам заказ №${m.no}`, true);
          S.list = "mine";
          S.focus = m.key;
        }
      }
      for (const k of S.mineKeys) {
        if (!mine.has(k) && !S.gone.has(k) && !S.queue.some((q) => `${q.t}__${q.s}` === k)) {
          toast("Один заказ снят с вас заведением — список обновлён");
        }
      }
    }
    S.mineKeys = mine;
    S.gone.clear();
    S.pendingTakes.clear();
    S.order = S.order.filter((k) => mine.has(k));
    for (const m of next.mine) if (!S.order.includes(m.key)) S.order.push(m.key);
    save(KEY.order, S.order);
    if (S.focus && !mine.has(S.focus)) S.focus = "";
    document.title = next.free.length ? `(${next.free.length}) Курьер · ZalPOS` : "Курьер · ZalPOS";
  }

  // ---------------------------------------------------------------- очередь действий

  function act(op, o, args = {}) {
    const item = { id: uid(), op, t: o.t, s: o.s, args, at: Date.now() };
    if (op === "take") S.pendingTakes.add(o.key);
    S.queue.push(item);
    save(KEY.queue, S.queue);
    if (S.data) applyLocal(item, S.data);
    if (S.data && ["deliver", "returned", "release"].includes(op) && !S.data.mine.length) { S.list = "free"; S.focus = ""; }
    buzz(15);
    render();
    flush();
  }

  /** Шаг на экране сразу, не дожидаясь сервера. */
  function applyLocal(q, data) {
    const key = `${q.t}__${q.s}`;
    const at = q.at;
    const mine = data.mine.find((m) => m.key === key);
    switch (q.op) {
      case "take": {
        const f = data.free.find((x) => x.key === key);
        if (f && !mine) {
          data.free = data.free.filter((x) => x.key !== key);
          data.mine.push({ ...f, stage: "toVenue", stageAt: at, address: f.street, lines: [], payAtDoor: { cash: true, card: false, qr: false }, local: true });
        }
        return;
      }
      case "release":
        if (mine) data.mine = data.mine.filter((m) => m.key !== key);
        return;
      case "pickup": if (mine && mine.stage === "toVenue") Object.assign(mine, { stage: "onWay", stageAt: at }); return;
      case "arrive": if (mine && mine.stage === "onWay") Object.assign(mine, { stage: "arrived", stageAt: at }); return;
      case "retry": if (mine && mine.stage === "failed") Object.assign(mine, { stage: "arrived", stageAt: at, fail: null }); return;
      case "fail": if (mine) Object.assign(mine, { stage: "failed", stageAt: at, fail: { reason: q.args.reason, label: (FAIL.find((f) => f[0] === q.args.reason) || [])[1], note: q.args.note || "" } }); return;
      case "deliver":
      case "returned":
        data.mine = data.mine.filter((m) => m.key !== key);
        return;
      default:
    }
  }

  async function flush() {
    if (S.flushing || !S.queue.length || !S.token) return;
    if (Date.now() < S.retryAt) return;
    S.flushing = true;
    let changed = false;
    try {
      while (S.queue.length) {
        const q = S.queue[0];
        try {
          await api("act", { op: q.op, t: q.t, s: q.s, ...q.args });
          S.queue.shift();
          changed = true;
          // Заказ ушёл от курьера его же нажатием — не «сняли».
          if (["deliver", "returned", "release"].includes(q.op)) S.gone.add(`${q.t}__${q.s}`);
          if (q.op === "deliver") { toast("Заказ вручён ✓", "ok"); S.histAt = 0; }
        } catch (e) {
          if (e.status === 401 || (e.status === 403 && /Доступ закрыт/.test(e.message))) { S.queue = []; save(KEY.queue, S.queue); return signedOut(e.message); }
          if (e.network) {
            setOnline(false);
            S.retryAt = Date.now() + 5000;
            setTimeout(flush, 5200);
            break;
          }
          // Сервер не согласен (заказ уже у другого, отменён…) — шаг снимаем и показываем почему.
          S.queue.shift();
          changed = true;
          toast(e.message, "bad");
          buzz([60, 60, 60]);
        }
        save(KEY.queue, S.queue);
      }
    } finally {
      S.flushing = false;
      save(KEY.queue, S.queue);
    }
    if (changed) { S.v = ""; await refresh(true); }
  }

  // ---------------------------------------------------------------- геолокация

  function startShiftServices() {
    startGeo();
    requestWake();
  }

  function startGeo() {
    if (S.geo.watch !== null || !("geolocation" in navigator)) return;
    S.geo.watch = navigator.geolocation.watchPosition(onPos, (err) => {
      S.geo.error = err && err.code ? err.code : 2;
      render();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  function stopGeo() {
    if (S.geo.watch !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(S.geo.watch);
    S.geo.watch = null;
  }

  function onPos(p) {
    const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 9999), at: Date.now() };
    const hadError = S.geo.error;
    const first = !S.geo.fix;
    S.geo.error = 0;
    S.geo.fix = fix;
    const last = S.geo.lastBuffered;
    // В память — каждые 15 с или при сдвиге на 25 м: путь считается точно, лишнего не шлём.
    if (!last || fix.at - last.at > 15000 || dist(last, fix) > 25) {
      S.pings.push(fix);
      if (S.pings.length > 600) S.pings = S.pings.slice(-600);
      S.geo.lastBuffered = fix;
    }
    if (hadError || first) render();
    else updateMap();
    if (S.pings.length === 1 || S.pings.length >= 30) flushPings();
  }

  function dist(a, b) {
    const R = 6371000;
    const r = (x) => (x * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const here = () => S.geo.fix || (S.data && S.data.me.pos) || null;
  /** Путь по дороге от a до b (м) и время в пути (мин) — для выбранного транспорта. */
  function leg(a, b) {
    if (!a || !b) return null;
    const m = Math.round(dist(a, b) * ROAD_FACTOR);
    return { m, min: Math.max(1, Math.round(m / TRANSPORT[S.transport].mPerMin)) };
  }

  let pingBusy = false;
  async function flushPings() {
    if (pingBusy || !S.pings.length || !S.token || !(S.data && S.data.me.onShift)) return;
    pingBusy = true;
    const batch = S.pings.slice(0, 300);
    try {
      await api("ping", { points: batch });
      S.pings = S.pings.slice(batch.length);
    } catch (e) {
      if (e.status === 401) signedOut(e.message);
      else if (e.network) setOnline(false);
      else S.pings = S.pings.slice(batch.length); // данные не приняли — не копим
    } finally {
      pingBusy = false;
      save(KEY.pings, S.pings.slice(-600));
    }
  }

  // ---------------------------------------------------------------- экран не гаснет

  async function requestWake() {
    if (S.wake || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      S.wake = await navigator.wakeLock.request("screen");
      S.wake.addEventListener("release", () => { S.wake = null; });
    } catch (_) { S.wake = null; }
  }
  function releaseWake() { if (S.wake) S.wake.release().catch(() => {}); S.wake = null; }

  // ---------------------------------------------------------------- сигналы

  function unlockAudio() {
    if (S.audio || !(window.AudioContext || window.webkitAudioContext)) return;
    try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { S.audio = null; }
  }
  function beep() {
    if (!S.sound || !S.audio) return;
    try {
      if (S.audio.state === "suspended") S.audio.resume();
      const t0 = S.audio.currentTime;
      [[880, 0], [1320, 0.18], [880, 0.36]].forEach(([f, dt]) => {
        const o = S.audio.createOscillator();
        const g = S.audio.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
        o.connect(g).connect(S.audio.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.17);
      });
    } catch (_) { /* звук не главное */ }
  }
  const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) { /* нет вибро */ } };
  function alertNew(text, important = false) {
    beep();
    buzz(important ? [250, 120, 250, 120, 250] : [200, 100, 200]);
    toast(text, "ok");
    if (document.visibilityState !== "visible" && S.reg && "Notification" in window && Notification.permission === "granted") {
      S.reg.showNotification("Курьер ZalPOS", { body: text, icon: "icon-192.png", badge: "icon-192.png", tag: "zc-order", renotify: true, vibrate: [200, 100, 200] }).catch(() => {});
    }
  }

  let toastTimer = null;
  function toast(text, kind = "") {
    $toast.textContent = text;
    $toast.className = kind;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, kind === "bad" ? 6000 : 3500);
  }

  // ---------------------------------------------------------------- ссылки на навигаторы

  const coordText = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  /** Ссылка «вести туда» в выбранный навигатор: по точке, если она есть, иначе по адресу. */
  function navHref(pos, address) {
    const tr = TRANSPORT[S.transport];
    if (S.nav === "yandexnavi") {
      return pos ? `yandexnavi://build_route_on_map?lat_to=${pos.lat}&lon_to=${pos.lng}` : `yandexnavi://map_search?text=${encodeURIComponent(address || "")}`;
    }
    if (S.nav === "dgis") {
      return pos ? `https://2gis.ru/routeSearch/rsType/${tr.dgis}/to/${pos.lng},${pos.lat}` : `https://2gis.ru/search/${encodeURIComponent(address || "")}`;
    }
    return `https://yandex.ru/maps/?rtext=~${pos ? coordText(pos) : encodeURIComponent(address || "")}&rtt=${tr.rtt}`;
  }
  /** Один маршрут по всем заказам: заведения, где ещё забрать, потом гости — по порядку. */
  function routeAllHref() {
    const stops = [];
    const add = (pos, a) => { const v = pos ? coordText(pos) : a ? encodeURIComponent(a) : ""; if (v && !stops.includes(v)) stops.push(v); };
    const list = sortedMine().filter((o) => !o.cancelled);
    for (const o of list) if (o.stage === "toVenue") add(o.point.pos, o.point.address || o.point.name);
    for (const o of list) add(o.dest, o.address || o.street);
    const from = here();
    return `https://yandex.ru/maps/?rtext=${from ? coordText(from) : ""}~${stops.slice(0, 9).join("~")}&rtt=${TRANSPORT[S.transport].rtt}`;
  }

  // ---------------------------------------------------------------- карта

  function sortedMine() {
    const idx = (k) => { const i = S.order.indexOf(k); return i < 0 ? 1e9 : i; };
    return S.data.mine.slice().sort((a, b) => idx(a.key) - idx(b.key) || a.stageAt - b.stageAt);
  }
  function activeOrder() {
    const list = sortedMine();
    return list.find((o) => o.key === S.focus) || list[0] || null;
  }
  function listMode() {
    const d = S.data;
    if (S.list === "mine" || S.list === "free") return S.list;
    return d.mine.length ? "mine" : "free";
  }
  /** Куда сейчас едет курьер по активному заказу. */
  function targetOf(o) {
    if (o.stage === "toVenue" && !o.cancelled) return { pos: o.point.pos, address: o.point.address || o.point.name, venue: true };
    if (o.cancelled) return { pos: o.point.pos, address: o.point.address || o.point.name, venue: true };
    return { pos: o.dest, address: o.address || o.street, venue: false };
  }

  /** Что показать на карте: маршрут активного заказа или все точки. */
  function mapSpec() {
    const d = S.data;
    const me = here();
    const tr = TRANSPORT[S.transport];
    const base = "https://yandex.ru/map-widget/v1/?lang=ru_RU&l=map,trf&";
    const marks = [];
    const mode = listMode();
    const a = mode === "mine" ? activeOrder() : null;
    if (a) {
      const t = targetOf(a);
      const to = t.pos ? coordText(t.pos) : t.address;
      if (to) {
        const pts = [me ? coordText(me) : "", to];
        // Ещё не забрал, и точка гостя известна — маршрут сразу до гостя через заведение.
        if (t.venue && !a.cancelled && a.dest) pts.push(coordText(a.dest));
        const enc = (v) => (/^-?\d+\.\d+,-?\d+\.\d+$/.test(v) ? v : encodeURIComponent(v));
        if (me) marks.push({ p: me, k: "me", t: "Вы" });
        if (a.point.pos) marks.push({ p: a.point.pos, k: "venue", t: a.point.name });
        if (a.dest) marks.push({ p: a.dest, k: "guest", t: `№${a.no}` });
        return {
          key: `r:${a.key}:${a.stage}:${S.transport}`,
          url: `${base}mode=routes&rtt=${tr.rtt}&ruri=${"~".repeat(pts.length - 1)}&rtext=${pts.map(enc).join("~")}`,
          from: me, marks, note: t.pos ? "" : "Точки на схеме нет: маршрут — по адресу",
        };
      }
    }
    // Обзор: где вы, заведения и свободные заказы.
    const pt = [];
    if (me) { pt.push(`${me.lng},${me.lat},pm2rdl`); marks.push({ p: me, k: "me", t: "Вы" }); }
    for (const p of d.me.points || []) if (p.pos) { pt.push(`${p.pos.lng},${p.pos.lat},pm2gnl`); marks.push({ p: p.pos, k: "venue", t: p.name }); }
    const orders = mode === "mine" ? d.mine : d.free;
    orders.slice(0, 20).forEach((f, i) => { if (f.dest) { pt.push(`${f.dest.lng},${f.dest.lat},pm2blm${Math.min(99, i + 1)}`); marks.push({ p: f.dest, k: "guest", t: `№${f.no}` }); } });
    const c = me || ((d.me.points || []).find((p) => p.pos) || {}).pos || (orders.find((f) => f.dest) || {}).dest;
    if (!c) return { key: "none", url: "", marks, note: "Включите геолокацию — карта покажет, где вы" };
    return { key: `o:${mode}:${pt.length}:${orders.map((f) => f.key).join(",")}`, url: `${base}ll=${c.lng},${c.lat}&z=12${pt.length ? `&pt=${pt.join("~")}` : ""}`, from: me, marks, note: "" };
  }

  /** Схема без интернета карт: точки и прямые с расстояниями. */
  function schemaSvg(marks, W, H) {
    if (!marks.length || W < 50 || H < 50) return "";
    const lats = marks.map((m) => m.p.lat);
    const lngs = marks.map((m) => m.p.lng);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const k = Math.cos((cLat * Math.PI) / 180);
    const xs = lngs.map((v) => v * k);
    const spanX = Math.max(...xs) - Math.min(...xs) || 0.01;
    const spanY = Math.max(...lats) - Math.min(...lats) || 0.01;
    // Поля: сверху — кнопки над картой, сбоку — подписи точек.
    const padT = 120;
    const padB = 40;
    const padX = 70;
    const scale = Math.min((W - padX * 2 - 90) / spanX, (H - padT - padB) / spanY);
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...lats) + Math.min(...lats)) / 2;
    const P = (p) => [W / 2 - 45 + (p.lng * k - midX) * scale, padT + (H - padT - padB) / 2 - (p.lat - midY) * scale];
    let lines = "";
    const me = marks.find((m) => m.k === "me");
    const venue = marks.find((m) => m.k === "venue");
    const chain = [me, venue, ...marks.filter((m) => m.k === "guest").slice(0, 1)].filter(Boolean);
    for (let i = 1; i < chain.length; i++) {
      const [x1, y1] = P(chain[i - 1].p);
      const [x2, y2] = P(chain[i].p);
      lines += `<line class="road" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      const m = Math.round(dist(chain[i - 1].p, chain[i].p) * ROAD_FACTOR);
      lines += `<text class="lbl" x="${(x1 + x2) / 2 + 10}" y="${(y1 + y2) / 2 - 8}">${kmText(m)}</text>`;
    }
    const dots = marks.map((m) => {
      const [x, y] = P(m.p);
      const fill = m.k === "me" ? "var(--blue)" : m.k === "venue" ? "var(--brand)" : "var(--ink)";
      return `<circle cx="${x}" cy="${y}" r="${m.k === "me" ? 11 : 9}" fill="${fill}" stroke="var(--card)" stroke-width="4"/><text class="lbl" x="${x + 15}" y="${y + 5}">${esc(String(m.t).slice(0, 22))}</text>`;
    }).join("");
    let grid = "";
    for (let x = 0; x <= W; x += 48) grid += `<line class="grid" x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
    for (let y = 0; y <= H; y += 48) grid += `<line class="grid" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${grid}${lines}${dots}</svg>`;
  }

  function updateMap(force = false) {
    if (!S.data || S.view !== "orders") return;
    const frame = $("mapframe");
    const schema = $("schema");
    const noteEl = $("mapnote");
    if (!frame || !schema) return;
    fitMap();
    const spec = mapSpec();
    const box = $("map");
    schema.innerHTML = schemaSvg(spec.marks, box.clientWidth, box.clientHeight);
    const showNote = !S.online ? "Нет связи — показываем схему" : spec.note;
    noteEl.hidden = !showNote;
    noteEl.textContent = showNote || "";
    if (!S.online || !spec.url) { frame.hidden = true; return; }
    frame.hidden = false;
    const m = S.map;
    if (!force && spec.key === m.key) {
      // Тот же маршрут: перестраиваем, только если курьер заметно сдвинулся.
      const moved = spec.from && m.from ? dist(spec.from, m.from) : spec.from && !m.from ? 1e9 : 0;
      if (moved < 350 || Date.now() - m.at < 45000) return;
    }
    if (spec.url === m.url && !force) return;
    S.map = { url: spec.url, key: spec.key, at: Date.now(), from: spec.from };
    frame.classList.remove("ready");
    frame.src = spec.url;
  }

  /** Карта занимает видимую часть экрана над шторкой: маршрут целиком на виду. */
  function fitMap() {
    const map = $("map");
    const sheet = $("sheet");
    if (!map || !sheet) return;
    if (S.view !== "orders" || sheet.hidden) { map.style.bottom = "0px"; return; }
    const navH = $("bnav") ? $("bnav").getBoundingClientRect().height : 62;
    const sh = sheet.getBoundingClientRect().height;
    map.style.bottom = `${Math.max(0, Math.round(sh + navH - 22))}px`;
  }

  // ---------------------------------------------------------------- отрисовка

  function render() {
    if (!S.token) return renderSignedOut();
    if (!S.data) {
      $app.innerHTML = `<div class="boot"><div class="spinner" aria-hidden="true"></div><p>Загружаем заказы…</p>${S.online ? "" : "<p class=\"small\">Нет связи — ждём сеть</p>"}</div>`;
      return;
    }
    if (!S.data.me.consent) return renderConsent();
    ensureShell();
    $("hud").innerHTML = hudHtml();
    renderSheet();
    const page = $("page");
    const sheet = $("sheet");
    if (S.view === "orders") {
      page.hidden = true;
      sheet.hidden = false;
      $("hud").hidden = false;
    } else {
      sheet.hidden = true;
      $("hud").hidden = true;
      page.hidden = false;
      const top = page.scrollTop;
      page.innerHTML = S.view === "income" ? incomeHtml() : profileHtml();
      page.scrollTop = top;
    }
    $("bnav").innerHTML = navHtml();
    updateMap();
    updateLive();
  }

  function ensureShell() {
    if ($("shell")) return;
    $app.innerHTML = `
      <div id="shell">
        <div class="map" id="map">
          <div class="schema" id="schema"></div>
          <iframe id="mapframe" title="Карта с маршрутом" referrerpolicy="strict-origin-when-cross-origin" allow="geolocation" hidden></iframe>
          <div class="schema-note" id="mapnote" hidden></div>
        </div>
        <div id="hud"></div>
        <section class="sheet" id="sheet" data-h="${esc(S.sheet)}" aria-label="Заказы">
          <div class="grab" id="grab" role="button" tabindex="0" aria-label="Развернуть или свернуть список"><i></i></div>
          <div class="sheet-head" id="sheethead"></div>
          <div class="sheet-body" id="sheetbody"></div>
        </section>
        <div class="page" id="page" hidden></div>
        <nav class="bnav" id="bnav" aria-label="Разделы"></nav>
      </div>`;
    $("mapframe").addEventListener("load", (e) => e.target.classList.add("ready"));
    bindSheetDrag();
    S.map = { url: "", key: "", at: 0, from: null };
  }

  function hudHtml() {
    const d = S.data;
    const me = d.me;
    const r = me.rates || {};
    const paid = (r.ratePerTrip || 0) + (r.ratePerKm || 0) > 0;
    const st = d.stats;
    const net = !S.online
      ? `<div class="netbar bad">${I.warn("s")}Нет связи${S.queue.length ? ` · ждут ${S.queue.length}` : ""}</div>`
      : S.queue.length ? `<div class="netbar">${I.refresh("s")}Отправляем ${S.queue.length}…</div>`
        : me.onShift && S.geo.error === 1 ? `<div class="netbar bad">${I.locate("s")}Нет доступа к геолокации</div>` : "";
    return `
      <div class="hud">
        <button class="pill ${me.onShift ? "on" : ""}" data-a="shift" aria-label="${me.onShift ? "Вы на линии. Закончить смену" : "Выйти на линию"}"><span class="dot"></span>${me.onShift ? "На линии" : "Не на линии"}</button>
        <button class="pill earn" data-a="view" data-view="income" aria-label="Доход за сегодня">
          <small>${paid ? "Сегодня" : "Доставок сегодня"}</small><b>${paid ? rub(st.earned) : st.trips}</b>
        </button>
      </div>
      ${net}
      <div class="hud-col">
        <button class="round" data-a="map-refresh" aria-label="Обновить карту и маршрут">${I.refresh()}</button>
      </div>`;
  }

  function navHtml() {
    const fresh = S.data.me.onShift ? S.data.free.length : 0;
    const tab = (id, label, icon, badge = 0) => `<button data-a="view" data-view="${id}" ${S.view === id ? 'aria-current="page"' : ""}>${icon()}${label}${badge ? `<span class="badge hot">${badge}</span>` : ""}</button>`;
    return tab("orders", "Заказы", I.box, fresh) + tab("income", "Доход", I.wallet) + tab("profile", "Профиль", I.user);
  }

  function renderSheet() {
    const d = S.data;
    const mode = listMode();
    const mine = sortedMine();
    $("sheet").dataset.h = S.sheet;
    $("sheethead").innerHTML = `
      <div class="seg2" role="group" aria-label="Список заказов">
        <button data-a="list" data-list="mine" aria-pressed="${mode === "mine"}">Мои <span class="badge${mine.length ? " hot" : ""}">${mine.length}</span></button>
        <button data-a="list" data-list="free" aria-pressed="${mode === "free"}">Свободные <span class="badge${d.me.onShift && d.free.length ? " hot" : ""}">${d.free.length}</span></button>
      </div>`;
    const body = $("sheetbody");
    // Новый шаг заказа или другой список — карточку с начала: главное сверху.
    const a = mode === "mine" ? activeOrder() : null;
    const view = `${mode}:${a ? `${a.key}:${a.stage}` : ""}`;
    const keep = body.dataset.view === view ? body.scrollTop : 0;
    body.dataset.view = view;
    body.innerHTML = (mode === "mine" ? mineHtml(mine) : freeHtml()) + installCard();
    body.scrollTop = keep;
  }

  function installCard() {
    if (!S.install || load(KEY.installSkip, 0) > Date.now()) return "";
    return `<div class="box" style="display:flex;gap:12px;align-items:center;margin-top:14px">${I.download()}
      <span class="grow small"><b>Приложение на экран телефона</b><br><span class="muted">Открывается в одно касание, как обычное</span></span>
      <button class="btn go" style="min-height:44px" data-a="install">Установить</button></div>`;
  }

  // -------- свободные заказы

  function offShiftCard() {
    return `<div class="online-card">
      <div class="row">${I.flag("l")}<b style="font-size:18px">Вы не на линии</b></div>
      <p>Выйдите на линию, чтобы брать заказы: придут со звуком и вибрацией, заведение и гость увидят вас на карте.</p>
      <button class="btn huge wide" data-a="shift">Выйти на линию</button>
    </div>`;
  }

  function freeHtml() {
    const d = S.data;
    const top = d.me.onShift ? "" : offShiftCard();
    if (!d.free.length) {
      return `${top}<div class="empty"><div class="art">${I.box("l")}</div><b>Свободных заказов нет</b>
        <p class="small">Новые появятся здесь со звуком и вибрацией${d.me.onShift ? "" : " — когда вы на линии"}.${d.mine.length ? "" : " Карта покажет их на карте."}</p></div>`;
    }
    const me = here();
    const list = d.free.slice().sort((a, b) => (b.returned - a.returned) || ((a.point.pos && me ? dist(me, a.point.pos) : 1e9) - (b.point.pos && me ? dist(me, b.point.pos) : 1e9)) || (b.ageMin - a.ageMin));
    return top + list.map((f) => offerHtml(f)).join("");
  }

  function offerHtml(f) {
    const d = S.data;
    const me = here();
    const toVenue = leg(me, f.point.pos);
    const total = f.tripM != null ? f.tripM + (toVenue ? toVenue.m : 0) : null;
    const minutes = total != null ? Math.max(1, Math.round(total / TRANSPORT[S.transport].mPerMin)) : null;
    const pay = f.payout != null
      ? `<div class="offer-pay">${f.payoutExact ? "" : "<small>от </small>"}${rub(f.payout)}</div>`
      : `<div class="offer-pay" style="color:var(--text);font-size:22px">№${esc(f.no)}</div>`;
    const right = total != null
      ? `<div class="offer-dist">${kmText(total)}<span>~${minText(minutes)} весь путь</span></div>`
      : toVenue ? `<div class="offer-dist">${kmText(toVenue.m)}<span>до заведения</span></div>` : "";
    const money = f.toCollect > 0 ? `<span class="chip amber">${I.cash("s")}Взять ${rub(f.toCollect)}</span>` : `<span class="chip green">${I.check("s")}Оплачен</span>`;
    return `
      <article class="offer${S.newFree.has(f.key) ? " new" : ""}">
        <div class="offer-top">${pay}${right}</div>
        <div class="route">
          <div class="stop"><b>${esc(f.point.name)}</b><span>${f.ready ? "Заказ готов — можно забирать" : `${esc(f.status)} · ждёт <span data-ago="${Date.now() - f.ageMin * 60000}">${minText(f.ageMin)}</span>`}</span></div>
          <div class="stop to"><b>${esc(f.street || "Адрес — после «Беру»")}</b><span>${f.tripM != null ? `${kmText(f.tripM)} от заведения` : "квартира и телефон — после «Беру»"}${f.zone ? ` · ${esc(f.zone)}` : ""}</span></div>
        </div>
        <div class="chips">
          ${f.returned ? `<span class="chip violet">Вернули в заведение</span>` : ""}
          ${money}
          <span class="chip">${f.items} ${plural(f.items, "позиция", "позиции", "позиций")}</span>
          ${f.promisedAt ? `<span class="chip ${f.promisedAt < Date.now() ? "red" : ""}">${I.clock("s")}к ${hhmm(f.promisedAt)}</span>` : ""}
          ${f.payout != null ? `<span class="chip">№${esc(f.no)}</span>` : ""}
        </div>
        <button class="btn go huge wide" style="margin-top:12px" data-a="take" data-key="${esc(f.key)}" ${d.me.onShift ? "" : "disabled"}>${d.me.onShift ? "Беру заказ" : "Выйдите на линию, чтобы взять"}</button>
      </article>`;
  }

  // -------- мои заказы

  function mineHtml(list) {
    const d = S.data;
    if (!list.length) {
      return `${d.me.onShift ? "" : offShiftCard()}<div class="empty"><div class="art">${I.route("l")}</div><b>У вас нет заказов</b>
        <p class="small">Возьмите заказ в «Свободных» — или заведение назначит его вам.</p>
        ${d.free.length ? `<button class="btn go wide" data-a="list" data-list="free">Свободные заказы · ${d.free.length}</button>` : ""}</div>`;
    }
    const a = activeOrder();
    const others = list.filter((o) => o.key !== a.key);
    return activeHtml(a) + (others.length ? `
      <div class="sec">Ещё ${others.length} ${plural(others.length, "заказ", "заказа", "заказов")}</div>
      <div class="others">${others.map((o) => {
        const st = o.cancelled ? { label: "Отменён" } : STAGE[o.stage] || STAGE.toVenue;
        return `<button class="other" data-a="focus" data-key="${esc(o.key)}"><span class="n">№${esc(o.no)}</span><span class="grow small">${esc(st.label)} · ${esc(o.stage === "toVenue" ? o.point.name : o.street || o.address)}</span>${o.toCollect > 0 ? `<b class="nowrap">${rub(o.toCollect)}</b>` : ""}</button>`;
      }).join("")}</div>
      <a class="btn line wide" style="margin-top:10px" href="${esc(routeAllHref())}" target="_blank" rel="noopener">${I.route()}Маршрут по всем в Яндекс Картах</a>` : "");
  }

  function activeHtml(o) {
    const st = o.cancelled ? { chip: "red", label: "Отменён заведением", step: 2 } : STAGE[o.stage] || STAGE.toVenue;
    const t = targetOf(o);
    const me = here();
    const l = leg(me, t.pos);
    const steps = [0, 1, 2].map((i) => `<div class="${i < st.step ? "done" : i === st.step ? "now" : ""}"></div>`).join("");
    const kicker = t.venue
      ? `${I.store("s")}${o.cancelled ? "Вернуть в заведение" : "Забрать"} · ${esc(o.point.name)}`
      : `${I.pin("s")}${o.stage === "arrived" ? "У двери" : "Гостю"}${o.guestName ? ` · ${esc(o.guestName)}` : ""}`;
    const meta = [];
    if (l) meta.push(`<span><b>${kmText(l.m)}</b> · ~${minText(l.min)}</span>`);
    if (t.venue && !o.cancelled) meta.push(o.ready ? `<span style="color:var(--brand)">✓ Заказ готов</span>` : `<span>⏳ ${esc(o.status || "Готовится")}</span>`);
    if (!t.venue && o.promisedAt) meta.push(`<span${o.promisedAt < Date.now() ? ' style="color:var(--red)"' : ""}>обещали к <b>${hhmm(o.promisedAt)}</b></span>`);
    meta.push(`<span>${esc(st.label)} <span class="timer" data-since="${o.stageAt}">00:00</span></span>`);
    const phone = !t.venue && o.phone;
    const call = phone
      ? `<a href="${esc(phoneHref(o.phone))}" data-a="link">${I.phone()}Позвонить</a>`
      : `<button disabled aria-disabled="true">${I.phone()}${t.venue ? "Гостю — потом" : "Нет телефона"}</button>`;
    const quick = `<div class="quick">
        ${call}
        <a href="${esc(navHref(t.pos, t.address))}" target="_blank" rel="noopener" data-a="link">${I.nav()}${esc(NAVS[S.nav].label.replace("Яндекс ", ""))}</a>
        <button data-a="copy" data-key="${esc(o.key)}">${I.copy()}Адрес</button>
        <button data-a="more" data-key="${esc(o.key)}">${I.more()}Ещё</button>
      </div>`;
    let main = "";
    let minor = "";
    if (o.cancelled) {
      main = o.stage === "toVenue" ? "" : `<button class="btn amber huge wide" data-a="returned" data-key="${esc(o.key)}">↩ Вернул заказ в заведение</button>`;
    } else if (o.stage === "toVenue") {
      main = `<button class="btn blue huge wide" data-a="pickup" data-key="${esc(o.key)}">${I.box()}Забрал заказ</button>`;
    } else if (o.stage === "onWay") {
      main = `<button class="btn go huge wide" data-a="arrive" data-key="${esc(o.key)}">${I.pin()}Я на месте</button>`;
      minor = `<button class="btn link" data-a="deliver" data-key="${esc(o.key)}">Уже вручил</button>`;
    } else if (o.stage === "arrived") {
      main = `<button class="btn go huge wide" data-a="deliver" data-key="${esc(o.key)}">${I.check()}Вручил${o.toCollect > 0 ? ` <span class="sum">· ${rub(o.toCollect)}</span>` : ""}</button>`;
      minor = `<span class="small muted">У двери <span class="timer" data-since="${o.stageAt}">00:00</span></span><button class="btn danger" data-a="fail" data-key="${esc(o.key)}">Не удалось вручить</button>`;
    } else if (o.stage === "failed") {
      main = `<button class="btn go huge wide" data-a="retry" data-key="${esc(o.key)}">Попробовать ещё раз</button><button class="btn amber wide" data-a="returned" data-key="${esc(o.key)}">↩ Вернул в заведение</button>`;
    }
    const money = o.toCollect > 0
      ? `<div class="box cash">${I.cash("l")}<span class="grow"><span class="small muted">Взять с гостя</span><br><b>${rub(o.toCollect)}</b></span><span class="small muted" style="text-align:right">${payWays(o)}</span></div>`
      : `<div class="box ok cash">${I.check("l")}<span class="grow">Оплачено — деньги не брать<br><span class="small" style="opacity:.8">${rub(o.total)}</span></span></div>`;
    const showAddr = !t.venue || o.cancelled ? "" : `<div class="small muted" style="margin-top:6px">Дальше: ${esc(o.address || o.street || "адрес гостя")}</div>`;
    return `
      <div class="steps" aria-hidden="true">${steps}</div>
      <div class="kicker">${kicker}<span class="grow"></span><span>№${esc(o.no)}</span></div>
      <div class="dest">${esc(t.address || "Адрес уточняется — позвоните в заведение")}</div>
      <div class="meta">${meta.join("")}</div>
      ${showAddr}
      ${o.fail ? `<div class="box bad">${I.warn("s")} ${esc(o.fail.label || "")}${o.fail.note ? ` — ${esc(o.fail.note)}` : ""}</div>` : ""}
      ${o.comment && !t.venue ? `<div class="box note">💬 ${esc(o.comment)}</div>` : ""}
      ${o.local ? `<div class="chips"><span class="chip">${I.refresh("s")}сохраняем…</span></div>` : ""}
      ${quick}
      ${money}
      ${o.payout != null ? `<div class="earnline"><span>Ваш заработок за заказ</span><b>${o.payoutExact ? "≈ " : "от "}${rub(o.payout)}</b></div>` : ""}
      ${o.lines && o.lines.length ? `<details class="items"><summary>${I.list("s")}Состав: ${o.items} ${plural(o.items, "позиция", "позиции", "позиций")} ▾</summary><ul>${o.lines.map((x) => `<li>${esc(x.name)}${x.mods && x.mods.length ? ` <span class="muted">(${esc(x.mods.join(", "))})</span>` : ""} × ${x.qty}</li>`).join("")}</ul></details>` : ""}
      <div class="main-act">${main}${minor ? `<div class="minor">${minor}</div>` : ""}</div>`;
  }

  function payWays(o) {
    const p = o.payAtDoor || {};
    return [p.cash && "наличные", p.card && "карта", p.qr && "QR"].filter(Boolean).join(" · ") || "оплата у двери не включена";
  }

  // -------- доход

  function incomeHtml() {
    const d = S.data;
    const h = S.hist;
    const r = d.me.rates || {};
    const paid = (r.ratePerTrip || 0) + (r.ratePerKm || 0) > 0;
    const st = d.stats;
    const shiftMin = d.me.onShift && d.me.shiftStartedAt ? Math.floor((Date.now() - d.me.shiftStartedAt) / 60000) : 0;
    const sel = h ? h.days.find((x) => x.day === (S.histDay || h.today)) || h.days[h.days.length - 1] : null;
    const isToday = !h || !S.histDay || S.histDay === h.today;
    const hero = `
      <div class="hero">
        <small>${isToday ? "Сегодня" : dayLabel(sel.day)}${paid ? "" : " · доставок"}</small>
        <div class="big">${paid ? rub(isToday ? st.earned : sel.earned) : (isToday ? st.trips : sel.trips)}</div>
        <div class="stats3">
          <div><b>${isToday ? st.trips : sel.trips}</b><span>${plural(isToday ? st.trips : sel.trips, "доставка", "доставки", "доставок")}</span></div>
          <div><b>${(isToday ? st.km : sel.km).toFixed(1).replace(".", ",")}</b><span>км с заказами</span></div>
          <div><b>${isToday ? (d.me.onShift ? minText(shiftMin) : st.avgMin ? minText(st.avgMin) : "—") : "—"}</b><span>${isToday && d.me.onShift ? "на линии" : "в среднем в пути"}</span></div>
        </div>
      </div>`;
    let week = "";
    if (h) {
      const max = Math.max(1, ...h.days.map((x) => (paid ? x.earned : x.trips)));
      week = `<div class="sec">Неделя</div><div class="card"><div class="week">${h.days.map((x) => {
        const v = paid ? x.earned : x.trips;
        const hgt = Math.max(4, Math.round((v / max) * 100));
        return `<button data-a="hday" data-day="${x.day}" aria-pressed="${(S.histDay || h.today) === x.day}" aria-label="${dayLabel(x.day)}: ${paid ? rub(v) : v}">
          <span class="v">${v ? (paid ? Math.round(v) : v) : ""}</span><span class="bar" style="height:${hgt}%"></span><span>${x.day === h.today ? "сег" : WEEKDAY[new Date(`${x.day}T12:00:00`).getDay()]}</span></button>`;
      }).join("")}</div></div>`;
    }
    const trips = !h ? `<div class="card muted small">Загружаем историю…</div>`
      : !h.trips.length ? `<div class="card muted small">${isToday ? "Сегодня доставок ещё не было." : "В этот день доставок не было."}</div>`
        : `<div class="list">${h.trips.map((x) => `
          <div class="trip"><span class="t">${x.at ? hhmm(x.at) : "—"}</span>
            <span class="grow"><b>№${esc(x.no)}</b> <span class="muted small">${esc(x.point)}${x.zone ? ` · ${esc(x.zone)}` : ""}</span><br>
            <span class="small muted">${x.result === "done" ? `${Number(x.km).toFixed(1).replace(".", ",")} км${x.pickedAt && x.doneAt ? ` · ${minText(Math.max(1, Math.round((x.doneAt - x.pickedAt) / 60000)))} в пути` : ""}${x.payment && x.payment.amount ? ` · ${rub(x.payment.amount)} ${METHOD[x.payment.method] || ""}` : ""}` : x.result === "cancelled" ? "отменён" : x.result === "returned" ? "возвращён в заведение" : x.result === "released" ? "отказался" : esc(x.result)}</span></span>
            ${x.result === "done" && paid ? `<span class="e">+${rub(x.earned)}</span>` : ""}</div>`).join("")}</div>`;
    const cashOn = d.me.cashOnHand;
    return `
      <h1>Доход</h1>
      ${hero}
      ${week}
      <div class="sec">${isToday ? "Доставки сегодня" : `Доставки · ${dayLabel(sel.day)}`}</div>
      ${trips}
      <div class="sec">Наличные</div>
      <div class="card cash">${I.cash("l")}<span class="grow"><b>${rub(cashOn)}</b><br><span class="small muted">${cashOn > 0 ? "на руках — сдайте в заведении, там отметят" : "на руках нет"}</span></span></div>
      <div class="sec">Как считается</div>
      <div class="card small">${paid ? `${r.ratePerTrip ? `<b>${rub(r.ratePerTrip)}</b> за доставку` : ""}${r.ratePerTrip && r.ratePerKm ? " + " : ""}${r.ratePerKm ? `<b>${rub(r.ratePerKm)}</b> за километр с заказом` : ""}. Километры — по геолокации от «Забрал» до «Вручил», но не меньше расстояния по карте.` : "Заведение не указало оплату за доставку в приложении — о ней договаривайтесь с заведением. Здесь — число доставок и километры."}</div>`;
  }
  function dayLabel(day) {
    const dt = new Date(`${day}T12:00:00`);
    return `${WEEKDAY[dt.getDay()]}, ${dt.getDate()}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
  }

  async function loadHistory(force = false) {
    if (!S.token || (!force && Date.now() - S.histAt < 60000)) return;
    S.histAt = Date.now();
    try {
      S.hist = await api("history", S.histDay ? { day: S.histDay } : {});
      if (S.view === "income") render();
    } catch (e) {
      if (e.status === 401) signedOut(e.message);
    }
  }

  // -------- профиль

  function profileHtml() {
    const d = S.data;
    const me = d.me;
    const first = String(me.name || "К").trim();
    const iosHint = /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone;
    const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    const sw = (on, a) => `<button class="switch" role="switch" aria-checked="${on}" data-a="${a}" aria-label="Переключить"></button>`;
    return `
      <h1>Профиль</h1>
      <div class="card me"><div class="avatar">${esc(first.slice(0, 1).toUpperCase())}</div>
        <div class="grow"><b style="font-size:19px">Курьер №${esc(me.no)} · ${esc(first.split(" ")[0])}</b><br>
        <span class="small muted">${me.onShift ? `На линии с ${hhmm(me.shiftStartedAt)}` : "Не на линии"}${me.demo ? " · демо" : ""}</span></div></div>

      <div class="sec">Как езжу</div>
      <div class="seg" role="group" aria-label="Транспорт">${Object.entries(TRANSPORT).map(([id, t]) => `<button data-a="transport" data-v="${id}" aria-pressed="${S.transport === id}">${t.label}</button>`).join("")}</div>
      <p class="small muted" style="margin:8px 4px 0">Маршрут на карте и время в пути — для этого транспорта.</p>

      <div class="sec">Навигатор</div>
      <div class="list">${Object.entries(NAVS).map(([id, n]) => `
        <button class="lrow" style="width:100%;text-align:left" data-a="nav" data-v="${id}">${I.nav()}<span class="grow"><b>${n.label}</b><br><span class="small muted">${n.note}</span></span>${S.nav === id ? `<span style="color:var(--brand)">${I.check()}</span>` : ""}</button>`).join("")}</div>

      <div class="sec">Сигналы</div>
      <div class="list">
        <div class="lrow">${I.sound()}<span class="grow">Звук нового заказа</span>${sw(S.sound, "sound")}</div>
        ${"Notification" in window ? `<div class="lrow">${I.bell()}<span class="grow">Уведомления, когда приложение свёрнуто</span>${Notification.permission === "granted" ? `<span class="chip green">Да</span>` : Notification.permission === "denied" ? `<span class="chip red">Запрещены</span>` : `<button class="btn go" style="min-height:40px" data-a="notify">Разрешить</button>`}</div>` : ""}
        <div class="lrow">${I.sun()}<span class="grow">Экран не гаснет на линии</span><span class="chip ${S.wake ? "green" : ""}">${S.wake ? "Да" : "wakeLock" in navigator ? "Включится на линии" : "Не поддерживается"}</span></div>
        ${standalone ? `<div class="lrow">${I.download()}<span class="grow">Приложение установлено</span><span class="chip green">Да</span></div>`
          : S.install ? `<div class="lrow">${I.download()}<span class="grow">Приложение на экран телефона</span><button class="btn go" style="min-height:40px" data-a="install">Установить</button></div>`
            : iosHint ? `<div class="lrow">${I.download()}<span class="grow small">На iPhone: «Поделиться» → «На экран „Домой“»</span></div>`
              : `<div class="lrow">${I.download()}<span class="grow small">Установить на Android: меню браузера ⋮ → «Добавить на главный экран»</span></div>`}
      </div>

      <div class="sec">Где работаю</div>
      <div class="list">${(me.points || []).map((p) => `<div class="lrow">${I.store()}<span class="grow"><b>${esc(p.name)}</b><br><span class="small muted">${esc(p.address || "")}</span></span></div>`).join("")}</div>

      <div class="sec">Данные</div>
      <div class="list">
        <div class="lrow">${I.shield()}<span class="grow small muted">Геолокация передаётся только на линии и хранится на сервере в России. Последняя точка стирается в конце смены, в заказе — после вручения.</span></div>
        <a class="lrow" href="https://yandex.ru/legal/maps_termsofuse/" target="_blank" rel="noopener">${I.nav()}<span class="grow small">Карты — © Яндекс, условия использования</span></a>
      </div>

      <div style="display:grid;gap:8px;margin-top:18px">
        ${me.onShift ? `<button class="btn line wide" data-a="shift-end">Закончить смену</button>` : `<button class="btn go wide" data-a="shift">Выйти на линию</button>`}
        <button class="btn link" data-a="refresh">${I.refresh("s")}Обновить данные</button>
        <button class="btn danger" data-a="logout">${I.logout("s")}Выйти из приложения</button>
      </div>`;
  }

  // -------- вход и согласие

  function renderSignedOut() {
    $app.innerHTML = `
      <div class="screen"><div class="inner">
        <img class="logo" src="icon-192.png" alt="">
        <h1>Курьер ZalPOS</h1>
        ${S.fatal ? `<div class="box bad">${esc(S.fatal)}</div>` : ""}
        <p>Войдите по <b>личной ссылке-приглашению</b> от заведения — пароль не нужен.</p>
        <div class="feat"><div class="ic">${I.route()}</div><div><b>Маршрут прямо на карте</b><span>от вас до заведения и гостя, с пробками; голосом — в навигаторе</span></div></div>
        <div class="feat"><div class="ic">${I.wallet()}</div><div><b>Доход виден сразу</b><span>за каждый заказ, за день и неделю; наличные на руках</span></div></div>
        <div class="feat"><div class="ic">${I.qr()}</div><div><b>Оплата у двери</b><span>наличные со сдачей, карта или QR через банк заведения</span></div></div>
        <p class="small muted">Ссылка одноразовая и действует 72 часа. Устарела — попросите новую: Кабинет → «Доставка» → «Курьеры».</p>
        <div class="sec" style="margin-top:26px">Попробовать демо</div>
        <p class="small muted" style="margin:0 4px">Код демо — на экране входа демо-кассы (тот же, что для приложения гостя).</p>
        <div class="field"><input id="demo-code" placeholder="demo-…" autocapitalize="none" autocomplete="off" spellcheck="false" inputmode="text" aria-label="Код демо" enterkeyhint="go"></div>
        <button class="btn ink huge wide" data-a="demo">Войти в демо</button>
      </div></div>`;
  }

  function renderConsent() {
    $app.innerHTML = `
      <div class="screen"><div class="inner">
        <img class="logo" src="icon-192.png" alt="">
        <h1>Геолокация во время смены</h1>
        <p>Чтобы заведение и гость видели, где заказ, приложение передаёт местоположение телефона — <b>только пока вы на линии</b>.</p>
        <div class="feat"><div class="ic">${I.user()}</div><div><b>Кто видит</b><span>заведение — пока вы на линии; гость — только свой заказ и только пока вы его везёте</span></div></div>
        <div class="feat"><div class="ic">${I.clock()}</div><div><b>Сколько хранится</b><span>последняя точка — до конца смены; в заказе — до вручения. В истории поездок — только километры, без координат</span></div></div>
        <div class="feat"><div class="ic">${I.shield()}</div><div><b>Где хранится</b><span>на сервере в России. Карту и маршрут рисует сервис «Яндекс Карты» (Россия) — ему уходят только координаты точек, без имени и телефона</span></div></div>
        <p class="small muted">Закончите смену — передача сразу остановится.</p>
        <button class="btn go huge wide" data-a="consent">Согласен, продолжить</button>
      </div></div>`;
  }

  /** Таймеры и «N мин назад» — без перерисовки всего экрана. */
  function updateLive() {
    const now = Date.now();
    document.querySelectorAll("[data-since]").forEach((el) => {
      const ms = now - Number(el.dataset.since);
      el.textContent = clock(ms);
      el.classList.toggle("long", ms > WAIT_HINT_MS);
    });
    document.querySelectorAll("[data-ago]").forEach((el) => {
      el.textContent = minText(Math.max(0, Math.round((now - Number(el.dataset.ago)) / 60000)));
    });
  }

  // ---------------------------------------------------------------- шторка тянется пальцем

  function bindSheetDrag() {
    const sheet = $("sheet");
    const grab = $("grab");
    const head = $("sheethead");
    let start = null;
    const order = ["mini", "peek", "full"];
    const setH = (h) => {
      S.sheet = h;
      save(KEY.sheet, h);
      sheet.dataset.h = h;
      sheet.style.height = "";
      // Карта подстраивается, когда шторка доехала.
      setTimeout(() => updateMap(), 320);
    };
    const down = (e) => {
      if (e.target.closest("button") && e.currentTarget === head) return;
      start = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false };
      sheet.classList.add("dragging");
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* старый браузер */ }
    };
    const move = (e) => {
      if (!start) return;
      const dy = start.y - e.clientY;
      if (Math.abs(dy) > 6) start.moved = true;
      sheet.style.height = `${Math.max(120, start.h + dy)}px`;
    };
    const up = (e) => {
      if (!start) return;
      sheet.classList.remove("dragging");
      const dy = start.y - e.clientY;
      const i = order.indexOf(S.sheet);
      // Касание без движения: свёрнута → наполовину → во весь экран → наполовину.
      if (!start.moved) setH(S.sheet === "peek" ? "full" : "peek");
      else if (dy > 60) setH(order[Math.min(2, i + (dy > 260 ? 2 : 1))]);
      else if (dy < -60) setH(order[Math.max(0, i - (dy < -260 ? 2 : 1))]);
      else setH(S.sheet);
      start = null;
    };
    for (const el of [grab, head]) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    }
    grab.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setH(S.sheet === "full" ? "peek" : "full"); } });
  }

  // ---------------------------------------------------------------- окна

  function openModal(m) {
    S.modal = m;
    drawModal();
  }
  function closeModal() {
    if (S.modal && S.modal.poll) clearTimeout(S.modal.poll);
    S.modal = null;
    $modal.hidden = true;
    $modal.innerHTML = "";
  }

  function drawModal() {
    const m = S.modal;
    if (!m) return closeModal();
    const o = S.data && S.data.mine.find((x) => x.key === m.key);
    let html = "";
    if (m.kind === "shift-end") {
      const busy = S.data && S.data.mine.length;
      html = `<h2>Закончить смену?</h2><p class="muted">${busy ? `<b>У вас ${busy} ${plural(busy, "заказ", "заказа", "заказов")}.</b> Сначала вручите или верните их. ` : ""}Заказы перестанут приходить, передача геолокации остановится.</p>
        <div class="actions"><button class="btn ink huge wide" data-m="shift-off">Закончить смену</button><button class="btn link" data-m="close">Остаться на линии</button></div>`;
    } else if (m.kind === "logout") {
      html = `<h2>Выйти из приложения?</h2><p class="muted">${S.queue.length ? "<b>Не все нажатия ушли на сервер.</b> " : ""}Чтобы войти снова, понадобится новая ссылка от заведения.</p>
        <div class="actions"><button class="btn danger huge wide" style="background:var(--red-soft)" data-m="logout">Выйти</button><button class="btn link" data-m="close">Отмена</button></div>`;
    } else if (!o) {
      return closeModal();
    } else if (m.kind === "more") {
      html = `<h2>Заказ №${esc(o.no)}</h2>
        ${o.guestName || o.phone ? `<p class="muted">${esc(o.guestName || "")}${o.phone ? ` · ${esc(phoneText(o.phone))}` : ""}</p>` : ""}
        <p class="small muted">${esc(o.address || o.street || "")}</p>
        <div class="actions">
          ${o.stage === "toVenue" ? `<button class="btn line wide" data-m="release">Отказаться от заказа</button>` : ""}
          ${["onWay", "arrived"].includes(o.stage) && !o.cancelled ? `<button class="btn line wide" style="color:var(--red)" data-m="fail-open">Не удалось вручить</button>` : ""}
          ${o.stage === "onWay" && !o.cancelled ? `<button class="btn line wide" data-m="deliver-open">Уже вручил</button>` : ""}
          <a class="btn line wide" href="${esc(navHref(targetOf(o).pos, targetOf(o).address))}" target="_blank" rel="noopener">${I.nav()}Открыть в навигаторе</a>
          <button class="btn link" data-m="close">Закрыть</button>
        </div>`;
    } else if (m.kind === "release") {
      html = `<h2>Отказаться от №${esc(o.no)}?</h2><p class="muted">Заказ снова станет свободным для других курьеров, заведение получит сигнал.</p>
        <div class="actions"><button class="btn ink huge wide" data-m="release-yes">Отказаться</button><button class="btn link" data-m="close">Оставить себе</button></div>`;
    } else if (m.kind === "fail") {
      html = `<h2>Не удалось вручить №${esc(o.no)}</h2><p class="muted small">Заведение сразу получит сигнал. Дальше: попробовать ещё раз или вернуть заказ.</p>
        <div class="reasons">${FAIL.map(([id, label]) => `<label><input type="radio" name="reason" value="${id}" ${m.reason === id ? "checked" : ""} data-m="reason"><span>${label}</span></label>`).join("")}</div>
        <div class="field"><label for="note">Комментарий${m.reason === "other" ? " (обязательно)" : ""}</label><textarea id="note" rows="2" maxlength="200" placeholder="Например: звонил дважды, домофон не работает">${esc(m.note || "")}</textarea></div>
        <div class="actions"><button class="btn amber huge wide" data-m="fail-send" ${m.reason ? "" : "disabled"}>Отметить «не удалось»</button><button class="btn link" data-m="close">Отмена</button></div>`;
    } else if (m.kind === "deliver") {
      html = deliverHtml(o, m);
    }
    // Окно открывается с анимацией один раз; дальше меняется только содержимое.
    let sheet = $modal.querySelector(".msheet");
    if (!sheet) {
      $modal.innerHTML = `<div class="msheet" role="dialog" aria-modal="true"></div>`;
      sheet = $modal.firstElementChild;
    }
    sheet.innerHTML = html;
    $modal.hidden = false;
    const input = $modal.querySelector("#received");
    if (input && m.focus) { input.focus(); input.select(); m.focus = false; }
  }

  function deliverHtml(o, m) {
    if (o.toCollect <= 0 || m.qrPaid) {
      return `<h2>Вручить заказ №${esc(o.no)}</h2>
        ${m.qrPaid ? `<div class="paid-ok">✓ Оплата по QR пришла</div>` : `<div class="box ok">Заказ оплачен. Денег не брать.</div>`}
        <div class="actions"><button class="btn go huge wide" data-m="deliver" data-method="${m.qrPaid ? "qr" : ""}">${I.check()}Вручил</button><button class="btn link" data-m="close">Отмена</button></div>`;
    }
    const pay = o.payAtDoor || {};
    const methods = [["cash", I.cash("s") + "Наличные", pay.cash], ["card", I.card("s") + "Карта", pay.card], ["qr", I.qr("s") + "QR", pay.qr]].filter((x) => x[2]);
    if (!m.method && methods.length === 1) m.method = methods[0][0];
    let body = "";
    if (m.method === "cash") {
      const due = o.toCollect;
      const received = m.received === undefined ? due : m.received;
      const change = Math.max(0, Math.round((received - due) * 100) / 100);
      const notes = [500, 1000, 2000, 5000].map((b) => Math.ceil(due / b) * b).filter((v, i, a) => v > due && a.indexOf(v) === i).slice(0, 3);
      body = `<div class="field"><label for="received">Сколько дал гость</label><input id="received" inputmode="decimal" autocomplete="off" value="${received}"></div>
        <div class="seg"><button data-m="received" data-v="${due}" aria-pressed="${received === due}">Без сдачи</button>${notes.map((v) => `<button data-m="received" data-v="${v}" aria-pressed="${received === v}">${rub(v)}</button>`).join("")}</div>
        <div class="change">${received < due ? `<span style="color:var(--red)">Не хватает ${rub(due - received)}</span>` : `Сдача: ${rub(change)}`}</div>
        <button class="btn go huge wide" data-m="deliver" data-method="cash" ${received < due ? "disabled" : ""}>${I.check()}Вручил, получил ${rub(received)}</button>`;
    } else if (m.method === "card") {
      body = `<p class="muted">Проведите оплату на терминале и дождитесь «Одобрено».</p>
        <button class="btn go huge wide" data-m="deliver" data-method="card">${I.check()}Оплата прошла, вручил</button>`;
    } else if (m.method === "qr") {
      if (!m.qr) body = `<p class="muted">${S.online ? "Готовим QR в банке заведения…" : "Для QR нужна связь — выберите другой способ или дождитесь сети."}</p>`;
      else body = `<div class="qr">${window.ZQR ? window.ZQR.svg(m.qr.url) : ""}</div>
        <p style="text-align:center" class="muted">Гость наводит камеру телефона и платит в своём банке${m.qr.bank ? ` · ${esc(m.qr.bank)}` : ""}.</p>
        <p style="text-align:center"><span class="spinner" style="display:inline-block;width:18px;height:18px;border-width:3px;vertical-align:-3px"></span> Ждём оплату…</p>`;
    }
    return `<h2>Вручить заказ №${esc(o.no)}</h2>
      <div class="due">${rub(o.toCollect)}</div>
      ${methods.length ? `<div class="seg" role="group" aria-label="Как оплатил гость">${methods.map(([id, label]) => `<button data-m="method" data-v="${id}" aria-pressed="${m.method === id}">${label}</button>`).join("")}</div>` : `<div class="box bad">Заведение не включило оплату при получении. Позвоните в заведение.</div>`}
      <div style="margin-top:12px">${body}</div>
      <div class="actions"><button class="btn link" data-m="close">Отмена</button></div>`;
  }

  async function startQr(o) {
    const m = S.modal;
    try {
      const r = await api("pay", { t: o.t, s: o.s });
      if (S.modal !== m) return;
      m.qr = r;
      if (r.status === "paid") m.qrPaid = true;
      drawModal();
      if (!m.qrPaid) pollQr(o);
    } catch (e) {
      toast(e.message, "bad");
      if (S.modal === m) { m.method = ""; drawModal(); }
    }
  }

  function pollQr(o) {
    const m = S.modal;
    m.poll = setTimeout(async () => {
      if (S.modal !== m) return;
      try {
        const r = await api("pay", { t: o.t, s: o.s, paymentId: m.qr.paymentId });
        if (S.modal !== m) return;
        if (r.status === "paid") {
          m.qrPaid = true;
          beep();
          buzz([100, 50, 100]);
          drawModal();
          return;
        }
        if (r.status === "failed") {
          toast("Банк отклонил оплату — попробуйте ещё раз или другой способ", "bad");
          m.qr = null;
          m.method = "";
          drawModal();
          return;
        }
      } catch (_) { /* связь мигнула — спросим ещё */ }
      pollQr(o);
    }, 3000);
  }

  // ---------------------------------------------------------------- нажатия

  const byKey = (k) => S.data && (S.data.mine.find((x) => x.key === k) || S.data.free.find((x) => x.key === k));

  async function onAction(a, el) {
    unlockAudio();
    if (a === "demo") {
      const code = (document.getElementById("demo-code") || {}).value || "";
      if (!code.trim()) return toast("Введите код демо из кассы", "bad");
      await login(code.trim(), true);
      render();
      if (S.token) await refresh(true);
      return;
    }
    if (a === "consent") {
      try { await api("consent"); S.v = ""; await refresh(true); } catch (e) { toast(e.message, "bad"); }
      return;
    }
    if (!S.data) return;
    const o = el.dataset.key ? byKey(el.dataset.key) : null;
    switch (a) {
      case "view":
        S.view = el.dataset.view;
        if (S.view === "orders") S.newFree.clear();
        if (S.view === "income") { S.histDay = ""; loadHistory(true); }
        render();
        if (S.view === "orders") updateMap(true);
        return;
      case "list":
        S.list = el.dataset.list;
        if (S.list === "free") S.newFree.clear();
        if (S.sheet === "mini") S.sheet = "peek";
        render();
        return;
      case "focus":
        S.focus = el.dataset.key;
        $("sheetbody").scrollTop = 0;
        render();
        return;
      case "shift":
        if (S.data.me.onShift) return openModal({ kind: "shift-end" });
        return setShift(true);
      case "shift-end": return openModal({ kind: "shift-end" });
      case "take":
        if (o) {
          act("take", o);
          S.list = "mine";
          S.focus = o.key;
          if (S.sheet === "mini") S.sheet = "peek";
          render();
        }
        return;
      case "pickup": case "arrive": case "retry": case "returned":
        if (o) act(a, o);
        return;
      case "deliver": if (o) openModal({ kind: "deliver", key: o.key, focus: true }); return;
      case "fail": if (o) openModal({ kind: "fail", key: o.key }); return;
      case "more": if (o) openModal({ kind: "more", key: o.key }); return;
      case "copy":
        if (o) {
          const t = targetOf(o);
          const text = t.address || "";
          try { await navigator.clipboard.writeText(text); toast("Адрес скопирован", "ok"); } catch (_) { toast(text); }
        }
        return;
      case "map-refresh":
        S.v = "";
        updateMap(true);
        refresh(true);
        return;
      case "hday": S.histDay = el.dataset.day; render(); loadHistory(true); return;
      case "transport": S.transport = el.dataset.v; save(KEY.transport, S.transport); render(); return;
      case "nav": S.nav = el.dataset.v; save(KEY.nav, S.nav); render(); return;
      case "sound": S.sound = !S.sound; save(KEY.sound, S.sound); if (S.sound) beep(); render(); return;
      case "notify":
        if ("Notification" in window) await Notification.requestPermission().catch(() => {});
        render();
        return;
      case "install":
        if (S.install) {
          S.install.prompt();
          S.install.userChoice.then((c) => { if (c && c.outcome !== "accepted") save(KEY.installSkip, Date.now() + 3 * 86400000); }).finally(() => { S.install = null; render(); });
        }
        return;
      case "refresh": S.v = ""; await refresh(true); loadHistory(true); toast("Обновлено"); return;
      case "logout": return openModal({ kind: "logout" });
      default:
    }
  }

  async function setShift(on) {
    try {
      if (on) {
        // Разрешения — прямо по нажатию: так их показывают и iPhone, и Android.
        startGeo();
        if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
      }
      await api("shift", { on });
      if (!on) { stopGeo(); releaseWake(); S.pings = []; save(KEY.pings, []); }
      S.v = "";
      await refresh(true);
      toast(on ? "Вы на линии — новые заказы придут со звуком" : "Смена закончена", "ok");
      if (on) { requestWake(); if (!S.data.mine.length) S.list = "free"; render(); }
    } catch (e) {
      if (!on) closeModal();
      toast(e.message, "bad");
      if (on && S.data && !S.data.me.onShift) stopGeo();
    }
  }

  async function onModal(a, el) {
    const m = S.modal;
    if (!m) return;
    const o = S.data && S.data.mine.find((x) => x.key === m.key);
    switch (a) {
      case "close": return closeModal();
      case "shift-off": closeModal(); return setShift(false);
      case "logout":
        try { await api("logout"); } catch (e) { if (e.status === 409) { closeModal(); return toast(e.message, "bad"); } }
        closeModal();
        S.queue = [];
        save(KEY.queue, []);
        return signedOut("Вы вышли. Для входа попросите у заведения новую ссылку.");
      case "release": return openModal({ kind: "release", key: m.key });
      case "release-yes": closeModal(); if (o) act("release", o); return;
      case "fail-open": return openModal({ kind: "fail", key: m.key });
      case "deliver-open": return openModal({ kind: "deliver", key: m.key, focus: true });
      case "reason": m.reason = el.value; m.note = ($modal.querySelector("#note") || {}).value || m.note; return drawModal();
      case "fail-send": {
        const note = (($modal.querySelector("#note") || {}).value || "").trim();
        if (m.reason === "other" && note.length < 3) return toast("Опишите причину в двух словах", "bad");
        closeModal();
        if (o) act("fail", o, { reason: m.reason, note });
        return;
      }
      case "method":
        if (m.poll) clearTimeout(m.poll);
        m.method = el.dataset.v;
        m.qr = null;
        if (m.method === "cash") m.focus = true;
        drawModal();
        if (m.method === "qr" && o && S.online) startQr(o);
        return;
      case "received": m.received = Number(el.dataset.v); return drawModal();
      case "deliver": {
        if (!o) return closeModal();
        const method = el.dataset.method || "";
        const args = method ? { method } : {};
        if (method === "cash") args.received = m.received === undefined ? o.toCollect : m.received;
        closeModal();
        act("deliver", o, args);
        return;
      }
      default:
    }
  }

  // ---------------------------------------------------------------- события

  $app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-a]");
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
    // Ссылки (звонок, навигатор) открывает сам телефон — так их не блокирует браузер.
    if (el.tagName === "A") { unlockAudio(); return; }
    e.preventDefault();
    onAction(el.dataset.a, el);
  });
  $app.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "demo-code") { e.preventDefault(); onAction("demo", e.target); }
  });
  $modal.addEventListener("click", (e) => {
    if (e.target === $modal) return closeModal();
    const el = e.target.closest("[data-m]");
    if (!el || el.disabled) return;
    if (el.tagName === "A") return;
    if (el.tagName !== "INPUT") e.preventDefault();
    onModal(el.dataset.m, el);
  });
  $modal.addEventListener("input", (e) => {
    if (e.target.id === "received" && S.modal) {
      const v = Number(String(e.target.value).replace(",", ".").replace(/[^\d.]/g, ""));
      S.modal.received = Number.isFinite(v) ? v : 0;
      // Перерисовываем только сдачу и кнопку — поле ввода остаётся в фокусе.
      const o = S.data.mine.find((x) => x.key === S.modal.key);
      if (!o) return;
      const due = o.toCollect;
      const box = $modal.querySelector(".change");
      const btn = $modal.querySelector('[data-m="deliver"]');
      if (box) box.innerHTML = S.modal.received < due ? `<span style="color:var(--red)">Не хватает ${rub(due - S.modal.received)}</span>` : `Сдача: ${rub(S.modal.received - due)}`;
      if (btn) { btn.disabled = S.modal.received < due; btn.innerHTML = `${I.check()}Вручил, получил ${rub(S.modal.received)}`; }
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.modal) closeModal(); });
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (S.data && S.data.me.onShift) requestWake();
      refresh();
      flush();
    }
  });
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.install = e; if (S.data) render(); });
  window.addEventListener("appinstalled", () => { S.install = null; toast("Приложение установлено — ищите «Курьер» на экране телефона", "ok"); if (S.data) render(); });
  // Новая ссылка-приглашение, когда приложение уже открыто (меняется только #…).
  window.addEventListener("hashchange", async () => {
    const m = /[#&]i=([A-Za-z0-9_-]{16,64})/.exec(location.hash || "");
    const demo = /[#&]demo=(demo-[A-Za-z0-9]{4,32})/.exec(location.hash || "");
    if (!m && !demo) return;
    if (S.queue.length) { history.replaceState(null, "", location.pathname + location.search); return toast("Сначала дождитесь отправки нажатий, потом откройте ссылку снова", "bad"); }
    if (demo && S.token) { history.replaceState(null, "", location.pathname + location.search); return; }
    S.data = null;
    S.v = "";
    S.mineKeys = null;
    await login(m ? m[1] : demo[1], !m);
    render();
    if (S.token) await refresh(true);
  });

  // ---------------------------------------------------------------- ход времени

  let lastTick = 0;
  function loop() {
    const now = Date.now();
    const on = S.data && S.data.me.onShift;
    const every = document.visibilityState !== "visible" ? 20000 : on ? 8000 : 30000;
    if (S.token && now - S.lastSync >= every) refresh();
    if (now - lastTick >= 10000) { lastTick = now; flushPings(); flush(); }
    if (S.view === "income") loadHistory();
    updateLive();
  }

  async function boot() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then((r) => { S.reg = r; }).catch(() => {});
    }
    const m = /[#&]i=([A-Za-z0-9_-]{16,64})/.exec(location.hash || "");
    const demo = /[#&]demo=(demo-[A-Za-z0-9]{4,32})/.exec(location.hash || "");
    if (m) await login(m[1]);
    else if (demo && !S.token) await login(demo[1], true);
    else if (demo) history.replaceState(null, "", location.pathname + location.search);
    render();
    if (S.token) await refresh(true);
    flush();
    setInterval(loop, 1000);
  }

  boot();
})();
