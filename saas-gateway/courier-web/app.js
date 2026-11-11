/* Приложение курьера ZalPOS (docs/delivery.md, раздел 6).
 *
 * Как устроено:
 *  • вход — по ссылке-приглашению (#i=…), дальше ключ в памяти телефона;
 *  • состояние — с сервера (api/state) каждые 8 с на смене, ответ «без
 *    изменений» короткий;
 *  • нажатия — в очередь: на экране шаг меняется сразу, на сервер уходит,
 *    когда есть связь (порядок сохраняется); ошибка сервера — сообщением;
 *  • геолокация — пачками раз в 10 с, без связи копится в памяти телефона;
 *  • на смене экран не гаснет; новый заказ — звук, вибрация, уведомление.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- утилиты

  const KEY = { token: "zc_token", queue: "zc_queue", pings: "zc_pings", order: "zc_order", nav: "zc_nav", sound: "zc_sound", seen: "zc_seen" };
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* память переполнена — не страшно */ } };
  const drop = (k) => { try { localStorage.removeItem(k); } catch (_) { /* нет доступа */ } };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nbsp = " ";
  const rub = (n) => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, nbsp)}${nbsp}₽`;
  const kmText = (m) => (m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10}${nbsp}м` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",")}${nbsp}км`);
  const minText = (n) => `${n}${nbsp}мин`;
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const phoneHref = (p) => { const d = String(p || "").replace(/\D/g, ""); return d ? `tel:+${d.length === 10 ? `7${d}` : d}` : ""; };
  const phoneText = (p) => { const d = String(p || "").replace(/\D/g, ""); const m = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(d); return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : p; };
  const plural = (n, a, b, c) => { const m10 = n % 10; const m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const $app = document.getElementById("app");
  const $modal = document.getElementById("modal");
  const $toast = document.getElementById("toast");

  const NAVS = {
    yandexmaps: { label: "Яндекс Карты", url: (a) => `https://yandex.ru/maps/?rtext=~${encodeURIComponent(a)}&rtt=auto` },
    yandexnavi: { label: "Яндекс Навигатор", url: (a) => `yandexnavi://map_search?text=${encodeURIComponent(a)}` },
    dgis: { label: "2ГИС", url: (a) => `https://2gis.ru/search/${encodeURIComponent(a)}` },
  };
  const FAIL = [
    ["no_answer", "Не открывают, не отвечают"],
    ["wrong_address", "Неверный адрес"],
    ["refused", "Гость отказался от заказа"],
    ["other", "Другая причина"],
  ];
  const STAGE = {
    toVenue: { chip: "blue", label: "Еду в заведение" },
    onWay: { chip: "green", label: "В пути" },
    arrived: { chip: "amber", label: "У двери" },
    failed: { chip: "red", label: "Не удалось вручить" },
  };
  const WAIT_HINT_MS = 10 * 60 * 1000;

  // ---------------------------------------------------------------- состояние

  const S = {
    token: load(KEY.token, ""),
    data: null,
    v: "",
    tab: "free",
    online: navigator.onLine !== false,
    queue: load(KEY.queue, []),
    pings: load(KEY.pings, []),
    order: load(KEY.order, []),
    nav: load(KEY.nav, "yandexmaps"),
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
  };

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
    drop(KEY.token);
    stopGeo();
    releaseWake();
    render();
  }

  // ---------------------------------------------------------------- вход

  async function login(code) {
    $app.innerHTML = `<div class="boot"><div class="spinner" aria-hidden="true"></div><p>Входим по приглашению…</p></div>`;
    try {
      const r = await api("login", { invite: code, device: deviceName() });
      S.token = r.token;
      save(KEY.token, r.token);
      S.fatal = "";
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
      alertNew(fresh.length === 1
        ? `Новый заказ: ${next.free.find((f) => f.key === fresh[0]).street || "доставка"}`
        : `Новых заказов: ${fresh.length}`);
    }
    if (fresh.length) S.newFree = new Set(fresh);
    S.seenFree = new Set(freeIds);
    save(KEY.seen, freeIds.slice(-200));
    const mine = new Set(next.mine.map((m) => m.key));
    if (S.mineKeys) {
      for (const m of next.mine) {
        if (!S.mineKeys.has(m.key) && !S.pendingTakes.has(m.key)) alertNew(`Заведение назначило вам заказ №${m.no}`, true);
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
    document.title = fresh.length || next.free.length ? `(${next.free.length}) Курьер · ZalPOS` : "Курьер · ZalPOS";
  }

  // ---------------------------------------------------------------- очередь действий

  function act(op, o, args = {}) {
    const item = { id: uid(), op, t: o.t, s: o.s, args, at: Date.now() };
    if (op === "take") S.pendingTakes.add(o.key);
    S.queue.push(item);
    save(KEY.queue, S.queue);
    if (S.data) applyLocal(item, S.data);
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
          if (q.op === "deliver") toast("Заказ вручён ✓", "ok");
        } catch (e) {
          if (e.status === 401 || e.status === 403 && /Доступ закрыт/.test(e.message)) { S.queue = []; save(KEY.queue, S.queue); return signedOut(e.message); }
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
    S.geo.error = 0;
    S.geo.fix = fix;
    const last = S.geo.lastBuffered;
    // В память — каждые 15 с или при сдвиге на 25 м: путь считается точно, лишнего не шлём.
    if (!last || fix.at - last.at > 15000 || dist(last, fix) > 25) {
      S.pings.push(fix);
      if (S.pings.length > 600) S.pings = S.pings.slice(-600);
      S.geo.lastBuffered = fix;
    }
    if (hadError) render();
    if (S.pings.length === 1 || S.pings.length >= 30) flushPings();
  }

  function dist(a, b) {
    const R = 6371000;
    const r = (x) => (x * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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

  // ---------------------------------------------------------------- отрисовка

  function render() {
    if (!S.token) return renderSignedOut();
    if (!S.data) {
      $app.innerHTML = `<div class="boot"><div class="spinner" aria-hidden="true"></div><p>Загружаем заказы…</p>${S.online ? "" : "<p class=\"muted\">Нет связи — ждём сеть</p>"}</div>`;
      return;
    }
    if (!S.data.me.consent) return renderConsent();
    const d = S.data;
    const me = d.me;
    const mine = sortedMine();
    const tabs = [
      ["free", "Свободные", d.free.length, me.onShift && d.free.length > 0],
      ["mine", "Мои", mine.length, false],
      ["day", "Итоги", null, false],
    ];
    $app.innerHTML = `
      <header class="top">
        <div class="bar">
          <img src="icon-192.png" alt="" width="40" height="40" style="border-radius:11px">
          <div class="who">
            <b>Курьер №${esc(me.no)} · ${esc(String(me.name || "").split(" ")[0])}</b>
            <span><i class="dot${S.online ? (S.queue.length ? " wait" : "") : " off"}"></i>${S.online ? (S.queue.length ? `отправляем ${S.queue.length}…` : "в сети") : `нет связи${S.queue.length ? ` · ждут ${S.queue.length}` : ""}`}</span>
          </div>
          <button class="shift${me.onShift ? " on" : ""}" data-a="shift">${me.onShift ? "На смене" : "Начать смену"}</button>
        </div>
        <nav class="tabs" role="tablist">
          ${tabs.map(([id, label, n, hot]) => `<button class="tab" role="tab" aria-selected="${S.tab === id}" data-a="tab" data-tab="${id}">${label}${n === null ? "" : `<span class="count${hot ? " hot" : ""}">${n}</span>`}</button>`).join("")}
        </nav>
      </header>
      <div class="strip">${notes()}</div>
      <main>${S.tab === "free" ? freeHtml() : S.tab === "mine" ? mineHtml(mine) : dayHtml()}</main>`;
    updateLive();
  }

  function notes() {
    const d = S.data;
    const out = [];
    if (!d.me.onShift) out.push(`<div class="note"><span class="grow">Вы не на смене: заказы видно, но брать их можно после «Начать смену».</span></div>`);
    if (d.me.onShift && S.geo.error === 1) {
      out.push(`<div class="note bad"><span class="grow"><b>Нет доступа к геолокации.</b> Разрешите её для этого сайта в настройках браузера — без неё заведение и гость не видят, где заказ.</span></div>`);
    } else if (d.me.onShift && !S.geo.fix && S.geo.watch !== null) {
      out.push(`<div class="note warn"><span class="grow">Ищем ваше местоположение…</span></div>`);
    }
    if (!S.online) out.push(`<div class="note warn"><span class="grow">Нет связи. Нажатия и маршрут сохраняются на телефоне и уйдут, когда сеть появится.</span></div>`);
    if (S.install && d.me.onShift) out.push(`<div class="note ok"><span class="grow">Поставьте приложение на экран — открывать в одно касание.</span><button data-a="install">Установить</button></div>`);
    return out.join("");
  }

  function sortedMine() {
    const idx = (k) => { const i = S.order.indexOf(k); return i < 0 ? 1e9 : i; };
    return S.data.mine.slice().sort((a, b) => idx(a.key) - idx(b.key) || a.stageAt - b.stageAt);
  }

  const multiPoint = () => (S.data.me.points || []).length > 1;

  function payLine(o) {
    if (o.toCollect > 0) return `<div class="money"><span class="muted">К получению</span><b>${rub(o.toCollect)}</b></div>`;
    return `<div class="money"><span class="chip green">Оплачено — деньги не брать</span><span class="muted small">${rub(o.total)}</span></div>`;
  }

  function freeHtml() {
    const d = S.data;
    if (!d.free.length) {
      return `<div class="empty"><div class="big">🛵</div><p><b>Свободных заказов нет</b></p><p class="small">Новые появятся здесь со звуком и вибрацией${d.me.onShift ? "" : " — когда вы на смене"}.</p></div>`;
    }
    return d.free.map((f) => `
      <article class="card${S.newFree.has(f.key) ? " new" : ""}">
        <div class="row head">
          <span class="grow">${multiPoint() ? `<b>${esc(f.point.name)}</b> · ` : ""}№${esc(f.no)}${f.zone ? ` · ${esc(f.zone)}` : ""}</span>
          <span class="nowrap" data-ago="${Date.now() - f.ageMin * 60000}">${minText(f.ageMin)}</span>
        </div>
        <div class="street">${esc(f.street || "Адрес уточняется")}</div>
        <div class="chips">
          ${f.returned ? `<span class="chip violet">Вернули в заведение</span>` : ""}
          <span class="chip ${f.ready ? "green" : "amber"}">${f.ready ? "Готов" : esc(f.status)}</span>
          <span class="chip">${f.items} ${plural(f.items, "позиция", "позиции", "позиций")}</span>
          ${f.toPointM != null ? `<span class="chip blue">до заведения ${kmText(f.toPointM)}</span>` : ""}
          ${f.etaMin ? `<span class="chip">обещали за ${minText(f.etaMin)}</span>` : ""}
        </div>
        ${payLine(f)}
        <button class="btn primary huge wide" data-a="take" data-key="${esc(f.key)}" ${d.me.onShift ? "" : "disabled"}>${d.me.onShift ? "Беру заказ" : "Начните смену, чтобы взять"}</button>
      </article>`).join("");
  }

  function mineHtml(list) {
    if (!list.length) {
      return `<div class="empty"><div class="big">📦</div><p><b>У вас нет заказов</b></p><p class="small">Возьмите заказ во вкладке «Свободные» — или заведение назначит его вам.</p></div>`;
    }
    const routeAll = list.length > 1
      ? `<button class="btn blue wide" data-a="route-all" style="margin-bottom:12px"><span class="ic">🧭</span>Маршрут по всем (${list.length})</button>` : "";
    return routeAll + list.map((o, i) => mineCard(o, i, list.length)).join("");
  }

  function mineCard(o, i, total) {
    const st = o.cancelled ? { chip: "red", label: "Отменён заведением" } : STAGE[o.stage] || STAGE.toVenue;
    const call = o.phone ? `<a class="btn" href="${esc(phoneHref(o.phone))}"><span class="ic">📞</span>Позвонить</a>` : `<button class="btn" disabled>Нет телефона</button>`;
    const toVenue = o.stage === "toVenue" && !o.cancelled;
    const route = `<button class="btn" data-a="route" data-key="${esc(o.key)}" data-to="${toVenue ? "venue" : "guest"}"><span class="ic">🧭</span>${toVenue ? "В заведение" : "Маршрут"}</button>`;
    let main = "";
    let minor = "";
    if (o.cancelled) {
      main = o.stage === "toVenue" ? "" : `<button class="btn amber huge wide" data-a="returned" data-key="${esc(o.key)}">↩️ Вернул заказ в заведение</button>`;
    } else if (o.stage === "toVenue") {
      main = `<button class="btn blue huge wide" data-a="pickup" data-key="${esc(o.key)}">📦 Забрал заказ</button>`;
      minor = `<button class="btn link" data-a="release" data-key="${esc(o.key)}">Отказаться от заказа</button>`;
    } else if (o.stage === "onWay") {
      main = `<button class="btn primary huge wide" data-a="arrive" data-key="${esc(o.key)}">📍 Я на месте</button>`;
      minor = `<button class="btn link" data-a="deliver" data-key="${esc(o.key)}">Сразу вручил</button><button class="btn danger" data-a="fail" data-key="${esc(o.key)}">Не удалось вручить</button>`;
    } else if (o.stage === "arrived") {
      main = `<button class="btn primary huge wide" data-a="deliver" data-key="${esc(o.key)}">✅ Вручил${o.toCollect > 0 ? ` · ${rub(o.toCollect)}` : ""}</button>`;
      minor = `<span class="muted small">У двери <span class="timer" data-since="${o.stageAt}">00:00</span></span><button class="btn danger" data-a="fail" data-key="${esc(o.key)}">Не удалось вручить</button>`;
    } else if (o.stage === "failed") {
      main = `<div class="grid2" style="margin-top:0"><button class="btn primary" data-a="retry" data-key="${esc(o.key)}">Попробовать ещё раз</button><button class="btn amber" data-a="returned" data-key="${esc(o.key)}">↩️ Вернул в заведение</button></div>`;
    }
    const pickup = toVenue
      ? `<div class="pickup"><span class="muted small">Забрать в заведении</span><b>${esc(o.point.name)}</b>${o.point.address ? esc(o.point.address) : ""}<div class="small" style="margin-top:4px">${o.ready ? "✅ Заказ готов" : `⏳ ${esc(o.status)}`}</div></div>` : "";
    return `
      <article class="card">
        <div class="row head">
          <span class="grow"><b>№${esc(o.no)}</b>${multiPoint() ? ` · ${esc(o.point.name)}` : ""}${o.zone ? ` · ${esc(o.zone)}` : ""}</span>
          ${total > 1 ? `<span class="move"><button aria-label="Выше" data-a="up" data-key="${esc(o.key)}" ${i === 0 ? "disabled" : ""}>↑</button><button aria-label="Ниже" data-a="down" data-key="${esc(o.key)}" ${i === total - 1 ? "disabled" : ""}>↓</button></span>` : ""}
        </div>
        <div class="chips"><span class="chip ${st.chip}">${st.label}</span>${o.local ? `<span class="chip">сохраняем…</span>` : ""}</div>
        ${o.fail ? `<div class="comment">⚠️ ${esc(o.fail.label || "")}${o.fail.note ? ` — ${esc(o.fail.note)}` : ""}</div>` : ""}
        ${pickup}
        <div class="addr">${esc(o.address || o.street || "")}</div>
        ${o.guestName ? `<div class="muted small">${esc(o.guestName)}${o.phone ? ` · ${esc(phoneText(o.phone))}` : ""}</div>` : ""}
        ${o.comment ? `<div class="comment">💬 ${esc(o.comment)}</div>` : ""}
        ${payLine(o)}
        ${o.lines && o.lines.length ? `<details class="items"><summary>Состав: ${o.items} ${plural(o.items, "позиция", "позиции", "позиций")}</summary><ul>${o.lines.map((l) => `<li>${esc(l.name)}${l.mods && l.mods.length ? ` <span class="muted">(${esc(l.mods.join(", "))})</span>` : ""} × ${l.qty}</li>`).join("")}</ul></details>` : ""}
        <div class="grid3">${call}${route}<button class="btn" data-a="copy" data-key="${esc(o.key)}"><span class="ic">📋</span>Адрес</button></div>
        <div class="actions">${main}${minor ? `<div class="minor">${minor}</div>` : ""}</div>
      </article>`;
  }

  function dayHtml() {
    const d = S.data;
    const st = d.stats;
    const r = d.me.rates || {};
    const paid = (r.ratePerTrip || 0) + (r.ratePerKm || 0) > 0;
    const shiftMin = d.me.onShift && d.me.shiftStartedAt ? Math.floor((Date.now() - d.me.shiftStartedAt) / 60000) : 0;
    const iosHint = /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone;
    return `
      <div class="stats">
        <div class="stat"><b>${st.trips}</b><span>${plural(st.trips, "доставка", "доставки", "доставок")} сегодня</span></div>
        <div class="stat"><b>${String(st.km).replace(".", ",")}</b><span>км с заказами</span></div>
        <div class="stat"><b>${st.avgMin ? minText(st.avgMin) : "—"}</b><span>в среднем в пути</span></div>
        <div class="stat"><b>${d.me.onShift ? `${Math.floor(shiftMin / 60)}${nbsp}ч ${shiftMin % 60}${nbsp}мин` : "—"}</b><span>на смене</span></div>
        ${paid ? `<div class="stat wide"><b>${rub(st.earned)}</b><span>заработано сегодня · ${r.ratePerTrip ? `${rub(r.ratePerTrip)} за доставку` : ""}${r.ratePerTrip && r.ratePerKm ? " + " : ""}${r.ratePerKm ? `${rub(r.ratePerKm)} за км` : ""}</span></div>` : ""}
        <div class="stat wide"><b>${rub(d.me.cashOnHand)}</b><span>наличные на руках${d.me.cashOnHand > 0 ? " — сдайте в заведении, там отметят" : ""}</span></div>
      </div>

      <div class="section">Навигатор</div>
      <div class="list"><div><div class="seg" role="group" aria-label="Навигатор">${Object.entries(NAVS).map(([id, n]) => `<button data-a="nav" data-nav="${id}" aria-pressed="${S.nav === id}">${n.label}</button>`).join("")}</div></div></div>

      <div class="section">Сигналы</div>
      <div class="list">
        <div><span class="grow">Звук нового заказа</span><button class="btn ${S.sound ? "primary" : "ghost"}" data-a="sound">${S.sound ? "Включён" : "Выключен"}</button></div>
        ${"Notification" in window ? `<div><span class="grow">Уведомления, когда приложение свёрнуто</span>${Notification.permission === "granted" ? `<span class="chip green">Разрешены</span>` : Notification.permission === "denied" ? `<span class="chip red">Запрещены в браузере</span>` : `<button class="btn" data-a="notify">Разрешить</button>`}</div>` : ""}
        <div><span class="grow">Экран не гаснет на смене</span><span class="chip ${S.wake ? "green" : ""}">${S.wake ? "Да" : "wakeLock" in navigator ? "Включится на смене" : "Телефон не поддерживает"}</span></div>
        ${S.install ? `<div><span class="grow">Приложение на экран телефона</span><button class="btn" data-a="install">Установить</button></div>` : iosHint ? `<div><span class="grow small">Чтобы поставить на экран iPhone: «Поделиться» → «На экран „Домой“».</span></div>` : ""}
      </div>

      <div class="section">Где работаю</div>
      <div class="list">${(d.me.points || []).map((p) => `<div><span class="grow"><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.address || "")}</span></span></div>`).join("")}</div>

      <div class="actions" style="margin-top:18px">
        ${d.me.onShift ? `<button class="btn ghost wide" data-a="shift-end">Закончить смену</button>` : `<button class="btn primary wide" data-a="shift">Начать смену</button>`}
        <button class="btn link" data-a="refresh">Обновить данные</button>
        <button class="btn danger" data-a="logout">Выйти из приложения</button>
      </div>
      <p class="muted small" style="text-align:center;margin-top:14px">Геолокация передаётся только на смене. Последняя точка стирается в конце смены, в заказе — после вручения.</p>`;
  }

  function renderSignedOut() {
    $app.innerHTML = `
      <div class="screen">
        <img class="logo" src="icon-192.png" alt="">
        <h1>Приложение курьера</h1>
        ${S.fatal ? `<div class="note bad" style="margin:12px 0"><span class="grow">${esc(S.fatal)}</span></div>` : ""}
        <p>Чтобы войти, откройте <b>личную ссылку-приглашение</b>, которую вам прислало заведение. Пароль не нужен.</p>
        <ul class="muted">
          <li>Ссылка одноразовая и действует 72 часа.</li>
          <li>Если ссылка устарела — попросите в заведении новую: Кабинет → «Доставка» → «Курьеры».</li>
        </ul>
      </div>`;
  }

  function renderConsent() {
    $app.innerHTML = `
      <div class="screen">
        <img class="logo" src="icon-192.png" alt="">
        <h1>Геолокация во время смены</h1>
        <p>Чтобы заведение и гость видели, где заказ, приложение передаёт местоположение телефона — <b>только пока вы на смене</b>.</p>
        <ul>
          <li><b>Кто видит:</b> заведение — пока вы на смене; гость — только свой заказ и только пока вы его везёте.</li>
          <li><b>Сколько хранится:</b> последняя точка — до конца смены; в заказе — до вручения. В истории поездок остаются только километры, без координат.</li>
          <li><b>Где хранится:</b> на сервере в России.</li>
        </ul>
        <p class="muted small">Вы можете в любой момент закончить смену — передача сразу остановится.</p>
        <button class="btn primary huge wide" data-a="consent">Согласен, продолжить</button>
      </div>`;
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
      html = `<h2>Закончить смену?</h2><p class="muted">Заказы перестанут приходить, передача геолокации остановится.</p>
        <div class="actions"><button class="btn primary huge wide" data-m="shift-off">Закончить смену</button><button class="btn link" data-m="close">Остаться на смене</button></div>`;
    } else if (!o) {
      return closeModal();
    } else if (m.kind === "fail") {
      html = `<h2>Не удалось вручить №${esc(o.no)}</h2><p class="muted small">Заведение сразу получит сигнал. Дальше: попробовать ещё раз или вернуть заказ.</p>
        <div class="reasons">${FAIL.map(([id, label]) => `<label><input type="radio" name="reason" value="${id}" ${m.reason === id ? "checked" : ""} data-m="reason"><span>${label}</span></label>`).join("")}</div>
        <div class="field"><label for="note" class="muted small">Комментарий${m.reason === "other" ? " (обязательно)" : ""}</label><textarea id="note" rows="2" maxlength="200" placeholder="Например: звонил дважды, домофон не работает">${esc(m.note || "")}</textarea></div>
        <div class="actions"><button class="btn amber huge wide" data-m="fail-send" ${m.reason ? "" : "disabled"}>Отметить «не удалось»</button><button class="btn link" data-m="close">Отмена</button></div>`;
    } else if (m.kind === "deliver") {
      html = deliverHtml(o, m);
    }
    // Окно открывается с анимацией один раз; дальше меняется только содержимое.
    let sheet = $modal.querySelector(".sheet");
    if (!sheet) {
      $modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"></div>`;
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
        ${m.qrPaid ? `<div class="paid-ok">✓ Оплата по QR пришла</div>` : `<div class="note ok"><span class="grow"><b>Заказ оплачен.</b> Денег не брать.</span></div>`}
        <div class="actions"><button class="btn primary huge wide" data-m="deliver" data-method="${m.qrPaid ? "qr" : ""}">✅ Вручил</button><button class="btn link" data-m="close">Отмена</button></div>`;
    }
    const pay = o.payAtDoor || {};
    const methods = [["cash", "💵 Наличные", pay.cash], ["card", "💳 Картой", pay.card], ["qr", "📱 По QR", pay.qr]].filter((x) => x[2]);
    if (!m.method && methods.length === 1) m.method = methods[0][0];
    let body = "";
    if (m.method === "cash") {
      const due = o.toCollect;
      const received = m.received === undefined ? due : m.received;
      const change = Math.max(0, Math.round((received - due) * 100) / 100);
      const notes = [500, 1000, 2000, 5000].map((b) => Math.ceil(due / b) * b).filter((v, i, a) => v > due && a.indexOf(v) === i).slice(0, 3);
      body = `<div class="field"><label for="received" class="muted small">Сколько дал гость</label><input id="received" inputmode="decimal" autocomplete="off" value="${received}"></div>
        <div class="seg"><button data-m="received" data-v="${due}" aria-pressed="${received === due}">Без сдачи</button>${notes.map((v) => `<button data-m="received" data-v="${v}" aria-pressed="${received === v}">${rub(v)}</button>`).join("")}</div>
        <div class="change ${received < due ? "" : ""}">${received < due ? `<span style="color:var(--red)">Не хватает ${rub(due - received)}</span>` : `Сдача: ${rub(change)}`}</div>
        <button class="btn primary huge wide" data-m="deliver" data-method="cash" ${received < due ? "disabled" : ""}>✅ Вручил, получил ${rub(received)}</button>`;
    } else if (m.method === "card") {
      body = `<p class="muted">Проведите оплату на терминале и дождитесь «Одобрено».</p>
        <button class="btn primary huge wide" data-m="deliver" data-method="card">✅ Оплата прошла, вручил</button>`;
    } else if (m.method === "qr") {
      if (!m.qr) body = `<p class="muted">${S.online ? "Готовим QR в банке заведения…" : "Для QR нужна связь — выберите другой способ или дождитесь сети."}</p>`;
      else body = `<div class="qr">${window.ZQR ? window.ZQR.svg(m.qr.url) : ""}</div>
        <p style="text-align:center" class="muted">Гость наводит камеру телефона и платит в своём банке${m.qr.bank ? ` · ${esc(m.qr.bank)}` : ""}.</p>
        <p style="text-align:center"><span class="spinner" style="display:inline-block;width:18px;height:18px;border-width:3px;vertical-align:-3px"></span> Ждём оплату…</p>`;
    }
    return `<h2>Вручить заказ №${esc(o.no)}</h2>
      <div class="due">${rub(o.toCollect)}</div>
      ${methods.length ? `<div class="seg" role="group" aria-label="Как оплатил гость">${methods.map(([id, label]) => `<button data-m="method" data-v="${id}" aria-pressed="${m.method === id}">${label}</button>`).join("")}</div>` : `<div class="note bad"><span class="grow">Заведение не включило оплату при получении. Позвоните в заведение.</span></div>`}
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

  // ---------------------------------------------------------------- маршруты

  function openRoute(o, to) {
    const addr = to === "venue" ? (o.point.address || o.point.name) : (o.address || o.street);
    if (!addr) return toast("Адреса нет — позвоните гостю", "bad");
    window.open((NAVS[S.nav] || NAVS.yandexmaps).url(addr), "_blank", "noopener");
  }

  /** Один маршрут в Яндекс Картах: от вас → заведения (что забрать) → адреса по порядку. */
  function routeAll() {
    const stops = [];
    const add = (a) => { if (a && !stops.includes(a)) stops.push(a); };
    const list = sortedMine().filter((o) => !o.cancelled);
    for (const o of list) if (o.stage === "toVenue") add(o.point.address || o.point.name);
    for (const o of list) add(o.address || o.street);
    if (!stops.length) return;
    const rtext = `~${stops.slice(0, 9).map(encodeURIComponent).join("~")}`;
    window.open(`https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`, "_blank", "noopener");
  }

  // ---------------------------------------------------------------- нажатия

  const byKey = (k) => S.data && (S.data.mine.find((x) => x.key === k) || S.data.free.find((x) => x.key === k));

  async function onAction(a, el) {
    unlockAudio();
    const o = el.dataset.key ? byKey(el.dataset.key) : null;
    switch (a) {
      case "tab": S.tab = el.dataset.tab; if (S.tab !== "free") S.newFree.clear(); render(); window.scrollTo(0, 0); return;
      case "shift":
        if (S.data.me.onShift) return openModal({ kind: "shift-end" });
        return setShift(true);
      case "shift-end": return openModal({ kind: "shift-end" });
      case "take": if (o) { act("take", o); S.tab = "mine"; render(); } return;
      case "pickup": case "arrive": case "retry": case "returned":
        if (o) act(a, o);
        return;
      case "release": if (o && confirm("Отказаться от заказа? Он снова станет свободным для других курьеров.")) act("release", o); return;
      case "deliver":
        if (!o) return;
        openModal({ kind: "deliver", key: o.key, focus: true });
        return;
      case "fail": if (o) openModal({ kind: "fail", key: o.key }); return;
      case "route": if (o) openRoute(o, el.dataset.to); return;
      case "route-all": return routeAll();
      case "copy":
        if (o) {
          const text = o.address || o.street || "";
          try { await navigator.clipboard.writeText(text); toast("Адрес скопирован", "ok"); } catch (_) { toast(text); }
        }
        return;
      case "up": case "down": {
        const keys = sortedMine().map((x) => x.key);
        const i = keys.indexOf(el.dataset.key);
        const j = a === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= keys.length) return;
        [keys[i], keys[j]] = [keys[j], keys[i]];
        S.order = keys;
        save(KEY.order, keys);
        render();
        return;
      }
      case "nav": S.nav = el.dataset.nav; save(KEY.nav, S.nav); render(); return;
      case "sound": S.sound = !S.sound; save(KEY.sound, S.sound); if (S.sound) beep(); render(); return;
      case "notify":
        if ("Notification" in window) await Notification.requestPermission().catch(() => {});
        render();
        return;
      case "install":
        if (S.install) { S.install.prompt(); S.install.userChoice.finally(() => { S.install = null; render(); }); }
        return;
      case "refresh": S.v = ""; await refresh(true); toast("Обновлено"); return;
      case "consent":
        try { await api("consent"); S.v = ""; await refresh(true); } catch (e) { toast(e.message, "bad"); }
        return;
      case "logout":
        if (S.queue.length && !confirm("Не все нажатия ушли на сервер. Всё равно выйти?")) return;
        if (!confirm("Выйти? Чтобы войти снова, понадобится новая ссылка от заведения.")) return;
        try { await api("logout"); } catch (e) { if (e.status === 409) return toast(e.message, "bad"); }
        S.queue = [];
        save(KEY.queue, []);
        return signedOut("Вы вышли. Для входа попросите у заведения новую ссылку.");
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
      toast(on ? "Смена началась — новые заказы придут со звуком" : "Смена закончена", "ok");
      if (on) requestWake();
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
        drawModal();
        if (m.method === "cash") { m.focus = true; drawModal(); }
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
    if (!el || el.disabled) return;
    if (el.tagName === "A") { unlockAudio(); return; }
    e.preventDefault();
    onAction(el.dataset.a, el);
  });
  $modal.addEventListener("click", (e) => {
    if (e.target === $modal) return closeModal();
    const el = e.target.closest("[data-m]");
    if (!el || el.disabled) return;
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
      if (btn) { btn.disabled = S.modal.received < due; btn.textContent = `✅ Вручил, получил ${rub(S.modal.received)}`; }
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
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.install = e; render(); });
  // Новая ссылка-приглашение, когда приложение уже открыто (меняется только #…).
  window.addEventListener("hashchange", async () => {
    const m = /[#&]i=([A-Za-z0-9_-]{16,64})/.exec(location.hash || "");
    if (!m) return;
    if (S.queue.length) { history.replaceState(null, "", location.pathname + location.search); return toast("Сначала дождитесь отправки нажатий, потом откройте ссылку снова", "bad"); }
    S.data = null;
    S.v = "";
    S.mineKeys = null;
    await login(m[1]);
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
    updateLive();
  }

  async function boot() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then((r) => { S.reg = r; }).catch(() => {});
    }
    const m = /[#&]i=([A-Za-z0-9_-]{16,64})/.exec(location.hash || "");
    if (m) await login(m[1]);
    render();
    if (S.token) await refresh(true);
    flush();
    setInterval(loop, 1000);
  }

  boot();
})();
