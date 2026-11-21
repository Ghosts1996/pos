"use strict";
// Схема зала по фото (кабинет → «Перенос данных» → «Схема зала по фото»).
//
// Владелец загружает фото плана помещения: план БТИ, рисунок от руки,
// скриншот схемы из прежней кассы, PDF. ИИ заведения (его ключ, раздел «ИИ»)
// возвращает стены, столы, зоны и подписи в долях картинки (0…1000), а здесь
// они переводятся в схему кассы — те же коллекции, что пишет редактор зала:
//   tables      — name, x, y (доли «базовый холст минус плитка»), seats,
//                 shape (rect|circle|long|oval|corner|bar), rotation 0…3, zone;
//   hallWalls   — zone, points [x0, y0, x1, y1, …] на холсте, closed;
//   hallLabels  — zone, text, x, y (центр на холсте).
// Геометрия — как в lib/utils/hall_layout.dart (kHallBasis, kHallCanvas в
// SaaS, kHallTile, сетка — четверть плитки). Масштаб подбирается так, чтобы
// соседние столы не наезжали друг на друга; что всё-таки наехало — сдвигается
// на ближайшее свободное место сетки. Это черновик: точную расстановку
// владелец доводит в кассе (Админ → «Схема зала»).
//
// «Заменить» — новая схема вместо всей прежней (все зоны: у нового заведения
// столы обычно без зоны, и замена «по названию» оставила бы их рядом с
// новыми). Столы с открытыми чеками и «С собой» остаются. Прежняя схема
// сохраняется (meta/hallImportUndo) — «Отменить импорт» возвращает её.

const BASIS = { w: 1000, h: 640 };
const CANVAS = { w: 2496, h: 2080 };
const TILE = 104;
const GRID = TILE / 4;
const SHAPES = ["rect", "circle", "long", "oval", "corner", "bar"];
const LIMITS = { zones: 8, tables: 150, walls: 60, wallPoints: 200, labels: 40 };
const LABEL_MAX = 40;
const NAME_MAX = 24;
const ZONE_MAX = 30;

const HALL_AI_PROMPT = `На картинке — план зала заведения общепита: чертёж или план БТИ, рисунок от руки, фото схемы или скриншот схемы зала из другой программы.
Перенеси его в JSON. Координаты — доли картинки от 0 до 1000: x слева направо, y сверху вниз (0,0 — левый верхний угол картинки, 1000,1000 — правый нижний).
Формат ответа — только JSON, без пояснений:
{"zones":[{"name":"…","walls":[{"points":[[x,y],[x,y],…],"closed":true}],"tables":[{"name":"…","seats":4,"shape":"rect","x":0,"y":0,"vertical":false}],"labels":[{"text":"…","x":0,"y":0}]}]}
Правила:
- zones — отдельные помещения или залы (например «Основной зал», «Веранда», «VIP»). Если помещение одно — одна зона; name — подпись с плана или "" если её нет.
- walls — стены помещения по углам: внешний контур зоны — одна замкнутая ломаная (closed: true), внутренние перегородки — отдельные незамкнутые. Двери и окна не нужны.
- tables — каждый стол, диван, барная стойка или место для гостей: x, y — центр стола. name — номер или подпись стола как на плане (например "5" или "VIP 2"), нет — "".
- shape: "circle" — круглый, "rect" — квадратный, "long" — прямоугольный вытянутый, "oval" — овальный, "corner" — угловой диван или стол буквой Г, "bar" — барная стойка. vertical: true — если вытянутый стол стоит вертикально.
- seats — число мест: посчитай стулья, если их видно; иначе по размеру (маленький — 2, обычный — 4, большой — 6–8).
- labels — подписи помещений и мест: «Вход», «Бар», «Кухня», «WC», «Гардероб», «Сцена» и т. п.
- Людей, мебель кроме столов, размеры и площади не переноси. Ничего не выдумывай: чего не видно — не добавляй.`;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round1 = (v) => Math.round(v * 10) / 10;
const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Размер плитки стола на холсте — как hallTileSize. */
function tileSize(shape, rotation) {
  if (shape === "corner") return { w: TILE * 2, h: TILE * 2 };
  const n = shape === "long" || shape === "oval" ? 2 : shape === "bar" ? 3 : 1;
  if (n === 1) return { w: TILE, h: TILE };
  return rotation % 2 === 1 ? { w: TILE, h: TILE * n } : { w: TILE * n, h: TILE };
}

/** Доли x/y стола по левому верхнему углу плитки — как hallFractionForTopLeft. */
function fraction(left, top, size) {
  const freeW = BASIS.w - size.w, freeH = BASIS.h - size.h;
  return { x: freeW <= 0 ? 0 : round4(left / freeW), y: freeH <= 0 ? 0 : round4(top / freeH) };
}
const round4 = (v) => Math.round(v * 10000) / 10000;

/** Левый верхний угол плитки по долям — как hallTileOffset. */
function offset(t) {
  const s = tileSize(t.shape, t.rotation);
  return {
    left: clamp(t.x * (BASIS.w - s.w), 0, CANVAS.w - s.w),
    top: clamp(t.y * (BASIS.h - s.h), 0, CANVAS.h - s.h),
    ...s,
  };
}

const overlaps = (a, b) => a.left < b.left + b.w - 0.5 && b.left < a.left + a.w - 0.5 && a.top < b.top + b.h - 0.5 && b.top < a.top + a.h - 0.5;

function tableName(raw, used) {
  let name = clean(raw, NAME_MAX);
  if (/^\d{1,4}$/.test(name)) name = `Стол ${name}`;
  if (!name) {
    let n = 1;
    while (used.has(`стол ${n}`)) n++;
    name = `Стол ${n}`;
  }
  let out = name;
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${name} (${k})`.slice(0, NAME_MAX + 4);
  used.add(out.toLowerCase());
  return out;
}

function shapeOf(raw) {
  const s = String(raw || "").toLowerCase();
  if (SHAPES.includes(s)) return s;
  if (/round|круг/.test(s)) return "circle";
  if (/bar|стойк/.test(s)) return "bar";
  if (/sofa|диван|угл|corner/.test(s)) return "corner";
  if (/oval|овал/.test(s)) return "oval";
  if (/long|rect.*long|прямоуг/.test(s)) return "long";
  return "rect";
}

/** Ближайшее свободное место сетки для плитки (по спирали от желаемого). */
function placeFree(want, placed) {
  const fits = (r) => r.left >= 0 && r.top >= 0 && r.left + r.w <= CANVAS.w && r.top + r.h <= CANVAS.h && !placed.some((p) => overlaps(r, p));
  if (fits(want)) return want;
  for (let ring = 1; ring <= 24; ring++) {
    let best = null;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const r = { ...want, left: want.left + dx * GRID, top: want.top + dy * GRID };
        if (!fits(r)) continue;
        const d = dx * dx + dy * dy;
        if (!best || d < best.d) best = { r, d };
      }
    }
    if (best) return best.r;
  }
  return null;
}

/** Одна зона из ответа ИИ → столы, стены и подписи на холсте кассы. */
function zoneFromAi(z, aspect) {
  const sx = 1000 * aspect, sy = 1000; // доли картинки → «пиксели» с верными пропорциями
  const P = (x, y) => ({ x: clamp(num(x) ?? 0, 0, 1000) / 1000 * sx, y: clamp(num(y) ?? 0, 0, 1000) / 1000 * sy });
  const rawTables = (Array.isArray(z.tables) ? z.tables : []).slice(0, LIMITS.tables)
    .filter((t) => t && num(t.x) !== null && num(t.y) !== null)
    .map((t) => {
      const shape = shapeOf(t.shape);
      return { at: P(t.x, t.y), shape, rotation: shape !== "rect" && shape !== "circle" && shape !== "corner" && t.vertical === true ? 1 : 0,
        name: t.name, seats: t.seats };
    });
  const rawWalls = (Array.isArray(z.walls) ? z.walls : []).slice(0, LIMITS.walls).map((w) => {
    const pts = Array.isArray(w && w.points) ? w.points : [];
    return { points: pts.filter((p) => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null).map((p) => P(p[0], p[1])), closed: !!(w && w.closed) };
  }).filter((w) => w.points.length >= 2);
  const rawLabels = (Array.isArray(z.labels) ? z.labels : []).slice(0, LIMITS.labels)
    .filter((l) => l && clean(l.text, LABEL_MAX) && num(l.x) !== null && num(l.y) !== null)
    .map((l) => ({ at: P(l.x, l.y), text: clean(l.text, LABEL_MAX) }));
  const all = [...rawTables.map((t) => t.at), ...rawWalls.flatMap((w) => w.points), ...rawLabels.map((l) => l.at)];
  if (!all.length) return null;
  const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const margin = TILE;
  // Масштаб: соседние столы — примерно в полторы плитки друг от друга
  // (берём близкие пары — 25-й процентиль), но весь план — на площадке.
  const fit = Math.min((CANVAS.w - margin * 2) / bw, (CANVAS.h - margin * 2) / bh);
  let k = Math.min(fit, (BASIS.w - margin) / bw * 1.6);
  if (rawTables.length >= 2) {
    const nn = rawTables.map((a) => Math.min(...rawTables.filter((b) => b !== a).map((b) => Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y)))).filter((d) => d > 0).sort((a, b) => a - b);
    if (nn.length) k = Math.min(fit, (TILE * 1.6) / nn[Math.floor(nn.length / 4)]);
  }
  k = Math.max(k, 0.01);
  const C = (p) => ({ x: (p.x - minX) * k + margin, y: (p.y - minY) * k + margin });

  const used = new Set();
  const placed = [];
  const tables = [];
  let moved = 0;
  // Сначала крупные — им труднее найти место.
  const order = rawTables.map((t, i) => ({ t, i, area: tileSize(t.shape, t.rotation).w * tileSize(t.shape, t.rotation).h })).sort((a, b) => b.area - a.area || a.i - b.i);
  const result = new Array(rawTables.length);
  for (const { t, i } of order) {
    const s = tileSize(t.shape, t.rotation);
    const c = C(t.at);
    const snap = (v) => Math.round(v / GRID) * GRID;
    const want = { left: clamp(snap(c.x - s.w / 2), 0, CANVAS.w - s.w), top: clamp(snap(c.y - s.h / 2), 0, CANVAS.h - s.h), w: s.w, h: s.h };
    const r = placeFree(want, placed);
    if (!r) continue;
    if (r.left !== want.left || r.top !== want.top) moved++;
    placed.push(r);
    result[i] = { t, r };
  }
  for (const item of result) {
    if (!item) continue;
    const { t, r } = item;
    const seatsN = Math.round(num(t.seats) ?? 0);
    tables.push({
      name: tableName(t.name, used),
      seats: seatsN >= 1 && seatsN <= 40 ? seatsN : t.shape === "bar" ? 6 : t.shape === "rect" || t.shape === "circle" ? 4 : 6,
      shape: t.shape, rotation: t.rotation,
      ...fraction(r.left, r.top, r),
    });
  }
  const walls = [];
  for (const w of rawWalls) {
    const pts = w.points.map(C).map((p) => [round1(clamp(p.x, 0, CANVAS.w)), round1(clamp(p.y, 0, CANVAS.h))]);
    for (let i = 0; i < pts.length; i += LIMITS.wallPoints - 1) {
      const part = pts.slice(i, i + LIMITS.wallPoints);
      if (part.length >= 2) walls.push({ points: part.flat(), closed: w.closed && i === 0 && pts.length <= LIMITS.wallPoints && part.length >= 3 });
    }
  }
  const labels = rawLabels.map((l) => { const p = C(l.at); return { text: l.text, x: round1(clamp(p.x, 0, CANVAS.w)), y: round1(clamp(p.y, 0, CANVAS.h)) }; });
  return { name: clean(z.name, ZONE_MAX), tables, walls, labels, moved, dropped: rawTables.length - tables.length };
}

/** Весь ответ ИИ → план для предпросмотра и записи. aspect — ширина/высота снимка. */
function planFromAi(parsed, aspect = 1) {
  const a = clamp(num(aspect) ?? 1, 0.2, 5);
  let zones = Array.isArray(parsed && parsed.zones) ? parsed.zones : parsed && (parsed.tables || parsed.walls) ? [parsed] : [];
  zones = zones.slice(0, LIMITS.zones).map((z) => zoneFromAi(z || {}, a)).filter((z) => z && (z.tables.length || z.walls.length));
  // Одинаковые названия зон — с номером; одна зона без названия — «Основной зал».
  const seen = new Set();
  zones.forEach((z, i) => {
    if (!z.name) z.name = zones.length === 1 ? "Основной зал" : `Зал ${i + 1}`;
    let n = z.name;
    for (let k = 2; seen.has(n.toLowerCase()); k++) n = `${z.name} ${k}`;
    z.name = n;
    seen.add(n.toLowerCase());
  });
  return { zones };
}

/** План от кабинета (владелец мог поправить названия и места) — снова в рамки. */
function sanitizePlan(plan) {
  const zones = (Array.isArray(plan && plan.zones) ? plan.zones : []).slice(0, LIMITS.zones);
  const out = [];
  const zoneNames = new Set();
  let total = 0;
  for (const z of zones) {
    const name = clean(z && z.name, ZONE_MAX);
    if (zoneNames.has(name.toLowerCase())) continue;
    zoneNames.add(name.toLowerCase());
    const used = new Set();
    const tables = [];
    for (const t of (Array.isArray(z.tables) ? z.tables : [])) {
      if (total >= LIMITS.tables || !t) break;
      const shape = SHAPES.includes(t.shape) ? t.shape : "rect";
      const rotation = clamp(Math.round(num(t.rotation) ?? 0), 0, 3);
      const s = tileSize(shape, rotation);
      const x = num(t.x), y = num(t.y);
      if (x === null || y === null) continue;
      const seats = Math.round(num(t.seats) ?? 4);
      tables.push({
        name: tableName(t.name, used), shape, rotation,
        seats: clamp(seats || 4, 1, 40),
        x: round4(clamp(x, 0, (CANVAS.w - s.w) / (BASIS.w - s.w))),
        y: round4(clamp(y, 0, (CANVAS.h - s.h) / (BASIS.h - s.h))),
      });
      total++;
    }
    const walls = (Array.isArray(z.walls) ? z.walls : []).slice(0, LIMITS.walls).map((w) => {
      const p = (Array.isArray(w && w.points) ? w.points : []).slice(0, LIMITS.wallPoints * 2).map(num);
      if (p.some((v) => v === null) || p.length % 2) return null;
      const pts = p.map((v, i) => round1(clamp(v, 0, i % 2 ? CANVAS.h : CANVAS.w)));
      return pts.length >= 4 ? { points: pts, closed: !!(w && w.closed) && pts.length >= 6 } : null;
    }).filter(Boolean);
    const labels = (Array.isArray(z.labels) ? z.labels : []).slice(0, LIMITS.labels).map((l) => {
      const text = clean(l && l.text, LABEL_MAX), x = num(l && l.x), y = num(l && l.y);
      return text && x !== null && y !== null ? { text, x: round1(clamp(x, 0, CANVAS.w)), y: round1(clamp(y, 0, CANVAS.h)) } : null;
    }).filter(Boolean);
    if (tables.length || walls.length || labels.length) out.push({ name, tables, walls, labels });
  }
  return { zones: out };
}

const busy = (d) => (Array.isArray(d.activeSessionIds) && d.activeSessionIds.length > 0) || (Array.isArray(d.openChecks) && d.openChecks.length > 0);

function createHallImport(deps) {
  const { db, admin, verifyAuth, parseJsonBody, sendJson, HttpError, requireTenantRole, aiVendor, aiComplete, extractJson, limiter, now = () => Date.now() } = deps;
  const tenant = (tid) => db().collection("tenants").doc(tid);
  const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

  async function recognize(tid, body) {
    const page = body.page;
    if (!page || !TYPES.has(page.mediaType) || typeof page.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(page.data)) {
      throw new HttpError(400, "Нужна картинка JPEG, PNG или WebP");
    }
    if (page.data.length > 960000) throw new HttpError(413, "Снимок больше 0,9 МБ — уменьшите его");
    const t = now();
    const lim = limiter.get(tid);
    if (!lim || lim.resetAt <= t) limiter.set(tid, { count: 1, resetAt: t + 3600000 });
    else if (lim.count + 1 > 60) throw new HttpError(429, "За час можно распознать до 60 снимков — продолжите позже");
    else lim.count += 1;
    const vendor = await aiVendor(tid);
    if (!vendor) throw new HttpError(412, "Подключите ИИ в разделе «ИИ» кабинета — схема распознаётся через ваш ключ");
    let parsed;
    try {
      const text = await aiComplete(vendor, {
        system: "Ты аккуратно переносишь план зала в схему. Отвечай только JSON.",
        content: [{ type: "text", text: HALL_AI_PROMPT }, { type: "image", mediaType: page.mediaType, data: page.data }],
        maxTokens: 8000, heavy: true,
      });
      parsed = extractJson(text);
    } catch (e) {
      throw new HttpError(502, `ИИ не распознал схему: ${String(e.message || e).slice(0, 160)}`);
    }
    const plan = planFromAi(parsed, body.aspect);
    const tables = plan.zones.reduce((s, z) => s + z.tables.length, 0);
    if (!plan.zones.length || (!tables && plan.zones.every((z) => z.walls.length < 1))) {
      throw new HttpError(422, "На снимке не нашлось ни столов, ни стен — сфотографируйте план ровнее и целиком");
    }
    return plan;
  }

  async function current(tid) {
    const t = tenant(tid);
    const [tables, walls, labels] = await Promise.all(["tables", "hallWalls", "hallLabels"].map((c) => t.collection(c).get()));
    return { tables: tables.docs, walls: walls.docs, labels: labels.docs };
  }

  async function commit(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db().batch();
      for (const op of ops.slice(i, i + 400)) {
        if (op.del) batch.delete(op.ref); else batch.set(op.ref, op.data);
      }
      await batch.commit();
    }
  }

  async function apply(tid, uid, body) {
    const plan = sanitizePlan(body.plan);
    if (!plan.zones.length) throw new HttpError(400, "Схема пустая — распознайте снимок ещё раз");
    const replace = body.mode === "replace";
    const t = tenant(tid);
    const cur = await current(tid);
    const zoneSet = new Set(plan.zones.map((z) => z.name));
    const ops = [];
    const removed = { tables: [], walls: [], labels: [] };
    const keptBusy = new Map(); // зона → названия столов с открытыми чеками
    if (replace) {
      for (const d of cur.tables) {
        const x = d.data() || {};
        if (d.id === "takeaway") continue;
        if (busy(x)) {
          const z = String(x.zone || "").trim();
          if (!keptBusy.has(z)) keptBusy.set(z, new Set());
          keptBusy.get(z).add(String(x.name || "").toLowerCase());
          continue;
        }
        removed.tables.push({ id: d.id, data: x });
        ops.push({ del: true, ref: t.collection("tables").doc(d.id) });
      }
      for (const [coll, list] of [["hallWalls", cur.walls], ["hallLabels", cur.labels]]) {
        for (const d of list) {
          const x = d.data() || {};
          removed[coll === "hallWalls" ? "walls" : "labels"].push({ id: d.id, data: x });
          ops.push({ del: true, ref: t.collection(coll).doc(d.id) });
        }
      }
    }
    // Названия, которые в зоне уже заняты (и останутся): новый стол — с номером.
    const taken = new Map();
    for (const d of cur.tables) {
      const x = d.data() || {};
      if (d.id === "takeaway") continue;
      const z = String(x.zone || "").trim();
      if (replace && !busy(x)) continue;
      if (!taken.has(z)) taken.set(z, new Set());
      taken.get(z).add(String(x.name || "").toLowerCase());
    }
    const created = { tables: [], walls: [], labels: [] };
    let skippedBusy = 0;
    for (const z of plan.zones) {
      const names = taken.get(z.name) || new Set();
      const busyNames = keptBusy.get(z.name) || new Set();
      for (const tb of z.tables) {
        if (busyNames.has(tb.name.toLowerCase())) { skippedBusy++; continue; }
        let name = tb.name;
        for (let k = 2; names.has(name.toLowerCase()); k++) name = `${tb.name} (${k})`;
        names.add(name.toLowerCase());
        const ref = t.collection("tables").doc();
        created.tables.push(ref.id);
        ops.push({ ref, data: { name, x: tb.x, y: tb.y, seats: tb.seats, shape: tb.shape, rotation: tb.rotation, status: "free", zone: z.name,
          activeSessionIds: [], maxOpenSessions: 2, busyUntil: null, openChecks: [] } });
      }
      for (const w of z.walls) {
        const ref = t.collection("hallWalls").doc();
        created.walls.push(ref.id);
        ops.push({ ref, data: { zone: z.name, points: w.points, closed: w.closed } });
      }
      for (const l of z.labels) {
        const ref = t.collection("hallLabels").doc();
        created.labels.push(ref.id);
        ops.push({ ref, data: { zone: z.name, text: l.text, x: l.x, y: l.y } });
      }
    }
    await commit(ops);
    await t.collection("meta").doc("hallImportUndo").set({
      at: admin.firestore.Timestamp.fromMillis(now()), by: uid, mode: replace ? "replace" : "add",
      zones: [...zoneSet], created, removed,
    });
    return {
      ok: true, zones: plan.zones.length, tables: created.tables.length, walls: created.walls.length, labels: created.labels.length,
      removedTables: removed.tables.length, keptBusy: [...keptBusy.values()].reduce((s, v) => s + v.size, 0), skippedBusy,
    };
  }

  async function undo(tid) {
    const t = tenant(tid);
    const ref = t.collection("meta").doc("hallImportUndo");
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, "Отменять нечего — импорта схемы ещё не было");
    const u = snap.data() || {};
    const ops = [];
    let keptBusy = 0;
    const created = u.created || {};
    for (const id of created.tables || []) {
      const d = await t.collection("tables").doc(id).get();
      if (!d.exists) continue;
      if (busy(d.data() || {})) { keptBusy++; continue; }
      ops.push({ del: true, ref: t.collection("tables").doc(id) });
    }
    for (const id of created.walls || []) ops.push({ del: true, ref: t.collection("hallWalls").doc(id) });
    for (const id of created.labels || []) ops.push({ del: true, ref: t.collection("hallLabels").doc(id) });
    const removed = u.removed || {};
    for (const x of removed.tables || []) ops.push({ ref: t.collection("tables").doc(x.id), data: x.data });
    for (const x of removed.walls || []) ops.push({ ref: t.collection("hallWalls").doc(x.id), data: x.data });
    for (const x of removed.labels || []) ops.push({ ref: t.collection("hallLabels").doc(x.id), data: x.data });
    await commit(ops);
    await ref.delete();
    return { ok: true, restoredTables: (removed.tables || []).length, keptBusy };
  }

  async function status(tid) {
    const snap = await tenant(tid).collection("meta").doc("hallImportUndo").get();
    if (!snap.exists) return { undo: null };
    const u = snap.data() || {};
    const at = u.at && typeof u.at.toMillis === "function" ? u.at.toMillis() : null;
    return { undo: { at, mode: u.mode, zones: u.zones || [], tables: ((u.created || {}).tables || []).length } };
  }

  async function handle(req, res) {
    const decoded = await verifyAuth(req);
    const body = await parseJsonBody(req, 1048576);
    const tid = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new HttpError(400, "Не указано заведение");
    await requireTenantRole(tid, decoded.uid, ["owner", "admin", "manager"]);
    const action = String(body.action || "recognize");
    if (action === "recognize") return sendJson(res, 200, await recognize(tid, body));
    if (action === "apply") return sendJson(res, 200, await apply(tid, decoded.uid, body));
    if (action === "undo") return sendJson(res, 200, await undo(tid));
    if (action === "status") return sendJson(res, 200, await status(tid));
    throw new HttpError(400, "Неизвестное действие");
  }

  return { handle, recognize, apply, undo, status };
}

module.exports = { createHallImport, planFromAi, sanitizePlan, tileSize, offset, overlaps, HALL_AI_PROMPT, BASIS, CANVAS, TILE };
