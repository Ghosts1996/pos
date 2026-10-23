// Живые иллюстрации инструкции: телефон с экраном кассы, касание пальца
// показывает, куда нажимать, подпись под телефоном — что происходит.
// Грузится вместе с guide.js при первом открытии инструкции.
//
// Экраны нарисованы по настоящим экранам кассы: те же подписи кнопок,
// порядок и цвета. Поменяли экран в приложении — поправьте сцену здесь.
//
// Сцена — список кадров. Кадр: экран (screen), что поверх него (over:
// меню сбоку, окно, лист снизу), как он появляется (enter) и что на нём
// делаем (acts): касание [data-tap], ввод текста, отметка [data-mark].

/* ------------------------------------------------------------------ *
 *  Иконки (линейные, как в кассе)
 * ------------------------------------------------------------------ */
const P = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14"/>',
  spark: '<path d="M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 2M9.5 2.5h5"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4 4.5 5.5 4.5 8.5S7.5 16.5 7.5 20.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5M10 18.5h4"/>',
  store: '<path d="M4 9.5 5.6 4h12.8L20 9.5M4 9.5V20h16V9.5M4 9.5h16M9.5 20v-5.5h5V20"/>',
  table: '<path d="M3.5 8.5h17M6.5 8.5V19M17.5 8.5V19M8 13h8"/>',
  tray: '<path d="M3.5 17.5h17M5.5 17.5a6.5 6.5 0 0 1 13 0M12 9V7M10 7h4"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8.5 3v4M15.5 3v4M4 10h16"/>',
  glass: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4.5 7.5 5.5 7.5 8.5S8 15.5 8 20.5M16 3.5c0 4.5-7.5 5.5-7.5 8.5s7.5 3.5 7.5 8.5"/>',
  receipt: '<path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21zM9 8h6M9 12h6M9 16h3"/>',
  cash: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
  hist: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7M12 8v4.2l3 1.8"/>',
  box: '<path d="M4 8 12 4l8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checks: '<path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
  logout: '<path d="M10 4H5.5v16H10M14.5 8l4 4-4 4M18.5 12H9.5"/>',
  dl: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M7 12h10"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.4-3.6 4.4-5.2 7.5-5.2s6.1 1.6 7.5 5.2"/>',
  users: '<circle cx="9" cy="9" r="3.5"/><path d="M2.5 19.5c1.2-3.2 3.8-4.6 6.5-4.6s5.3 1.4 6.5 4.6M15.5 5.6a3.5 3.5 0 0 1 0 6.8M18 14.9c1.6.6 2.8 2 3.5 4.6"/>',
  seat: '<path d="M6 11V8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3M4 12a1.8 1.8 0 0 1 3.6 0v2h8.8v-2a1.8 1.8 0 0 1 3.6 0v5H4zM6 17v2M18 17v2"/>',
  fork: '<path d="M7 3v7.5M5 3v4.5a2 2 0 0 0 4 0V3M7 10.5V21M17 3c-2.2 1.6-3.2 4.2-3.2 7.4h3.2V21"/>',
  hookah: '<path d="M10 3h4M12 3v3M9.5 6h5l-.8 4h-3.4zM12 10v2.5M8.5 14.5a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0zM15.5 14.5c2 0 3.5-1.5 3.5-4.5"/>',
  cup: '<path d="M6 4h12l-1.6 14.6a2 2 0 0 1-2 1.9H9.6a2 2 0 0 1-2-1.9zM6.5 9h11"/>',
  split: '<path d="M12 21v-7M12 14 6 8M12 14l6-6M4.5 4.5h4v4M19.5 4.5h-4v4"/>',
  tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  doc: '<path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6M9 16h6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.3"/><circle cx="17" cy="17" r="2.3"/>',
  printer: '<path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17M7 13.5h10v7H7z"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  chart: '<path d="M5 20V11M12 20V4.5M19 20v-6.5"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V18a2 2 0 0 0 2 2h14V8H6.5A2.5 2.5 0 0 1 4 7.5zM16.5 14h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  wifi: '<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.5a7.6 7.6 0 0 1 11 0M9.5 15.5a3.4 3.4 0 0 1 5 0M12 19h.01"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M18.5 12h.01"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 1.9-1 1.4-2.1-.6-1.3.2-2.6 1.6-2.6h1.8A3.7 3.7 0 0 0 20.5 12 8.5 8.5 0 0 0 12 3.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16 15 11l-8.5 8.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  home: '<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/>',
  star: '<path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  wall: '<path d="M4 20V5h7M11 5v6h9"/>',
  pin: '<path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  gem: '<path d="M6.5 4h11l3.5 5-9 11-9-11zM3 9h18M9.5 4 8 9l4 11 4-11-1.5-5"/>',
  bag: '<path d="M5.5 8h13l-1 12.5h-11zM9 8V6.5a3 3 0 0 1 6 0V8"/>',
  call: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  send: '<path d="M21 3.5 10.5 14M21 3.5l-6.5 17-4-6.5-6.5-4z"/>',
  truck: '<path d="M3 6.5h11v9H3zM14 9.5h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
};

const ic = (name, size = 22, sw = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

/* ------------------------------------------------------------------ *
 *  Детали экрана кассы
 * ------------------------------------------------------------------ */
const tp = (k) => (k ? ` data-tap="${k}"` : '');
const mk = (k) => (k ? ` data-mark="${k}"` : '');
const cls = (...c) => c.filter(Boolean).join(' ');

const status = (time = '19:42') =>
  `<div class="gx-status"><span>${time}</span><span style="display:flex;gap:6px;align-items:center">${ic('wifi', 13, 2)}<i></i></span></div>`;

function appBar({ title, sub = '', left = 'menu', right = [], tapLeft = '', tapRight = {}, badge = {} }) {
  return `<div class="gx-bar">
    <div class="gx-bar-btn"${tp(tapLeft)}>${ic(left === 'menu' ? 'menu' : 'back', 24)}</div>
    <div class="gx-bar-title"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
    ${right.map((r) => `<div class="gx-bar-btn" style="position:relative"${tp(tapRight[r])}>${ic(r, 22)}${badge[r]
    ? `<span class="gx-badge" style="position:absolute;top:2px;right:0;min-width:18px;height:18px;font-size:11px">${badge[r]}</span>` : ''}</div>`).join('')}
  </div>`;
}

// Столы основного зала демо: те же имена и состояния, что в демо-кассе.
const HALL = [
  { n: 'Диван 8', s: 8, sum: '7 030 ₽', note: 'День рождения', time: '−10:28', st: 'alert', bell: true },
  { n: 'Стол 1', s: 2, sum: '2 340 ₽', note: 'Аня', time: '01:04:31', st: 'busy', bell: true },
  { n: 'Бар', s: 6, sum: '500 ₽', note: 'Кирилл', time: '29:31', st: 'busy', extra: '2 чека' },
  { n: 'Стол 2', s: 2, st: 'free' },
  { n: 'Стол 3', s: 4, st: 'free' },
  { n: 'Стол 4', s: 4, st: 'free' },
  { n: 'Стол 5', s: 4, st: 'free' },
  { n: 'Стол 6', s: 6, sum: '3 890 ₽', note: 'Компания у окна', time: '09:31', st: 'warn' },
];

function tableCard(t, { tap = '', mark = '' } = {}) {
  const free = t.st === 'free';
  return `<div class="${cls('gx-t', t.st)}"${tp(tap)}${mk(mark)}>
    <div class="gx-t-top"><span class="dot"></span>${t.n}
      ${t.bell ? `<span style="margin-left:auto;color:var(--bad)">${ic('bell', 18)}</span>` : ''}
      ${t.extra ? `<span class="gx-mu gx-small" style="margin-left:auto;font-weight:400">${t.extra}</span>` : ''}</div>
    <div class="gx-t-mid"><span style="display:flex;align-items:center;gap:5px">${ic('seat', 16)} ${t.s}</span>${t.sum ? `<b>${t.sum}</b>` : ''}</div>
    <div class="gx-t-low">${free ? '<span>Свободен</span>' : `<span>${t.note}</span><span>${t.time}</span>`}</div>
  </div>`;
}

// Расстановка демо-зала на схеме (в «пикселях кассы», холст 336 × 340):
// так зал выглядит при входе — схемой, список столов спрятан.
const HALL_AT = {
  'Диван 8': [16, 16, 198], 'Бар': [228, 16], 'Стол 1': [16, 122], 'Стол 2': [122, 122],
  'Стол 3': [228, 122], 'Стол 4': [16, 228], 'Стол 5': [122, 228], 'Стол 6': [228, 228],
};

function mapTile(t, tap) {
  const [x, y, w = 92] = HALL_AT[t.n] || [16, 16];
  const free = t.st === 'free';
  return `<div class="${cls('gx-mt', t.st)}" style="left:${x}px;top:${y}px;width:${w}px"${tp(tap)}>
    ${t.bell ? `<span class="gx-mt-bell">${ic('bell', 11, 2.4)}</span>` : ''}
    <b>${t.n}</b><span class="gx-mt-s">${t.s} ${t.s < 5 ? 'места' : 'мест'}</span>
    ${free ? '<span class="gx-mt-st"><i></i>Свободен</span>' : `<span class="gx-mt-time">${t.time}</span><span class="gx-mt-sum">${t.sum}</span>`}
  </div>`;
}

function hall({ who = 'Алина', tapTable = '', tapMenu = '', tapBanner = '', tables = HALL, takeaway = 0, tapTakeaway = '', tapList = '' } = {}) {
  return `<div class="gx-app">${status()}
    ${appBar({ title: 'Зал', sub: who, left: 'menu', right: takeaway ? ['bag', 'grid', 'spark'] : ['grid', 'spark'], tapLeft: tapMenu,
    tapRight: { bag: tapTakeaway }, badge: { bag: takeaway } })}
    <div class="gx-banner">${ic('bell', 17)}<span>Гости зовут: 3 · ждут 3 мин</span><span class="gx-mu"${tp(tapBanner)}>Показать ›</span></div>
    <div class="gx-chips"><span class="gx-chip on">Основной зал</span><span class="gx-chip">2 этаж</span><span class="gx-chip">Терраса</span></div>
    <div class="gx-chips"><span class="gx-chip on">Все 11</span><span class="gx-chip"><span class="dot" style="background:var(--ok)"></span>Свободны 5</span><span class="gx-chip"><span class="dot" style="background:var(--busy)"></span>Заняты 4</span><span class="gx-chip"><span class="dot" style="background:var(--warn)"></span>Скоро освободятся 2</span></div>
    <div class="gx-map">
      <div class="gx-map-in">
        <svg class="gx-walls" viewBox="0 0 336 340" fill="none"><path d="M6 6h236M276 6h54v328H6V6"/><path d="M216 6v-0"/></svg>
        <span class="gx-map-lbl" style="left:244px;top:-1px">Вход</span>
        <span class="gx-map-lbl" style="left:132px;top:318px">Кухня</span>
        ${tables.map((t) => mapTile(t, t.n === tapTable ? 'table' : '')).join('')}
      </div>
      <div class="gx-map-pill"${tp(tapList)}>${ic('checks', 17, 2)}Показать список · 11</div>
    </div>
  </div>`;
}

// Список столов — шторкой поверх схемы (кнопка «Показать список»).
const hallList = ({ tapTable = '' } = {}) => sheet(`<div class="gx-sheet-h"><b>Столы · 11</b>${ic('plus', 20).replace('<svg', '<svg style="transform:rotate(45deg);color:var(--mu)"')}</div>
  <div class="gx-tables">${HALL.slice(0, 6).map((t) => tableCard(t, { tap: t.n === tapTable ? 'table' : '' })).join('')}</div>`);

const drawerItem = ({ icon, t, s = '', tap = '', badge = '', ok = false, chev = false, mark = '' }) =>
  `<div class="${cls('gx-di', ok && 'ok')}"${tp(tap)}${mk(mark)}>${ic(icon, 22)}
    <div class="gx-di-t"><b>${t}</b>${s ? `<span>${s}</span>` : ''}</div>
    ${badge ? `<span class="gx-badge">${badge}</span>` : ''}${chev ? `<span class="gx-mu">${ic('chev', 18)}</span>` : ''}</div>`;

function drawer({ name = 'Алина', role = 'ОФИЦИАНТ', shift = 'on', since = '18:02', tap = {} } = {}) {
  const my = shift === 'on'
    ? drawerItem({ icon: 'timer', t: 'Моя смена идёт', s: `С ${since} · нажмите, когда уходите`, ok: true, tap: tap.my })
    : drawerItem({ icon: 'timer', t: 'Моя смена не начата', s: 'Нажмите, когда пришли на работу', tap: tap.my });
  return `<div class="gx-scrim"></div><div class="gx-panel gx-drawer">
    <div class="gx-dr-head"><div class="gx-ava">${name[0]}</div><div><b>${name}</b><span>${role}</span></div></div>
    <div style="padding-top:6px">${my}
    ${drawerItem({ icon: 'store', t: 'Смена заведения открыта', s: 'С 17:40 · на смене 2: Алина, Максим', ok: true, chev: true, tap: tap.venue })}</div>
    <div class="gx-di-sep"></div>
    ${drawerItem({ icon: 'table', t: 'Зал' })}
    ${drawerItem({ icon: 'tray', t: 'Очередь заказов', s: 'Заказы и вызовы из приложения гостей', badge: '3', tap: tap.queue })}
    ${drawerItem({ icon: 'fork', t: 'Кухня и бар', s: 'Что готовить по всем столам', tap: tap.kitchen })}
    ${drawerItem({ icon: 'cal', t: 'Брони', s: 'Подтверждение и посадка гостей', tap: tap.book })}
    ${drawerItem({ icon: 'glass', t: 'Лист ожидания', s: 'Когда все столы заняты', tap: tap.wait })}
    <div class="gx-di-sep"></div>
    ${drawerItem({ icon: 'receipt', t: 'X-отчёт (текущая смена)', s: 'Продажи и оплаты без закрытия смены', tap: tap.x })}
    ${drawerItem({ icon: 'cash', t: 'Касса', s: 'Наличные, инкассация, внесение и выплата', tap: tap.cash })}
    ${drawerItem({ icon: 'hist', t: 'История чеков', s: 'Просмотр и возврат закрытых чеков', tap: tap.hist })}
  </div>`;
}

const dialog = (title, body, acts) =>
  `<div class="gx-scrim"></div><div class="gx-panel gx-dialog"><h4>${title}</h4>${body}<div class="gx-acts">${acts}</div></div>`;
const sheet = (body) => `<div class="gx-scrim"></div><div class="gx-panel gx-sheet"><div class="gx-grab"></div>${body}</div>`;
const toast = (text) => `<div class="gx-panel gx-toastbox">${ic('check', 18, 2.2)}${text}</div>`;
const btn = (label, { kind = '', tap = '', style = '', icon = '' } = {}) =>
  `<div class="${cls('gx-b', kind)}"${tp(tap)}${style ? ` style="${style}"` : ''}>${icon ? ic(icon, 18, 2) : ''}${label}</div>`;
const field = (label, { ph = '', val = '', type = '', focus = false, style = '', tap = '' } = {}) =>
  `<div class="${cls('gx-f', focus && 'focus')}"${tp(tap || type)}${type ? ` data-type="${type}"` : ''}${style ? ` style="${style}"` : ''}>
    ${label ? `<span class="gx-f-l">${label}</span>` : ''}<span class="gx-val">${val}</span><span class="gx-ph">${ph}</span></div>`;

// Экран входа по PIN.
function pinScreen({ admin = false } = {}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  const n = admin ? 6 : 4;
  return `<div class="gx-app" style="padding-top:64px">
    <div class="gx-logo">Zal<em>POS</em></div>
    <div style="text-align:center;margin:12px 0 26px;font-size:11px;letter-spacing:.2em;color:var(--br);font-weight:600">КАФЕ «ЛЕТО»</div>
    <div class="gx-seg2"><span class="${admin ? '' : 'on'}">Сотрудник</span><span class="${admin ? 'on' : ''}"${tp('admin')}${mk('admin')}>Администратор</span></div>
    <div class="gx-dots">${Array.from({ length: n }, (_, i) => `<i${mk('d' + (i + 1))}></i>`).join('')}</div>
    <div class="gx-keys">${keys.map((k) => (k ? `<div class="gx-key"${tp('k' + k)}>${k}</div>` : '<div class="gx-key blank"></div>')).join('')}</div>
  </div>`;
}

// Карточка свободного стола.
function tableFree(name = 'Стол 2') {
  return `<div class="gx-app">${status()}${appBar({ title: name, left: 'back' })}<div class="gx-sep"></div>
    <div style="display:flex;flex-direction:column;align-items:center;padding:150px 18px 0">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--el);display:flex;align-items:center;justify-content:center;color:var(--ok)">${ic('table', 30)}</div>
      <div style="font-size:21px;font-weight:600;margin-top:18px">Стол свободен</div>
      <div class="gx-mu" style="font-size:13px;margin:6px 0 22px">2 места · сеанс 1,5 часа</div>
      ${btn('Начать сеанс', { tap: 'start', icon: 'play', style: 'width:100%' })}
    </div></div>`;
}

const ACTIONS = [
  ['split', 'Разделить', 'счёт на части'], ['timer', 'Время', '± 5 · 10 · 30 мин'], ['tag', 'Подписать', 'кто за столом'],
  ['card', 'Скидка', 'по карте'], ['swap', 'Пересадить', 'за другой стол'], ['receipt', 'Ещё чек', 'отдельный счёт'],
];

// Счёт стола: таймер, действия, заказ, итог.
function tableCheck({ name = 'Стол 2', who = 'Алина', items = [], total = '0 ₽', tap = {}, strip = null } = {}) {
  const list = items.length
    ? `<div class="gx-card" style="margin:0 14px">${items.map((i) => `<div class="gx-row"${mk(i.mark)}>
        <div class="gx-row-t"><b>${i.n}</b><span>${i.p} × ${i.q}</span><span style="display:flex;align-items:center;gap:3px;font-size:11.5px;color:${i.note ? 'var(--br)' : 'var(--mu)'};${i.note ? 'font-style:italic' : ''}">${ic(i.note ? 'pen' : 'plus', 12)}${i.note || 'пожелание'}</span></div>
        <span class="gx-mu" style="display:flex;align-items:center;gap:10px">${ic('minus', 16)}<b style="color:var(--tx)">${i.q}</b>${ic('plus', 16)}</span>
        <span class="gx-price" style="min-width:62px;text-align:right">${i.sum}</span></div>`).join('')}</div>`
    : `<div class="gx-card" style="margin:0 14px;height:112px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
        <span class="gx-mu">${ic('fork', 26)}</span><b style="font-size:14.5px">Заказ пока пуст</b><span class="gx-mu gx-small">Нажмите, чтобы открыть меню</span></div>`;
  return `<div class="gx-app">${status()}${appBar({ title: name, left: 'back' })}
    <div class="gx-timer"><small>Осталось</small><strong style="color:var(--ok)">01:29:57</strong>
      <span class="gx-mu gx-small">до 21:12 · за столом 0 мин</span>
      <div style="margin-top:9px;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:var(--el);font-size:12px">${ic('user', 13)} ${who}</div></div>
    <div class="gx-acts-grid">${ACTIONS.map(([icn, t, s], i) => `<div class="gx-act"${tp(tap[icn])} style="${i === 0 ? '' : ''}">
      <span style="display:flex;align-items:center;gap:6px">${ic(icn, 15)}<b>${t}</b></span><span>${s}</span></div>`).join('')}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 14px 10px">
      <b style="font-size:17px">Заказ${items.length ? `<span class="gx-mu" style="font-weight:400;font-size:13px"> · ${items.length} ${items.length === 1 ? 'позиция' : 'позиции'}</span>` : ''}</b>
      ${btn('Добавить', { kind: 'sm', icon: 'plus', tap: tap.add })}</div>
    ${strip ? `<div class="gx-fold"${mk(strip.mark)}><div class="gx-strip">${ic('receipt', 19)}
      <div style="flex:1;min-width:0"><b style="display:block;font-size:13.5px">Новое в заказе: ${strip.n} шт.</b><span class="gx-mu" style="font-size:11.5px">бегунок ещё не печатали</span></div>
      ${btn('На кухню', { kind: 'sm', icon: 'printer', tap: strip.tap })}</div></div>` : ''}
    ${list}
    <div style="position:absolute;left:0;right:0;bottom:0;height:86px;background:var(--sf);border-top:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;padding:0 16px 8px">
      <div><div class="gx-mu gx-small">Итого</div><b style="font-size:22px">${total}</b></div>
      ${btn('Закрыть стол', { kind: 'ok', tap: tap.close, icon: 'cash', style: 'padding:0 18px' })}</div>
  </div>`;
}

const CATS = [
  ['Кальяны', 'hookah', 'linear-gradient(140deg,#4A2F22,#22180F)'], ['Завтраки', 'fork', ''], ['Салаты', 'fork', ''],
  ['Супы', 'fork', ''], ['Горячее', 'fork', ''], ['Пицца и хачапури', 'fork', ''],
  ['Чай', 'cup', 'linear-gradient(140deg,#2E3324,#181A12)'], ['Кофе', 'cup', 'linear-gradient(140deg,#3B2C22,#1C1510)'], ['Напитки', 'cup', 'linear-gradient(140deg,#24303A,#12181D)'],
];

function menuCats({ tap = '', count = 0 } = {}) {
  return `<div class="gx-app">${status()}${appBar({ title: 'Меню', left: 'back', right: ['scan'] })}
    <div class="gx-search">${ic('search', 18)}Поиск по меню…</div>
    <div class="gx-tiles" style="grid-template-columns:repeat(3,1fr)">${CATS.map(([n, icn, g]) =>
      `<div class="gx-tile" style="height:100px;${g ? `--g:${g}` : ''}"${tp(n === tap ? 'cat' : '')}>${ic(icn, 20)}<span style="font-size:13px">${n}</span></div>`).join('')}</div>
    <div class="gx-bottom">${btn(`Перейти к чеку${count ? ` (${count})` : ''}`, { tap: 'tocheck' })}</div></div>`;
}

function menuItems({ title, items, tap = '', count = 0, countMark = '' }) {
  return `<div class="gx-app">${status()}${appBar({ title, left: 'back', tapLeft: 'back' })}
    <div class="gx-tiles" style="gap:10px">${items.map((it) => `<div class="gx-card" style="height:150px;padding:12px;display:flex;flex-direction:column;justify-content:space-between;background:var(--sf)">
      <div style="height:62px;border-radius:10px;background:var(--el);display:flex;align-items:center;justify-content:center;color:var(--mu)">${ic(it.icon || 'fork', 22)}</div>
      <div><b style="display:block;font-size:13.5px;line-height:1.25">${it.n}</b>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px"><span class="gx-brass" style="font-size:12.5px;font-weight:600">${it.p}</span>
      <span style="display:flex;align-items:center;gap:6px"><span class="gx-qty"${mk(it.n === tap ? 'q' : '')}>1</span><span style="width:26px;height:26px;border-radius:50%;background:var(--pr);color:#FFF7F0;display:flex;align-items:center;justify-content:center"${tp(it.n === tap ? 'item' : '')}>${ic('plus', 15, 2.4)}</span></span></div></div>
    </div>`).join('')}</div>
    <div class="gx-bottom">${btn(`Перейти к чеку<span${mk(countMark)} class="gx-hide"${countMark ? '' : ' style="opacity:1"'}>&nbsp;(${count})</span>`, { tap: 'tocheck' })}</div></div>`;
}

function payment({ total = '1 420', tap = {}, mixed = false } = {}) {
  const row = (l, v, extra = '') => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <span style="flex:1;font-size:14px">${l}</span><div class="gx-f" style="width:132px;height:42px;justify-content:flex-end;color:var(--tx)">${v}</div>${extra}</div>`;
  const sw = (l, k) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0"${mk(k)}><span style="font-size:14px">${l}</span><span class="gx-sw"${tp(k)}></span></div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Назад', left: 'back' })}
    <div style="padding:0 16px"><div style="font-size:24px;font-weight:600;margin:2px 0 14px">К оплате: ${total} ₽</div>
    <div class="gx-card" style="padding:12px 14px;margin-bottom:12px"><b style="display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:10px"><span class="gx-brass">${ic('wallet', 18)}</span>Бонусы гостя</b>
      <div style="display:flex;gap:8px">${field('', { ph: 'Телефон гостя', style: 'flex:1;height:42px' })}${btn('Найти', { kind: 'ghost sm' })}</div></div>
    <div style="display:flex;align-items:center;gap:6px;color:var(--mu);font-size:13px;margin:0 0 14px">${ic('plus', 15)} Добавить чаевые</div>
    ${row('Наличными:', total.replace(' ', ''))}${row('Банковской картой:', '0')}${row('Оплата с терминала:', '0')}${row('За счёт заведения:', '0')}
    <div class="gx-sep" style="margin:6px 0 4px"></div>
    ${sw('Закрыть без оплаты', '')}${sw('Распечатать чек', 'print')}
    ${mixed ? `<div class="gx-unfold"${mk('print')}><div style="display:flex;align-items:center;gap:10px;padding:4px 0 4px 16px"${mk('one')}>
      <span style="flex:1;font-size:13.5px;line-height:1.3">Кальяны — отдельным чеком<br><span class="gx-mu" style="font-size:11.5px"><span class="gx-show"${mk('one')}>Два чека: «Кальяны» и «Кухня и бар»</span><span class="gx-alt"${mk('one')}>Всё одним общим чеком</span></span></span>
      <span class="gx-sw inv"${tp('one')}></span></div></div>` : ''}</div>
    <div class="gx-bottom">${btn('Оплатить', { tap: 'pay' })}</div></div>`;
}

/* ---- Админ ---- */
const ADMIN_TILES = [
  ['chart', 'Отчёты'], ['map', 'Карта зала'], ['timer', 'Длительность сеанса'], ['hourglass', 'Тайм-кафе'], ['fork', 'Меню'],
  ['box', 'Склад'], ['users', 'Сотрудники'], ['timer', 'Смены сотрудников'], ['wallet', 'Зарплата'],
];

function adminHome({ tap = '', tiles = ADMIN_TILES } = {}) {
  return `<div class="gx-app">${status()}
    <div class="gx-bar" style="padding-left:16px"><div class="gx-bar-title"><b style="font-size:17px">Админ · Ольга</b></div>
      <div class="gx-bar-btn">${ic('dl', 20)}</div><div class="gx-bar-btn">${ic('logout', 20)}</div></div>
    <div class="gx-h" style="color:var(--tx);font-size:14px">Работа заведения</div>
    <div class="gx-tiles" style="gap:10px">${tiles.map(([icn, t]) => `<div class="gx-card" style="height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px"${tp(t === tap ? 'tile' : '')}>
      ${ic(icn, 24)}<span style="font-size:13px;font-weight:500">${t}</span></div>`).join('')}</div></div>`;
}

const switchRow = (t, s, { on = false, tap = '', mark = '' } = {}) =>
  `<div class="${cls(on && 'on')}" style="display:flex;align-items:flex-start;gap:12px;padding:12px 0"${mk(mark)}>
    <div style="flex:1"><b style="display:block;font-size:14.5px">${t}</b>${s ? `<span class="gx-mu" style="font-size:12px;line-height:1.35">${s}</span>` : ''}</div>
    <span class="gx-sw"${tp(tap)}></span></div>`;

/* ---- Кабинет (сайт) ----
   Один и тот же экран кабинета рисуется двумя способами: на широкой
   странице — окно браузера с меню слева, на телефоне — мобильная версия
   сайта в рамке телефона: адресная строка, кнопка ☰ и название раздела. */
const WEB_NAV = [['home', 'Обзор'], ['phone', 'Устройства'], ['card', 'Оплата'], ['gem', 'Тарифы'], ['palette', 'Брендинг'], ['users', 'Команда'], ['spark', 'ИИ'], ['gear', 'Настройки']];
function web(active, main, { tap = {} } = {}) {
  // Переход в другой раздел: на широкой странице — пункт меню слева, на
  // телефоне — кнопка ☰ (у проигрывателя тот же ключ касания).
  const navKey = Object.values(tap)[0] || '';
  return `<div class="gx-web">
    <div class="gx-web-m">${status()}<div class="gx-web-url">${ic('lock', 11, 2.2)}zalpos.ru</div>
      <div class="gx-web-top"><span class="gx-web-burger"${tp(navKey)}>${ic('menu', 22)}</span><b>${active}</b><span class="gx-web-brand">Zal<em>POS</em></span></div></div>
    <div class="gx-web-nav"><div class="gx-web-brand">Zal<em>POS</em></div>
    ${WEB_NAV.map(([icn, t]) => `<div class="${cls('gx-web-ni', t === active && 'on')}"${tp(tap[t])}>${ic(icn, 18)}${t}</div>`).join('')}</div>
    <div class="gx-web-main">${main}</div></div>`;
}

// Лендинг и первые шаги — без меню кабинета. [url] — что в адресной
// строке (у сайта сервиса ИИ — не наш адрес).
function webPage(main, { url = 'zalpos.ru' } = {}) {
  return `<div class="gx-web gx-web-page">
    <div class="gx-web-m">${status()}<div class="gx-web-url">${ic('lock', 11, 2.2)}${url}</div></div>
    <div class="gx-web-main">${main}</div></div>`;
}
const wField = (label, { val = '', ph = '', type = '', tap = '' } = {}) =>
  `<div class="gx-wf"${tp(tap || type)}${type ? ` data-type="${type}"` : ''}>${label ? `<span class="gx-wf-l">${label}</span>` : ''}<span class="gx-wf-box"><span class="gx-val">${val}</span><span class="gx-ph">${ph}</span></span></div>`;
const wCheck = (label, k) => `<div class="gx-wc"${mk(k)}><span class="gx-wc-box"${tp(k)}>${ic('check', 13, 3)}</span><span>${label}</span></div>`;
const wBtn = (label, { tap = '', ghost = false, style = '' } = {}) =>
  `<div class="${cls('gx-web-btn', ghost && 'ghost')}"${tp(tap)}${style ? ` style="${style}"` : ''}>${label}</div>`;

// Регистрация: email и согласия на сайте.
function webSignup() {
  return webPage(`<div class="gx-web-hero"><div class="gx-web-brand big">Zal<em>POS</em></div>
    <h3>Касса, зал и гости — в одном приложении</h3><div class="gx-mu">7 дней бесплатно, без карты</div></div>
    <div class="gx-web-card gx-web-narrow">
      ${wField('Email', { type: 'mail', ph: 'you@example.com' })}
      ${wCheck('Принимаю условия оферты', 'c1')}${wCheck('Согласен на обработку персональных данных', 'c2')}
      ${wBtn('Попробовать бесплатно', { tap: 'go', style: 'width:100%;justify-content:center;margin-top:12px' })}</div>`);
}
function webCheckMail() {
  return webPage(`<div class="gx-web-card gx-web-narrow" style="text-align:center;padding:28px 22px">
    <div style="width:58px;height:58px;border-radius:50%;margin:0 auto 14px;background:var(--s2);color:var(--pr);display:flex;align-items:center;justify-content:center">${ic('mail', 28)}</div>
    <h3 style="font-size:26px">Проверьте почту</h3>
    <div class="gx-mu" style="font-size:14px;line-height:1.5;margin-top:8px">Отправили ссылку для входа на <b style="color:var(--tx)">olga@kafe-leto.ru</b>. Откройте письмо и перейдите по ссылке — без пароля.</div></div>`);
}
// Первое заведение: название, код, тип.
function webOnboarding() {
  return webPage(`<h3>Новое заведение</h3><div class="gx-mu" style="margin-bottom:12px">Название и тип — остальное можно поменять потом</div>
    <div class="gx-web-card gx-web-narrow" style="margin-top:0">
      ${wField('Название заведения', { type: 'vname', ph: 'Кафе «Лето»' })}
      ${wField('Код заведения', { val: '<span class="gx-alt" data-mark="slug">kafe-leto</span>', ph: '<span class="gx-show" data-mark="slug">kafe-leto</span>' })}
      ${wField('Тип заведения', { val: '<span class="gx-show" data-mark="kind">Кальянная / лаунж</span><span class="gx-alt" data-mark="kind">Кафе / кофейня</span>', tap: 'kind' })}
      ${wBtn('Создать заведение', { tap: 'create', style: 'width:100%;justify-content:center;margin-top:6px' })}</div>`);
}
// Обзор кабинета: первые шаги.
function webOverview({ tap = {} } = {}) {
  const step = (t, done) => `<div class="gx-web-row"><span class="${cls('gx-web-tick', done && 'on')}">${ic('check', 12, 3)}</span><span style="flex:1">${t}</span><span class="gx-web-link">Открыть</span></div>`;
  return web('Обзор', `<h3>Добрый вечер, Ольга</h3><div class="gx-mu">Кафе «Лето» · пробный период, осталось 7 дней</div>
    <div class="gx-web-card"><h5>Настройка заведения</h5>
      ${step('Настроить фирменные цвета и лого', true)}${step('Пригласить первого сотрудника')}${step('Собрать и установить APK на планшет')}</div>`, { tap });
}

// Команда: сотрудники кассы с PIN и доступ к кабинету.
// saved / invited — форма уже очищена, новый человек в списке.
function webTeam({ tap = {}, saved = false, invited = false } = {}) {
  const added = (on, k) => (on ? '<div>' : `<div class="gx-unfold"${mk(k)}>`);
  return web('Команда', `<h3>Команда</h3>
    <div class="gx-web-card"><h5>Сотрудники кассы (вход по PIN)</h5>
      <div class="gx-web-row" style="border-top:none"><span style="flex:1">Алина<br><span class="gx-mu" style="font-size:12px">Сотрудник · PIN •••• · Официант</span></span><span class="gx-web-link">Изменить</span></div>
      ${added(saved, 'saved')}<div class="gx-web-row"><span style="flex:1">Марина<br><span class="gx-mu" style="font-size:12px">Сотрудник · PIN •••• · Бармен</span></span><span class="gx-web-link">Изменить</span></div></div>
      <div class="gx-cols" style="margin-top:12px">
        ${wField('Имя', { type: 'ename', ph: 'Имя для кассы' })}
        ${wField('PIN-код', { type: 'epin', ph: '0000' })}
        ${wField('Специализация', { val: '<span class="gx-show" data-mark="pos">Универсал</span><span class="gx-alt" data-mark="pos">Бармен</span>', tap: 'pos' })}
        <div style="display:flex;align-items:flex-end">${wBtn('Сохранить', { tap: 'esave', ghost: true })}</div></div></div>
    <div class="gx-web-card"><h5>Доступ к кабинету</h5>
      <div class="gx-web-row" style="border-top:none"><span style="flex:1">olga@kafe-leto.ru <span class="gx-mu">(вы)</span><br><span class="gx-mu" style="font-size:12px">Владелец</span></span></div>
      ${added(invited, 'invited')}<div class="gx-web-row"><span style="flex:1">anna@kafe-leto.ru<br><span class="gx-mu" style="font-size:12px">Менеджер</span></span></div></div>
      <div class="gx-cols" style="margin-top:12px">
        ${wField('Пригласить по email', { type: 'imail', ph: 'coworker@example.com' })}
        ${wField('Роль', { val: '<span class="gx-show" data-mark="role">Сотрудник</span><span class="gx-alt" data-mark="role">Менеджер</span>', tap: 'role' })}
        <div style="display:flex;align-items:flex-end">${wBtn('Пригласить', { tap: 'invite', ghost: true })}</div></div></div>`, { tap });
}

// Тарифы: карточки, срок оплаты, кто платит.
function webPlans({ tap = {} } = {}) {
  const plan = (n, t, cur, k) => `<div class="${cls('gx-web-plan', cur && 'cur')}">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:16px">${n}</b>${cur ? '<span class="gx-web-badge">Ваш тариф</span>' : ''}</div>
    <div class="gx-mu" style="font-size:12px;margin:2px 0 10px">${t}</div><div class="gx-web-sk"></div>
    ${k ? `${wField('', { val: '<span class="gx-show" data-mark="year">Оплатить на месяц</span><span class="gx-alt" data-mark="year">Оплатить на год (выгоднее)</span>', tap: 'period' })}` : ''}
    ${wBtn(cur ? 'Оплатить' : 'Перейти и оплатить', { tap: k ? 'pay' : '', ghost: !k, style: 'width:100%;justify-content:center;margin-top:8px' })}</div>`;
  return web('Тарифы', `<h3>Тарифы</h3>
    <div class="gx-web-plans">${plan('Старт', 'Касса, зал, брони', false)}${plan('Бизнес', 'Плюс ИИ-помощники', true, true)}${plan('Про', 'Без лимита сотрудников', false)}</div>
    <div class="gx-web-payer"><b style="font-size:13px">Кто платит</b>
      <div class="gx-wc on"><span class="gx-wc-box radio"></span><span>Физическое лицо — картой или по СБП</span></div>
      <div class="gx-wc"><span class="gx-wc-box radio"></span><span>ИП или организация — счёт на оплату</span></div></div>`, { tap });
}
function webBilling() {
  return web('Оплата', `<h3>Оплата</h3>
    <div class="gx-web-card"><div class="gx-mu" style="font-size:13.5px;line-height:1.7">Тариф: Бизнес<br>Статус: <b style="color:#3F8A5C">Активна</b><br>Оплачено до: 3 октября 2027</div>
      ${wBtn('Отключить автопродление', { ghost: true, style: 'margin-top:12px' })}</div>
    <div class="gx-web-card"><h5>История платежей</h5><div class="gx-web-row" style="border-top:none"><span style="flex:1" class="gx-mu">сегодня, 19:46 · подписка на год</span><b>чек на email</b></div></div>`);
}

// ИИ: включить, провайдер, ключ, модель, проверка связи.
function webAi({ tap = {} } = {}) {
  return web('ИИ', `<h3>ИИ-помощники</h3><div class="gx-mu">Ассистент зала в кассе и помощник гостя в приложении</div>
    <div class="gx-web-card">${wCheck('Включить ИИ-помощников (касса и консьерж в гостевом приложении)', 'ai')}
      <div class="gx-cols" style="margin-top:10px">${wField('Основной провайдер', { val: 'Tooken Club' })}${wField('API-ключ', { type: 'key', ph: 'вставьте ключ' })}${wField('Модель', { val: 'gpt-4o-mini' })}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${wBtn('Сохранить', { tap: 'aisave' })}${wBtn('Проверить связь', { tap: 'aitest', ghost: true })}</div>
      <div class="gx-unfold"${mk('ok')}><div class="gx-web-ok">${ic('check', 15, 2.6)}Связь есть: Tooken Club ответил «OK»</div></div></div>`, { tap });
}

// Сайт сервиса ИИ — схематично: баланс и ключи. Настоящий кабинет
// сервиса выглядит по-своему, важны шаги, а не кнопки один в один.
function webAiProvider() {
  return webPage(`<h3>Личный кабинет сервиса</h3><div class="gx-mu" style="margin-bottom:4px">Один ключ — к GPT, Claude и DeepSeek</div>
    <div class="gx-web-card gx-web-narrow"><h5>Баланс</h5>
      <div style="display:flex;align-items:center;gap:14px"><b style="font-size:24px"><span class="gx-show"${mk('paid')}>0 ₽</span><span class="gx-alt"${mk('paid')}>300 ₽</span></b>${wBtn('Пополнить', { tap: 'topup', ghost: true })}</div></div>
    <div class="gx-web-card gx-web-narrow"><h5>API-ключи</h5>
      <div class="gx-unfold"${mk('key')}><div class="gx-web-key"><code>sk-••••••••••••7f3a</code><span class="gx-web-link"${tp('copy')}><span class="gx-show"${mk('copied')}>Скопировать</span><span class="gx-alt"${mk('copied')}>Скопировано ✓</span></span></div></div>
      ${wBtn('Создать ключ', { tap: 'newkey', style: 'margin-top:8px' })}</div>`, { url: 'сайт сервиса ИИ' });
}

/* ---- Ещё экраны ---- */
function splitScreen({ people = 2, each = '750 ₽', total = '1 500 ₽', tap = '' } = {}) {
  const round = (icn, k, on) => `<div style="width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${on ? 'var(--sel2)' : 'var(--el)'};color:${on ? 'var(--tx)' : 'var(--mu)'}"${tp(k)}>${ic(icn, 24)}</div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Разделить счёт', left: 'back' })}
    <div style="padding:4px 14px">
      <div class="gx-seg2" style="width:100%;margin-bottom:14px"><span class="on">${ic('check', 14, 2.2)}&nbsp;Поровну</span><span>${ic('checks', 15)}&nbsp;По позициям</span></div>
      <div class="gx-card" style="padding:18px 16px;text-align:center"><div class="gx-mu" style="font-size:13px">Сколько человек платят</div>
        <div style="display:flex;align-items:center;justify-content:center;gap:34px;margin-top:10px">${round('minus', '', false)}
        <b style="font-size:40px;min-width:34px"><span class="gx-show"${mk('n')}>${people}</span><span class="gx-alt"${mk('n')}>${people + 1}</span></b>${round('plus', tap, true)}</div></div>
      <div class="gx-card" style="padding:18px 16px;text-align:center;margin-top:12px"><div class="gx-mu" style="font-size:13px">С каждого</div>
        <b style="display:block;font-size:34px;color:var(--ok);margin:4px 0"><span class="gx-show"${mk('n')}>${each}</span><span class="gx-alt"${mk('n')}>500 ₽</span></b>
        <span class="gx-mu" style="font-size:13px">Счёт ${total}</span></div>
      <p class="gx-mu" style="font-size:12.5px;line-height:1.45;margin:14px 2px 0">Оплату принимайте на экране «Закрыть стол» — по частям: наличными, картой, с терминала.</p>
    </div></div>`;
}

const reqCard = ({ table, min, text, tone = 'warn', body = '', acts = '' }) =>
  `<div class="gx-card" style="padding:14px 14px 12px;margin-bottom:10px;border-color:${tone === 'ok' ? 'var(--okb)' : 'rgba(217,168,78,.6)'};border-width:1.5px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:16px">${table}</b>
    <span style="font-size:11.5px;padding:3px 8px;border-radius:9px;background:${tone === 'ok' ? 'rgba(109,178,135,.18)' : 'rgba(217,168,78,.2)'};color:${tone === 'ok' ? 'var(--ok)' : 'var(--warn)'};font-weight:600">${min}</span></div>
    <div class="gx-mu" style="font-size:12.5px;margin:3px 0 10px">${text}</div>${body}${acts}</div>`;

function queueScreen({ accepted = false } = {}) {
  return `<div class="gx-app">${status()}${appBar({ title: 'Очередь заказов', left: 'back' })}<div style="padding:4px 14px">
    <div${mk('gone')} class="gx-fold">${reqCard({ table: 'Стол 1', min: '1 мин', text: 'Заказ из приложения · 710 ₽', tone: 'ok',
      body: '<div style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Чизкейк Нью-Йорк ×1<br>Латте ×1</div>',
      acts: `<div style="display:flex;align-items:center;gap:8px">${btn('Принять в чек', { kind: 'ok sm', tap: 'accept', style: 'flex:1' })}${btn('Отклонить', { kind: 'text', style: 'height:38px;font-size:13.5px' })}</div>` })}</div>
    ${reqCard({ table: 'Диван 8', min: '4 мин', text: 'Счёт, пожалуйста', acts: btn('Выполнено', { kind: 'sm', style: 'background:#D9A84E;color:#1D160C' }) })}
    ${reqCard({ table: 'Стол 1', min: '2 мин', text: 'Поменять угли', acts: btn('Выполнено', { kind: 'sm', style: 'background:#D9A84E;color:#1D160C' }) })}
    ${accepted ? '' : ''}</div></div>`;
}

const bookCard = ({ time, name, info, note, acts, mark = '' }) =>
  `<div class="gx-card" style="padding:12px 12px 10px;margin-bottom:10px">
    <div style="display:flex;gap:10px;align-items:flex-start"><span style="padding:5px 8px;border-radius:8px;background:var(--sel2);color:var(--br);font-weight:700;font-size:13px">${time}</span>
    <div style="flex:1"><b style="font-size:15px">${name}</b><div class="gx-mu" style="font-size:11.5px;line-height:1.35"${mk(mark)}><span class="gx-show"${mk(mark)}>${info}</span><span class="gx-alt"${mk(mark)}>${info.replace('Новая', 'Подтверждена')}</span></div></div></div>
    <div style="font-size:12.5px;font-style:italic;color:var(--mu);margin:8px 0 10px">«${note}»</div>${acts}</div>`;

function bookingsScreen() {
  return `<div class="gx-app">${status()}${appBar({ title: 'Брони', sub: 'сегодня', left: 'back', right: ['spark', 'cal'] })}<div style="padding:4px 12px">
    ${bookCard({ time: '20:30', name: 'Игорь · 6 чел.', info: 'Стол 6 · 180 мин · Новая · из приложения', note: 'Будем с коллегами', mark: 'conf',
      acts: `<div style="display:flex;gap:8px;margin-bottom:8px">${btn('Подтвердить', { kind: 'sm', tap: 'confirm', style: 'flex:1' })}${btn('Сменить стол', { kind: 'ghost sm', style: 'flex:1' })}</div>
      <div style="display:flex;gap:8px;align-items:center">${btn('Посадить', { kind: 'sm', tap: 'seat' })}<span class="gx-mu" style="font-size:12.5px;padding:0 6px">Не пришёл</span><span style="font-size:12.5px;color:var(--bad)">Отменить</span></div>` })}
    ${bookCard({ time: '21:15', name: 'Мария · 4 чел.', info: 'Стол 7 · 120 мин · Подтверждена', note: 'Отмечаем повышение',
      acts: `<div style="display:flex;gap:8px">${btn('Сменить стол', { kind: 'ghost sm' })}${btn('Посадить', { kind: 'sm' })}</div>` })}
    </div>
    <div style="position:absolute;right:14px;bottom:22px">${btn('Бронь по телефону', { icon: 'plus', style: 'border-radius:24px;padding:0 18px;box-shadow:0 8px 20px rgba(0,0,0,.4)' })}</div></div>`;
}

const venueSheet = sheet(`<b style="display:block;font-size:19px">Смена заведения</b><span class="gx-mu" style="font-size:12.5px">Открыта в 12:00 · открыл(а) Ольга</span>
  <div style="font-weight:600;font-size:13.5px;margin:14px 0 8px">Сейчас на смене · 2</div>
  <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:5px 0"><span>Максим · кальянщик</span><span class="gx-mu">с 12:05</span></div>
  <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:5px 0 12px"><span>Алина · официант</span><span class="gx-mu">с 17:40</span></div>
  ${btn('X-отчёт', { icon: 'receipt', style: 'margin-bottom:10px' })}${btn('Закрыть смену заведения', { kind: 'ghost', tap: 'closev', style: 'color:#E07A5F;border-color:rgba(212,85,63,.4)' })}`);

function closeDialog() {
  const line = (l, v, b) => `<div style="display:flex;justify-content:space-between;font-size:${b ? 14 : 12.5}px;${b ? 'font-weight:600;color:var(--tx)' : 'color:var(--mu)'};padding:2px 0"><span>${l}</span><span>${v}</span></div>`;
  return dialog('Закрытие смены', `<div style="background:var(--sf);border-radius:12px;padding:10px 12px;margin-bottom:14px">
      ${line('Должно быть в кассе', '12 580 ₽', true)}${line('Размен на начало смены', '5 000 ₽')}${line('+ наличные за чеки', '7 580 ₽')}</div>
    ${field('Насчитали наличных', { type: 'cnt', focus: true, ph: '' })}
    <div style="font-weight:600;color:var(--ok);font-size:13px;margin:6px 2px 10px" class="gx-hide"${mk('ok')}>Сходится</div>
    ${field('Оставить на размен', { val: '5000', style: 'height:46px' })}
    <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:14px"><b>Инкассация</b><b>7 580 ₽</b></div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Закрыть смену', { kind: 'sm', tap: 'done' })}`);
}

function menuEditor({ kind = 'Кухня (по названию)', tap = '' } = {}) {
  const row = (n, sub, icn, k) => `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--bd)">
    <div class="gx-ico" style="background:var(--el);color:var(--mu)">${ic('fork', 18)}</div>
    <div style="flex:1;min-width:0"><b style="display:block;font-size:14.5px">${n}</b><span class="gx-mu" style="font-size:11.5px">${sub}</span></div>
    <span style="color:var(--mu)"${tp(k)}>${ic(icn, 19)}</span><span class="gx-mu">${ic('pen', 18)}</span><span class="gx-mu">${ic('chev', 16)}</span></div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Меню', left: 'back', right: ['grid'] })}
    ${row('Кальяны', '5 позиций · Кальяны (по названию)', 'hookah')}
    ${row('Завтраки', '4 позиции · Кухня (по названию)', 'fork')}
    ${row('Чай', '5 позиций · Бар и напитки (по названию)', 'cup')}
    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--bd)">
      <div class="gx-ico" style="background:var(--el);color:var(--mu)">${ic('fork', 18)}</div>
      <div style="flex:1;min-width:0"><b style="display:block;font-size:14.5px">Авторские</b><span class="gx-mu" style="font-size:11.5px"><span class="gx-show"${mk('k')}>6 позиций · ${kind}</span><span class="gx-alt"${mk('k')}>6 позиций · Бар и напитки</span></span></div>
      <span style="color:var(--mu)"${tp(tap)}><span class="gx-show"${mk('k')}>${ic('fork', 19)}</span><span class="gx-alt"${mk('k')}>${ic('cup', 19)}</span></span><span class="gx-mu">${ic('pen', 18)}</span><span class="gx-mu">${ic('chev', 16)}</span></div>
    ${row('Десерты', '5 позиций · Кухня (по названию)', 'fork')}
    ${row('Лимонады', '5 позиций · Бар и напитки (по названию)', 'cup')}
    ${row('Снеки', '4 позиции · Кухня (по названию)', 'fork')}</div>`;
}

const kindPopup = `<div class="gx-panel gx-pop" style="right:70px;top:268px">
  <div class="gx-mu" style="font-size:12.5px;padding:10px 16px 6px">Что в категории</div>
  ${['Кухня', 'Бар и напитки', 'Кальяны'].map((k) => `<div style="display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:14.5px"${tp(k === 'Бар и напитки' ? 'bar' : '')}><span style="width:18px"></span>${k}</div>`).join('')}
  <div style="display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:14.5px"><span style="width:18px;color:var(--br)">${ic('check', 18, 2.2)}</span>По названию</div></div>`;

function employeesScreen({ barSummary = '220 ₽ в час', tap = '' } = {}) {
  const card = (l, n, role, sum, k) => `<div class="gx-card" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:9px"${tp(k)}>
    <div class="gx-ava" style="width:40px;height:40px;font-size:16px">${l}</div>
    <div style="flex:1;min-width:0"><b style="font-size:15px">${n}</b><div style="display:flex;gap:6px;align-items:center;margin-top:3px">
    <span style="font-size:11px;padding:2px 8px;border-radius:9px;background:var(--sel2)">${role}</span><span class="gx-mu" style="font-size:11.5px">${sum}</span></div></div>
    <span class="gx-mu">${ic('chev', 16)}</span></div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Сотрудники', left: 'back' })}<div style="padding:4px 12px">
    ${card('А', 'Алина', 'Официант', '2 000 ₽ за смену · 3% с чеков')}
    ${card('Д', 'Денис', 'Бармен', `<span class="gx-show"${mk('saved')}>${barSummary}</span><span class="gx-alt"${mk('saved')}>220 ₽ в час · 5% с бара</span>`, tap)}
    ${card('М', 'Максим', 'Кальянщик', '250 ₽ в час · 10% с кальянов')}</div>
    <div style="position:absolute;right:14px;bottom:22px">${btn('Добавить', { icon: 'user', style: 'border-radius:24px;padding:0 18px' })}</div></div>`;
}

function payForm() {
  const pct = (label, k, hint) => `<div style="margin:12px 0 4px">${field('', { type: k, ph: label, style: 'height:46px' })}</div>${hint ? `<div class="gx-mu" style="font-size:11px;line-height:1.35;margin:0 2px 4px">${hint}</div>` : ''}`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Денис', left: 'back' })}<div style="padding:0 14px">
    <div class="gx-card" style="padding:14px">
      <b style="display:flex;align-items:center;gap:8px;font-size:16px;margin-bottom:10px"><span class="gx-brass">${ic('wallet', 19)}</span>Зарплата</b>
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Оплата времени</div>
      <div class="gx-seg2" style="width:100%;height:38px"><span>Нет</span><span class="on">За час</span><span>За смену</span></div>
      <div style="margin-top:12px">${field('₽ в час', { val: '220', style: 'height:44px' })}</div>
      ${switchRow('Переработка', 'Доплата за каждый час сверх нормы смены')}
      ${switchRow('Проценты с продаж', 'Только с денег, которые заведение реально получило', { tap: 'pct', mark: 'pct' })}
      <div class="gx-hide"${mk('pct')}>
        ${pct('С чеков, которые он вёл', 'chk')}
        ${pct('С кальянов', 'hk')}
        ${pct('С бара и напитков', 'bar', 'Напитки, алкоголь, коктейли, кофе — то, что он сам добавил в чек, и поровну с остального бара смены.')}
      </div></div></div>
    <div class="gx-bottom" style="background:linear-gradient(180deg,rgba(21,18,15,0),var(--bg) 30%)">${btn('Сохранить', { icon: 'check', tap: 'save' })}</div></div>`;
}

function payrollScreen() {
  const row = (l, m, v, k) => `<div style="display:flex;gap:8px;font-size:12px;padding:3px 0"${mk(k)}><span style="flex:1"><span style="color:var(--tx)">${l}:</span> <span class="gx-mu">${m}</span></span><span>${v}</span></div>`;
  const card = (n, meta, rows, total, k) => `<div class="gx-card" style="padding:12px 14px;margin-bottom:10px"${tp(k)}>
    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><b style="font-size:15px">${n}</b><span class="gx-mu" style="font-size:11.5px">${meta}</span></div>
    ${rows}<div style="display:flex;justify-content:space-between;border-top:1px solid var(--bd);margin-top:6px;padding-top:7px"><b style="font-size:13.5px">К выплате</b><b class="gx-brass" style="font-size:15px">${total}</b></div></div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Зарплата', left: 'back' })}<div style="padding:0 12px">
    <div class="gx-chips" style="padding:0"><span class="gx-chip">Пол-месяца</span><span class="gx-chip on"${tp('month')}>Этот месяц</span><span class="gx-chip">Прошлый месяц</span></div>
    <div class="gx-mu" style="font-size:12px;margin:0 2px 10px">01.10 – 31.10 · 3 сотрудника · Итого: 112 480 ₽</div>
    ${card('Максим', '14 смен · 142 ч', row('Обычные часы', '142 ч × 250 ₽', '35 500 ₽') + row('С кальянов', '10% от 186 000 ₽ (свои 171 000 ₽, доля смены 15 000 ₽)', '18 600 ₽', 'hk') + row('Чаевые', 'от гостей, не зарплата', '4 300 ₽'), '54 100 ₽', 'max')}
    ${card('Алина', '13 смен · 128 ч', row('Оклад за смену', '13 × 2 000 ₽', '26 000 ₽') + row('С чеков', '3% от 214 000 ₽', '6 420 ₽'), '32 420 ₽')}
    ${card('Денис', '12 смен · 118 ч', row('Обычные часы', '118 ч × 220 ₽', '25 960 ₽'), '25 960 ₽')}</div></div>`;
}

function printerSettings({ tickets = false } = {}) {
  return `<div class="gx-app">${status()}${appBar({ title: 'Интеграции', left: 'back' })}<div style="padding:0 14px">
    <div class="gx-card" style="padding:14px">
      <b style="display:flex;align-items:center;gap:8px;font-size:16px"><span class="gx-brass">${ic('printer', 19)}</span>Чековый принтер</b>
      <div class="gx-mu" style="font-size:11.5px;margin:4px 0 12px">Печатается информационный чек (не фискальный).</div>
      <div class="gx-seg2" style="width:100%;height:38px;margin-bottom:12px"><span>Не подключён</span><span class="on">Bluetooth</span><span>Wi‑Fi / LAN</span></div>
      <div style="display:flex;align-items:center;gap:10px;font-size:13.5px;margin-bottom:6px"><span class="gx-brass">${ic('printer', 17)}</span><span style="flex:1">XP-58 · подключён</span><span style="color:#D98A5C;font-size:12.5px">Выбрать устройство</span></div>
      ${switchRow('Кальяны — отдельным чеком', tickets ? '' : 'Два чека: «Кальяны» и «Кухня и бар», каждый со своим итогом. При оплате можно переключить для конкретного счёта.', { tap: tickets ? '' : 'split', mark: tickets ? '' : 'split', on: tickets })}
      ${tickets ? switchRow('Бегунки на кухню и бар', 'В счёте стола появится кнопка «На кухню»: печатает только новые позиции, отдельным листком для каждого цеха.', { tap: 'kt', mark: 'kt' }) : ''}
      ${btn('Тестовая печать', { kind: 'ghost sm', icon: 'printer', style: 'margin-top:6px' })}</div></div></div>`;
}

const slip = (title, lines, total, note, delay) => `<div class="gx-slip" style="animation-delay:${delay}ms">
  <div style="text-align:center;font-weight:700;font-size:14px;${title ? '' : 'margin-bottom:6px'}">КАФЕ «ЛЕТО»</div>
  ${title ? `<div style="text-align:center;font-weight:700;font-size:13px;margin:2px 0 6px">${title}</div>` : ''}
  <div style="text-align:center;font-size:11px">Стол: Стол 2 · Официант: Алина</div>
  <div class="gx-slip-hr"></div>${lines.map(([n, v]) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1px 0"><span>${n}</span><span>${v}</span></div>`).join('')}
  <div class="gx-slip-hr"></div><div style="display:flex;justify-content:space-between;font-weight:700;font-size:13px"><span>ИТОГО</span><span>${total}</span></div>
  ${note ? `<div style="text-align:center;font-size:10.5px;margin-top:6px">${note}</div>` : ''}</div>`;

// Один общий чек — «Кальяны — отдельным чеком» выключили при оплате.
const receiptOne = `<div class="gx-scrim"></div><div class="gx-panel gx-slips">
  ${slip('', [['Классический кальян x1', '1200'], ['Сок яблочный x1', '220']], '1420', '', 0)}</div>`;

// Бегунки: по листку на цех, без цен, крупно.
const ticket2 = (title, lines, delay) => `<div class="gx-slip" style="animation-delay:${delay}ms;width:228px">
  <div style="text-align:center;font-weight:800;font-size:19px;letter-spacing:.04em">${title}</div>
  <div style="text-align:center;font-weight:800;font-size:16px;margin:1px 0 2px">Стол 5</div>
  <div style="text-align:center;font-size:10.5px">Марина, официант Максим · 21:14</div>
  <div class="gx-slip-hr"></div>${lines.map(([n, note]) => `<div style="font-weight:700;font-size:14px;padding:2px 0">${n}</div>${note ? `<div style="font-size:11.5px;padding:0 0 2px 14px">! ${note}</div>` : ''}`).join('')}</div>`;
const kitchenTickets = `<div class="gx-scrim"></div><div class="gx-panel gx-slips">
  ${ticket2('КУХНЯ', [['2 x Паста карбонара', 'без лука'], ['1 x Том ям с креветками', '']], 0)}
  ${ticket2('БАР', [['2 x Мохито', 'без сахара']], 650)}</div>`;

const receipts = `<div class="gx-scrim"></div><div class="gx-panel gx-slips">
  ${slip('Кальяны', [['Классический кальян x1', '1200']], '1200', 'Кухня и бар — отдельным чеком', 0)}
  ${slip('Кухня и бар', [['Сок яблочный x1', '220']], '220', '', 650)}</div>`;

function hallEditor({ placed = false } = {}) {
  const t = (n, x, y, w, h, round, k = '', extra = '') => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${round ? '50%' : '8px'};border:1.5px solid #5A5148;background:#24201C;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;color:var(--tx)${extra}"${tp(k)}${mk(k)}>${n}</div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Карта зала', left: 'back' })}
    <div class="gx-chips"><span class="gx-chip on">${ic('pen', 13)} Основной зал · 11</span><span class="gx-chip">2 этаж · 9</span><span class="gx-chip">+ Зона</span></div>
    <div class="gx-mu" style="font-size:11px;line-height:1.4;padding:0 14px 10px">Нажмите на стол — появятся стрелки, поворот и настройки. Или удерживайте его: зелёная рамка покажет, куда он встанет.</div>
    <div style="position:relative;margin:0 12px;height:400px;border-radius:14px;background:repeating-linear-gradient(0deg,transparent 0 23px,rgba(255,255,255,.035) 23px 24px),repeating-linear-gradient(90deg,transparent 0 23px,rgba(255,255,255,.035) 23px 24px),#1A1714;border:1px solid var(--bd);overflow:hidden">
      <div style="position:absolute;left:10px;top:10px;right:10px;bottom:10px;border:2px solid #6B6157;border-radius:4px"></div>
      ${t('Бар', 26, 26, 120, 44, false)}${t('Стол 1', 200, 26, 54, 54, true)}${t('Стол 2', 266, 26, 54, 54, true)}
      ${t('Стол 3', 26, 110, 66, 52, false)}${t('Стол 4', 110, 110, 66, 52, false)}${t('Стол 5', 200, 110, 66, 52, false)}
      ${t('Диван 8', 26, 200, 92, 60, false)}${t('Стол 6', 140, 200, 66, 52, false)}
      <div class="gx-newt"${mk('newt')} style="position:absolute;left:236px;top:290px">${t('Стол 12', 0, 0, 66, 52, false, 'drag', ';position:relative;border-color:#C46A3C;background:#2C211A')}</div>
      <div style="position:absolute;left:150px;bottom:16px;font-size:10px;letter-spacing:.14em;color:var(--mu)">ВХОД</div>
    </div>
    <div style="position:absolute;right:14px;bottom:24px;display:flex;gap:8px">${btn('Стены', { kind: 'ghost sm', icon: 'wall', style: 'border-radius:22px;background:var(--el)' })}${btn('Стол', { icon: 'plus', tap: 'add', style: 'border-radius:22px;padding:0 18px;height:44px' })}</div></div>`;
}

const newTableDialog = dialog('Новый стол', `${field('Название', { type: 'tname', focus: true, ph: '' })}
  <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;font-size:14px"><span>Мест за столом</span><span style="display:flex;align-items:center;gap:14px"><span class="gx-mu">${ic('minus', 18)}</span><b>4</b><span class="gx-mu">${ic('plus', 18)}</span></span></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 4px;font-size:14px"><span>Чеков одновременно</span><span style="display:flex;align-items:center;gap:14px"><span class="gx-mu">${ic('minus', 18)}</span><b>1</b><span class="gx-mu">${ic('plus', 18)}</span></span></div>
  <div class="gx-mu" style="font-size:11.5px;margin-bottom:10px">Несколько чеков — когда компания платит раздельно.</div>
  <div class="gx-mu" style="font-size:12px;margin-bottom:6px">Форма</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="gx-chip on" style="height:30px">Прямоугольный</span><span class="gx-chip" style="height:30px">Круглый</span><span class="gx-chip" style="height:30px">Диван</span></div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Сохранить', { kind: 'sm', tap: 'save' })}`);

function kitchenScreen() {
  const line = (n, name, note) => `<div style="display:flex;gap:10px;padding:5px 0">
    <b class="gx-brass" style="width:26px;font-size:15px">${n}×</b>
    <div style="flex:1"><b style="display:block;font-size:14.5px">${name}</b>${note ? `<i class="gx-brass" style="font-size:13px">${note}</i>` : ''}</div>
    <span class="gx-mu">${ic('check', 18)}</span></div>`;
  const ticket = (table, sub, min, tone, lines, k) => `<div class="gx-card gx-fold"${mk(k)} style="padding:12px 14px;margin-bottom:10px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between">
      <div><b style="font-size:17px">${table}</b><div class="gx-mu" style="font-size:12px">${sub}</div></div>
      <span style="padding:3px 9px;border-radius:9px;font-weight:700;font-size:12.5px;background:${tone === 'warn' ? 'rgba(217,168,78,.16)' : 'rgba(163,154,142,.14)'};color:${tone === 'warn' ? 'var(--warn)' : 'var(--mu)'}">${min} мин</span></div>
    <div class="gx-sep" style="margin:9px 0 4px"></div>${lines}
    ${btn('Всё готово', { kind: 'ok sm', icon: 'checks', tap: k, style: 'margin-top:8px' })}</div>`;
  return `<div class="gx-app">${status()}${appBar({ title: 'Кухня и бар', left: 'back' })}
    <div class="gx-chips"><span class="gx-chip on">Кухня · 2</span><span class="gx-chip">Бар · 1</span><span class="gx-chip">Кальяны</span></div>
    <div style="padding:2px 14px">
      ${ticket('Стол 1', 'Аня · Алина', 18, 'warn', line(1, 'Сырники со сметаной') + line(2, 'Капучино', 'На растительном молоке').replace('Капучино', 'Цезарь с курицей').replace('На растительном молоке', 'Соус отдельно'), 't1')}
      ${ticket('Стол 5', 'Максим', 6, '', line(2, 'Паста карбонара', 'Без лука') + line(1, 'Том ям с креветками'), 't5')}
    </div></div>`;
}

/* ---- Кабинет ---- */
function webDevices({ tap = {} } = {}) {
  return web('Устройства', `<h3>Устройства</h3>
    <div class="gx-web-card"><h5>Код приглашения устройства</h5><div class="gx-mu" style="font-size:12.5px;line-height:1.45">Введите его на планшете вместе с кодом заведения <b style="color:var(--tx)">kafe-leto</b>. Это секрет — по умолчанию скрыт.</div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:8px"><b class="gx-web-code"${tp('code')}${mk('code')}>K7Q2M9</b><span class="gx-web-link">Скопировать</span></div></div>
    <div class="gx-web-card"><h5>Сборка APK</h5><div style="color:var(--mu);font-size:13px;line-height:1.5;margin-bottom:14px;max-width:560px">Одна кнопка — сразу три личных приложения этого заведения: касса для Android-планшета, касса для Windows и гостевое приложение.</div>
      <div style="display:flex;align-items:center;gap:16px"><div class="gx-web-btn ghost"${tp('build')}><span class="gx-show"${mk('q')}>Собрать APK</span><span class="gx-alt"${mk('q')}><span class="gx-show"${mk('done')}>Сборка уже идёт…</span><span class="gx-alt"${mk('done')}>Собрать APK</span></span></div>
      <div class="gx-show"${mk('done')}><div class="gx-hide"${mk('q')} style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--mu)"><div class="gx-prog"><i${mk('q')}></i></div>собираем, это займёт минут 10</div></div></div>
      <div style="margin-top:12px">
        ${[['Касса', 'b1'], ['Касса (Windows)', 'b2'], ['Гостевое приложение', 'b3']].map(([n, k]) => `<div class="gx-web-row"><span style="flex:1;color:var(--mu)">${n} · <span class="gx-show"${mk('done')}>в очереди</span><span class="gx-alt"${mk('done')}>готова</span></span><span class="gx-web-link gx-hide"${mk('done')}${tp(k === 'b1' ? 'dl' : '')}>Скачать</span></div>`).join('')}
      </div></div>`, { tap });
}

function webBranding() {
  const sw = (a, b, on, k) => `<div style="width:54px;height:54px;border-radius:14px;padding:4px;border:2px solid ${on ? 'var(--pr)' : 'transparent'}"${tp(k)}${mk(k)}><div style="width:100%;height:100%;border-radius:10px;background:linear-gradient(135deg,${a} 50%,${b} 50%)"></div></div>`;
  return web('Брендинг', `<h3>Брендинг</h3><div style="color:var(--mu);font-size:14px">Название, логотип и цвета — для приложения гостей и веб-меню</div>
    <div class="gx-web-split"><div class="gx-web-card" style="flex:1;margin:0">
      <div style="font-size:13px;color:var(--mu);margin-bottom:6px">Имя приложения</div>
      <div style="height:42px;border:1px solid var(--bd);border-radius:10px;display:flex;align-items:center;padding:0 12px;font-size:14px;margin-bottom:14px;background:var(--bg)">Кафе «Лето»</div>
      <div style="font-size:13px;color:var(--mu);margin-bottom:8px">Цвета</div>
      <div style="display:flex;gap:6px">${sw('#A4502A', '#1D1A16', true)}${sw('#2F6B4F', '#14201A', false, 'sage')}${sw('#3D5A80', '#121A24', false)}${sw('#8E3B5B', '#211219', false)}</div>
      <div class="gx-web-btn" style="margin-top:18px"${tp('save')}>Сохранить брендинг</div></div>
      <div class="gx-web-preview">
        <div style="font:600 18px var(--serif);margin-bottom:12px">Кафе «Лето»</div>
        <div style="height:70px;border-radius:12px;background:#24201C;margin-bottom:10px"></div><div style="height:12px;width:70%;border-radius:6px;background:#2C2722;margin-bottom:6px"></div><div style="height:12px;width:50%;border-radius:6px;background:#2C2722;margin-bottom:16px"></div>
        <div style="height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:#fff;transition:background .4s"><span class="gx-brand-pay"${mk('sage')}>Оплатить</span></div></div></div>`);
}

/* ------------------------------------------------------------------ *
 *  Сцены
 * ------------------------------------------------------------------ */
const DIGITS = (code, from = 1) => [...code].map((d, i) => ({ tap: 'k' + d, mark: 'd' + (from + i), fast: true }));

const HOOKAHS = [
  { n: 'Кальян на молоке', p: '1 500 ₽', icon: 'hookah' }, { n: 'Кальян на ананасе', p: '2 000 ₽', icon: 'hookah' },
  { n: 'Перезабивка', p: '700 ₽', icon: 'hookah' }, { n: 'Классический кальян', p: '1 200 ₽', icon: 'hookah' },
];
const DRINKS = [
  { n: 'Сок яблочный', p: '220 ₽', icon: 'cup' }, { n: 'Кола', p: '250 ₽', icon: 'cup' },
  { n: 'Вода негазированная', p: '150 ₽', icon: 'cup' }, { n: 'Морс клюквенный', p: '250 ₽', icon: 'cup' },
];
const ORDER = [
  { n: 'Классический кальян', p: '1 200 ₽', q: 1, sum: '1 200 ₽' },
  { n: 'Сок яблочный', p: '220 ₽', q: 1, sum: '220 ₽' },
];
const ORDER_KITCHEN = [
  { n: 'Паста карбонара', p: '690 ₽', q: 2, sum: '1 380 ₽', note: 'без лука' },
  { n: 'Том ям с креветками', p: '540 ₽', q: 1, sum: '540 ₽' },
  { n: 'Мохито', p: '220 ₽', q: 2, sum: '440 ₽', note: 'без сахара' },
];
const startDialog = (since = '17:40') => dialog('Начать вашу смену?',
  `<p>Смена заведения открыта в ${since}.<br>Начните смену, если вы сейчас работаете: вызовы гостей будут приходить и вам, а время посчитается в зарплату.</p>`,
  `${btn('Не сейчас', { kind: 'text' })}${btn('Начать смену', { kind: 'sm', tap: 'go' })}`);

/* ---- Доставка и с собой из приложения гостя ---- */
// Лист «С собой и доставка» с заказом из приложения: звонок, подтверждение.
function takeawaySheet() {
  return sheet(`<b style="display:block;font-size:19px;margin-bottom:10px">С собой и доставка</b>
    <div class="gx-card" style="padding:12px 14px;border-color:var(--pr);border-width:1.5px">
      <div style="display:flex;align-items:center;gap:10px"><span class="gx-brass">${ic('truck', 24)}</span>
        <b style="flex:1;font-size:16px">Доставка · Аня</b>
        <span style="font-size:11px;padding:3px 8px;border-radius:10px;background:var(--el);display:flex;align-items:center;gap:4px">${ic('phone', 13)}Приложение</span></div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--pr);font-weight:600;font-size:14px"${tp('call')}>${ic('call', 17)}+7 (999) 123-45-67</div>
      <div style="font-size:13px;margin-top:4px">ул. Ленина, 5, кв. 12, подъезд 2, этаж 3</div>
      <div class="gx-mu" style="font-size:12px;margin-top:3px;font-style:italic">«Позвоните за 10 минут»</div>
      <div style="font-size:12.5px;font-weight:600;margin-top:4px" class="gx-mu">Оплатит онлайн после подтверждения</div>
      <div class="gx-mu" style="font-size:12px;margin-top:3px">2 мин назад · Том ям ×1, Чай улун ×1 · 940 ₽</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap">
        <span style="font-size:12px;padding:5px 10px;border-radius:12px;background:var(--el)"${mk('acc')}><span class="gx-show"${mk('acc')}>Новый</span><span class="gx-alt"${mk('acc')}>Принят</span></span>
        <span class="gx-show"${mk('acc')}><span style="display:inline-flex;gap:8px">${btn('Подтвердить', { kind: 'ok sm', icon: 'check', tap: 'accept' })}${btn('Отклонить', { kind: 'ghost sm' })}</span></span>
        <span class="gx-alt"${mk('acc')}><span style="display:inline-flex;gap:8px">${btn('Начать готовить', { kind: 'sm', tap: 'cook' })}${btn('Отменить', { kind: 'text' })}</span></span>
      </div></div>
    <div class="gx-mu" style="font-size:12px;line-height:1.4;margin-top:10px">Позвоните гостю: сверьте состав, адрес и время. После подтверждения позиции встанут в чек, гость увидит «Принят».</div>`);
}

function callScreen() {
  return `<div class="gx-app" style="display:flex;flex-direction:column;align-items:center;padding-top:150px">
    <div style="width:84px;height:84px;border-radius:50%;background:var(--el);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:600">А</div>
    <b style="font-size:24px;margin-top:16px">+7 (999) 123-45-67</b><span class="gx-mu" style="margin-top:6px">Вызов…</span>
    <div style="position:absolute;bottom:90px;width:64px;height:64px;border-radius:50%;background:var(--bad);color:#fff;display:flex;align-items:center;justify-content:center">${ic('call', 28)}</div></div>`;
}

// Касса → Админ → Интеграции → «Онлайн-оплата гостей».
function onlinePayScreen() {
  return `<div class="gx-app">${status()}${appBar({ title: 'Интеграции', left: 'back' })}<div style="padding:0 14px">
    <div class="gx-card" style="padding:14px">
      <b style="display:flex;align-items:center;gap:8px;font-size:16px"><span class="gx-brass">${ic('card', 19)}</span>Онлайн-оплата гостей</b>
      <div class="gx-mu" style="font-size:11.5px;line-height:1.4;margin:4px 0 12px">Гость платит из приложения сам: счёт за столом и заказ доставки или с собой. Деньги приходят на ваш счёт в банке.</div>
      <div class="gx-f" style="height:52px"${tp('bank')}><span class="gx-f-l">Банк</span><span class="gx-val"><span class="gx-show"${mk('bank')}>Не подключён</span><span class="gx-alt"${mk('bank')}>Робокасса — СБП и карты</span></span></div>
      <div class="gx-unfold"${mk('bank')}><div style="padding-top:10px">
        ${field('Идентификатор магазина', { type: 'shop', style: 'height:48px;margin-bottom:8px' })}
        ${field('Пароль №1', { val: '••••••••', style: 'height:48px;margin-bottom:8px' })}
        ${field('Пароль №2', { val: '••••••••', style: 'height:48px' })}</div></div>
      ${btn('Сохранить и проверить подключение', { kind: 'ghost sm', icon: 'check', tap: 'check', style: 'margin-top:12px;width:100%' })}
      <div class="gx-unfold"${mk('ok')}><div style="color:var(--ok);font-size:12.5px;font-weight:600;line-height:1.4;margin-top:10px">✓ Робокасса приняла идентификатор и пароль №2. Пароль №1 проверится при первой оплате</div></div>
    </div></div></div>`;
}

// Касса → Админ → Профиль заведения: переключатели доставки и оплаты.
function venueToggles() {
  return `<div class="gx-app">${status()}${appBar({ title: 'Профиль заведения', left: 'back' })}<div style="padding:0 16px">
    ${switchRow('Заказы с собой и доставка', 'Кнопка в шапке зала, а у гостя в меню — «Доставка или с собой».', { on: true })}
    ${switchRow('Гость оплачивает онлайн из приложения', 'Счёт за столом и заказ доставки: гость платит из своего банка, персоналу приходит «Оплачено онлайн».', { tap: 'pay', mark: 'pay' })}
    </div>
    <div class="gx-bottom">${btn('Сохранить', { icon: 'check', tap: 'save' })}</div></div>`;
}

/* ---- Приложение гостя ---- */
function guestMenu() {
  return `<div class="gx-app">${status()}<div style="padding:8px 16px 0"><b style="font-size:28px;font-family:var(--serif, serif)">Меню</b></div>
    <div class="gx-search" style="margin-top:10px">${ic('search', 18)}Поиск по меню</div>
    <div class="gx-tiles" style="gap:10px">${[['Том ям', '640 ₽', 1], ['Чай улун', '300 ₽', 1], ['Пад тай', '520 ₽', 0], ['Пиво светлое', '350 ₽', -1]].map(([n, p, q]) => `
      <div class="gx-card" style="padding:12px;height:118px;display:flex;flex-direction:column;justify-content:space-between${q > 0 ? ';border-color:var(--pr)' : ''}">
        <b style="font-size:13.5px">${n}</b>
        <div style="display:flex;align-items:center;justify-content:space-between"><span class="gx-brass" style="font-weight:600">${p}</span>
        ${q < 0 ? '<span class="gx-mu" style="font-size:10.5px;text-align:right;line-height:1.2">Только<br>в заведении</span>'
    : `<span style="display:flex;align-items:center;gap:6px">${q ? '<b>1</b>' : ''}<span style="width:26px;height:26px;border-radius:50%;background:var(--pr);color:#FFF7F0;display:flex;align-items:center;justify-content:center">${ic('plus', 15, 2.4)}</span></span>`}</div></div>`).join('')}</div>
    <div class="gx-card" style="margin:14px 14px 0;padding:14px"><b style="font-size:14px">Ваш заказ: 2 позиции · 940 ₽</b>
      <div class="gx-mu" style="font-size:12px;margin:4px 0 10px">Доставка или самовывоз: заведение позвонит и подтвердит заказ.</div>
      ${btn('Доставка или с собой', { icon: 'bag', tap: 'go' })}</div></div>`;
}

function guestCheckout() {
  return `<div class="gx-app">${status()}${appBar({ title: 'Оформление заказа', left: 'back' })}<div style="padding:0 14px">
    <div class="gx-seg2" style="width:100%;height:38px;margin-bottom:12px"><span class="on">Доставка</span><span>Заберу сам</span></div>
    ${field('Как к вам обращаться', { val: 'Аня', style: 'height:46px;margin-bottom:8px' })}
    ${field('Телефон', { type: 'tel', ph: '+7 9XX XXX-XX-XX', style: 'height:46px;margin-bottom:8px' })}
    ${field('Улица и дом', { type: 'street', style: 'height:46px;margin-bottom:8px' })}
    <div style="display:flex;gap:8px">${field('Кв./офис', { val: '12', style: 'height:46px;flex:1' })}${field('Подъезд', { val: '2', style: 'height:46px;flex:1' })}</div>
    <b style="display:block;font-size:14px;margin:14px 0 8px">Оплата</b>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <span class="gx-chip"${mk('on')} style="padding:7px 12px"><span class="gx-show"${mk('on')}>✓ </span>При получении</span>
      <span class="gx-chip"${tp('online')}${mk('on')} style="padding:7px 12px"><span class="gx-alt"${mk('on')}>✓ </span>Онлайн — СБП или картой</span></div>
    <div class="gx-mu" style="font-size:11.5px;margin-top:8px">Кнопка оплаты появится после того, как заведение подтвердит заказ.</div></div>
    <div class="gx-bottom">${btn('Оформить заказ · 940 ₽', { tap: 'send' })}</div></div>`;
}

function guestOrder() {
  const step = (t, i) => `<div style="display:flex;align-items:center;gap:12px;padding:6px 0;font-size:14px">
    <span style="width:20px;height:20px;border-radius:50%;border:2px solid ${i === 0 ? 'var(--pr)' : 'var(--bd)'};display:flex;align-items:center;justify-content:center;flex:none"${i === 0 ? mk('acc') : ''}>${i === 0 ? `<span class="gx-alt"${mk('acc')} style="color:var(--pr)">${ic('check', 12, 3)}</span>` : ''}</span>
    <span${i < 2 ? '' : ' class="gx-mu"'}>${i === 1 ? `<span class="gx-show"${mk('acc')} style="color:var(--mu)">${t}</span><b class="gx-alt"${mk('acc')}>${t}</b>` : i === 0 ? `<b class="gx-show"${mk('acc')}>${t}</b><span class="gx-alt"${mk('acc')}>${t}</span>` : t}</span></div>`;
  return `<div class="gx-app">${status()}<div style="padding:8px 16px 0">
    <div class="gx-mu" style="font-size:11px;letter-spacing:.14em;font-weight:600">ЗАКАЗ №6SRG</div>
    <b style="font-size:28px">Доставка</b>
    <div class="gx-mu" style="font-size:13px;line-height:1.4;margin:6px 0 12px"><span class="gx-show"${mk('acc')}>Заказ получен. Заведение позвонит вам, чтобы подтвердить состав и адрес — держите телефон рядом.</span><span class="gx-alt"${mk('acc')}>Заказ подтверждён и скоро начнут готовить.</span></div>
    <div class="gx-card" style="padding:10px 14px">${['Ждёт подтверждения', 'Принят', 'Готовится', 'У курьера', 'Доставлен'].map(step).join('')}</div>
    <div class="gx-card" style="padding:12px 14px;margin-top:10px">
      <div class="gx-show"${mk('acc')}><span class="gx-mu" style="font-size:12.5px">Оплата онлайн станет доступна сразу после подтверждения заказа.</span></div>
      <div class="gx-alt"${mk('acc')}><span class="gx-mu" style="font-size:12.5px;display:block;margin-bottom:10px">Оплатите заказ сейчас — СБП или картой. Чек — от заведения.</span>${btn('Оплатить онлайн', { tap: 'pay', style: 'width:100%' })}</div></div>
    </div></div>`;
}

/* ---- Telegram-бот (кабинет → Настройки) ---- */
function webTelegram() {
  return web('Настройки', `<h3>Настройки</h3>
    <div class="gx-web-card"><h5>Telegram-бот заведения</h5>
      <div class="gx-fold"${mk('bot')}><div class="gx-mu" style="font-size:12.5px;line-height:1.5;max-width:560px">Заказы с собой и доставки — в рабочую группу с кнопками статусов, владельцу — выручка, смены, отмены и итоги каждое утро. Имена, телефоны и адреса гостей в Telegram не уходят.</div>
        ${wField('Токен бота', { type: 'token', ph: '123456789:AA…' })}
        ${wBtn('Подключить бота', { tap: 'connect' })}</div>
      <div class="gx-unfold"${mk('bot')} style="--max:640px"><div style="font-size:13.5px;line-height:1.8">Бот: <b>@kafe_leto_bot</b> · токен хранится зашифрованным</div>
        <div style="font-size:13.5px;font-weight:600;margin-top:8px">Кто управляет ботом</div>
        <div class="gx-unfold"${mk('acc')}><div class="gx-web-row" style="border-top:none"><span style="flex:1">Ольга · ID 123456789<br><span class="gx-mu" style="font-size:12px">владелец, управляющий</span></span><span class="gx-web-link">Убрать</span></div></div>
        <div class="gx-cols wide2" style="margin-top:6px">${wField('Telegram ID', { type: 'tgid', ph: '123456789' })}${wField('Права', { val: 'Владелец / управляющий' })}<div style="display:flex;align-items:flex-end">${wBtn('Добавить', { tap: 'addid', ghost: true })}</div></div>
        <div style="font-size:13.5px;line-height:1.8;margin-top:6px">Владелец: <span class="gx-show"${mk('own')}><span class="gx-mu">не подключён</span></span><span class="gx-alt"${mk('own')}><b>Ольга</b></span></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">${wBtn('Подключить мой Telegram', { tap: 'owner', ghost: true })}${wBtn('Подключить группу сотрудников', { tap: 'group', ghost: true })}</div>
        <div style="font-size:13px;margin-top:10px">Рабочая группа: <span class="gx-show"${mk('grp')}><span class="gx-mu">не подключена</span></span><span class="gx-alt"${mk('grp')}><b>Кухня и курьеры</b></span></div></div>
    </div>`, {});
}

function tgChat() {
  return webPage(`<div class="gx-web-card gx-web-narrow" style="padding:14px 16px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span style="width:36px;height:36px;border-radius:50%;background:#2AABEE;color:#fff;display:flex;align-items:center;justify-content:center">${ic('send', 18)}</span><b>Кухня и курьеры</b></div>
    <div style="background:var(--s2, rgba(127,127,127,.12));border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.55">
      🛵 <b>Доставка №6SRG</b> · 📱 из приложения<br>Статус: <span class="gx-show"${mk('st')}>Принят</span><span class="gx-alt"${mk('st')}>Готовится</span><br>
      Позиций: 2 · 940 ₽<br>Оплата: онлайн после подтверждения<br>• Том ям (Огонь) ×1<br>• Чай улун ×1</div>
    <div style="margin-top:8px">${wBtn('<span class="gx-show" data-mark="st">▶️ Начать готовить</span><span class="gx-alt" data-mark="st">▶️ Передать курьеру</span>', { tap: 'cook', ghost: true, style: 'width:100%;justify-content:center' })}</div>
    <div style="display:flex;gap:8px;margin-top:8px">${wBtn('🚴 Назначить курьера', { ghost: true, style: 'flex:1;justify-content:center' })}${wBtn('📍 Адрес', { ghost: true, style: 'flex:1;justify-content:center' })}</div></div>`, { url: 'Telegram' });
}

/* ---- Остальные экраны инструкции ----
   Детали экранов собраны в X, чтобы не путать их с экранами выше. */
const X = {};
X.scr = (title, body, { right = [], bottom = '', sub = '', tapRight = {}, pad = '0 14px' } = {}) =>
  `<div class="gx-app">${status()}${appBar({ title, sub, left: 'back', right, tapRight })}<div style="padding:${pad}">${body}</div>${bottom ? `<div class="gx-bottom">${bottom}</div>` : ''}</div>`;
X.card = (inner, style = '') => `<div class="gx-card" style="padding:12px 14px;margin-bottom:10px;${style}">${inner}</div>`;
X.line = (l, v, { b = false, k = '', mu = false, c = '' } = {}) =>
  `<div style="display:flex;justify-content:space-between;gap:10px;font-size:${b ? 14.5 : 13}px;padding:4px 0;${b ? 'font-weight:600;' : ''}${c ? `color:${c};` : ''}"${mk(k)}><span${mu ? ' class="gx-mu"' : ''}>${l}</span><span class="gx-price">${v}</span></div>`;
X.chips = (list, on = 0, tapIdx = -1, tapKey = '') =>
  `<div class="gx-chips" style="padding:0 0 10px">${list.map((c, i) => `<span class="gx-chip${i === on ? ' on' : ''}"${i === tapIdx ? tp(tapKey) + mk(tapKey) : ''}>${c}</span>`).join('')}</div>`;
X.h = (t) => `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin:12px 2px 8px">${t}</div>`;
X.fab = (label, k, icon = 'plus') => `<div style="position:absolute;right:14px;bottom:22px">${btn(label, { icon, tap: k, style: 'border-radius:24px;padding:0 18px;box-shadow:0 8px 20px rgba(0,0,0,.4)' })}</div>`;
X.stars = (n) => `<span style="color:#D9A84E;letter-spacing:1px">${'★'.repeat(n)}<span style="color:var(--bd)">${'★'.repeat(5 - n)}</span></span>`;

const GUEST_TILES = [['users', 'Гости'], ['star', 'Программа лояльности'], ['card', 'Скидочные карты'], ['gem', 'Сертификаты'],
  ['star', 'Отзывы'], ['image', 'Лента для гостей'], ['qr', 'QR-коды столов'], ['store', 'Профиль заведения']];
const AI_TILES = [['spark', 'ИИ-разборы'], ['checks', 'Активность и журнал'], ['spark', 'Настройки ИИ'], ['gear', 'Интеграции']];
X.admin = (group, tiles, tap) => adminHome({ tap, tiles }).replace('>Работа заведения<', `>${group}<`);

// Боковое меню с пунктом «Обновления» внизу.
X.drawerUpd = (tapKey) => drawer().replace(/<\/div>$/, `<div class="gx-di-sep"></div>${drawerItem({ icon: 'dl', t: 'Обновления', s: 'Версия 1.41 · есть новая', tap: tapKey, badge: '1' })}</div>`);

/* ---- Счёт стола с «Предчеком» ---- */
X.checkWithPre = (o) => tableCheck(o).replace(
  btn('Закрыть стол', { kind: 'ok', tap: o.tap?.close, icon: 'cash', style: 'padding:0 18px' }),
  `<span style="display:flex;gap:8px">${btn('Предчек', { kind: 'ghost sm', tap: 'pre', style: 'height:46px;padding:0 12px' })}${btn('Закрыть стол', { kind: 'ok', style: 'padding:0 14px;white-space:nowrap' })}</span>`).replace('<b style="font-size:22px">', '<b style="font-size:20px;white-space:nowrap">');
X.preSlip = `<div class="gx-scrim"></div><div class="gx-panel gx-slips"><div class="gx-slip" style="width:236px">
  <div style="text-align:center;font-weight:700;font-size:14px">КАФЕ «ЛЕТО»</div>
  <div style="text-align:center;font-weight:700;font-size:12.5px;margin:2px 0 4px">ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ</div>
  <div style="text-align:center;font-size:11px">Стол 2 · Официант: Алина · 21:40</div><div class="gx-slip-hr"></div>
  ${[['Классический кальян x1', '1200'], ['Сок яблочный x2', '440'], ['Чизкейк x1', '390']].map(([n, v]) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1px 0"><span>${n}</span><span>${v}</span></div>`).join('')}
  <div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1px 0"><span>Скидка по карте 10%</span><span>−83</span></div>
  <div class="gx-slip-hr"></div><div style="display:flex;justify-content:space-between;font-weight:700;font-size:13px"><span>К ОПЛАТЕ</span><span>1947</span></div>
  <div style="text-align:center;font-size:10px;margin-top:6px">Не является кассовым чеком</div></div></div>`;
const ORDER3 = [
  { n: 'Классический кальян', p: '1 200 ₽', q: 1, sum: '1 200 ₽' },
  { n: 'Сок яблочный', p: '220 ₽', q: 2, sum: '440 ₽' },
  { n: 'Чизкейк', p: '390 ₽', q: 1, sum: '390 ₽' },
];

/* ---- История чеков и возврат ---- */
X.receipts = () => X.scr('История чеков', `${X.chips(['Сегодня', '7 дней', '30 дней', 'Свой период'])}
  ${[['Стол 2', '21:52 · Алина · наличные', '1 947 ₽', 'r1'], ['Диван 8', '21:10 · Максим · карта', '7 030 ₽'], ['Бар', '20:44 · Денис · терминал Сбер', '500 ₽'], ['Доставка №6SRG', '20:15 · онлайн', '940 ₽']].map(([t, s, v, k]) =>
    `<div class="gx-card" style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px"${tp(k)}><span class="gx-ico">${ic('receipt', 18)}</span><div style="flex:1"><b style="font-size:14.5px">${t}</b><div class="gx-mu" style="font-size:11.5px">${s}</div></div><b>${v}</b></div>`).join('')}`);
X.receipt = () => X.scr('Чек · Стол 2', X.card(`<div class="gx-mu" style="font-size:12px;margin-bottom:6px">Сегодня, 21:52 · Алина · наличными</div>
  ${X.line('Классический кальян ×1', '1 200 ₽')}${X.line('Сок яблочный ×2', '440 ₽')}${X.line('Чизкейк ×1', '390 ₽')}${X.line('Скидка по карте 10%', '−83 ₽', { mu: true })}
  <div class="gx-sep" style="margin:6px 0"></div>${X.line('К оплате', '1 947 ₽', { b: true })}
  <div class="gx-hide"${mk('ref')} style="margin-top:8px;padding:6px 10px;border-radius:9px;background:rgba(212,85,63,.14);color:#E07A5F;font-size:12.5px;font-weight:600">Возврат оформлен · 21:58 · Ольга</div>`),
  { bottom: btn('Возврат чека', { kind: 'ghost', tap: 'ret', style: 'color:#E07A5F;border-color:rgba(212,85,63,.4)' }) });
X.refundDialog = dialog('Возврат чека', '<p>Вернуть гостю 1 947 ₽ наличными? Возврат попадёт в X-отчёт, отчёты и журнал, процент сотрудников с этого чека пропадёт.</p>',
  `${btn('Отмена', { kind: 'text' })}${btn('Оформить возврат', { kind: 'sm', tap: 'do', style: 'background:#C4553F' })}`);

/* ---- Касса: наличные ---- */
X.cash = ({ done = false } = {}) => X.scr('Касса', `${X.card(`<div class="gx-mu" style="font-size:12px">Должно быть в кассе</div>
    <b style="font-size:30px"><span class="gx-show"${mk('out')}>${done ? '10 580 ₽' : '12 580 ₽'}</span><span class="gx-alt"${mk('out')}>10 580 ₽</span></b>
    <div class="gx-mu" style="font-size:12px;margin-top:2px">Размен 5 000 ₽ + наличные за чеки 7 580 ₽</div>`)}
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">${btn('Внесение', { kind: 'ghost sm' })}${btn('Выплата', { kind: 'ghost sm', tap: 'pay' })}${btn('Инкассация', { kind: 'ghost sm' })}</div>
  ${X.h('Операции за смену')}
  <div class="gx-unfold"${mk('out')}>${X.card(`<div style="display:flex;justify-content:space-between"><b style="font-size:14px">Выплата · −2 000 ₽</b><span class="gx-mu" style="font-size:11.5px">21:20 · Ольга</span></div><div class="gx-mu" style="font-size:12px;margin:2px 0 8px">Курьер Сергей, доставка лимонов</div><span style="font-size:12.5px;color:#E07A5F">Отменить операцию</span>`)}</div>
  ${X.card(`<div style="display:flex;justify-content:space-between"><b style="font-size:14px">Внесение · +5 000 ₽</b><span class="gx-mu" style="font-size:11.5px">12:02 · Ольга</span></div><div class="gx-mu" style="font-size:12px;margin-top:2px">Размен из сейфа</div>`)}`);
X.payoutDialog = dialog('Выплата из кассы', `${field('Сумма, ₽', { type: 'sum', focus: true })}<div style="height:8px"></div>${field('Кому и за что', { type: 'why' })}`,
  `${btn('Отмена', { kind: 'text' })}${btn('Провести', { kind: 'sm', tap: 'ok' })}`);

/* ---- X-отчёт ---- */
X.xreport = () => X.scr('X-отчёт', `${X.chips(['Текущая смена', 'Прошлые смены'])}
  ${X.card(`<div class="gx-mu" style="font-size:12px;margin-bottom:4px">Смена открыта в 12:00 · 38 чеков</div>
    ${X.line('Наличными', '7 580 ₽')}${X.line('Картой', '12 340 ₽')}
    ${X.line('Терминалом', '9 200 ₽')}<div style="padding-left:12px">${X.line('· Сбер', '6 100 ₽', { mu: true })}${X.line('· Т-Банк', '3 100 ₽', { mu: true })}</div>
    ${X.line('Агрегатор · Яндекс Еда', '2 640 ₽')}${X.line('Онлайн из приложения', '1 880 ₽')}${X.line('Возвраты', '−1 947 ₽', { c: '#E07A5F' })}${X.line('Чаевые (вне выручки)', '1 300 ₽', { mu: true })}
    <div class="gx-sep" style="margin:6px 0"></div>${X.line('Итого выручка', '31 693 ₽', { b: true })}${X.line('Наличные в кассе', '10 580 ₽', { b: true, k: 'cash' })}`)}`,
  { bottom: `<div style="display:flex;gap:8px">${btn('Распечатать', { icon: 'printer', tap: 'print', style: 'flex:1' })}${btn('Скопировать', { kind: 'ghost', tap: 'copy', style: 'flex:1' })}</div>` });

/* ---- Лист ожидания ---- */
X.waitlist = ({ added = false } = {}) => X.scr('Лист ожидания', `
  ${added ? '' : `<div class="gx-unfold"${mk('add')} style="--max:220px">`}${X.card(`<div style="display:flex;justify-content:space-between"><b style="font-size:15.5px">Андрей · 4 чел.</b><span class="gx-mu" style="font-size:12px">ждёт 2 мин</span></div>
    <div class="gx-mu" style="font-size:12px;margin:2px 0 10px">+7 •••  ••• 12-45 · <span class="gx-show"${mk('ready')}>в очереди</span><span class="gx-alt"${mk('ready')} style="color:var(--ok);font-weight:600">стол готов — позвали</span></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${btn('<span class="gx-show" data-mark="ready">Стол готов</span><span class="gx-alt" data-mark="ready">Посадили</span>', { kind: 'sm', tap: 'ready' })}${btn('В бронь', { kind: 'ghost sm' })}${btn('Ушёл', { kind: 'text', style: 'height:38px;font-size:13px' })}</div>`, 'border-color:var(--pr)')}${added ? '' : '</div>'}
  ${X.card(`<div style="display:flex;justify-content:space-between"><b style="font-size:15.5px">Света · 2 чел.</b><span class="gx-mu" style="font-size:12px">ждёт 9 мин</span></div><div class="gx-mu" style="font-size:12px;margin-top:2px">+7 ••• ••• 77-10 · в очереди</div>`)}`,
  { bottom: btn('Записать гостя', { icon: 'plus', tap: 'new' }) });
X.waitDialog = dialog('Записать гостя', `${field('Имя', { type: 'wname', focus: true })}<div style="height:8px"></div>${field('Телефон гостя', { type: 'wtel' })}`,
  `${btn('Отмена', { kind: 'text' })}${btn('Записать', { kind: 'sm', tap: 'save' })}`);

/* ---- QR-коды столов ---- */
X.qrGrid = () => X.scr('QR-коды столов', `<div class="gx-mu" style="font-size:12px;line-height:1.4;margin-bottom:10px">Распечатайте и наклейте каждый код на свой стол. Гость наводит камеру — открывается меню и счёт этого стола.</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${['Стол 1', 'Стол 2', 'Стол 3', 'Диван 8'].map((t, i) => `<div class="gx-card" style="padding:12px;text-align:center">
    <div style="width:92px;height:92px;margin:0 auto 8px;border-radius:8px;background:#F4EFE8;color:#1D1A16;display:flex;align-items:center;justify-content:center"${i === 1 ? mk('new') : ''}>${ic('qr', 70, 1.6)}</div>
    <b style="font-size:13.5px">${t}</b><div style="font-size:12px;margin-top:4px;color:#D98A5C"${i === 1 ? tp('renew') : ''}>${i === 1 ? '<span class="gx-show" data-mark="new">Новый код</span><span class="gx-alt" data-mark="new" style="color:var(--ok)">Код заменён ✓</span>' : 'Новый код'}</div></div>`).join('')}</div>`,
  { bottom: btn('Распечатать все', { icon: 'printer' }) });
X.qrDialog = dialog('Выпустить новый код?', '<p>Старая наклейка «Стол 2» перестанет открывать счёт. Распечатайте новую и замените.</p>', `${btn('Отмена', { kind: 'text' })}${btn('Выпустить новый', { kind: 'sm', tap: 'yes' })}`);

/* ---- Приложение гостя ---- */
X.guestTabs = (on) => `<div style="position:absolute;left:0;right:0;bottom:0;height:70px;background:var(--sf);border-top:1px solid var(--bd);display:flex;justify-content:space-around;align-items:center;font-size:10.5px">
  ${[['home', 'Главная'], ['fork', 'Меню'], ['cal', 'Бронь'], ['table', 'Мой стол'], ['user', 'Профиль']].map(([i, t]) => `<span style="display:flex;flex-direction:column;align-items:center;gap:3px;color:${t === on ? 'var(--pr)' : 'var(--mu)'}">${ic(i, 20)}${t}</span>`).join('')}</div>`;
X.guestTable = () => `<div class="gx-app">${status()}<div style="padding:8px 16px 0">
  <div class="gx-mu" style="font-size:11px;letter-spacing:.14em;font-weight:600">КАФЕ «ЛЕТО»</div><b style="font-size:28px">Стол 5</b>
  <div class="gx-mu" style="font-size:12.5px;margin:2px 0 12px">Вас обслуживает Алина</div>
  ${btn('Сделать заказ', { icon: 'fork', style: 'width:100%;margin-bottom:10px' })}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${[['Позвать официанта', 'call'], ['Счёт, пожалуйста', ''], ['Позвать кальянщика', ''], ['Поменять угли', '']].map(([t, k]) =>
    `<div class="gx-card" style="height:64px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:13px;font-weight:600;padding:6px"${tp(k)}>${t}</div>`).join('')}</div>
  <div class="gx-hide"${mk('call')} style="margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(109,178,135,.15);color:var(--ok);font-size:13px;font-weight:600">✓ Официант получил вызов</div>
  ${X.card(`${X.line('Ваш счёт', '2 030 ₽', { b: true })}<div class="gx-mu" style="font-size:12px">Кальян, 2 сока, чизкейк</div>${btn('Оплатить онлайн', { kind: 'ghost sm', style: 'margin-top:8px;width:100%' })}`, 'margin-top:12px')}
  </div>${X.guestTabs('Мой стол')}</div>`;
X.guestReview = () => `<div class="gx-app">${status()}<div style="padding:120px 20px 0;text-align:center">
  <b style="font-size:22px">Как вам визит?</b><div class="gx-mu" style="font-size:13px;margin:6px 0 18px">Кафе «Лето» · Стол 5</div>
  <div style="font-size:40px;letter-spacing:6px"${tp('star')}><span class="gx-show"${mk('rate')} style="color:var(--bd)">★★★★★</span><span class="gx-alt"${mk('rate')} style="color:#D9A84E">★★★★★</span></div>
  <div style="margin-top:18px">${field('', { type: 'rev', ph: 'Пара слов для заведения' })}</div>${btn('Отправить', { tap: 'send', style: 'width:100%;margin-top:12px' })}</div>${X.guestTabs('Мой стол')}</div>`;

/* ---- Профиль заведения, сеанс ---- */
X.sessionScreen = () => X.scr('Длительность сеанса', `<div class="gx-mu" style="font-size:12.5px;line-height:1.4;margin-bottom:12px">Сколько обычно длится посещение. За столом пойдёт таймер.</div>
  ${['1 час', '1,5 часа', '2 часа', '3 часа', 'Без ограничений'].map((t, i) => {
    const on = '<span class="gx-wc-box radio" style="background:var(--bg);box-shadow:inset 0 0 0 4px var(--pr);border-color:var(--pr)"></span>';
    const off = '<span class="gx-wc-box radio"></span>';
    const box = i === 1 ? `<span class="gx-show" data-mark="two">${on}</span><span class="gx-alt" data-mark="two">${off}</span>`
      : i === 2 ? `<span class="gx-show" data-mark="two">${off}</span><span class="gx-alt" data-mark="two">${on}</span>` : off;
    return `<div style="display:flex;align-items:center;gap:10px;padding:12px 4px;border-bottom:1px solid var(--bd)"${i === 2 ? tp('two') : ''}>${box}<span style="font-size:15px">${t}</span></div>`;
  }).join('')}
  <div style="margin-top:14px">${field('Своя длительность, часов', { ph: 'Например, 1,5' })}</div>`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });
/* ---- Тайм-кафе: оплата за время ---- */
X.timeCafeScreen = () => X.scr('Тайм-кафе', `<div class="gx-mu" style="font-size:12px;line-height:1.4;margin-bottom:4px">Гость платит за время, проведённое за столом. Таймер стола настраивается отдельно.</div>
  ${switchRow('Включить тайм-кафе', '', { tap: 'on', mark: 'on' })}
  <div class="gx-unfold"${mk('on')} style="--max:520px">
    ${field('Цена часа за гостя, ₽', { type: 'price', style: 'height:50px;margin:8px 0 14px' })}
    ${field('Цена первого часа, ₽ (необязательно)', { ph: 'По умолчанию как остальные часы', style: 'height:50px;margin-bottom:10px' })}
    <div class="gx-mu" style="font-size:12px;margin:6px 2px">Округлять время вверх до</div>
    ${X.chips(['минуты', '5 мин', '15 мин', '30 мин', 'часа'], -1, 2, 'r15')}
    <div class="gx-mu" style="font-size:12px;margin:0 2px 6px">Минимальная оплата</div>
    ${X.chips(['нет', '30 мин', '1 ч'], 0)}
    ${field('Стоп-чек за гостя, ₽ (необязательно)', { type: 'stop', style: 'height:50px;margin:6px 0 12px' })}
    <div class="gx-unfold"${mk('ex')}>${X.card('<div style="font-size:12.5px;line-height:1.45">Сколько заплатит один гость:<br><b>20 мин — 105 ₽ · 1 ч — 300 ₽ · 1 ч 30 мин — 450 ₽ · 3 ч — 900 ₽</b></div>')}</div>
  </div>`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });

/** Счёт стола в тайм-кафе: сколько уже набежало и кнопка «Время в счёт». */
X.cafeTable = ({ items = [], total = '0 ₽', tap = {}, recount = false } = {}) => {
  // Неразрывный дефис: на узкой плитке «Тайм-кафе» не делится на две строки.
  const acts = [['hourglass', 'Тайм\u2011кафе', recount ? 'пересчитать' : 'время в счёт', tap.cafe], ...ACTIONS.filter(([icn]) => icn !== 'receipt' && icn !== 'timer').map((a) => [...a, '']), ['receipt', 'Ещё чек', 'отдельный счёт', '']].slice(0, 6);
  return tableCheck({ items, total, tap })
    .replace(/<div class="gx-timer">[\s\S]*?<\/div><\/div>/, `<div class="gx-timer"><small>За столом</small><strong>1:24</strong>
      <span class="gx-mu gx-small">с 18:18</span>
      <div style="margin-top:7px;display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:var(--br)">${ic('hourglass', 15)}<span>Тайм-кафе: 420 ₽ за гостя · 1 ч 25 мин</span></div></div>`)
    .replace(/<div class="gx-acts-grid">[\s\S]*?(?=<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 14px 10px">)/,
      `<div class="gx-acts-grid">${acts.map(([icn, t, sub, k], n) => `<div class="gx-act"${tp(k)}${n === 0 ? ' style="border-color:var(--pr)"' : ''}>
      <span style="display:flex;align-items:center;gap:6px">${ic(icn, 15)}<b>${t}</b></span><span>${sub}</span></div>`).join('')}</div>
    `);
};

X.cafeDialog = dialog('Время в счёт', `<div class="gx-mu" style="font-size:12.5px;margin-bottom:10px">За столом 1 ч 25 мин · по тарифу 420 ₽ за гостя</div>
  <div style="font-size:13.5px;margin-bottom:6px">Сколько гостей платят за время</div>
  <div style="display:flex;align-items:center;justify-content:center;gap:18px;margin-bottom:10px">
    <span class="gx-mu" style="width:38px;height:38px;border-radius:50%;background:var(--el);display:flex;align-items:center;justify-content:center">${ic('minus', 18)}</span>
    <b style="font-size:28px;min-width:40px;text-align:center"><span class="gx-show"${mk('g2')}>1</span><span class="gx-alt"${mk('g2')}>2</span></b>
    <span style="width:38px;height:38px;border-radius:50%;background:var(--el);display:flex;align-items:center;justify-content:center"${tp('plus')}>${ic('plus', 18)}</span></div>
  ${field('Сумма за гостя, ₽', { val: '420', style: 'height:50px' })}
  <div style="font-weight:600;font-size:14px;margin-top:10px">Итого за время: <span class="gx-show"${mk('g2')}>420 ₽</span><span class="gx-alt"${mk('g2')}>840 ₽</span></div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('В счёт', { kind: 'sm', tap: 'ok' })}`);

const CAFE_ORDER = [
  { n: 'Время в тайм-кафе · 1 ч 25 мин', p: '420 ₽', q: 2, sum: '840 ₽', note: 'не уходит на кухню' },
  { n: 'Чай чёрный', p: '250 ₽', q: 1, sum: '250 ₽' },
];

X.venueProfile = () => X.scr('Профиль заведения', `
  ${field('Тип заведения', { val: 'Кальянная / лаунж', style: 'height:50px;margin-bottom:8px' })}
  ${field('Адрес', { type: 'addr', style: 'height:50px;margin-bottom:8px' })}
  ${field('Телефон', { val: '+7 (900) 000-00-00', style: 'height:50px;margin-bottom:8px' })}
  <div style="font-size:13px;font-weight:600;margin:10px 2px 6px">Часы работы</div>
  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">${['Пн–Чт · 14:00-02:00', 'Пт · 14:00-04:00', 'Сб · 12:00-04:00', 'Вс · <span class="gx-mu">выходной</span>'].map((t) => `<div class="gx-f" style="height:40px;font-size:12.5px;color:var(--tx)">${t}</div>`).join('')}</div>
  <div style="margin-top:10px">${field('Правила, частые вопросы, акции', { type: 'rules', style: 'height:56px' })}</div>
  ${switchRow('Чаевые в приложении гостя', 'Гость оставит чаевые после визита', { on: true })}`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });

/* ---- Меню: позиция ---- */
X.catItems = () => X.scr('Кальяны', `${[['Классический кальян', '1 200 ₽'], ['Кальян на молоке', '1 500 ₽'], ['Кальян на ананасе', '2 000 ₽'], ['Перезабивка', '700 ₽']].map(([n, p]) =>
  `<div style="display:flex;align-items:center;gap:12px;padding:11px 2px;border-bottom:1px solid var(--bd)"><div class="gx-ico" style="background:var(--el);color:var(--mu)">${ic('hookah', 18)}</div><b style="flex:1;font-size:14.5px">${n}</b><span class="gx-brass" style="font-weight:600">${p}</span><span class="gx-mu">${ic('pen', 17)}</span></div>`).join('')}`,
  { bottom: btn('Добавить позицию', { icon: 'plus', tap: 'add' }) });
X.itemForm = ({ stock = false, tobacco = false } = {}) => X.scr('Новая позиция', `
  ${field('Название', { type: 'iname', style: 'height:48px;margin-bottom:8px' })}
  <div style="display:flex;gap:8px;margin-bottom:8px">${field('Цена, ₽', { type: 'iprice', style: 'height:48px;flex:1' })}${field('Ставка НДС', { val: 'Без НДС', style: 'height:48px;flex:1' })}</div>
  ${field('Состав / описание', { val: 'Чаша на грейпфруте, микс от мастера', style: 'height:48px;margin-bottom:8px' })}
  <div class="gx-card" style="padding:10px 12px;margin-bottom:6px${stock ? ';border-color:var(--pr)' : ''}"><b style="font-size:13.5px">Склад (автосписание)</b>
    <div style="display:flex;gap:8px;margin-top:8px">${field('Продукт', { val: stock ? '<span class="gx-show" data-mark="prod">не выбран</span><span class="gx-alt" data-mark="prod">Смесь для кальяна</span>' : 'не выбран', tap: stock ? 'prod' : '', style: 'height:44px;flex:1.4' })}${field('Граммовка', { type: stock ? 'gram' : '', ph: 'г', style: 'height:44px;flex:1' })}</div></div>
  ${switchRow('Составная позиция (микс)', 'Несколько продуктов склада')}
  ${switchRow('Табак / никотин', 'Без фото, без скидок и бонусов, только в заведении', { tap: tobacco ? 'tob' : '', mark: tobacco ? 'tob' : '' })}`,
  { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });
X.guestTobacco = () => `<div class="gx-app">${status()}<div style="padding:8px 16px 0"><b style="font-size:28px">Кальяны</b>
  <div class="gx-mu" style="font-size:12px;margin:4px 0 12px">Список доступен только в заведении</div>
  ${[['Классический кальян', '1 200 ₽'], ['Кальян на молоке', '1 500 ₽'], ['Кальян на ананасе', '2 000 ₽']].map(([n, p]) => `<div style="display:flex;justify-content:space-between;padding:12px 2px;border-bottom:1px solid var(--bd);font-size:14.5px"><span>${n}</span><b>${p}</b></div>`).join('')}
  <div class="gx-mu" style="font-size:11.5px;line-height:1.4;margin-top:12px">Без фото и рекламы — так требует закон 15-ФЗ. Скидки и бонусы на табак не действуют.</div></div>${X.guestTabs('Меню')}</div>`;

/* ---- Зарплата ---- */
X.attrCheck = () => X.scr('Стол 6 · кто что добавил', `${X.card(`
  ${[['Кальян на ананасе', '2 000 ₽', 'Максим · кальянщик', 'hk'], ['Мохито ×2', '600 ₽', 'Денис · бармен', 'br'], ['Лимонад ×2', '400 ₽', 'Алина · официант', 'wt']].map(([n, v, who, k]) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)"${mk(k)}><div style="flex:1"><b style="font-size:14px">${n}</b><div class="gx-mu" style="font-size:11.5px">добавил: ${who}</div></div><b>${v}</b></div>`).join('')}
  ${X.line('Оплачено картой', '3 000 ₽', { b: true })}`)}
  ${X.h('Кто сколько получит с этого чека')}
  ${X.card(`<div class="gx-hide"${mk('hk')}>${X.line('Максим · 10% с кальянов', '200 ₽')}</div><div class="gx-hide"${mk('br')}>${X.line('Денис · 5% с бара (1 000 ₽)', '50 ₽')}</div><div class="gx-hide"${mk('wt')}>${X.line('Алина · 3% с чека без кальянов', '30 ₽')}</div>`)}
  <div class="gx-mu" style="font-size:11.5px;line-height:1.4">Лимонады бар не готовил сам — они идут в общий котёл бара смены. Скидки, бонусы и возвраты процента не дают.</div>`);
X.review = () => X.scr('Зарплата', `${X.chips(['Пол-месяца', 'Этот месяц', 'Прошлый месяц'], 1)}
  ${X.card(`<div style="display:flex;justify-content:space-between;margin-bottom:6px"><b style="font-size:15px">Денис</b><span class="gx-mu" style="font-size:11.5px">12 смен · 118 ч</span></div>
    ${X.line('Обычные часы · 118 ч × 220 ₽', '25 960 ₽')}
    <div class="gx-card" style="padding:10px 12px;margin:8px 0;border-color:rgba(217,168,78,.6);background:rgba(217,168,78,.08)"${mk('chk')}><b style="font-size:13px;color:var(--warn)">Проверьте</b>
      <div style="font-size:12px;line-height:1.55;margin-top:4px">• 2 ручные правки · 3,5 ч · правила: Ольга<br>• Сам себе указал время: 1 смена<br>• Смена длиннее 14 часов: 1<br>• Ставка менялась 12.10: 200 → 220 ₽/ч</div></div>
    <div style="display:flex;justify-content:space-between;border-top:1px solid var(--bd);padding-top:7px"><b>К выплате</b><b class="gx-brass" style="font-size:15px">25 960 ₽</b></div>`)}`);
X.shifts = () => X.scr('Смены сотрудников', `${X.chips(['Сегодня', 'Этот месяц', 'Прошлый месяц'], 0)}
  ${X.card(`<div style="display:flex;align-items:center;gap:10px"><div style="flex:1"><b style="font-size:14.5px">Максим</b><div class="gx-mu" style="font-size:12px">12:05 — <span class="gx-show"${mk('closed')} style="color:var(--warn);font-weight:600">идёт 15 ч 40 мин</span><span class="gx-alt"${mk('closed')}>02:30 · 14 ч 25 мин · ручная правка</span></div></div>
    <span class="gx-show"${mk('closed')}>${btn('Закрыть', { kind: 'sm', tap: 'close' })}</span></div>`, 'border-color:rgba(217,168,78,.6)')}
  ${X.card(`<div style="display:flex;align-items:center;gap:10px"><div style="flex:1"><b style="font-size:14.5px">Алина</b><div class="gx-mu" style="font-size:12px">17:40 — 02:10 · 8 ч 30 мин</div></div><span class="gx-mu">${ic('pen', 17)}</span></div>`)}
  ${X.card(`<div style="display:flex;align-items:center;gap:10px;opacity:.6"><div style="flex:1"><b style="font-size:14.5px;text-decoration:line-through">Денис</b><div class="gx-mu" style="font-size:12px">Отменено · Ольга · не входит в зарплату</div></div></div>`)}`)
  + X.fab('Добавить смену', 'addsh');
X.closeShiftDialog = dialog('Когда ушёл Максим?', `${field('Конец', { type: 'end', focus: true, ph: 'чч:мм' })}<div class="gx-mu" style="font-size:11.5px;margin-top:8px">Правка подпишется вашим именем и будет видна в зарплате.</div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Сохранить', { kind: 'sm', tap: 'ok' })}`);
X.tipsDialog = dialog('Чаевые к счёту', `<div class="gx-f" style="height:50px"${tp('who')}><span class="gx-f-l">Кому</span><span class="gx-val"><span class="gx-show" data-mark="all">Алина</span><span class="gx-alt" data-mark="all">Всей смене (поровну)</span></span></div>
  <div style="height:8px"></div>${field('Сумма, ₽', { type: 'tip' })}
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${['5% · 100 ₽', '10% · 200 ₽', '15% · 300 ₽'].map((c) => `<span class="gx-chip" style="height:30px">${c}</span>`).join('')}</div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Добавить', { kind: 'sm', tap: 'ok' })}`);
X.reports = () => X.scr('Отчёты', `${X.chips(['Сегодня', '7 дней', '30 дней', 'Свой период'], 1, 1, 'w')}
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">${[['Выручка', '214 380 ₽'], ['Визитов', '412'], ['Средний чек', '1 920 ₽']].map(([l, v]) => `<div class="gx-card" style="padding:10px"><div class="gx-mu" style="font-size:11px">${l}</div><b style="font-size:15px">${v}</b></div>`).join('')}</div>
  ${X.card(`<b style="font-size:13.5px">По сотрудникам</b>${X.line('Алина', '78 240 ₽', { mu: true })}${X.line('Максим', '71 900 ₽', { mu: true })}${X.line('Денис', '64 240 ₽', { mu: true })}`)}
  ${X.card(`<b style="font-size:13.5px">Терминал по банкам</b>${X.line('Сбер', '41 200 ₽', { mu: true })}${X.line('Т-Банк', '18 600 ₽', { mu: true })}<b style="font-size:13.5px;display:block;margin-top:6px">Агрегаторы</b>${X.line('Яндекс Еда · комиссия 25%', 'к выплате 13 860 ₽', { mu: true })}`)}`,
  { bottom: `<div style="display:flex;gap:6px">${btn('Напечатать', { kind: 'ghost sm', icon: 'printer', style: 'flex:1' })}${btn('Текстом', { kind: 'ghost sm', style: 'flex:1' })}${btn('Excel', { kind: 'sm', icon: 'dl', tap: 'xls', style: 'flex:1' })}</div>` });
X.activity = () => X.scr('Активность и журнал', `${X.chips(['Все', 'Скидки', 'Возвраты', 'Смены', 'Склад'])}
  ${[['21:58', 'Ольга', 'Возврат чека · Стол 2 · 1 947 ₽', '#E07A5F'], ['21:40', 'Алина', 'Скидка по карте 10% · Стол 2', ''], ['20:12', 'Максим', 'Удалил позицию «Перезабивка» · Диван 8', '#E07A5F'], ['19:05', 'Ольга', 'Правка смены: Максим, конец 02:30', '#D9A84E'], ['18:30', 'ИИ-ассистент', 'Списание склада: лимоны 0,5 кг · подтвердила Ольга', ''], ['17:55', 'Ольга', 'Ставка Дениса: 200 → 220 ₽/ч', '#D9A84E']].map(([t, who, what, c], i) =>
    `<div class="gx-fold"${i === 0 ? '' : ''} style="display:flex;gap:10px;padding:10px 2px;border-bottom:1px solid var(--bd)"><span class="gx-mu" style="font-size:12px;width:38px">${t}</span><div style="flex:1"><b style="font-size:13.5px">${who}</b><div style="font-size:12.5px;${c ? `color:${c}` : 'color:var(--mu)'}">${what}</div></div></div>`).join('')}`);

/* ---- Бонус за шаги выручки (новое) ---- */
X.stepsForm = () => X.scr('Алина', `<div class="gx-card" style="padding:14px">
  <b style="display:flex;align-items:center;gap:8px;font-size:16px;margin-bottom:4px"><span class="gx-brass">${ic('wallet', 19)}</span>Зарплата</b>
  <div class="gx-mu" style="font-size:12px;margin-bottom:10px">Оклад 2 000 ₽ за смену · 3% с чеков</div>
  <div class="gx-sep" style="margin:4px 0 10px"></div>
  <div style="display:flex;align-items:flex-start;gap:10px"><div style="flex:1"><b style="font-size:14px">Бонус за выручку заведения</b><div class="gx-mu" style="font-size:11.5px;line-height:1.35">Если выручка за период достигла порога — сотрудник получает бонус</div></div>
    <span style="color:#D98A5C;font-size:13px;font-weight:600;display:flex;align-items:center;gap:3px"${tp('add')}>${ic('plus', 15)}Добавить</span></div>
  <div class="gx-unfold"${mk('s1')} style="--max:150px"><div style="padding-top:10px"><div style="display:flex;gap:8px">${field('Выручка от, ₽', { type: 't1', style: 'height:46px;flex:1' })}${field('Бонус, ₽', { type: 'v1', style: 'height:46px;flex:1' })}</div>
    <div class="gx-seg2" style="width:100%;height:34px;margin-top:6px"><span class="on" style="font-size:12px">Фиксированная сумма</span><span style="font-size:12px">Процент от выручки</span></div></div></div>
  <div class="gx-unfold"${mk('s2')} style="--max:150px"><div style="padding-top:12px"><div style="display:flex;gap:8px">${field('Выручка от, ₽', { type: 't2', style: 'height:46px;flex:1' })}${field('<span class="gx-show" data-mark="pct">Бонус, ₽</span><span class="gx-alt" data-mark="pct">Бонус, %</span>', { type: 'v2', style: 'height:46px;flex:1' })}</div>
    <div class="gx-show"${mk('pct')}><div class="gx-seg2" style="width:100%;height:34px;margin-top:6px"><span class="on" style="font-size:12px">Фиксированная сумма</span><span style="font-size:12px"${tp('pct')}>Процент от выручки</span></div></div>
    <div class="gx-alt"${mk('pct')}><div class="gx-seg2" style="width:100%;height:34px;margin-top:6px"><span style="font-size:12px">Фиксированная сумма</span><span class="on" style="font-size:12px">Процент от выручки</span></div></div></div></div>
  </div>`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });
X.stepsPayroll = () => X.scr('Зарплата', `${X.chips(['Пол-месяца', 'Этот месяц', 'Прошлый месяц'], 1)}
  <div class="gx-mu" style="font-size:12px;margin:0 2px 10px">01.10 – 31.10 · выручка заведения 512 000 ₽</div>
  ${X.card(`<div style="display:flex;justify-content:space-between;margin-bottom:6px"><b style="font-size:15px">Алина</b><span class="gx-mu" style="font-size:11.5px">13 смен · 128 ч</span></div>
    ${X.line('Оклад за смену · 13 × 2 000 ₽', '26 000 ₽')}${X.line('С чеков · 3% от 214 000 ₽', '6 420 ₽')}
    <div${mk('b')} class="gx-hide">${X.line('Бонус за выручку · 2 шага из 2', '8 120 ₽', { c: 'var(--ok)' })}<div class="gx-mu" style="font-size:11.5px;line-height:1.4;padding-left:2px">от 300 000 ₽ → 3 000 ₽ · от 500 000 ₽ → 1% = 5 120 ₽</div></div>
    <div style="display:flex;justify-content:space-between;border-top:1px solid var(--bd);margin-top:6px;padding-top:7px"><b>К выплате</b><b class="gx-brass" style="font-size:15px"><span class="gx-show"${mk('b')}>32 420 ₽</span><span class="gx-alt"${mk('b')}>40 540 ₽</span></b></div>`)}`);

/* ---- Лояльность ---- */
X.loyalty = () => X.scr('Программа лояльности', `<div class="gx-mu" style="font-size:12.5px;line-height:1.4;margin-bottom:10px">Уровень считается по всем чекам гостя. 1 бонус = 1 ₽.</div>
  ${[['Серебро', '0', '3'], ['Золото', '20 000', '5'], ['Платина', '60 000', '7'], ['Алмаз', '150 000', '10']].map(([n, from, pct], i) => X.card(`<b style="font-size:14.5px">${n}</b>
    <div style="display:flex;gap:8px;margin-top:8px">${field('От, ₽', { val: from, style: 'height:42px;flex:1.3' })}${field('Кешбэк, %', i === 1 ? { val: '<span class="gx-show" data-mark="p">5</span><span class="gx-alt" data-mark="p">6</span>', tap: 'p', style: 'height:42px;flex:1' } : { val: pct, style: 'height:42px;flex:1' })}</div>`, 'padding:10px 12px;margin-bottom:8px')).join('')}
  ${switchRow('Без скидок и бонусов на кальяны', '', { on: true })}`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });
X.payBonus = () => payment({ total: '2 030' }).replace(`${field('', { ph: 'Телефон гостя', style: 'flex:1;height:42px' })}${btn('Найти', { kind: 'ghost sm' })}`,
  `${field('', { type: 'ph', ph: 'Телефон гостя', style: 'flex:1;height:42px' })}${btn('Найти', { kind: 'ghost sm', tap: 'find' })}</div><div class="gx-unfold"${mk('g')}><div style="padding-top:10px;font-size:13px">Аня · Золото · <b class="gx-brass">640 бонусов</b><div style="display:flex;gap:8px;margin-top:8px">${btn('Списать 640', { kind: 'sm', tap: 'use', style: 'flex:1' })}${btn('Начислить 5%', { kind: 'ghost sm', style: 'flex:1' })}</div></div>`);
X.cards = () => X.scr('Скидочные карты', `${X.card(`<div style="display:flex;justify-content:space-between"><b>№ 0147 · Игорь</b><span class="gx-brass" style="font-weight:600">10%</span></div><div class="gx-mu" style="font-size:12px">постоянный гость</div>`)}
  ${X.card(`<div style="display:flex;justify-content:space-between"><b>№ 0152 · Мария</b><span class="gx-brass" style="font-weight:600">15%</span></div><div class="gx-mu" style="font-size:12px">день рождения в октябре</div>`)}
  <div class="gx-unfold"${mk('saved')}>${X.card(`<div style="display:flex;justify-content:space-between"><b>№ 0160 · Аня</b><span class="gx-brass" style="font-weight:600">10%</span></div><div class="gx-mu" style="font-size:12px">новая карта</div>`, 'border-color:var(--pr)')}</div>`)
  + X.fab('Новая карта', 'new');
X.cardDialog = dialog('Новая карта', `${field('Номер карты', { type: 'cn', focus: true })}<div style="height:8px"></div>${field('Имя гостя', { type: 'cname' })}<div style="height:8px"></div>${field('Скидка, %', { type: 'cpct' })}
  <div class="gx-mu" style="font-size:11.5px;margin-top:8px">Без телефонов и документов гостя</div>`, `${btn('Отмена', { kind: 'text' })}${btn('Сохранить', { kind: 'sm', tap: 'save' })}`);
X.discDialog = dialog('Скидочная карта', `${field('', { type: 'dn', focus: true, ph: 'Номер карты' })}<div class="gx-unfold"${mk('found')}><div style="color:var(--ok);font-weight:600;font-size:13px;margin-top:10px">Аня · скидка 10% · −203 ₽</div></div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Применить', { kind: 'sm', tap: 'apply' })}`);
X.certs = ({ issued = false } = {}) => X.scr('Сертификаты', `${issued ? '' : `<div class="gx-unfold"${mk('iss')} style="--max:240px">`}${X.card(`<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:15px">Пост в ТГ на выходные</b><span style="font-size:11px;padding:3px 8px;border-radius:9px;background:rgba(109,178,135,.18);color:var(--ok);font-weight:600">активен</span></div>
    <div style="font:700 22px/1.2 ui-monospace,monospace;letter-spacing:.08em;margin:8px 0 4px">WEEKEND500</div>
    <div class="gx-mu" style="font-size:12px">500 бонусов каждому · 0 из 50 · ещё 14 дней</div>
    <div style="display:flex;gap:8px;margin-top:10px">${btn('Скопировать код', { kind: 'ghost sm', style: 'flex:1' })}${btn('<span class="gx-show" data-mark="post">Скопировать пост</span><span class="gx-alt" data-mark="post">Скопировано ✓</span>', { kind: 'sm', tap: 'post', style: 'flex:1' })}</div>`, 'border-color:var(--pr)')}${issued ? '' : '</div>'}
  ${X.card(`<b style="font-size:14.5px">День рождения</b><div class="gx-mu" style="font-size:12px;margin-top:2px">BDAY300 · 300 бонусов · 12 из 100</div>`)}`) + X.fab('Выпустить сертификат', 'new', 'gem');
X.certDialog = dialog('Выпустить сертификат', `${field('Бонусов каждому', { type: 'b', focus: true })}<div style="height:8px"></div>${field('Сколько человек успеет', { type: 'n' })}<div style="height:8px"></div>${field('Действует дней', { type: 'd' })}`,
  `${btn('Отмена', { kind: 'text' })}${btn('Выпустить', { kind: 'sm', tap: 'go' })}`);
X.stories = () => X.scr('Лента для гостей', `${X.card(`<div style="height:92px;border-radius:10px;background:linear-gradient(135deg,#5A3A26,#2A1C14);margin-bottom:8px;display:flex;align-items:flex-end;padding:10px;font-weight:600;color:#FFF7F0">Новый вкус: манго-маракуйя</div>
    <div class="gx-mu" style="font-size:12px">ведёт в меню</div><div style="display:flex;gap:14px;margin-top:8px;font-size:12.5px;color:#D98A5C"><span>Выше в ленте</span><span${tp('down')}>Ниже в ленте</span><span>Изменить</span></div>`)}
  ${X.card(`<div style="height:70px;border-radius:10px;background:linear-gradient(135deg,#2E3A4A,#141A22);margin-bottom:8px;display:flex;align-items:flex-end;padding:10px;font-weight:600;color:#FFF7F0">Живая музыка в пятницу</div><div class="gx-mu" style="font-size:12px">ведёт на бронь</div>`)}`) + X.fab('Новая карточка', 'new');
X.storyForm = () => X.scr('Новая карточка', `${field('Заголовок', { type: 'st', style: 'height:48px;margin-bottom:8px' })}${field('Текст', { type: 'sx', style: 'height:64px;margin-bottom:8px' })}${field('Ссылка на фото', { val: 'фото из галереи ✓', style: 'height:48px;margin-bottom:12px' })}
  <div class="gx-mu" style="font-size:12.5px;margin-bottom:6px">Кнопка ведёт</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><span class="gx-chip">В меню</span><span class="gx-chip"${tp('book')}${mk('book')}>К брони</span><span class="gx-chip on">Без кнопки</span></div>`, { bottom: btn('Сохранить', { icon: 'check', tap: 'save' }) });
X.reviews = () => X.scr('Отзывы гостей', `${X.chips(['Все отзывы', 'Ниже 5 звёзд', 'Ниже 4 звёзд — разобраться'], 0, 2, 'bad')}
  <div class="gx-fold"${mk('bad')}>${X.card(`<div style="display:flex;justify-content:space-between"><b>Игорь</b>${X.stars(5)}</div><div style="font-size:13px;margin-top:4px">Лучший кальян в городе, Максим — мастер!</div>`)}
  ${X.card(`<div style="display:flex;justify-content:space-between"><b>Мария</b>${X.stars(4)}</div><div style="font-size:13px;margin-top:4px">Вкусно, но долго несли десерт.</div>`)}</div>
  ${X.card(`<div style="display:flex;justify-content:space-between"><b>Гость без имени</b>${X.stars(2)}</div><div style="font-size:13px;margin-top:4px">Ждали счёт 20 минут.</div><div class="gx-mu" style="font-size:12px;margin-top:6px">Стол 6 · вчера, 23:10 · Телефон: +7 ••• ••• 31-08</div>`, 'border-color:rgba(212,85,63,.5)')}`);
X.guests = () => X.scr('Гости', `<div class="gx-f" style="height:46px;margin-bottom:10px" data-tap="q" data-type="q"><span class="gx-val"></span><span class="gx-ph">Поиск по имени или телефону</span></div>
  <div class="gx-unfold"${mk('found')} style="--max:400px">${X.card(`<div style="display:flex;align-items:center;gap:12px"><div class="gx-ava" style="width:44px;height:44px">А</div><div style="flex:1"><b style="font-size:16px">Аня</b><div class="gx-mu" style="font-size:12px">+7 ••• ••• 45-67 · Золото · 640 бонусов</div></div></div>
    <div class="gx-mu" style="font-size:12px;margin:10px 0">23 визита · всего 38 400 ₽ · последний — вчера, Стол 1</div>
    ${btn('Сменить номер', { kind: 'ghost sm', style: 'width:100%;margin-bottom:8px' })}${btn('Объединить с новым устройством', { kind: 'ghost sm', tap: 'merge', style: 'width:100%;margin-bottom:8px' })}${btn('Удалить гостя', { kind: 'text', style: 'width:100%;color:#E07A5F' })}`)}</div>`);
X.mergeDialog = dialog('Объединить с новым устройством', `<p>Аня поставила приложение на новый телефон. Попросите её открыть «Профиль» и продиктовать код.</p>${field('Код из профиля на новом телефоне', { type: 'mc', focus: true })}`,
  `${btn('Отмена', { kind: 'text' })}${btn('Объединить', { kind: 'sm', tap: 'ok' })}`);

/* ---- Склад ---- */
X.stock = ({ added = false } = {}) => X.scr('Склад', `${X.chips(['Остатки', 'История', 'Что заказать'])}
  ${[['Смесь для кальяна', 'Кальяны', '1,24 кг', false, 'dk'], ['Уголь кокосовый', 'Кальяны', '3,5 кг', false], ['Лимоны', 'Бар', '0,4 кг', true], ['Молоко 3,2%', 'Бар', '6 л', false]].map(([n, c, v, low, k]) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:11px 2px;border-bottom:1px solid var(--bd)"${tp(k)}><div class="gx-ico" style="background:var(--el);color:var(--mu)">${ic('box', 18)}</div><div style="flex:1"><b style="font-size:14.5px">${n}</b><div class="gx-mu" style="font-size:11.5px">${c}</div></div><b style="${low ? 'color:#E07A5F' : ''}">${v}${low ? ' · мало' : ''}</b></div>`).join('')}
  ${added ? '' : `<div class="gx-unfold"${mk('new')}>`}<div style="display:flex;align-items:center;gap:12px;padding:11px 2px;border-bottom:1px solid var(--bd)"><div class="gx-ico">${ic('box', 18)}</div><div style="flex:1"><b style="font-size:14.5px">Мята свежая</b><div class="gx-mu" style="font-size:11.5px">Бар · порог 0,2 кг</div></div><b>0 кг</b></div>${added ? '' : '</div>'}`)
  + X.fab('Новая позиция склада', 'new');
X.stockDialog = dialog('Новая позиция склада', `${field('Название', { type: 'sn', focus: true })}<div style="height:8px"></div>${field('Категория', { val: 'Бар' })}<div style="height:8px"></div>
  <div style="display:flex;gap:8px">${field('Единица измерения', { val: 'кг', style: 'flex:1' })}${field('Порог «мало»', { type: 'thr', style: 'flex:1' })}</div>`, `${btn('Отмена', { kind: 'text' })}${btn('Сохранить', { kind: 'sm', tap: 'save' })}`);
X.stockItem = () => X.scr('Смесь для кальяна', `${X.card(`<div class="gx-mu" style="font-size:12px">Остаток</div><b style="font-size:30px"><span class="gx-show"${mk('in')}>1,24 кг</span><span class="gx-alt"${mk('in')}>3,24 кг</span></b>`)}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">${btn('Приход', { icon: 'plus', tap: 'in' })}${btn('Списание', { kind: 'ghost', icon: 'minus' })}</div>${btn('Скорректировать остаток вручную', { kind: 'text', style: 'width:100%' })}
  ${X.h('История движений')}
  <div class="gx-unfold"${mk('in')}>${X.line('Приход · +2 кг · Ольга', 'сейчас', { mu: true })}</div>
  ${X.line('Продажа · Классический кальян ×1 · −20 г', '21:40', { mu: true })}${X.line('Продажа · Кальян на молоке ×2 · −40 г', '20:15', { mu: true })}${X.line('Списание · угощение · −20 г · Максим', 'вчера', { mu: true })}`);
X.inv = ({ started = false } = {}) => X.scr('Инвентаризация', started ? `<div class="gx-mu" style="font-size:12px;margin-bottom:8px">Инвентаризация в процессе · посчитано 2 из 4</div>
  ${[['Смесь для кальяна', '1,24 кг', 'c1', '1,18'], ['Уголь кокосовый', '3,5 кг', '', '3,5'], ['Лимоны', '0,4 кг', 'c3', ''], ['Молоко 3,2%', '6 л', '', '6']].map(([n, exp, k, val]) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--bd)"><div style="flex:1"><b style="font-size:14px">${n}</b><div class="gx-mu" style="font-size:11.5px">по учёту ${exp}</div></div>${field('', { type: k, val: k ? '' : val, ph: k ? 'факт' : '', style: 'width:96px;height:40px' })}</div>`).join('')}
  <div class="gx-unfold"${mk('res')}><div class="gx-card" style="padding:10px 12px;margin-top:10px;border-color:rgba(217,168,78,.6)"><b style="font-size:13.5px">Расхождений: 2</b><div style="font-size:12.5px;line-height:1.5;margin-top:4px">Смесь для кальяна −60 г · Лимоны −0,1 кг<br>Остатки поправлены, запись в журнале.</div></div></div>`
  : `<div style="text-align:center;padding:120px 10px 0"><span class="gx-mu">${ic('checks', 34)}</span><b style="display:block;font-size:18px;margin:12px 0 6px">Новая инвентаризация</b><div class="gx-mu" style="font-size:13px;line-height:1.4">Пересчитайте то, что есть на самом деле. Сотрудники тоже могут считать: меню ☰ → «Инвентаризация».</div></div>`,
  { bottom: started ? btn('Завершить инвентаризацию', { tap: 'fin' }) : btn('Начать инвентаризацию', { tap: 'start' }) });

/* ---- Интеграции ---- */
X.integ = (icon, title, sub, body) => X.scr('Интеграции', `<div class="gx-card" style="padding:14px">
  <b style="display:flex;align-items:center;gap:8px;font-size:16px"><span class="gx-brass">${ic(icon, 19)}</span>${title}</b>
  <div class="gx-mu" style="font-size:11.5px;line-height:1.4;margin:4px 0 12px">${sub}</div>${body}</div>`);
X.egais = () => X.integ('box', 'ЕГАИС (алкоголь)', 'Нужны УТМ на компьютере в заведении и электронная подпись. Продажи в ЕГАИС общепит не отправляет — только накладные и вскрытие тары.',
  `${field('Адрес компьютера с УТМ', { type: 'utm', style: 'height:48px' })}
  ${btn('Проверить связь и входящие документы', { kind: 'ghost sm', icon: 'check', tap: 'chk', style: 'margin-top:12px;width:100%' })}
  <div class="gx-unfold"${mk('ok')} style="--max:220px"><div style="color:var(--ok);font-size:12.5px;font-weight:600;margin:10px 0 6px">✓ УТМ на связи · новых накладных: 2</div>
    ${X.line('ООО «Напитки Юга» · ТТН 0451', '12 бут.', { mu: true })}${X.line('ИП Сафонов · ТТН 1188', '6 бут.', { mu: true })}<div class="gx-mu" style="font-size:11.5px;margin-top:4px">Принимают и подписывают их в УТМ.</div></div>`);
X.fiscal = () => X.integ('receipt', 'Онлайн-касса (54-ФЗ)', 'Фискальный чек пробивается при каждой оплате. Пока касса не подключена — чеки пробивайте на своей ККТ.',
  `<div class="gx-f" style="height:52px"${tp('mode')}><span class="gx-f-l">Касса</span><span class="gx-val"><span class="gx-show"${mk('mode')}>Касса не подключена</span><span class="gx-alt"${mk('mode')}>Регистратор АТОЛ в заведении</span></span></div>
  <div class="gx-unfold"${mk('mode')} style="--max:260px"><div style="padding-top:10px">${field('Адрес веб-сервера драйвера АТОЛ 10', { type: 'atol', style: 'height:48px;margin-bottom:8px' })}
    <div style="display:flex;gap:8px">${field('Налогообложение', { val: 'УСН доходы', style: 'height:48px;flex:1' })}${field('НДС по умолчанию', { val: 'Без НДС', style: 'height:48px;flex:1' })}</div></div></div>
  ${btn('Проверить связь с регистратором', { kind: 'ghost sm', icon: 'check', tap: 'chk', style: 'margin-top:12px;width:100%' })}
  <div class="gx-unfold"${mk('ok')}><div style="color:var(--ok);font-size:12.5px;font-weight:600;line-height:1.4;margin-top:10px">✓ Регистратор на связи: смена открыта, ФН действителен до 03.2028</div></div>`);
X.terminal = () => X.integ('card', 'Терминал оплаты', 'Подходит терминал любого банка, терминал в телефоне и табличка с QR СБП.',
  `${field('Способ', { val: 'Терминал любого банка', style: 'height:48px;margin-bottom:10px' })}
  <div class="gx-mu" style="font-size:12.5px;margin-bottom:6px">Какие терминалы стоят в заведении</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">${['Сбер', 'ВТБ', 'Альфа-Банк', 'Т-Банк', 'Газпромбанк', 'Точка', 'Другой банк'].map((b) => `<span class="gx-chip${b === 'Сбер' ? ' on' : ''}"${b === 'Т-Банк' ? tp('tb') + mk('tb') : ''} style="height:30px">${b === 'Т-Банк' ? `<span class="gx-alt" data-mark="tb">✓ </span>` : b === 'Сбер' ? '✓ ' : ''}${b}</span>`).join('')}</div>
  ${btn('Тест', { kind: 'ghost sm', style: 'margin-top:12px' })}`);
X.payTerminal = () => payment({ total: '2 030' });
X.termDialog = dialog('Оплата на терминале', `<p>Внесите 2 030 ₽ на терминале и дождитесь его чека/слипа.<br><br>Нажмите «Оплата прошла» только после того, как терминал это подтвердил.</p>
  <b style="display:block;font-size:13.5px;margin:12px 0 8px">На каком терминале?</b>
  <div style="display:flex;gap:8px"><span class="gx-chip"${tp('sber')}${mk('sber')} style="height:32px"><span class="gx-alt" data-mark="sber">✓ </span>Сбер</span><span class="gx-chip" style="height:32px">Т-Банк</span></div>`,
  `${btn('Отменить', { kind: 'text' })}${btn('Оплата прошла', { kind: 'ok sm', tap: 'yes' })}`);
X.aggr = () => X.integ('truck', 'Агрегаторы доставки', 'Заказ гость уже оплатил в приложении агрегатора. Выручка идёт отдельной строкой, не в наличные.',
  `${switchRow('Яндекс Еда', '', { tap: 'ya', mark: 'ya' })}
  <div class="gx-unfold"${mk('ya')} style="--max:200px">${field('Комиссия по договору, %', { type: 'com', style: 'height:46px;margin-bottom:4px' })}${switchRow('Чек покупателю пробивает агрегатор', 'Касса свой фискальный чек не пробьёт — продажа не попадёт в налоговую дважды', { on: true })}</div>
  ${switchRow('Купер', '')}${switchRow('Мегамаркет', '')}<div class="gx-mu" style="font-size:12.5px;color:#D98A5C">+ Другой агрегатор</div>`);
X.payAggr = () => payment({ total: '2 640' }).replace(`${'<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'}
    <span style="flex:1;font-size:14px">За счёт заведения:</span>`, `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"${tp('ya')}>
    <span style="flex:1;font-size:14px;color:#D98A5C;font-weight:600">Яндекс Еда:</span><div class="gx-f" style="width:132px;height:42px;justify-content:flex-end;color:var(--tx)"><span class="gx-show" data-mark="ya">0</span><span class="gx-alt" data-mark="ya">2640</span></div></div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <span style="flex:1;font-size:14px">За счёт заведения:</span>`);

/* ---- ИИ ---- */
X.aiChat = () => sheet(`<b style="display:flex;align-items:center;gap:8px;font-size:18px;margin-bottom:10px"><span class="gx-brass">${ic('spark', 20)}</span>Ассистент зала</b>
  <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><div class="gx-hide"${mk('q')} style="background:var(--pr);color:#FFF7F0;border-radius:14px 14px 4px 14px;padding:8px 12px;font-size:13px;max-width:80%">Какие столы освободятся через час?</div></div>
  <div class="gx-hide"${mk('a')} style="background:var(--el);border-radius:14px 14px 14px 4px;padding:10px 12px;font-size:13px;line-height:1.5;max-width:92%">До 22:45 освободятся: <b>Стол 1</b> (сеанс до 22:12), <b>Бар</b> — Кирилл просил счёт. <b>Диван 8</b> уже на 10 мин дольше сеанса — стоит подойти. На 23:00 бронь на Стол 6.</div>
  <div style="display:flex;gap:8px;margin-top:12px">${field('', { type: 'aq', ph: 'Спросите обычными словами…', style: 'flex:1;height:44px' })}<span style="width:44px;height:44px;border-radius:50%;background:var(--pr);color:#FFF7F0;display:flex;align-items:center;justify-content:center"${tp('send')}>${ic('send', 18)}</span></div>`);
X.aiInsights = () => X.scr('ИИ-разборы', `<div class="gx-tiles" style="padding:0;gap:10px">${[['chart', 'Выручка'], ['box', 'Заявка на закупку'], ['tag', 'Идеи акций'], ['star', 'Отзывы гостей'], ['cal', 'Брони на смену'], ['spark', 'Свободный диалог с аналитиком']].map(([i, t]) =>
  `<div class="gx-card" style="height:84px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;text-align:center;padding:6px"${tp(t === 'Заявка на закупку' ? 'buy' : '')}>${ic(i, 22)}<span style="font-size:12.5px;font-weight:500">${t}</span></div>`).join('')}</div>`);
X.aiBuy = () => X.scr('Заявка на закупку', `<div class="gx-card" style="padding:12px 14px;font-size:13px;line-height:1.6"><span class="gx-brass" style="display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:6px">${ic('spark', 16)}По продажам за 14 дней и остаткам</span>
  <b>Срочно (кончится за 2 дня):</b><br>• Лимоны — 3 кг<br>• Мята свежая — 0,8 кг<br><b>На неделю:</b><br>• Смесь для кальяна — 1 кг (расход ~140 г/день)<br>• Уголь кокосовый — 6 кг<br>• Молоко 3,2% — 12 л<br><span class="gx-mu">Сок яблочный продаётся вдвое медленнее — можно не брать.</span></div>`,
  { bottom: `<div style="display:flex;gap:8px">${btn('Скопировать', { kind: 'ghost', style: 'flex:1' })}${btn('Отправить в Telegram', { style: 'flex:1' })}</div>` });

/* ---- Кабинет: сеть, бэкап, поддержка, Windows, РКН ---- */
X.webNetwork = ({ tap = {} } = {}) => web('Тарифы', `<h3>Тарифы</h3><div class="gx-mu">Кафе «Лето» · тариф Бизнес</div>
  <div class="gx-web-card"><h5>Сеть заведений</h5><div class="gx-mu" style="font-size:13px;line-height:1.5;max-width:560px">У каждой точки свой зал, сотрудники и PIN-коды. Гости и их бонусы — общие на всю сеть.</div>
    <div style="margin-top:12px">${wBtn('<span class="gx-show" data-mark="net">Перевести в сеть</span><span class="gx-alt" data-mark="net">Сеть «Лето» ✓</span>', { tap: 'net' })}</div></div>
  <div class="gx-web-card"><h5>Точки сети</h5>
    <div class="gx-web-row" style="border-top:none"><span style="flex:1">Кафе «Лето» · Центр<br><span class="gx-mu" style="font-size:12px">kafe-leto · оплачено до 03.10.2027</span></span></div>
    <div class="gx-unfold"${mk('pt')}><div class="gx-web-row"><span style="flex:1">Кафе «Лето» · Набережная<br><span class="gx-mu" style="font-size:12px">kafe-leto-2 · после оплаты появится на кассах</span></span><span class="gx-web-link">Оплатить</span></div></div>
    <div style="margin-top:8px">${wBtn('Добавить точку сети', { tap: 'pt', ghost: true })}</div></div>`, { tap });
X.webBackup = () => web('Настройки', `<h3>Настройки</h3>
  <div class="gx-web-card"><h5>Резервная копия</h5><div class="gx-mu" style="font-size:13px;line-height:1.5;max-width:560px">Все данные одним файлом: меню, зал, чеки, смены, бонусы гостей, склад. Имён, телефонов и адресов гостей в файле нет. Скачивать можно раз в 3 дня.</div>
    <div style="display:flex;align-items:center;gap:14px;margin-top:12px">${wBtn('Скачать бэкап заведения', { tap: 'dl' })}<span class="gx-hide"${mk('dl')} style="font-size:13px;color:#3F8A5C;font-weight:600">kafe-leto-2026-10-16.json · 4,2 МБ ✓</span></div></div>
  <div class="gx-web-card"><h5>Telegram-бот заведения</h5><div class="gx-mu" style="font-size:13px">Бот: @kafe_leto_bot · подключён</div></div>`);
X.webSupport = () => webPage(`<h3>Поддержка</h3><div class="gx-mu" style="margin-bottom:10px">Ответ придёт здесь же, в обращении</div>
  <div class="gx-web-card gx-web-narrow" style="margin-top:0">${wField('Что делали и что увидели на экране', { type: 'sup', ph: 'Опишите проблему' })}
    <div style="display:flex;align-items:center;gap:10px;font-size:13px;margin:4px 0 10px"><span class="gx-web-link"${tp('att')}>${ic('image', 15)} Приложить снимок экрана</span><span class="gx-hide"${mk('att')} class="gx-mu">screenshot.png ✓</span></div>
    ${wBtn('Отправить', { tap: 'send', style: 'width:100%;justify-content:center' })}</div>
  <div class="gx-unfold"${mk('ans')} style="--max:200px"><div class="gx-web-card gx-web-narrow"><b style="font-size:13px">Поддержка ZalPOS · 4 мин назад</b><div style="font-size:13px;line-height:1.5;margin-top:4px">Здравствуйте! Принтер выбран как Bluetooth, а на Windows нужен «Wi‑Fi / LAN». Переключите и нажмите «Тестовая печать».</div></div></div>`);
X.winDl = () => web('Устройства', `<h3>Устройства</h3><div class="gx-web-card"><h5>Сборка APK</h5><div class="gx-mu" style="font-size:13px;margin-bottom:8px">Готово · версия 1.41</div>
  ${[['Касса', ''], ['Касса (Windows)', 'win'], ['Гостевое приложение', '']].map(([n, k]) => `<div class="gx-web-row"><span style="flex:1;color:var(--mu)">${n} · готова</span><span class="gx-web-link"${tp(k)}>Скачать</span></div>`).join('')}</div>`);
// Синее окно SmartScreen — как его показывает Windows 10 и 11.
X.winSmart = () => `<div class="gx-smart"><h4>Система Windows защитила ваш компьютер</h4>
  <div style="max-width:560px;opacity:.95">Фильтр SmartScreen Microsoft Defender предотвратил запуск неопознанного приложения, которое может подвергнуть компьютер риску.</div>
  <div class="lnk" style="margin-top:12px;display:inline-block"${tp('more')}>Подробнее</div>
  <div class="gx-unfold"${mk('more')}><div style="margin-top:14px;opacity:.95">Приложение: ZalPOS-Kassa-Setup.exe<br>Издатель: неизвестный издатель</div></div>
  <div class="acts"><span class="gx-hide"${mk('more')}${tp('run')}>Выполнить в любом случае</span><span class="def">Не выполнять</span></div></div>`;
// Касса в окне Windows: зал схемой во всю ширину, список столов — по кнопке.
X.winApp = () => `<div class="gx-app gx-wide">
  <div class="gx-bar" style="height:52px;border-bottom:1px solid var(--bd)"><div class="gx-bar-btn">${ic('menu', 22)}</div><div class="gx-bar-title"><b>Зал</b><span>Алина</span></div>
    <div class="gx-bar-btn">${ic('grid', 20)}</div><div class="gx-bar-btn">${ic('spark', 20)}</div></div>
  <div class="gx-chips" style="margin-top:10px"><span class="gx-chip on">Основной зал</span><span class="gx-chip">2 этаж</span><span class="gx-chip">Терраса</span>
    <span style="width:14px"></span><span class="gx-chip on">Все 11</span><span class="gx-chip"><span class="dot" style="background:var(--ok)"></span>Свободны 5</span><span class="gx-chip"><span class="dot" style="background:var(--busy)"></span>Заняты 4</span></div>
  <div class="gx-map" style="top:104px">
    <div class="gx-map-in" style="top:10px;transform:scale(.94);transform-origin:top center">
      <svg class="gx-walls" viewBox="0 0 336 340" fill="none"><path d="M6 6h236M276 6h54v328H6V6"/></svg>
      <span class="gx-map-lbl" style="left:244px;top:-1px">Вход</span><span class="gx-map-lbl" style="left:132px;top:318px">Кухня</span>
      ${HALL.map((t) => mapTile(t, '')).join('')}
    </div>
    <div class="gx-map-pill">${ic('checks', 17, 2)}Показать список · 11</div>
  </div></div>`;
X.webRkn = () => webPage(`<h3>Уведомление об обработке ПД</h3><div class="gx-mu" style="margin-bottom:10px">Схема формы на pd.rkn.gov.ru — подпись через Госуслуги</div>
  <div class="gx-web-card gx-web-narrow gx-wf-wrap" style="margin-top:0">
    ${wField('Цель обработки', { type: 'goal', ph: '' })}
    ${wField('Категории данных', { val: 'ФИО; должность; рабочее время и зарплата' })}
    ${wField('Субъекты', { val: 'работники' })}
    ${wField('Трансграничная передача', { val: '<span class="gx-show" data-mark="tb">—</span><span class="gx-alt" data-mark="tb">нет</span>', tap: 'tb' })}
    ${wField('Место нахождения базы данных', { val: 'Российская Федерация' })}
    ${wBtn('Подписать и отправить', { tap: 'send', style: 'width:100%;justify-content:center;margin-top:6px' })}</div>`, { url: 'pd.rkn.gov.ru (схема)' });

// Переходы в разделы кассы, общие для сцен ниже.
const ADMIN_TO = (t) => ({ screen: adminHome({ tap: t }), cap: `Войдите по PIN администратора и откройте «${t}».`, acts: [{ wait: 400 }, { tap: 'tile' }] });
const GADMIN_TO = (t) => ({ screen: X.admin('Гости и лояльность', GUEST_TILES, t), cap: `Админ → «${t}».`, acts: [{ wait: 400 }, { tap: 'tile' }] });
const DRAWER_TO = (key, cap) => ({ screen: hall(), over: { kind: 'drawer', html: drawer({ tap: { [key]: key } }) }, cap, acts: [{ tap: key }] });

/* ---- Звонки и сигналы ---- */
X.alarmBanner = `<div class="gx-fold gx-alarm"${mk('acc')} style="margin:8px 12px 4px;padding:10px 12px;border-radius:14px;border:2px solid #D4553F;display:flex;align-items:center;gap:10px">
  <span style="color:#E07A5F">${ic('bell', 26)}</span>
  <div style="flex:1"><b style="font-size:15.5px;display:block">Новый заказ на кухню</b><span style="font-size:12.5px">Стол 5: Паста карбонара ×2, Том ям</span></div>
  ${btn('Принял', { kind: 'sm', tap: 'acc', style: 'background:#C4553F;height:44px;padding:0 16px;font-size:15px;font-weight:700' })}</div>`;
X.kitchenAlarm = () => kitchenScreen().replace('<div class="gx-chips">', `${X.alarmBanner}<div class="gx-chips">`);

X.notif = (title, body, k = 'n') => `<div class="gx-hide gx-buzz"${mk(k)} style="position:absolute;left:10px;right:10px;top:30px;z-index:6;padding:10px 12px;border-radius:16px;background:#2A2520;border:1px solid var(--bd);box-shadow:0 10px 26px rgba(0,0,0,.45)">
  <div class="gx-mu" style="font-size:11px;display:flex;justify-content:space-between"><span>ZalPOS · касса</span><span>сейчас</span></div>
  <b style="display:block;font-size:14.5px;margin-top:2px">${title}</b><span style="font-size:12.5px">${body}</span>
  <div class="gx-mu" style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:5px">${ic('phone', 13)} вибрация: три длинных</div></div>`;
X.hallReady = () => hall().replace('<div class="gx-app">', `<div class="gx-app">${X.notif('Готово · Стол 5', 'Можно выносить: Паста карбонара ×2, Том ям')}`);

X.watch = (big, small, sub, k = 'w') => `<div class="gx-app" style="display:flex;align-items:center;justify-content:center;background:#0E0D0C">
  <div style="position:relative;width:236px;height:236px;border-radius:50%;background:#000;border:10px solid #2C2824;box-shadow:0 0 0 2px #3A352F;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:26px">
    <div class="gx-mu" style="font-size:12px">19:42</div>
    <div class="gx-hide gx-buzz"${mk(k)}><b style="display:block;font-size:22px;margin:6px 0 2px;color:#F4EFE8">${big}</b>
    <span style="font-size:13px;color:#F4EFE8">${small}</span><div class="gx-mu" style="font-size:11px;margin-top:6px">${sub}</div></div>
  </div></div>`;

X.secCard = (icon, title, body, style = '') => X.card(`<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span class="gx-brass">${ic(icon, 19)}</span><b style="font-size:14px">${title}</b></div>${body}`, style);
X.signals = ({ relay = false, beep = false, lan = false } = {}) => X.scr('Звонки и сигналы', `
  ${lan ? '' : X.secCard('fork', 'Сигнал нового заказа на кухне', '<div class="gx-mu" style="font-size:12px;line-height:1.4">Звенит на экране «Кухня и бар», пока повар не нажмёт «Принял».</div>')}
  ${lan || beep ? '' : X.secCard('phone', 'Официанту: вибрация и часы', '<div class="gx-mu" style="font-size:12px;line-height:1.4">«Готово» с кухни и вызовы гостей — три длинных вибрации, их повторяют смарт-часы.</div>')}
  ${lan || beep ? '' : X.secCard('wifi', 'Wi‑Fi реле: звонок, лампа, пейджер', `${relay ? `<div class="gx-card" style="padding:9px 11px;margin:6px 0;display:flex;align-items:center;gap:10px"><span style="color:var(--ok)">${ic('bell', 18)}</span><div style="flex:1"><b style="font-size:13px">Звонок на раздаче</b><div class="gx-mu" style="font-size:11px">Shelly · 192.168.1.50 · новый заказ на кухню</div></div><span class="gx-mu">${ic('play', 18)}</span></div>` : ''}
    ${btn('Добавить реле', { kind: 'ghost sm', icon: 'plus', tap: 'add', style: 'margin-top:6px' })}`)}
  ${beep ? X.secCard('printer', 'Зуммер кухонного принтера', `<div class="gx-mu" style="font-size:12px;line-height:1.4;margin-bottom:8px">Принтер пищит, когда печатает бегунок.</div>
    <div style="display:flex;border:1px solid var(--bd);border-radius:20px;overflow:hidden;font-size:12.5px;text-align:center">
      <span style="flex:1;padding:8px 0" class="gx-show"${mk('b')}>● Выкл.</span><span style="flex:1;padding:8px 0" class="gx-alt"${mk('b')}>Выкл.</span>
      <span style="flex:1;padding:8px 0;border-left:1px solid var(--bd)"${tp('b')}><span class="gx-show"${mk('b')}>Встроенный</span><span class="gx-alt"${mk('b')} style="color:var(--pr);font-weight:700">● Встроенный</span></span>
      <span style="flex:1;padding:8px 0;border-left:1px solid var(--bd)">Через ящик</span></div>
    <div class="gx-unfold"${mk('b')} style="--max:200px"><div style="display:flex;align-items:center;gap:10px;font-size:13px;margin:12px 0 4px">Сколько раз <span style="flex:1;height:4px;border-radius:2px;background:linear-gradient(90deg,var(--pr) 25%,var(--bd) 25%)"></span><b>3</b></div>
      ${switchRow('Пищать на каждый новый заказ', 'Даже если бегунки не печатают')}
      <div style="display:flex;gap:8px">${btn('Проверить кухонный', { kind: 'ghost sm', icon: 'bell', tap: 'test' })}${btn('Проверить барный', { kind: 'ghost sm' })}</div></div>`) : ''}
  ${lan ? X.secCard('wifi', 'Без интернета: сигналы по Wi‑Fi', `<div class="gx-mu" style="font-size:12px;line-height:1.4">Планшеты передают «новый заказ» и «готово» напрямую по Wi‑Fi заведения. Роутер нужен, интернет — нет.</div>
    ${switchRow('Сигналы между планшетами по Wi‑Fi', '', { on: true })}
    ${btn('Проверить, кто на связи', { kind: 'ghost sm', tap: 'ping', style: 'margin-top:2px' })}
    <div class="gx-hide"${mk('ping')} style="margin-top:8px;font-size:13px">На связи: <b>Бар · Денис</b>, <b>Кухня · Ильдар</b>, <b>Зал · Алина</b></div>`) : ''}`,
  { bottom: relay ? btn('Сохранить', { icon: 'check', tap: 'save' }) : '' });

X.relayDialog = dialog('Новое реле', `${field('Название', { val: 'Звонок на раздаче' })}<div style="height:8px"></div>
  ${field('Тип', { val: 'Shelly (1-е поколение: Shelly 1, 1PM, 2.5)' })}<div style="height:8px"></div>
  ${field('IP-адрес реле в Wi‑Fi заведения', { type: 'ip', focus: true, ph: '192.168.1.50' })}
  <div style="display:flex;justify-content:space-between;font-size:13px;margin:10px 0 4px"><span>Держать включённым</span><b>2 с</b></div>
  <div style="font-size:12.5px;font-weight:600;margin:8px 0 4px">Когда включать</div>
  ${[['Новый заказ на кухню', 'ev'], ['Блюдо готово', ''], ['Гость зовёт официанта', '']].map(([t, k]) => `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0"${tp(k)}><span style="width:18px;height:18px;border-radius:4px;border:2px solid var(--mu);display:inline-flex;align-items:center;justify-content:center"><span class="gx-hide"${mk(k)} style="color:var(--pr)">${ic('check', 14, 3)}</span></span>${t}</div>`).join('')}
  ${btn('Проверить сейчас', { kind: 'ghost sm', icon: 'play', tap: 'test', style: 'margin-top:8px' })}
  <div class="gx-hide"${mk('ok')} style="font-size:12.5px;color:var(--ok);margin-top:6px">Реле ответило — должно было щёлкнуть</div>`,
  `${btn('Отмена', { kind: 'text' })}${btn('Готово', { kind: 'sm', tap: 'done' })}`);

// Схема подключения: блоки и провода.
X.wire = (rows, note) => `<div class="gx-app" style="padding:22px 14px;background:var(--bg)">
  <div style="font:600 17px var(--serif);margin-bottom:12px">${note}</div>
  ${rows.map(([a, b, c, k]) => `<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px"${mk(k)}>
    <div class="gx-card" style="flex:1;padding:9px;text-align:center;font-size:12.5px;margin:0"><b>${a}</b></div>
    <div style="flex:none;width:58px;text-align:center;font-size:11px;color:var(--pr)"><div style="height:2px;background:var(--pr);margin-bottom:3px"></div>${b}</div>
    <div class="gx-card" style="flex:1;padding:9px;text-align:center;font-size:12.5px;margin:0"><b>${c}</b></div></div>`).join('')}
  </div>`;

X.watchApp = () => X.scr('Уведомления', `<div class="gx-mu" style="font-size:12px;line-height:1.4;margin-bottom:10px">Приложение часов на телефоне официанта: Mi Fitness, Zepp, Huawei Health или Galaxy Wearable → «Уведомления».</div>
  ${X.card(`${switchRow('Уведомления на часы', 'Показывать на часах уведомления телефона', { on: true })}`)}
  ${X.h('Приложения')}
  ${X.card(`${switchRow('ZalPOS · касса', 'Готово с кухни, вызовы гостей', { tap: 'zp', mark: 'zp' })}${switchRow('Telegram', '', { on: true })}${switchRow('Почта', '')}`)}`);

X.hallOffline = () => hall().replace('<div class="gx-banner">', `<div style="margin:0 12px 8px;padding:8px 10px;border-radius:10px;background:rgba(217,168,78,.16);color:var(--warn);font-size:12px;display:flex;gap:8px;align-items:center">${ic('wifi', 16)}<span>Нет интернета — касса работает. Заказы и оплаты сохранены на устройстве и отправятся сами, когда связь вернётся.</span></div><div class="gx-banner">`);

export const SCENES = {
  login: {
    label: 'Вход в кассу по PIN',
    frames: [
      { screen: pinScreen(), cap: 'Наберите свой PIN — четыре цифры. Администратор сначала нажимает «Администратор», у него шесть цифр.', acts: DIGITS('2580') },
      { screen: pinScreen(), over: { kind: 'dialog', html: startDialog() }, cap: 'Касса спросит про смену. Если вы на работе, нажмите «Начать смену».', acts: [{ tap: 'go' }] },
      { screen: hall(), enter: 'fade', over: { kind: 'toast', html: toast('Ваша смена началась') }, cap: 'Готово: открылся зал, рабочее время пошло.', acts: [{ wait: 1300 }] },
    ],
  },

  shift: {
    label: 'Начать и закончить свою смену',
    frames: [
      { screen: hall({ tapMenu: 'menu' }), cap: 'Откройте меню — кнопка ☰ слева вверху.', acts: [{ tap: 'menu' }] },
      { screen: hall(), over: { kind: 'drawer', html: drawer({ shift: 'off', tap: { my: 'my' } }) }, cap: 'Нажмите «Моя смена не начата».', acts: [{ tap: 'my' }] },
      { screen: hall(), over: { kind: 'dialog', html: startDialog() }, cap: 'Подтвердите кнопкой «Начать смену».', acts: [{ tap: 'go' }] },
      { screen: hall(), over: { kind: 'drawer', html: drawer({ shift: 'on', since: '18:02', tap: { my: 'my' } }) }, cap: 'Смена идёт. Уходя домой, нажмите ту же строку «Моя смена идёт».', acts: [{ wait: 900 }, { tap: 'my' }] },
      {
        screen: hall(), over: { kind: 'dialog', html: dialog('Закончить вашу смену?', '<p>Смена началась в 18:02 · отработано 8 ч 10 мин.<br>Смена заведения продолжается — их касса, X-отчёт и вызовы гостей не изменятся.</p>', `${btn('Отмена', { kind: 'text' })}${btn('Закончить смену', { kind: 'sm', tap: 'end' })}`) },
        cap: '«Закончить смену» — время ухода касса запишет сама.', acts: [{ tap: 'end' }],
      },
      { screen: hall(), over: { kind: 'toast', html: toast('Смена закончена. Смена заведения продолжается') }, cap: 'Часы попали в табель и в зарплату.', acts: [{ wait: 1400 }] },
    ],
  },

  'hall-list': {
    label: 'Зал: схема и список столов',
    frames: [
      { screen: hall({ tapList: 'list' }), cap: 'Зал открывается схемой. Схему можно двигать и приближать двумя пальцами.', acts: [{ wait: 900 }, { tap: 'list' }] },
      { screen: hall(), over: { kind: 'sheet', html: hallList({ tapTable: 'Стол 2' }) }, cap: '«Показать список» — столы выезжают шторкой снизу. Смахните её вниз, чтобы снова видеть схему.', acts: [{ wait: 1200 }, { tap: 'table' }] },
      { screen: tableFree(), enter: 'push', cap: 'Стол открывается одним касанием — из схемы или из списка.', acts: [{ wait: 1500 }] },
    ],
  },

  'open-table': {
    label: 'Открыть стол',
    frames: [
      { screen: hall({ tapTable: 'Стол 2', tapList: 'list' }), cap: 'Зал открывается схемой: столы стоят, как в заведении. Нажмите на свободный — с зелёной точкой «Свободен».', acts: [{ wait: 700 }, { tap: 'table' }] },
      { screen: tableFree(), enter: 'push', cap: 'Нажмите «Начать сеанс».', acts: [{ tap: 'start' }] },
      {
        screen: tableFree(),
        over: { kind: 'dialog', html: dialog('Кто за столом?', field('Имя гостя (необязательно)', { ph: 'Например, Константин', type: 'guest', focus: true }), `${btn('Отмена', { kind: 'text' })}${btn('Начать сеанс', { kind: 'sm', tap: 'go' })}`) },
        cap: 'Имя гостя можно вписать, а можно пропустить — и снова «Начать сеанс».', acts: [{ type: 'guest', text: 'Аня' }, { tap: 'go' }],
      },
      { screen: tableCheck(), enter: 'fade', cap: 'Стол открыт: пошёл таймер, можно принимать заказ.', acts: [{ wait: 1500 }] },
    ],
  },

  order: {
    label: 'Добавить позиции в заказ',
    frames: [
      { screen: tableCheck({ tap: { add: 'add' } }), cap: 'В счёте стола нажмите «Добавить».', acts: [{ tap: 'add' }] },
      { screen: menuCats({ tap: 'Кальяны' }), enter: 'push', cap: 'Откройте категорию. Или найдите блюдо через поиск.', acts: [{ tap: 'cat' }] },
      { screen: menuItems({ title: 'Кальяны', items: HOOKAHS, tap: 'Классический кальян', count: 1, countMark: 'n' }), enter: 'push', cap: 'Нажмите «+» у позиции — она уже в счёте.', acts: [{ tap: 'item', mark: 'q' }, { mark: 'n' }, { wait: 500 }, { tap: 'back' }] },
      { screen: menuCats({ tap: 'Напитки', count: 1 }), enter: 'back', cap: 'Вернитесь назад и добавьте ещё — например, напиток.', acts: [{ tap: 'cat' }] },
      { screen: menuItems({ title: 'Напитки', items: DRINKS, tap: 'Сок яблочный', count: 2, countMark: 'n' }), enter: 'push', cap: 'Каждое нажатие «+» — ещё одна штука. Потом «Перейти к чеку».', acts: [{ tap: 'item', mark: 'q' }, { mark: 'n' }, { wait: 400 }, { tap: 'tocheck' }] },
      { screen: tableCheck({ items: ORDER, total: '1 420 ₽' }), enter: 'push', cap: 'Заказ сохранён и виден на всех кассах заведения.', acts: [{ wait: 1600 }] },
    ],
  },

  kitchen: {
    label: 'Экран «Кухня и бар»',
    frames: [
      { screen: hall(), over: { kind: 'drawer', html: drawer({ name: 'Ильдар', role: 'ПОВАР', tap: { kitchen: 'kitchen' } }) }, cap: 'Меню ☰ → «Кухня и бар».', acts: [{ tap: 'kitchen' }] },
      { screen: kitchenScreen(), enter: 'push', cap: 'Столы с вашими позициями. Сверху — те, что ждут дольше всех: 15 минут подсвечиваются жёлтым.', acts: [{ wait: 1600 }] },
      { screen: kitchenScreen(), cap: 'Когда всё приготовлено, нажмите «Всё готово». Официант увидит в счёте зелёную отметку «готово».', acts: [{ tap: 't1', mark: 't1' }, { wait: 1500 }] },
    ],
  },

  split: {
    label: 'Разделить счёт поровну',
    frames: [
      { screen: tableCheck({ items: [{ n: 'Кальян на молоке', p: '1 500 ₽', q: 1, sum: '1 500 ₽' }], total: '1 500 ₽', tap: { split: 'split' } }), cap: 'В счёте стола нажмите «Разделить».', acts: [{ tap: 'split' }] },
      { screen: splitScreen({ tap: 'more' }), enter: 'push', cap: 'Сколько человек платят — кнопками «−» и «+». Касса сразу посчитает, сколько с каждого.', acts: [{ wait: 600 }, { tap: 'more', mark: 'n' }, { wait: 1200 }] },
      { screen: splitScreen({ tap: 'more' }), cap: 'Принимайте оплату частями на экране «Закрыть стол»: кто наличными, кто картой.', acts: [{ wait: 1800 }] },
    ],
  },

  pay: {
    label: 'Оплата и закрытие стола',
    frames: [
      { screen: tableCheck({ items: ORDER, total: '1 420 ₽', tap: { close: 'close' } }), cap: 'Гость просит счёт — нажмите «Закрыть стол».', acts: [{ tap: 'close' }] },
      { screen: payment(), enter: 'push', cap: 'Касса уже вписала всю сумму в «Наличными». Платят картой — перенесите сумму в «Банковской картой».', acts: [{ wait: 1600 }] },
      { screen: payment(), cap: 'Нужен бумажный чек — включите «Распечатать чек». И нажмите «Оплатить».', acts: [{ tap: 'print', mark: 'print' }, { tap: 'pay' }] },
      { screen: hall(), enter: 'back', cap: 'Стол снова свободен, оплата уже в X-отчёте и в отчётах.', acts: [{ wait: 1600 }] },
    ],
  },

  queue: {
    label: 'Заказ гостя из приложения',
    frames: [
      { screen: hall({ tapMenu: 'menu' }), cap: 'Гость заказал из приложения — откройте меню ☰.', acts: [{ tap: 'menu' }] },
      { screen: hall(), over: { kind: 'drawer', html: drawer({ tap: { queue: 'queue' } }) }, cap: 'Нажмите «Очередь заказов». Число рядом — сколько обращений ждут.', acts: [{ tap: 'queue' }] },
      { screen: queueScreen(), enter: 'push', cap: 'Проверьте заказ и нажмите «Принять в чек» — позиции сами попадут в счёт стола.', acts: [{ wait: 700 }, { tap: 'accept', mark: 'gone' }, { wait: 900 }] },
      { screen: queueScreen(), cap: 'Вызовы («Счёт, пожалуйста», «Поменять угли») отмечайте «Выполнено» — гость увидит это у себя.', acts: [{ wait: 1800 }] },
    ],
  },

  booking: {
    label: 'Подтвердить бронь и посадить гостя',
    frames: [
      { screen: hall(), over: { kind: 'drawer', html: drawer({ tap: { book: 'book' } }) }, cap: 'Меню ☰ → «Брони».', acts: [{ tap: 'book' }] },
      { screen: bookingsScreen(), enter: 'push', cap: 'Бронь из приложения пришла со статусом «Новая». Позвоните гостю, если нужно, и нажмите «Подтвердить».', acts: [{ wait: 600 }, { tap: 'confirm', mark: 'conf' }] },
      { screen: bookingsScreen(), cap: 'Когда гость пришёл, нажмите «Посадить».', acts: [{ wait: 500 }, { tap: 'seat' }] },
      { screen: tableCheck({ name: 'Стол 6', who: 'Алина' }), enter: 'push', over: { kind: 'toast', html: toast('Гость посажен, чек открыт') }, cap: 'Стол занят, счёт открыт — дальше как обычно.', acts: [{ wait: 1600 }] },
    ],
  },

  'close-venue': {
    label: 'Закрыть смену заведения',
    frames: [
      { screen: hall(), over: { kind: 'drawer', html: drawer({ tap: { venue: 'venue' } }) }, cap: 'В конце дня: меню ☰ → «Смена заведения открыта».', acts: [{ tap: 'venue' }] },
      { screen: hall(), over: { kind: 'sheet', html: venueSheet }, cap: 'Видно, кто ещё на смене. Нажмите «Закрыть смену заведения».', acts: [{ wait: 700 }, { tap: 'closev' }] },
      { screen: hall(), over: { kind: 'dialog', html: closeDialog() }, cap: 'Пересчитайте наличные в ящике и впишите сумму. Касса сравнит её с «Должно быть в кассе».', acts: [{ type: 'cnt', text: '12580' }, { mark: 'ok' }, { wait: 900 }] },
      { screen: hall(), over: { kind: 'dialog', html: closeDialog() }, cap: 'Сколько оставить на размен, решаете вы, остальное уходит в инкассацию. Нажмите «Закрыть смену».', acts: [{ tap: 'done' }] },
      { screen: pinScreen(), enter: 'fade', cap: 'Смена закрыта, отчёт сохранён. Расхождение, если оно было, владелец увидит в кабинете.', acts: [{ wait: 1600 }] },
    ],
  },

  'menu-kind': {
    label: 'Чья категория: кальяны, бар или кухня',
    frames: [
      { screen: menuEditor({ tap: 'kind' }), cap: 'Админ → «Меню». Под названием категории видно, к чему она относится.', acts: [{ wait: 1100 }, { tap: 'kind' }] },
      { screen: menuEditor({ tap: 'kind' }), over: { kind: 'pop', html: kindPopup }, cap: 'Нажмите значок слева от карандаша и выберите, что в категории: кухня, бар и напитки или кальяны.', acts: [{ tap: 'bar' }] },
      { screen: menuEditor({ tap: 'kind' }), cap: 'Готово: напитки этой категории идут в процент бармена, а при раздельной печати — в чек «Кухня и бар».', acts: [{ mark: 'k' }, { wait: 1800 }] },
    ],
  },

  'pay-setup': {
    label: 'Процент сотрудника по его роли',
    frames: [
      { screen: employeesScreen({ tap: 'den' }), cap: 'Админ → «Сотрудники» → откройте сотрудника.', acts: [{ tap: 'den' }] },
      { screen: payForm(), enter: 'push', cap: 'В разделе «Зарплата» включите «Проценты с продаж».', acts: [{ tap: 'pct', mark: 'pct' }] },
      { screen: payForm(), cap: 'Бармену подходит процент «С бара и напитков», кальянщику «С кальянов», официанту «С чеков, которые он вёл».', acts: [{ type: 'bar', text: '5' }, { wait: 400 }, { tap: 'save' }] },
      { screen: employeesScreen(), enter: 'back', cap: 'Ставка действует с этой минуты: прошлые смены и чеки считаются по старой.', acts: [{ mark: 'saved' }, { wait: 1800 }] },
    ],
  },

  payroll: {
    label: 'Расчёт зарплаты за месяц',
    frames: [
      { screen: adminHome({ tap: 'Зарплата' }), cap: 'Админ → «Зарплата».', acts: [{ tap: 'tile' }] },
      { screen: payrollScreen(), enter: 'push', cap: 'Выберите период. По каждому — часы, оклад, проценты по видам и «К выплате».', acts: [{ wait: 900 }, { tap: 'max' }] },
      { screen: payrollScreen(), cap: '«Свои» — то, что сотрудник добавил в чек сам, «доля смены» — его часть общего котла.', acts: [{ mark: 'hk' }, { wait: 2000 }] },
    ],
  },

  'print-split': {
    label: 'Кальяны: отдельным чеком или в общем',
    frames: [
      { screen: printerSettings(), cap: 'Админ → «Интеграции» → «Чековый принтер». «Кальяны — отдельным чеком» — как печатать по умолчанию.', acts: [{ wait: 600 }, { tap: 'split', mark: 'split' }, { wait: 500 }] },
      { screen: payment({ mixed: true }), enter: 'push', cap: 'При оплате включите «Распечатать чек» — под ним тот же переключатель, только для этого счёта.', acts: [{ tap: 'print', mark: 'print' }, { wait: 900 }] },
      { screen: payment({ mixed: true }), cap: 'Гость просит один чек? Выключите «Кальяны — отдельным чеком» и нажмите «Оплатить».', acts: [{ tap: 'one', mark: 'one' }, { wait: 500 }, { tap: 'pay' }] },
      { screen: payment({ mixed: true }), over: { kind: 'slips', html: receiptOne }, cap: 'Вышел один общий чек. Не трогали переключатель — было бы два: «Кальяны» и «Кухня и бар».', acts: [{ wait: 2600 }] },
    ],
  },

  'kitchen-print': {
    label: 'Бегунки на кухню и бар',
    frames: [
      { screen: printerSettings({ tickets: true }), cap: 'Админ → «Интеграции» → «Чековый принтер». Включите «Бегунки на кухню и бар».', acts: [{ wait: 600 }, { tap: 'kt', mark: 'kt' }, { wait: 500 }] },
      { screen: tableCheck({ name: 'Стол 5', who: 'Марина', items: ORDER_KITCHEN, total: '2 360 ₽', strip: { n: 5, tap: 'send', mark: 'sent' } }), enter: 'push', cap: 'Добавили позиции — в счёте стола появилось «Новое в заказе». Нажмите «На кухню».', acts: [{ wait: 700 }, { tap: 'send' }] },
      { screen: tableCheck({ name: 'Стол 5', who: 'Марина', items: ORDER_KITCHEN, total: '2 360 ₽', strip: { n: 5, tap: 'send', mark: 'sent' } }), over: { kind: 'slips', html: kitchenTickets }, cap: 'Листок на каждый цех: крупно, без цен, с пожеланиями гостя.', acts: [{ wait: 2600 }] },
      { screen: tableCheck({ name: 'Стол 5', who: 'Марина', items: ORDER_KITCHEN, total: '2 360 ₽', strip: { n: 5, tap: 'send', mark: 'sent' } }), cap: 'Плашка ушла. Дозакажут — следующий бегунок напечатает только новое, с пометкой «ещё».', acts: [{ mark: 'sent' }, { wait: 1600 }] },
    ],
  },

  'hall-edit': {
    label: 'Добавить стол на карту зала',
    frames: [
      { screen: hallEditor(), cap: 'Админ → «Карта зала». Нажмите «Стол» внизу справа.', acts: [{ wait: 500 }, { tap: 'add' }] },
      { screen: hallEditor(), over: { kind: 'dialog', html: newTableDialog }, cap: 'Укажите название, число мест и форму стола и нажмите «Сохранить».', acts: [{ type: 'tname', text: 'Стол 12' }, { tap: 'save' }] },
      { screen: hallEditor(), cap: 'Стол появился. Удерживайте его и тяните на место — схема сразу обновится на всех кассах и у гостей.', acts: [{ mark: 'newt' }, { wait: 500 }, { drag: 'drag', dx: -40, dy: -70 }, { wait: 1200 }] },
    ],
  },

  devices: {
    label: 'Собрать и скачать кассу',
    device: 'web',
    frames: [
      { screen: webOverview({ tap: { 'Устройства': 'nav' } }), cap: 'В кабинете откройте «Устройства».', acts: [{ wait: 400 }, { tap: 'nav' }] },
      { screen: webDevices(), cap: 'Код приглашения скрыт — нажмите, чтобы показать. Его вводят на планшете вместе с кодом заведения.', acts: [{ tap: 'code', mark: 'code' }, { wait: 900 }] },
      { screen: webDevices(), cap: 'Ниже — «Собрать APK»: одна кнопка, и готовы кассы для Android и Windows и приложение гостя.', acts: [{ tap: 'build', mark: 'q' }] },
      { screen: webDevices(), cap: 'Сборка идёт около 10 минут, страницу можно закрыть — придёт уведомление.', acts: [{ wait: 2200 }, { mark: 'done' }] },
      { screen: webDevices(), cap: 'Нажмите «Скачать» на том устройстве, где будет касса, и откройте файл.', acts: [{ tap: 'dl' }, { wait: 1200 }] },
    ],
  },

  branding: {
    label: 'Цвета и название приложения гостя',
    device: 'web',
    frames: [
      { screen: webBranding(), cap: 'Кабинет → «Брендинг»: название, логотип и цвета приложения гостя. Выберите гамму.', acts: [{ wait: 600 }, { tap: 'sage', mark: 'sage' }] },
      { screen: webBranding(), cap: 'Рядом сразу видно, как это будет выглядеть у гостя. Нажмите «Сохранить брендинг».', acts: [{ wait: 900 }, { tap: 'save' }, { wait: 1200 }] },
    ],
  },

  signup: {
    label: 'Регистрация и первое заведение',
    device: 'web',
    frames: [
      { screen: webSignup(), cap: 'На zalpos.ru впишите email, отметьте согласия и нажмите «Попробовать бесплатно».', acts: [{ type: 'mail', text: 'olga@kafe-leto.ru' }, { tap: 'c1', mark: 'c1', fast: true }, { tap: 'c2', mark: 'c2', fast: true }, { tap: 'go' }] },
      { screen: webCheckMail(), cap: 'Пароль не нужен: на почту придёт ссылка, она сразу откроет кабинет.', acts: [{ wait: 2200 }] },
      { screen: webOnboarding(), cap: 'Название заведения — код для ссылок появится сам. Выберите тип и «Создать заведение».', acts: [{ type: 'vname', text: 'Кафе «Лето»' }, { mark: 'slug' }, { tap: 'kind', mark: 'kind' }, { tap: 'create' }] },
      { screen: webOverview(), cap: 'Готово: 7 дней бесплатно. На «Обзоре» список «Настройка заведения» подскажет, что дальше.', acts: [{ wait: 2200 }] },
    ],
  },

  'team-pin': {
    label: 'Добавить сотрудника с PIN-кодом',
    device: 'web',
    frames: [
      { screen: webOverview({ tap: { 'Команда': 'nav' } }), cap: 'В кабинете откройте «Команда».', acts: [{ wait: 400 }, { tap: 'nav' }] },
      { screen: webTeam(), cap: 'В разделе «Сотрудники кассы» укажите имя, PIN-код и специализацию и нажмите «Сохранить».', acts: [{ type: 'ename', text: 'Марина' }, { type: 'epin', text: '4821' }, { tap: 'pos', mark: 'pos' }, { tap: 'esave', mark: 'saved' }] },
      { screen: webTeam({ saved: true }), enter: 'none', cap: 'Сотрудник появился в списке и на всех кассах. Имя и PIN скажите ему лично.', acts: [{ wait: 2000 }] },
    ],
  },

  'team-invite': {
    label: 'Доступ к кабинету для управляющего',
    device: 'web',
    frames: [
      { screen: webTeam(), cap: '«Команда» → «Доступ к кабинету»: email управляющего и роль «Менеджер».', acts: [{ type: 'imail', text: 'anna@kafe-leto.ru' }, { tap: 'role', mark: 'role' }] },
      { screen: webTeam(), cap: 'Нажмите «Пригласить». Важно: он должен сначала сам зарегистрироваться на zalpos.ru.', acts: [{ tap: 'invite', mark: 'invited' }, { wait: 700 }] },
      { screen: webTeam({ invited: true }), enter: 'none', cap: 'Готово: управляющий видит кабинет этого заведения. Роль можно сменить или отключить доступ в любой момент.', acts: [{ wait: 2000 }] },
    ],
  },

  plans: {
    label: 'Оплатить подписку',
    device: 'web',
    frames: [
      { screen: webOverview({ tap: { 'Тарифы': 'nav' } }), cap: 'В кабинете откройте «Тарифы».', acts: [{ wait: 400 }, { tap: 'nav' }] },
      { screen: webPlans(), cap: 'Выберите срок: за год выходит дешевле. Ниже — кто платит: вы картой или ИП и организация по счёту.', acts: [{ tap: 'period', mark: 'year' }, { wait: 600 }, { tap: 'pay' }] },
      { screen: webBilling(), cap: 'После оплаты в «Оплате» — статус «Активна» и до какого числа. Чек придёт на email.', acts: [{ wait: 2400 }] },
    ],
  },

  'ai-setup': {
    label: 'Подключить ИИ-помощников',
    device: 'web',
    frames: [
      { screen: webOverview({ tap: { 'ИИ': 'nav' } }), cap: 'В кабинете откройте «ИИ».', acts: [{ wait: 400 }, { tap: 'nav' }] },
      { screen: webAi(), cap: 'Включите помощников, вставьте ключ и нажмите «Сохранить».', acts: [{ tap: 'ai', mark: 'ai' }, { type: 'key', text: 'sk-••••••7f3a' }, { tap: 'aisave' }] },
      { screen: webAi(), cap: '«Проверить связь» — если всё верно, появится «Связь есть».', acts: [{ tap: 'aitest', mark: 'ok' }, { wait: 1800 }] },
    ],
  },

  'ai-key': {
    label: 'Где взять ключ ИИ',
    device: 'web',
    frames: [
      { screen: webAiProvider(), url: 'сайт сервиса ИИ', cap: 'На сайте сервиса (например, tooken.club) зарегистрируйтесь и пополните баланс — для начала хватит 300 ₽.', acts: [{ wait: 500 }, { tap: 'topup', mark: 'paid' }, { wait: 700 }] },
      { screen: webAiProvider(), url: 'сайт сервиса ИИ', cap: '«Создать ключ» — и «Скопировать». Ключ как пароль: никому его не пересылайте.', acts: [{ tap: 'newkey', mark: 'key' }, { wait: 500 }, { tap: 'copy', mark: 'copied' }, { wait: 700 }] },
      { screen: webAi(), cap: 'Кабинет ZalPOS → «ИИ». Включите помощников и вставьте ключ. Модель уже стоит — gpt-4o-mini.', acts: [{ tap: 'ai', mark: 'ai' }, { type: 'key', text: 'sk-••••••7f3a' }, { tap: 'aisave' }] },
      { screen: webAi(), cap: '«Проверить связь» → «Связь есть». Готово: ассистент работает в кассе, помощник — у гостей.', acts: [{ tap: 'aitest', mark: 'ok' }, { wait: 2000 }] },
    ],
  },

  'delivery-in': {
    label: 'Заказ доставки из приложения: звонок и подтверждение',
    frames: [
      { screen: hall({ takeaway: 1, tapTakeaway: 'bag' }), cap: 'Гость оформил доставку — у кнопки «С собой и доставка» в шапке зала появилась цифра. Нажмите её.', acts: [{ wait: 500 }, { tap: 'bag' }] },
      { screen: hall({ takeaway: 1 }), over: { kind: 'sheet', html: takeawaySheet() }, cap: 'Заказ из приложения ждёт звонка. Нажмите на телефон — касса наберёт гостя.', acts: [{ wait: 900 }, { tap: 'call' }] },
      { screen: callScreen(), enter: 'fade', cap: 'Сверьте состав, адрес и время доставки. Имя и номер гость указал сам.', acts: [{ wait: 1800 }] },
      { screen: hall({ takeaway: 1 }), over: { kind: 'sheet', html: takeawaySheet() }, enter: 'fade', cap: 'Если всё верно, нажмите «Подтвердить». Позиции встанут в чек, кухня увидит заказ, а гость увидит статус «Принят».', acts: [{ tap: 'accept', mark: 'acc' }, { wait: 900 }] },
      { screen: hall({ takeaway: 1 }), over: { kind: 'sheet', html: takeawaySheet() }, cap: 'Дальше по шагам: «Начать готовить», «Передать курьеру», «Доставлен». Гость видит каждый шаг у себя.', acts: [{ wait: 600 }, { tap: 'cook' }, { wait: 900 }] },
    ],
  },

  'online-pay': {
    label: 'Подключить онлайн-оплату гостей',
    frames: [
      { screen: adminHome({ tap: 'Интеграции', tiles: [['chart', 'Отчёты'], ['map', 'Карта зала'], ['fork', 'Меню'], ['users', 'Сотрудники'], ['store', 'Профиль заведения'], ['gear', 'Интеграции']] }), cap: 'Войдите в кассу по PIN администратора и откройте «Интеграции».', acts: [{ wait: 400 }, { tap: 'tile' }] },
      { screen: onlinePayScreen(), enter: 'push', cap: '«Онлайн-оплата гостей» → «Банк»: Т-Банк, Сбер, Альфа, ВТБ, МТС, Райффайзен, Робокасса или другой банк — тот, с кем у вас договор эквайринга.', acts: [{ tap: 'bank', mark: 'bank' }, { wait: 500 }] },
      { screen: onlinePayScreen(), cap: 'Впишите реквизиты из кабинета банка. Нажмите «Сохранить и проверить подключение» — деньги при проверке не списываются.', acts: [{ type: 'shop', text: 'kafe-leto' }, { tap: 'check', mark: 'ok' }, { wait: 1400 }] },
      { screen: adminHome({ tap: 'Профиль заведения', tiles: [['chart', 'Отчёты'], ['map', 'Карта зала'], ['fork', 'Меню'], ['users', 'Сотрудники'], ['store', 'Профиль заведения'], ['gear', 'Интеграции']] }), enter: 'back', cap: 'Вернитесь и откройте «Профиль заведения».', acts: [{ tap: 'tile' }] },
      { screen: venueToggles(), enter: 'push', cap: 'Включите «Гость оплачивает онлайн из приложения» и «Сохранить». Кнопка оплаты появится у гостей за столом и в заказах доставки.', acts: [{ tap: 'pay', mark: 'pay' }, { wait: 400 }, { tap: 'save' }, { wait: 900 }] },
    ],
  },

  'guest-delivery': {
    label: 'Как гость заказывает доставку',
    frames: [
      { screen: guestMenu(), cap: 'Гость собирает заказ в меню приложения. Табак и алкоголь с доставкой не продаются — у них «Только в заведении».', acts: [{ wait: 900 }, { tap: 'go' }] },
      { screen: guestCheckout(), enter: 'push', cap: 'Доставка или «Заберу сам», телефон и адрес. Оплата — при получении или онлайн, если у заведения подключён банк.', acts: [{ type: 'tel', text: '+7 999 123-45-67' }, { type: 'street', text: 'ул. Ленина, 5' }, { tap: 'online', mark: 'on' }, { tap: 'send' }] },
      { screen: guestOrder(), enter: 'push', cap: 'Заказ ушёл на кассу. Гость видит «Ждёт подтверждения» — заведение позвонит.', acts: [{ wait: 1800 }] },
      { screen: guestOrder(), cap: 'Кассир подтвердил — статус «Принят», и появилась кнопка «Оплатить онлайн». Деньги списываются только за подтверждённый заказ.', acts: [{ mark: 'acc' }, { wait: 900 }, { tap: 'pay' }, { wait: 900 }] },
    ],
  },

  telegram: {
    label: 'Подключить Telegram-бота заведения',
    device: 'web',
    frames: [
      { screen: webTelegram(), cap: 'В Telegram откройте @BotFather → /newbot, придумайте имя и адрес бота — он пришлёт токен. Кабинет → «Настройки»: вставьте токен и «Подключить бота».', acts: [{ type: 'token', text: '7012345678:AAH…' }, { tap: 'connect', mark: 'bot' }, { wait: 700 }] },
      { screen: webTelegram(), cap: 'Управлять ботом смогут только те, чей Telegram ID в списке. Напишите боту /id — он пришлёт число. Впишите его и «Добавить».', acts: [{ type: 'tgid', text: '123456789' }, { tap: 'addid', mark: 'acc' }, { wait: 700 }] },
      { screen: webTelegram(), cap: '«Подключить мой Telegram» — откроется ваш бот, нажмите «Запустить». Вам будут приходить выручка, смены, отмены и итоги дня.', acts: [{ tap: 'owner', mark: 'own' }, { wait: 900 }] },
      { screen: webTelegram(), cap: '«Подключить группу сотрудников» — выберите рабочую группу и добавьте бота. Курьеров и поваров, которые жмут кнопки, впишите в список с правами «Сотрудник».', acts: [{ tap: 'group', mark: 'grp' }, { wait: 900 }] },
      { screen: tgChat(), enter: 'fade', cap: 'Заказы приходят в группу с кнопками — следующий шаг, курьер, адрес. Нажать их может только тот, кто в списке; остальным бот ответит «Нет доступа».', acts: [{ wait: 600 }, { tap: 'cook', mark: 'st' }, { wait: 1200 }] },
    ],
  },

  overview: {
    label: 'Как всё устроено: гость → касса → кабинет',
    frames: [
      { screen: X.guestTable(), cap: 'Гость за столом открывает приложение по QR-коду и нажимает «Позвать официанта».', acts: [{ wait: 500 }, { tap: 'call', mark: 'call' }, { wait: 700 }] },
      { screen: queueScreen(), enter: 'fade', cap: 'Вызов тут же на кассе — в «Очереди заказов». Касса, приложение гостя и кабинет работают с одной общей базой.', acts: [{ wait: 1500 }] },
      { screen: X.xreport(), enter: 'push', cap: 'Закрыли чек — выручка сразу в X-отчёте на кассе и на «Обзоре» в кабинете владельца.', acts: [{ wait: 1800 }] },
    ],
  },
  windows: {
    label: 'Поставить кассу на Windows', device: 'windows',
    frames: [
      { screen: X.winDl(), win: { title: 'Кабинет ZalPOS — браузер', url: 'zalpos.ru' }, cap: 'В браузере на компьютере: кабинет → «Устройства» → «Скачать» у строки «Касса (Windows)». Запустите скачанный файл — права администратора не нужны.', acts: [{ wait: 400 }, { tap: 'win' }, { wait: 500 }] },
      { screen: X.winSmart(), win: { title: 'Windows SmartScreen' }, enter: 'fade', cap: 'Windows может показать «Система Windows защитила ваш компьютер» — нажмите «Подробнее», потом «Выполнить в любом случае».', acts: [{ tap: 'more', mark: 'more' }, { wait: 400 }, { tap: 'run' }] },
      { screen: X.winApp(), win: { title: 'ZalPOS — Кафе «Лето»', icon: true }, enter: 'fade', cap: 'Ярлык ZalPOS появится на рабочем столе и в меню «Пуск», касса сама подключится к заведению. F11 — во весь экран. Принтер подключается по сети, сканер штрихкодов по USB.', acts: [{ wait: 2400 }] },
    ],
  },
  updates: {
    label: 'Обновления кассы',
    frames: [
      { screen: hall({ tapMenu: 'menu' }), cap: 'Делать ничего не нужно: новая версия собирается сама. Проверить вручную — меню ☰.', acts: [{ tap: 'menu' }] },
      { screen: hall(), over: { kind: 'drawer', html: X.drawerUpd('upd') }, cap: 'Внизу откройте «Обновления».', acts: [{ wait: 400 }, { tap: 'upd' }] },
      { screen: hall(), over: { kind: 'dialog', html: dialog('Доступна версия 1.42', '<p>Новое: бонусы за шаги выручки, отчёт по банкам терминала. Данные и настройки сохранятся.</p>', `${btn('Позже', { kind: 'text' })}${btn('Установить', { kind: 'sm', tap: 'go' })}`) }, cap: 'Нажмите «Установить». «Собрать APK» в кабинете нужно снова, только если поменяли логотип или название.', acts: [{ tap: 'go' }, { wait: 700 }] },
    ],
  },
  network: {
    label: 'Сеть заведений', device: 'web',
    frames: [
      { screen: X.webNetwork(), cap: 'Кабинет → «Тарифы» → «Перевести в сеть».', acts: [{ wait: 400 }, { tap: 'net', mark: 'net' }, { wait: 500 }] },
      { screen: X.webNetwork(), cap: '«Добавить точку сети» — точка появится на кассах после оплаты. Переключаться между точками — список «Заведение» в меню кабинета.', acts: [{ tap: 'pt', mark: 'pt' }, { wait: 1200 }] },
      { screen: X.webNetwork(), cap: 'Касса при входе спросит «В какую кассу войти?». Гость копит бонусы в одной точке и тратит в другой — без настроек.', acts: [{ wait: 1800 }] },
    ],
  },
  'menu-item': {
    label: 'Меню: категория и позиция',
    frames: [
      { screen: menuEditor(), cap: 'Админ → «Меню». Новая категория — значок папки вверху справа. Откройте категорию.', acts: [{ wait: 1200 }] },
      { screen: X.catItems(), enter: 'push', cap: 'В категории нажмите «Добавить позицию».', acts: [{ wait: 400 }, { tap: 'add' }] },
      { screen: X.itemForm(), enter: 'push', cap: 'Заполните «Название», «Цена, ₽», «Состав / описание», добавьте фото и выберите «Ставка НДС». Для блюда из нескольких продуктов включите «Составная позиция (микс)».', acts: [{ type: 'iname', text: 'Кальян на грейпфруте' }, { type: 'iprice', text: '1800' }, { wait: 300 }, { tap: 'save' }] },
      { screen: X.catItems(), enter: 'back', over: { kind: 'toast', html: toast('Сохранено — меню обновилось на кассах и у гостей') }, cap: 'Меню сразу обновится на всех кассах и в приложении гостя.', acts: [{ wait: 1500 }] },
    ],
  },
  tobacco: {
    label: 'Табак и закон 15-ФЗ',
    frames: [
      { screen: X.itemForm({ tobacco: true }), cap: 'В карточке табачной позиции включите «Табак / никотин».', acts: [{ wait: 500 }, { tap: 'tob', mark: 'tob' }, { wait: 400 }, { tap: 'save' }] },
      { screen: X.guestTobacco(), enter: 'fade', cap: 'Гость видит табак строгим списком с ценами — без фото и только когда он уже в заведении. Скидки и бонусы на него не действуют.', acts: [{ wait: 2400 }] },
    ],
  },
  session: {
    label: 'Длительность сеанса',
    frames: [
      ADMIN_TO('Длительность сеанса'),
      { screen: X.sessionScreen(), enter: 'push', cap: 'Выберите, сколько обычно длится посещение, или «Без ограничений» и нажмите «Сохранить».', acts: [{ tap: 'two', mark: 'two' }, { wait: 300 }, { tap: 'save' }] },
      { screen: tableCheck({ items: ORDER, total: '1 420 ₽', tap: { timer: 'time' } }), enter: 'push', cap: 'За столом идёт таймер. Кнопкой «Время» его можно продлить или сократить на 5, 10 или 30 минут.', acts: [{ wait: 600 }, { tap: 'time' }, { wait: 900 }] },
    ],
  },
  'time-cafe': {
    label: 'Тайм-кафе: оплата за время',
    frames: [
      ADMIN_TO('Тайм-кафе'),
      { screen: X.timeCafeScreen(), enter: 'push', cap: 'Включите «Тайм-кафе» и укажите цену часа за гостя. При желании задайте цену первого часа, округление, минимальную оплату и стоп-чек.', acts: [{ tap: 'on', mark: 'on' }, { wait: 400 }, { type: 'price', text: '300' }, { tap: 'r15', mark: 'r15' }] },
      { screen: X.timeCafeScreen(), cap: 'Внизу видно, сколько заплатит один гость. Если всё верно, нажмите «Сохранить». Цена сразу изменится на всех кассах.', acts: [{ mark: 'on' }, { type: 'stop', text: '900' }, { mark: 'ex' }, { wait: 900 }, { tap: 'save' }] },
      { screen: X.cafeTable({ items: [CAFE_ORDER[1]], total: '250 ₽', tap: { cafe: 'cafe' } }), enter: 'push', cap: 'На экране стола видно, сколько гость уже должен за время. Нажмите «Тайм-кафе», чтобы добавить время в счёт.', acts: [{ wait: 1000 }, { tap: 'cafe' }] },
      { screen: X.cafeTable({ items: [CAFE_ORDER[1]], total: '250 ₽' }), over: { kind: 'dialog', html: X.cafeDialog }, cap: 'Кнопками «−» и «+» укажите, сколько гостей платят за время. Сумму за гостя можно поправить. Затем нажмите «В счёт».', acts: [{ tap: 'plus', mark: 'g2' }, { wait: 700 }, { tap: 'ok' }] },
      { screen: X.cafeTable({ items: CAFE_ORDER, total: '1 090 ₽', tap: { close: 'close' }, recount: true }), enter: 'fade', cap: 'Время появилось в счёте отдельной строкой. Повторное нажатие «Тайм-кафе» пересчитает её, а при закрытии стола время пересчитается на момент оплаты.', acts: [{ wait: 1300 }, { tap: 'close' }] },
    ],
  },
  'venue-profile': {
    label: 'Профиль заведения',
    frames: [
      GADMIN_TO('Профиль заведения'),
      { screen: X.venueProfile(), enter: 'push', cap: 'Тип заведения — касса подстроит слова: официант, бармен или кальянщик. Адрес, телефон и часы работы (пустое поле — выходной).', acts: [{ type: 'addr', text: 'ул. Ленина, 5' }, { wait: 400 }] },
      { screen: X.venueProfile(), cap: 'Правила, частые вопросы и акции гости увидят в приложении. Нажмите «Сохранить».', acts: [{ type: 'rules', text: 'Кальян с 18 лет, паспорт обязателен' }, { tap: 'save' }, { wait: 700 }] },
    ],
  },
  'venue-shift': {
    label: 'Смена заведения и размен утром',
    frames: [
      { screen: pinScreen(), cap: 'Первый, кто утром нажмёт «Начать смену», откроет и смену заведения — одну на всех: касса, наличные и X-отчёт.', acts: DIGITS('2580') },
      { screen: hall(), enter: 'fade', over: { kind: 'drawer', html: drawer({ tap: { cash: 'cash' } }) }, cap: 'Размен в ящик кладут через меню ☰ → «Касса» → «Внесение».', acts: [{ wait: 500 }, { tap: 'cash' }] },
      { screen: X.cash(), enter: 'push', cap: 'Касса показывает, сколько наличных должно быть в ящике. Кто сейчас на смене — в меню ☰ под «Смена заведения открыта».', acts: [{ wait: 2000 }] },
    ],
  },
  precheck: {
    label: 'Предчек — счёт гостю',
    frames: [
      { screen: X.checkWithPre({ items: ORDER3, total: '1 947 ₽' }), cap: 'Гость просит счёт — нажмите «Предчек» рядом с «Закрыть стол».', acts: [{ wait: 600 }, { tap: 'pre' }] },
      { screen: X.checkWithPre({ items: ORDER3, total: '1 947 ₽' }), over: { kind: 'slips', html: X.preSlip }, cap: 'Принтер напечатает «Предварительный счёт»: позиции, скидку и «К оплате». Это не кассовый чек — его выдаст онлайн-касса при оплате.', acts: [{ wait: 2800 }] },
    ],
  },
  refund: {
    label: 'Возврат чека',
    frames: [
      DRAWER_TO('hist', 'Меню ☰ → «История чеков».'),
      { screen: X.receipts(), enter: 'push', cap: 'Найдите чек: «Сегодня», «7 дней», «30 дней» или «Свой период» — и откройте его.', acts: [{ wait: 500 }, { tap: 'r1' }] },
      { screen: X.receipt(), enter: 'push', cap: 'Нажмите «Возврат чека».', acts: [{ wait: 400 }, { tap: 'ret' }] },
      { screen: X.receipt(), over: { kind: 'dialog', html: X.refundDialog }, cap: 'Нажмите «Оформить возврат». Возврат попадёт в X-отчёт, отчёты и журнал, а процент сотрудников с этого чека снимется.', acts: [{ tap: 'do' }] },
      { screen: X.receipt(), cap: 'Готово: на чеке отметка о возврате и кто его оформил.', acts: [{ mark: 'ref' }, { wait: 1500 }] },
    ],
  },
  cash: {
    label: 'Наличные: внесение, выплата, инкассация',
    frames: [
      DRAWER_TO('cash', 'Меню ☰ → «Касса». Любые движения наличных проводите здесь — тогда сумма в ящике сойдётся.'),
      { screen: X.cash(), enter: 'push', cap: '«Внесение» нужно для размена из сейфа, «Выплата» для поставщика, курьера или аванса, «Инкассация», когда деньги забрали в сейф или отдали владельцу.', acts: [{ wait: 700 }, { tap: 'pay' }] },
      { screen: X.cash(), over: { kind: 'dialog', html: X.payoutDialog }, cap: 'В выплате обязательно напишите, кому и за что.', acts: [{ type: 'sum', text: '2000' }, { type: 'why', text: 'Курьер Сергей, лимоны' }, { tap: 'ok' }] },
      { screen: X.cash(), cap: 'Сумма в ящике пересчиталась. Если ошиблись, нажмите «Отменить операцию».', acts: [{ mark: 'out' }, { wait: 1600 }] },
    ],
  },
  'x-report': {
    label: 'X-отчёт',
    frames: [
      DRAWER_TO('x', 'Меню ☰ → «X-отчёт (текущая смена)».'),
      { screen: X.xreport(), enter: 'push', cap: 'Продажи и оплаты без закрытия смены: наличные, карта, терминал по банкам, агрегаторы, возвраты, чаевые.', acts: [{ wait: 1800 }, { mark: 'cash' }] },
      { screen: X.xreport(), cap: '«Распечатать» отправит отчёт на чековый принтер, «Скопировать» поможет переслать его в мессенджер. Прошлые смены лежат во вкладке «Прошлые смены».', acts: [{ tap: 'copy' }, { wait: 1200 }] },
    ],
  },
  waitlist: {
    label: 'Лист ожидания',
    frames: [
      DRAWER_TO('wait', 'Все столы заняты — меню ☰ → «Лист ожидания».'),
      { screen: X.waitlist(), enter: 'push', cap: 'Нажмите «Записать гостя» и укажите имя и телефон.', acts: [{ tap: 'new' }] },
      { screen: X.waitlist(), over: { kind: 'dialog', html: X.waitDialog }, cap: 'Укажите имя и телефон и нажмите «Записать».', acts: [{ type: 'wname', text: 'Андрей' }, { type: 'wtel', text: '+7 999 000-12-45' }, { tap: 'save' }] },
      { screen: X.waitlist(), cap: 'Когда стол освободился, нажмите «Стол готов», когда гость сел, «Посадили». Если гость хочет позже, нажмите «В бронь», если ушёл, «Ушёл».', acts: [{ mark: 'add' }, { wait: 600 }, { tap: 'ready', mark: 'ready' }, { wait: 1200 }] },
    ],
  },
  'table-qr': {
    label: 'QR-коды столов',
    frames: [
      GADMIN_TO('QR-коды столов'),
      { screen: X.qrGrid(), enter: 'push', cap: 'Распечатайте коды и наклейте каждый на свой стол. Гость наводит камеру — открывается меню и счёт этого стола.', acts: [{ wait: 1200 }, { tap: 'renew' }] },
      { screen: X.qrGrid(), over: { kind: 'dialog', html: X.qrDialog }, cap: 'Если наклейку сфотографировали или унесли, нажмите «Новый код». Старый перестанет работать.', acts: [{ tap: 'yes' }] },
      { screen: X.qrGrid(), cap: 'Распечатайте новую наклейку и замените.', acts: [{ mark: 'new' }, { wait: 1500 }] },
    ],
  },
  'guest-app': {
    label: 'Что видит гость',
    frames: [
      { screen: X.guestTable(), cap: 'Вкладки «Главная», «Меню», «Бронь», «Мой стол», «Профиль». За столом после QR: заказ, кнопки вызова, свой счёт и чаевые.', acts: [{ wait: 900 }, { tap: 'call', mark: 'call' }, { wait: 900 }] },
      { screen: X.guestReview(), enter: 'push', cap: 'После визита гость ставит оценку и пишет отзыв — он придёт в «Отзывы» в кассе.', acts: [{ tap: 'star', mark: 'rate' }, { type: 'rev', text: 'Всё отлично!' }, { tap: 'send' }, { wait: 700 }] },
    ],
  },
  'percent-rules': {
    label: 'Кто какой процент получает',
    frames: [
      { screen: X.attrCheck(), cap: 'Касса сама записывает, кто добавил каждую позицию, — по PIN. Отсюда и проценты.', acts: [{ wait: 1200 }] },
      { screen: X.attrCheck(), cap: 'Кальянщик получает процент с кальянов, которые добавил сам, бармен со своих напитков и поровну с остального бара, официант со столов, которые открыл.', acts: [{ mark: 'hk' }, { wait: 700 }, { mark: 'br' }, { wait: 700 }, { mark: 'wt' }, { wait: 1300 }] },
    ],
  },
  'anti-fraud': {
    label: 'Защита от накруток',
    frames: [
      { screen: X.review(), cap: 'Время смен ставит сервер, ставки хранятся с историей. Всё, что меняли руками, — в блоке «Проверьте» у сотрудника.', acts: [{ wait: 900 }, { mark: 'chk' }, { wait: 1500 }] },
      { screen: X.shifts(), enter: 'push', cap: 'Смену нельзя удалить — только отменить: запись остаётся зачёркнутой, с именем администратора. Свою смену администратор не правит.', acts: [{ wait: 2200 }] },
    ],
  },
  'staff-shifts': {
    label: 'Смены сотрудников (табель)',
    frames: [
      ADMIN_TO('Смены сотрудников'),
      { screen: X.shifts(), enter: 'push', cap: 'Здесь видно, кто, когда и сколько работал. Если кто-то не закончил смену, нажмите «Закрыть».', acts: [{ wait: 700 }, { tap: 'close' }] },
      { screen: X.shifts(), over: { kind: 'dialog', html: X.closeShiftDialog }, cap: 'Укажите, когда человек ушёл. Правка подпишется вашим именем.', acts: [{ type: 'end', text: '02:30' }, { tap: 'ok' }] },
      { screen: X.shifts(), cap: 'Если сотрудник забыл отметиться, нажмите «Добавить смену». Ошибку исправит карандаш или кнопка «Отменить запись».', acts: [{ mark: 'closed' }, { wait: 800 }, { tap: 'addsh' }, { wait: 600 }] },
    ],
  },
  tips: {
    label: 'Чаевые',
    frames: [
      { screen: payment({ total: '2 030' }).replace('Добавить чаевые</div>', '<span data-tap="tips">Добавить чаевые</span></div>'), cap: 'При оплате нажмите «Добавить чаевые».', acts: [{ wait: 500 }, { tap: 'tips' }] },
      { screen: payment({ total: '2 030' }), over: { kind: 'dialog', html: X.tipsDialog }, cap: '«Кому» — конкретному сотруднику или «Всей смене (поровну)», и сумма. Чаевые — не выручка, в зарплате они отдельной строкой.', acts: [{ tap: 'who', mark: 'all' }, { type: 'tip', text: '300' }, { tap: 'ok' }] },
      { screen: X.stepsPayroll().replace('Алина', 'Алина').replace(X.line('С чеков · 3% от 214 000 ₽', '6 420 ₽'), X.line('С чеков · 3% от 214 000 ₽', '6 420 ₽') + X.line('Чаевые · от гостей, не зарплата', '4 300 ₽', { mu: true })), enter: 'fade', cap: 'В приложении гостя — включите «Чаевые» в профиле заведения. Своя ссылка (Нетмонет, CloudTips) — в карточке сотрудника.', acts: [{ wait: 2000 }] },
    ],
  },
  reports: {
    label: 'Отчёты',
    frames: [
      ADMIN_TO('Отчёты'),
      { screen: X.reports(), enter: 'push', cap: 'Период: «Сегодня», «7 дней», «30 дней» или «Свой период». Выручка, визиты, средний чек, сотрудники, терминал по банкам, агрегаторы.', acts: [{ tap: 'w' }, { wait: 1600 }] },
      { screen: X.reports(), cap: '«Напечатать», «Текстом» — для мессенджера, «Таблица продаж для Excel» — каждая позиция строкой, для бухгалтера.', acts: [{ tap: 'xls' }, { wait: 1200 }] },
    ],
  },
  activity: {
    label: 'Журнал действий',
    frames: [
      { screen: X.admin('Искусственный интеллект', AI_TILES, 'Активность и журнал'), cap: 'Админ → «Активность и журнал».', acts: [{ wait: 400 }, { tap: 'tile' }] },
      { screen: X.activity(), enter: 'push', cap: 'Скидки, возвраты, удалённые позиции, закрытия без оплаты, правки смен, ставок и склада — с именем и временем. Что менял ИИ — тоже здесь.', acts: [{ wait: 2600 }] },
    ],
  },
  'revenue-steps': {
    label: 'Бонус за шаги выручки заведения',
    frames: [
      { screen: employeesScreen().replace(`${'<div class="gx-card" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:9px">'}
    <div class="gx-ava" style="width:40px;height:40px;font-size:16px">А</div>`, `<div class="gx-card" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:9px" data-tap="al">
    <div class="gx-ava" style="width:40px;height:40px;font-size:16px">А</div>`), cap: 'Админ → «Сотрудники» → откройте сотрудника.', acts: [{ tap: 'al' }] },
      { screen: X.stepsForm(), enter: 'push', cap: 'В разделе «Зарплата» откройте «Бонус за выручку заведения» и нажмите «Добавить». Шаг состоит из порога выручки и бонуса в виде фиксированной суммы.', acts: [{ tap: 'add', mark: 's1' }, { type: 't1', text: '300000' }, { type: 'v1', text: '3000' }] },
      { screen: X.stepsForm(), cap: 'Шагов может быть несколько. Второй шаг здесь «Процент от выручки»: 1% со всей выручки, если она дошла до 500 000 ₽. Нажмите «Сохранить».', acts: [{ tap: 'add', mark: 's2' }, { type: 't2', text: '500000' }, { tap: 'pct', mark: 'pct' }, { type: 'v2', text: '1' }, { tap: 'save' }] },
      { screen: X.stepsPayroll(), enter: 'push', cap: 'В «Зарплате» за период — строка «Бонус за выручку»: сколько шагов пройдено и сумма. Каждый пройденный шаг платится отдельно.', acts: [{ wait: 800 }, { mark: 'b' }, { wait: 1800 }] },
    ],
  },
  loyalty: {
    label: 'Программа лояльности',
    frames: [
      GADMIN_TO('Программа лояльности'),
      { screen: X.loyalty(), enter: 'push', cap: 'Уровни: с какой суммы покупок начинается («От, ₽») и сколько возвращается бонусами («Кешбэк, %»). 1 бонус = 1 ₽.', acts: [{ tap: 'p', mark: 'p' }, { wait: 400 }, { tap: 'save' }] },
      { screen: X.payBonus(), enter: 'push', cap: 'При оплате — телефон гостя → «Найти»: уровень и бонусы. Списать или начислить.', acts: [{ type: 'ph', text: '+7 999 123-45-67' }, { tap: 'find', mark: 'g' }, { wait: 500 }, { tap: 'use' }, { wait: 800 }] },
    ],
  },
  'discount-cards': {
    label: 'Скидочные карты',
    frames: [
      GADMIN_TO('Скидочные карты'),
      { screen: X.cards(), enter: 'push', cap: 'Нажмите «Новая карта».', acts: [{ wait: 500 }, { tap: 'new' }] },
      { screen: X.cards(), over: { kind: 'dialog', html: X.cardDialog }, cap: 'Номер, имя гостя (без фамилии и телефона) и скидка в процентах.', acts: [{ type: 'cn', text: '0160' }, { type: 'cname', text: 'Аня' }, { type: 'cpct', text: '10' }, { tap: 'save', mark: 'saved' }] },
      { screen: tableCheck({ items: ORDER3, total: '2 030 ₽', tap: { card: 'disc' } }), enter: 'push', cap: 'За столом сотрудник нажимает «Скидка» и вводит номер карты.', acts: [{ wait: 400 }, { tap: 'disc' }] },
      { screen: tableCheck({ items: ORDER3, total: '2 030 ₽' }), over: { kind: 'dialog', html: X.discDialog }, cap: 'Скидка сразу в счёте и в предчеке.', acts: [{ type: 'dn', text: '0160' }, { mark: 'found' }, { wait: 500 }, { tap: 'apply' }] },
    ],
  },
  certificates: {
    label: 'Сертификаты и бонусные коды',
    frames: [
      GADMIN_TO('Сертификаты'),
      { screen: X.certs(), enter: 'push', cap: 'Нажмите «Выпустить сертификат».', acts: [{ wait: 400 }, { tap: 'new' }] },
      { screen: X.certs(), over: { kind: 'dialog', html: X.certDialog }, cap: 'Сколько бонусов начислить, сколько человек успеют им воспользоваться и сколько дней он действует.', acts: [{ type: 'b', text: '500' }, { type: 'n', text: '50' }, { type: 'd', text: '14' }, { tap: 'go', mark: 'iss' }] },
      { screen: X.certs(), cap: '«Скопировать код» или «Скопировать пост» — готовый текст для канала. Гость вводит код в «Профиле» приложения.', acts: [{ wait: 600 }, { tap: 'post', mark: 'post' }, { wait: 1200 }] },
    ],
  },
  stories: {
    label: 'Лента для гостей',
    frames: [
      GADMIN_TO('Лента для гостей'),
      { screen: X.stories(), enter: 'push', cap: 'Порядок меняют кнопки «Выше в ленте» и «Ниже в ленте». Новую карточку добавляет «Новая карточка».', acts: [{ wait: 600 }, { tap: 'new' }] },
      { screen: X.storyForm(), enter: 'push', cap: 'Заголовок, текст и фото — новость, событие, новое блюдо. Кнопка ведёт в меню, на бронь или никуда. Рекламу табака касса не пропустит.', acts: [{ type: 'st', text: 'Живая музыка в субботу' }, { type: 'sx', text: 'С 20:00, вход свободный' }, { tap: 'book', mark: 'book' }, { tap: 'save' }] },
    ],
  },
  reviews: {
    label: 'Отзывы',
    frames: [
      GADMIN_TO('Отзывы'),
      { screen: X.reviews(), enter: 'push', cap: 'Все оценки и отзывы после визитов. Фильтр «Ниже 4 звёзд — разобраться» покажет, кому стоит позвонить.', acts: [{ wait: 900 }, { tap: 'bad', mark: 'bad' }, { wait: 1600 }] },
    ],
  },
  guests: {
    label: 'База гостей',
    frames: [
      GADMIN_TO('Гости'),
      { screen: X.guests(), enter: 'push', cap: 'Поиск по имени или телефону: уровень, визиты и бонусы гостя.', acts: [{ type: 'q', text: 'Аня' }, { mark: 'found' }, { wait: 800 }] },
      { screen: X.guests(), cap: 'Если гость сменил номер, нажмите «Сменить номер». Если у гостя новый телефон, нажмите «Объединить с новым устройством», и бонусы перенесутся.', acts: [{ tap: 'merge' }] },
      { screen: X.guests(), over: { kind: 'dialog', html: X.mergeDialog }, cap: 'По просьбе гостя данные удаляются кнопкой «Удалить гостя».', acts: [{ type: 'mc', text: '4821-77' }, { tap: 'ok' }, { wait: 500 }] },
    ],
  },
  stock: {
    label: 'Склад: остатки и движения',
    frames: [
      ADMIN_TO('Склад'),
      { screen: X.stock(), enter: 'push', cap: 'Остатки и отметка «мало» видны сразу. Новую позицию добавляет кнопка «Новая позиция склада».', acts: [{ wait: 800 }, { tap: 'new' }] },
      { screen: X.stock(), over: { kind: 'dialog', html: X.stockDialog }, cap: 'Название, категория, единица измерения и порог, после которого касса скажет «мало».', acts: [{ type: 'sn', text: 'Мята свежая' }, { type: 'thr', text: '0,2' }, { tap: 'save', mark: 'new' }] },
      { screen: X.stock({ added: true }), enter: 'none', cap: 'Откройте позицию.', acts: [{ wait: 500 }, { tap: 'dk' }] },
      { screen: X.stockItem(), enter: 'push', cap: '«Приход» оформляет поставку, «Списание» порчу или угощение. В «Истории движений» видно каждое изменение и кто его сделал.', acts: [{ tap: 'in', mark: 'in' }, { wait: 1600 }] },
    ],
  },
  'auto-writeoff': {
    label: 'Автосписание при продаже',
    frames: [
      { screen: X.itemForm({ stock: true }), cap: 'В карточке позиции меню выберите продукт в «Склад (автосписание)» и укажите граммовку.', acts: [{ type: 'iname', text: 'Классический кальян' }, { tap: 'prod', mark: 'prod' }, { type: 'gram', text: '20' }, { tap: 'save' }] },
      { screen: X.stockItem(), enter: 'push', cap: 'При продаже касса сама спишет граммовку × количество. Не хватает продукта — предупредит при оплате.', acts: [{ wait: 2400 }] },
    ],
  },
  inventory: {
    label: 'Инвентаризация',
    frames: [
      { screen: X.inv(), cap: 'Админ → «Склад» → «Инвентаризация» → «Начать инвентаризацию».', acts: [{ wait: 700 }, { tap: 'start' }] },
      { screen: X.inv({ started: true }), enter: 'push', cap: 'Пересчитайте, что есть на самом деле, и впишите.', acts: [{ type: 'c1', text: '1,18' }, { type: 'c3', text: '0,3' }, { tap: 'fin' }] },
      { screen: X.inv({ started: true }), cap: '«Завершить инвентаризацию» — касса покажет расхождения и поправит остатки.', acts: [{ mark: 'res' }, { wait: 2000 }] },
    ],
  },
  egais: {
    label: 'ЕГАИС (алкоголь)',
    frames: [
      { screen: X.admin('Настройки', [['gear', 'Интеграции']], 'Интеграции'), cap: 'Админ → «Интеграции» → «ЕГАИС (алкоголь)».', acts: [{ wait: 400 }, { tap: 'tile' }] },
      { screen: X.egais(), enter: 'push', cap: 'Впишите адрес компьютера с УТМ и нажмите «Проверить связь и входящие документы».', acts: [{ type: 'utm', text: 'http://192.168.1.20:8080' }, { tap: 'chk', mark: 'ok' }, { wait: 1800 }] },
    ],
  },
  fiscal: {
    label: 'Онлайн-касса (54-ФЗ)',
    frames: [
      { screen: X.fiscal(), cap: 'Откройте Админ → «Интеграции» → «Онлайн-касса (54-ФЗ)». Для своего регистратора АТОЛ выберите «Регистратор АТОЛ в заведении». Если своей ККТ нет, подойдёт облачная касса (АТОЛ Онлайн, OrangeData).', acts: [{ wait: 500 }, { tap: 'mode', mark: 'mode' }, { wait: 400 }] },
      { screen: X.fiscal(), cap: 'Адрес веб-сервера из драйвера АТОЛ 10, налогообложение и НДС. «Проверить связь с регистратором» — и проверьте чек в кабинете ОФД.', acts: [{ type: 'atol', text: 'http://127.0.0.1:16732' }, { tap: 'chk', mark: 'ok' }, { wait: 1600 }] },
    ],
  },
  terminal: {
    label: 'Терминал оплаты картой',
    frames: [
      { screen: X.terminal(), cap: 'Админ → «Интеграции» → «Терминал оплаты». Отметьте, терминалы каких банков стоят в заведении.', acts: [{ wait: 500 }, { tap: 'tb', mark: 'tb' }, { wait: 600 }] },
      { screen: X.payTerminal(), enter: 'push', over: { kind: 'dialog', html: X.termDialog }, cap: 'Сумму набирают на терминале. Банков несколько — отметьте, на каком оплатили: банк запишется в чек.', acts: [{ wait: 600 }, { tap: 'sber', mark: 'sber' }, { wait: 400 }] },
      { screen: X.payTerminal(), over: { kind: 'dialog', html: X.termDialog }, cap: '«Оплата прошла» — только когда терминал подтвердил. В X-отчёте и отчётах терминал разложен по банкам.', acts: [{ tap: 'yes' }, { wait: 500 }] },
    ],
  },
  aggregators: {
    label: 'Яндекс Еда, Купер, Мегамаркет',
    frames: [
      { screen: X.aggr(), cap: 'Админ → «Интеграции» → «Агрегаторы доставки». Включите своих и впишите комиссию по договору.', acts: [{ tap: 'ya', mark: 'ya' }, { type: 'com', text: '25' }, { wait: 500 }] },
      { screen: X.payAggr(), enter: 'push', cap: 'Заказ пришёл — заведите его как обычно, а при оплате нажмите на поле агрегатора: туда встанет вся сумма. В наличные он не попадёт.', acts: [{ wait: 500 }, { tap: 'ya', mark: 'ya' }, { wait: 500 }, { tap: 'pay' }] },
    ],
  },
  'ai-hall': {
    label: 'Ассистент зала',
    frames: [
      { screen: hall().replace(`<div class="gx-bar-btn" style="position:relative">${ic('spark', 22)}`, `<div class="gx-bar-btn" style="position:relative" data-tap="ai">${ic('spark', 22)}`), cap: 'В зале — значок ✦ вверху.', acts: [{ wait: 500 }, { tap: 'ai' }] },
      { screen: hall(), over: { kind: 'sheet', html: X.aiChat() }, cap: 'Спрашивайте обычными словами — ассистент отвечает по данным вашего заведения прямо сейчас.', acts: [{ type: 'aq', text: 'Какие столы освободятся?' }, { tap: 'send' }, { mark: 'q' }, { wait: 900 }, { mark: 'a' }, { wait: 2200 }] },
    ],
  },
  'ai-insights': {
    label: 'ИИ-разборы',
    frames: [
      { screen: X.admin('Искусственный интеллект', AI_TILES, 'ИИ-разборы'), cap: 'Админ → «ИИ-разборы».', acts: [{ wait: 400 }, { tap: 'tile' }] },
      { screen: X.aiInsights(), enter: 'push', cap: 'Готовые разборы: выручка, заявка на закупку, идеи акций, отзывы, брони на смену. Или свой вопрос аналитику.', acts: [{ wait: 900 }, { tap: 'buy' }] },
      { screen: X.aiBuy(), enter: 'push', cap: 'Заявка на закупку — по продажам и остаткам склада. Скопируйте и отправьте поставщику.', acts: [{ wait: 2600 }] },
    ],
  },
  backup: {
    label: 'Резервная копия', device: 'web',
    frames: [
      { screen: X.webBackup(), cap: 'Кабинет → «Настройки» → «Скачать бэкап заведения»: меню, зал, чеки, смены, бонусы, склад — одним файлом.', acts: [{ wait: 600 }, { tap: 'dl', mark: 'dl' }, { wait: 1200 }] },
      { screen: X.webBackup(), cap: 'Храните файл у себя. Имён, телефонов и адресов гостей в нём нет. Скачивать можно раз в 3 дня.', acts: [{ wait: 2000 }] },
    ],
  },
  support: {
    label: 'Поддержка', device: 'web',
    frames: [
      { screen: X.webSupport(), cap: 'Кабинет → «Поддержка». Опишите, что делали и что увидели, приложите снимок экрана.', acts: [{ type: 'sup', text: 'Не печатает чек на Windows' }, { tap: 'att', mark: 'att' }, { tap: 'send' }] },
      { screen: X.webSupport(), cap: 'Ответ придёт здесь же, в обращении.', acts: [{ mark: 'ans' }, { wait: 2200 }] },
    ],
  },
  rkn: {
    label: 'Роскомнадзор: уведомление работодателя', device: 'web',
    frames: [
      { screen: X.webRkn(), url: 'pd.rkn.gov.ru (схема)', cap: 'За гостей ZalPOS отвечает сам. Заведению остаётся общее уведомление работодателя — если ещё не подавали: pd.rkn.gov.ru.', acts: [{ type: 'goal', text: 'кадровый и бухгалтерский учёт, расчёт зарплаты' }, { wait: 400 }] },
      { screen: X.webRkn(), url: 'pd.rkn.gov.ru (схема)', cap: 'Трансграничная передача — нет, база — Российская Федерация. Подпишите через Госуслуги: бесплатно, 15–20 минут.', acts: [{ tap: 'tb', mark: 'tb' }, { wait: 500 }, { tap: 'send' }, { wait: 900 }] },
    ],
  },
  'kitchen-alarm': {
    label: 'Громкий сигнал нового заказа',
    frames: [
      { screen: X.kitchenAlarm(), cap: 'Новый заказ — экран кухни мигает красным, а планшет звенит громкостью будильника каждые 4 секунды, пока его не приняли.', acts: [{ wait: 2400 }] },
      { screen: X.kitchenAlarm(), cap: 'Повар нажимает «Принял» — звонок замолкает. Не приняли за 45 секунд — ещё раз звонит звонок на раздаче, если подключено реле.', acts: [{ wait: 400 }, { tap: 'acc', mark: 'acc' }, { wait: 1600 }] },
    ],
  },
  'waiter-ready': {
    label: '«Готово» официанту: телефон и часы',
    frames: [
      { screen: kitchenScreen(), cap: 'Повар нажимает «Всё готово» на своём планшете.', acts: [{ wait: 400 }, { tap: 't5', mark: 't5' }, { wait: 900 }] },
      { screen: X.hallReady(), enter: 'fade', cap: 'У официанта этого стола всплывает «Готово · Стол 5» с длинной вибрацией — так же приходят вызовы гостей.', acts: [{ wait: 300 }, { mark: 'n' }, { wait: 2200 }] },
      { screen: X.watch('Готово · Стол 5', 'Паста карбонара ×2, Том ям', 'ZalPOS · касса'), enter: 'fade', cap: 'Смарт-часы или фитнес-браслет повторяют уведомление на руке — телефон можно не доставать.', acts: [{ wait: 300 }, { mark: 'w' }, { wait: 2200 }] },
    ],
  },
  'smartwatch': {
    label: 'Смарт-часы официанта',
    frames: [
      { screen: X.watchApp(), cap: 'На телефоне официанта откройте приложение часов (Mi Fitness, Zepp, Huawei Health, Galaxy Wearable) → «Уведомления» и включите ZalPOS.', acts: [{ wait: 700 }, { tap: 'zp', mark: 'zp' }, { wait: 1200 }] },
      { screen: X.watch('Гость зовёт', 'Стол 3 · «Принесите счёт»', 'ZalPOS · касса'), enter: 'fade', cap: 'Готово: «готово» с кухни, вызовы и заказы гостей вибрируют на руке.', acts: [{ wait: 300 }, { mark: 'w' }, { wait: 2000 }] },
    ],
  },
  'signals-setup': {
    label: 'Wi‑Fi реле: звонок или лампа',
    frames: [
      { screen: X.admin('Настройки', [['gear', 'Интеграции'], ['bell', 'Звонки и сигналы']], 'Звонки и сигналы'), cap: 'Админ → «Звонки и сигналы».', acts: [{ wait: 400 }, { tap: 'tile' }] },
      { screen: X.signals(), enter: 'push', cap: 'Здесь кухня, официанты, реле, зуммер принтера и работа без интернета. Нажмите «Добавить реле».', acts: [{ wait: 900 }, { tap: 'add' }] },
      { screen: X.signals(), over: { kind: 'dialog', html: X.relayDialog }, cap: 'Тип реле, его IP в Wi‑Fi заведения и события, на которые звонить. «Проверить сейчас» — реле должно щёлкнуть.', acts: [{ type: 'ip', text: '192.168.1.50' }, { tap: 'ev', mark: 'ev' }, { wait: 300 }, { tap: 'test', mark: 'ok' }, { wait: 1300 }, { tap: 'done' }] },
      { screen: X.signals({ relay: true }), cap: '«Сохранить» — реле звонит с любого планшета заведения, интернет для этого не нужен.', acts: [{ wait: 700 }, { tap: 'save' }, { wait: 800 }] },
    ],
  },
  'relay-wiring': {
    label: 'Как подключить реле к звонку',
    frames: [
      { screen: X.wire([['Сеть 220 В · L', 'L', 'Shelly 1 · L и вход SW', ''], ['Сеть 220 В · N', 'N', 'Shelly 1 · N', ''], ['Сеть 220 В · L', 'перемычка', 'Shelly 1 · I', ''], ['Shelly 1 · O', 'провод', 'Звонок · вывод 1', ''], ['Звонок · вывод 2', 'N', 'Сеть 220 В · N', '']], 'Звонок 220 В через Shelly 1'), cap: 'Звонок 220 В: питание реле подключают к L и N, вход I соединяют с L, выход O ведут на звонок, второй провод звонка на ноль. Электрик справится минут за десять.', acts: [{ wait: 3600 }] },
      { screen: X.wire([['Блок питания 12 В · +', '+12 В', 'Shelly 1 · I', ''], ['Shelly 1 · O', '+12 В', 'Маячок или звонок 12 В · +', ''], ['Маячок · −', '−', 'Блок питания 12 В · −', ''], ['Shelly 1 · питание', '12 В DC', 'тот же блок питания', '']], 'Маячок или звонок 12 В'), cap: 'Маячок или звонок на 12 В: контакты I и O у Shelly 1 «сухие» — они просто замыкают провод от блока питания к лампе.', acts: [{ wait: 3600 }] },
    ],
  },
  'pager-watch': {
    label: 'Часы-пейджеры официантов',
    frames: [
      { screen: X.wire([['Кнопка вызова · контакт 1', 'провод', 'Shelly 1 · I', ''], ['Кнопка вызова · контакт 2', 'провод', 'Shelly 1 · O', ''], ['Shelly 1 · питание', '220 В или 12 В', 'розетка / блок питания', '']], 'Кнопка системы вызова + реле'), cap: 'Возьмите одну кнопку от системы вызова (iBells, Retekess и др.) и припаяйте к контактам её кнопки два провода — на вход I и выход O реле.', acts: [{ wait: 3400 }] },
      { screen: X.watch('Кухня · 05', 'Заберите заказ', 'вызов с кнопки №5'), enter: 'fade', cap: 'Повар нажал «Всё готово» — реле на секунду нажимает эту кнопку, и часы официантов вибрируют с её номером. Работает без интернета.', acts: [{ wait: 300 }, { mark: 'w' }, { wait: 2200 }] },
    ],
  },
  'printer-beep': {
    label: 'Зуммер кухонного принтера',
    frames: [
      { screen: X.signals({ beep: true }), cap: '«Звонки и сигналы» → «Зуммер кухонного принтера». «Встроенный» — у Xprinter, Gprinter, Rongta, HPRT, Sunmi, Epson с зуммером.', acts: [{ wait: 700 }, { tap: 'b', mark: 'b' }, { wait: 900 }] },
      { screen: X.signals({ beep: true }), cap: 'Сколько раз пискнуть и «Проверить кухонный» — принтер должен пискнуть сразу, без бумаги.', acts: [{ mark: 'b' }, { wait: 400 }, { tap: 'test' }, { wait: 1200 }], over: { kind: 'toast', html: toast('Принтер должен пискнуть') } },
    ],
  },
  'offline-lan': {
    label: 'Работа без интернета',
    frames: [
      { screen: X.hallOffline(), cap: 'Пропал интернет — касса продолжает работать: заказы, оплаты, бегунки на сетевые принтеры. Всё уйдёт в облако само, когда связь вернётся.', acts: [{ wait: 2600 }] },
      { screen: X.signals({ lan: true }), enter: 'push', cap: 'Кухня и официанты слышат друг друга по Wi‑Fi заведения. «Проверить, кто на связи» — покажет планшеты в сети.', acts: [{ wait: 600 }, { tap: 'ping', mark: 'ping' }, { wait: 1800 }] },
    ],
  },
};

/* ------------------------------------------------------------------ *
 *  Проигрыватель
 * ------------------------------------------------------------------ */
// Тайминги, мс. На телефоне палец «опускается» на кнопку (land), на сайте
// курсор подъезжает к ней (move).
const T = {
  enter: 520, settle: 400, land: 340, fastLand: 150, move: 660, fastMove: 300,
  hl: 260, press: 320, after: 340, fastAfter: 110, char: 95, end: 2200, hold: 520, drag: 1000,
};
const reach = (fast, web) => (web ? (fast ? T.fastMove : T.move) : (fast ? T.fastLand : T.land));

function actTime(a, web) {
  if (a.tap) return reach(a.fast, web) + (a.fast ? T.fastAfter : T.hl + T.after) + T.press;
  if (a.type) return reach(false, web) + T.hl + T.press + a.text.length * T.char + 320;
  if (a.drag) return reach(false, web) + T.hold + T.drag + 60 + T.after;
  if (a.mark) return 420;
  if (a.wait) return a.wait;
  return 0;
}
const frameTime = (f, last, web) =>
  T.enter + T.settle + (f.acts || []).reduce((s, a) => s + actTime(a, web), 0) + (last ? T.end : 0);

// Курсор мыши для сцен кабинета.
const CURSOR = '<svg viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5H19L5 2.5z" fill="#fff" stroke="#1D1A16" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const VIEW_W = { phone: 360, tablet: 960, web: 960 };

// Сцены кассы показываем на телефоне или планшете — выбор один на всю
// инструкцию и запоминается в браузере.
const DEVICE_KEY = 'gx-device';
const deviceChoice = () => {
  try { return localStorage.getItem(DEVICE_KEY) === 'tablet' ? 'tablet' : 'phone'; } catch (_) { return 'phone'; }
};
function switchDevice(d) {
  try { localStorage.setItem(DEVICE_KEY, d); } catch (_) { /* приватный режим — только на эту страницу */ }
  for (const [fig, p] of [...players]) {
    if (p.site) continue;
    // Планшет — во всю ширину статьи, телефон — в колонке рядом с шагами.
    const body = fig.closest('.guide-item-body');
    if (body) body.classList.toggle('wide', d === 'tablet');
    p.destroy();
    players.set(fig, new Player(fig, p.scene));
  }
}

const WIN_BAR = `<div class="gx-win-bar"><i class="gx-win-start"><b></b><b></b><b></b><b></b></i><i class="gx-win-search">${ic('search', 11, 2)}Поиск</i>
  <i style="background:#F2C14E"></i><i style="background:linear-gradient(140deg,#3AA0F0,#1F6FD0)"></i><i class="on" style="background:linear-gradient(140deg,#C7743F,#8E3F1C)"></i>
  <span class="gx-win-tray"><span>РУС</span><span>19:42<br>18.10.2026</span></span></div>`;

class Player {
  constructor(fig, scene) {
    this.fig = fig;
    this.scene = scene;
    this.frames = scene.frames;
    this.gen = 0;
    this.idx = 0;
    this.playing = false;
    this.userPaused = false;
    this.visible = false;
    this.started = false;
    // Сцена кабинета на узком экране — мобильная версия сайта в телефоне:
    // окно браузера в треть ширины было бы не прочитать.
    // Касса на Windows — окно на рабочем столе при любой ширине: это и
    // есть то, что человек увидит у себя на компьютере.
    const winOS = scene.device === 'windows';
    const site = scene.device === 'web' || winOS;
    const width = fig.getBoundingClientRect().width || window.innerWidth;
    const web = winOS || (site && width >= 560);
    const tablet = !site && deviceChoice() === 'tablet';
    this.site = site;
    const devs = site ? '' : `<div class="gx-devs" role="group" aria-label="Устройство">${[['phone', 'Телефон', 'phone'], ['tablet', 'Планшет', 'tablet']]
      .map(([k, t, i]) => `<button type="button" class="${cls('gx-dev', (tablet ? 'tablet' : 'phone') === k && 'on')}" data-dev="${k}" aria-pressed="${(tablet ? 'tablet' : 'phone') === k}">${ic(i, 15, 2)}${t}</button>`).join('')}</div>`;
    let device;
    if (winOS) {
      device = `<div class="gx-win" aria-hidden="true"><div class="gx-win-desk"><div class="gx-win-icon"><span>Z</span>ZalPOS</div>
        <div class="gx-win-window"><div class="gx-win-title"><span class="app"></span><span class="name">ZalPOS</span><span class="ctl"><i>—</i><i>▢</i><i>✕</i></span></div>
        <div class="gx-win-addr">${ic('lock', 10, 2.2)}<span>zalpos.ru</span></div><div class="gx-screen web"></div></div></div>${WIN_BAR}</div>`;
    } else if (web) {
      device = `<div class="gx-browser" aria-hidden="true"><div class="gx-browser-bar"><i></i><i></i><i></i><span class="gx-url">zalpos.ru</span></div><div class="gx-screen web"></div></div>`;
    } else if (tablet) {
      device = '<div class="gx-tablet" aria-hidden="true"><div class="gx-screen tab"></div></div>';
    } else {
      device = `<div class="gx-phone" aria-hidden="true"><div class="${cls('gx-screen', site && 'webm')}"><div class="gx-island"></div></div></div>`;
    }
    fig.innerHTML = `
      <div class="gx-stage">
        ${devs}
        ${device}
        <div class="gx-foot">
          <div class="gx-cap" aria-live="polite"><span class="gx-cap-n">1</span><span class="gx-cap-t"></span></div>
          <div class="gx-ctrl">
            <div class="gx-segs">${this.frames.map((_, i) => `<button type="button" class="gx-seg" data-i="${i}" aria-label="Шаг ${i + 1}"><i></i></button>`).join('')}</div>
            <button type="button" class="gx-btn" aria-label="Пауза">${ic('pause', 13, 2.4).replace('<svg', '<svg class="gx-i-pause"')}${ic('play', 13).replace('<svg', '<svg class="gx-i-play"')}</button>
          </div>
        </div>
      </div>`;
    fig.setAttribute('aria-label', `Анимация: ${scene.label}`);
    this.screen = fig.querySelector('.gx-screen');
    if (site && document.documentElement.dataset.theme === 'dark') this.screen.classList.add('dark');
    this.capN = fig.querySelector('.gx-cap-n');
    this.capT = fig.querySelector('.gx-cap-t');
    this.segs = [...fig.querySelectorAll('.gx-seg')];
    this.ppBtn = fig.querySelector('.gx-btn');
    this.web = web;
    this.touch = document.createElement('div');
    this.touch.className = web ? 'gx-touch web' : 'gx-touch';
    if (web) this.touch.innerHTML = CURSOR;
    this.screen.appendChild(this.touch);
    this.viewW = VIEW_W[web ? 'web' : tablet ? 'tablet' : 'phone'];
    this.win = winOS ? fig.querySelector('.gx-win') : null;
    fig.querySelectorAll('.gx-dev').forEach((b) => { b.onclick = () => { if (!b.classList.contains('on')) switchDevice(b.dataset.dev); }; });

    this.segs.forEach((b) => { b.onclick = () => this.jump(Number(b.dataset.i)); });
    this.ppBtn.onclick = () => {
      if (this.playing) { this.userPaused = true; this.pause(); } else { this.userPaused = false; this.resume(true); }
    };
    this.ro = new ResizeObserver(() => { this.scale(); this.fitCaption(); });
    this.ro.observe(this.screen);
    this.scale();
    this.render(0);
    this.setPaused(true);
    this.io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && !this.userPaused && !reduceMotion()) this.resume(); else if (!this.visible) this.pause();
    }, { threshold: 0.35 });
    this.io.observe(fig);
    this.onVis = () => { if (document.hidden) this.pause(); else if (this.visible && !this.userPaused && !reduceMotion()) this.resume(); };
    document.addEventListener('visibilitychange', this.onVis);
    if (reduceMotion()) this.pointAt(this.frames[0]);
  }

  destroy() {
    this.gen++;
    this.io.disconnect();
    this.ro.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    clearTimeout(this.timer);
    this.fig.innerHTML = '';
  }

  // Подпись — высотой с самую длинную, чтобы страница не прыгала.
  fitCaption() {
    const w = this.capT.clientWidth;
    if (!w || w === this.capW) return;
    this.capW = w;
    const probe = this.capT.cloneNode();
    probe.className = 'gx-cap-t';
    probe.style.cssText = `position:absolute;visibility:hidden;width:${w}px`;
    this.capT.parentNode.appendChild(probe);
    let h = 0;
    for (const f of this.frames) { probe.innerHTML = uiText(f.cap); h = Math.max(h, probe.offsetHeight); }
    probe.remove();
    this.capT.parentNode.style.minHeight = `${h}px`;
  }

  scale() {
    const w = this.screen.clientWidth;
    if (w) this.screen.style.setProperty('--s', String(w / this.viewW));
  }

  setPaused(p) {
    this.fig.classList.toggle('paused', p);
    this.ppBtn.setAttribute('aria-label', p ? 'Смотреть' : 'Пауза');
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.setPaused(true);
  }

  resume(force = false) {
    if (this.playing) return;
    if (reduceMotion() && !force) return;
    this.playing = true;
    this.setPaused(false);
    if (!this.started) { this.started = true; this.run(this.idx, true); return; }
    const wake = this.onResume;
    this.onResume = null;
    if (wake) wake();
  }

  sleep(ms, gen) {
    return new Promise((res) => {
      let left = ms;
      let last = performance.now();
      const tick = () => {
        if (gen !== this.gen) return res(false);
        const now = performance.now();
        if (this.playing) left -= now - last;
        last = now;
        if (left <= 0) return res(true);
        // На паузе не крутим таймер — ждём resume().
        if (!this.playing) { this.onResume = () => { last = performance.now(); tick(); }; return; }
        this.timer = setTimeout(tick, Math.min(left, 60));
      };
      tick();
    });
  }

  top() {
    const layers = this.screen.querySelectorAll('.gx-layer:not(.out):not(.out-push):not(.out-back):not(.out-fade)');
    return layers[layers.length - 1];
  }

  find(sel) {
    // Сначала в верхнем слое (окно, меню), потом в экране под ним. Только
    // видимое: у кабинета на телефоне меню слева спрятано, вместо него ☰.
    const layers = [...this.screen.querySelectorAll('.gx-layer:not(.out):not(.out-push):not(.out-back):not(.out-fade)')].reverse();
    for (const l of layers) {
      const el = [...l.querySelectorAll(sel)].find((e) => e.getClientRects().length);
      if (el) return el;
    }
    return null;
  }

  // Кадр без анимации: при переходе по шагам и в начале.
  render(i) {
    this.screen.querySelectorAll('.gx-layer').forEach((l) => l.remove());
    const f = this.frames[i];
    this.screen.insertBefore(this.layer('base', f.screen), this.touch);
    if (f.over) this.screen.insertBefore(this.layer(`over ${f.over.kind}`, f.over.html, true), this.touch);
    // Состояние, накопленное предыдущими кадрами на этом же экране (точки PIN, введённый текст).
    for (let j = i - 1; j >= 0 && this.frames[j].screen === f.screen; j--) {
      for (const a of this.frames[j].acts || []) this.applyState(a);
    }
    this.touch.classList.remove('on');
    this.caption(i, false);
    this.idx = i;
  }

  layer(cls, html, noAnim = false) {
    const d = document.createElement('div');
    d.className = `gx-layer ${cls}`;
    if (noAnim) d.style.animation = 'none';
    d.innerHTML = `<div class="gx-view">${html}</div>`;
    if (noAnim) d.querySelectorAll('.gx-panel, .gx-scrim').forEach((p) => { p.style.animation = 'none'; });
    return d;
  }

  applyState(a) {
    if (a.mark) this.screen.querySelectorAll(`[data-mark="${a.mark}"]`).forEach((m) => m.classList.add('on'));
    if (a.type) {
      const f = this.screen.querySelector(`[data-type="${a.type}"] .gx-val`);
      if (f) f.textContent = a.text;
    }
  }

  // Переход к кадру с анимацией.
  enter(i) {
    const f = this.frames[i];
    const prev = this.frames[this.idx];
    const base = this.screen.querySelector('.gx-layer.base:not([class*="out"])');
    const overs = [...this.screen.querySelectorAll('.gx-layer.over:not(.out)')];
    const sameBase = base && i !== 0 && prev && prev.screen === f.screen;
    const drop = (l, cls, ms) => { l.classList.add(...cls.split(' ')); setTimeout(() => l.remove(), ms); };
    if (!sameBase) {
      const kind = f.enter || 'fade';
      const nb = this.layer('base', f.screen, kind === 'none');
      if (kind !== 'none') nb.classList.add(`in-${kind}`);
      this.screen.insertBefore(nb, this.touch);
      // При «проявлении» старый экран остаётся под новым непрозрачным,
      // пока тот не проявится целиком, — без провала в пустоту.
      if (base) {
        // Уходящий экран — под новым, даже если сам когда-то въехал поверх.
        base.classList.remove('in-push', 'in-back', 'in-fade');
        drop(base, kind === 'none' || kind === 'fade' ? 'out' : `out-${kind}`, 520);
      }
      overs.forEach((o) => drop(o, 'out', 340));
      if (f.over) this.screen.insertBefore(this.layer(`over ${f.over.kind}`, f.over.html), this.touch);
    } else {
      const same = overs.length && prev.over && f.over && prev.over.html === f.over.html;
      if (!same) {
        overs.forEach((o) => drop(o, 'out', 340));
        if (f.over) this.screen.insertBefore(this.layer(`over ${f.over.kind}`, f.over.html), this.touch);
      }
    }
    this.caption(i, true);
    this.idx = i;
  }

  caption(i, animate) {
    const f = this.frames[i];
    const url = this.fig.querySelector('.gx-url');
    if (url) url.textContent = f.url || 'zalpos.ru';
    if (this.win) {
      // Окно Windows: заголовок, адресная строка браузера и ярлык на столе — по шагу.
      const w = f.win || {};
      this.win.querySelector('.name').textContent = w.title || 'ZalPOS';
      this.win.querySelector('.gx-win-addr span').textContent = w.url || '';
      this.win.classList.toggle('url', Boolean(w.url));
      this.win.querySelector('.gx-win-icon').classList.toggle('on', Boolean(w.icon));
    }
    this.capN.textContent = String(i + 1);
    this.capT.innerHTML = uiText(f.cap);
    if (animate) { this.capT.classList.remove('swap'); void this.capT.offsetWidth; this.capT.classList.add('swap'); }
    this.segs.forEach((s, j) => {
      s.classList.toggle('done', j < i);
      s.classList.remove('run');
      s.querySelector('i').style.removeProperty('--p');
    });
    const seg = this.segs[i];
    seg.style.setProperty('--d', `${frameTime(f, i === this.frames.length - 1, this.web)}ms`);
    if (animate) { void seg.offsetWidth; seg.classList.add('run'); } else seg.querySelector('i').style.setProperty('--p', '0');
  }

  pos(el) {
    const s = this.screen.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }

  // Поставить палец или курсор в точку сразу, без движения.
  place(x, y) {
    const prev = this.touch.style.transition;
    this.touch.style.transition = 'none';
    this.touch.style.translate = `${x}px ${y}px`;
    void this.touch.offsetWidth;
    this.touch.style.transition = prev;
  }

  // К кнопке: на телефоне палец появляется прямо на ней (никуда не
  // летит), на сайте курсор подъезжает — а если его ещё не было видно,
  // выходит из-за края кнопки, а не из угла экрана.
  moveTo(el) {
    const { x, y } = this.pos(el);
    const shown = this.touch.classList.contains('on');
    if (!this.web || !shown) this.place(this.web ? x + 46 : x, this.web ? y + 34 : y);
    if (this.web) {
      void this.touch.offsetWidth;
      this.touch.style.translate = `${x}px ${y}px`;
    }
    this.touch.classList.add('on');
    return { x, y };
  }

  // Палец поднялся — исчезает на месте.
  lift() {
    if (!this.web) this.touch.classList.remove('on');
  }

  // Статичная подсказка: палец над первой кнопкой кадра (без анимации).
  pointAt(f) {
    const a = (f.acts || []).find((x) => x.tap || x.type);
    const el = a && this.find(`[data-tap="${a.tap || a.type}"]`);
    if (!el) { this.touch.classList.remove('on'); return; }
    const { x, y } = this.pos(el);
    const prev = this.touch.style.transition;
    this.touch.style.transition = 'none';
    this.touch.style.translate = `${x}px ${y}px`;
    this.touch.classList.add('on');
    void this.touch.offsetWidth;
    this.touch.style.transition = prev;
    el.classList.add('hl');
  }

  async tap(a, gen) {
    const el = this.find(`[data-tap="${a.tap || a.type}"]`);
    if (!el) return true;
    const { x, y } = this.moveTo(el);
    if (!(await this.sleep(reach(a.fast, this.web), gen))) return false;
    if (!a.fast) {
      el.classList.add('hl');
      if (!(await this.sleep(T.hl, gen))) return false;
    }
    this.touch.classList.remove('press'); void this.touch.offsetWidth; this.touch.classList.add('press');
    const rip = document.createElement('div');
    rip.className = 'gx-ripple';
    rip.style.left = `${x}px`; rip.style.top = `${y}px`;
    this.screen.appendChild(rip);
    setTimeout(() => rip.remove(), 660);
    el.classList.add('pressed');
    if (!(await this.sleep(T.press, gen))) return false;
    el.classList.remove('pressed', 'hl');
    this.lift();
    if (a.mark) this.applyState({ mark: a.mark });
    return true;
  }

  // Удерживать и тянуть: элемент едет вместе с пальцем.
  async drag(a, gen) {
    const el = this.find(`[data-tap="${a.drag}"]`);
    if (!el) return true;
    const { x, y } = this.moveTo(el);
    if (!(await this.sleep(reach(false, this.web), gen))) return false;
    el.classList.add('hl');
    this.touch.classList.add('hold');
    if (!(await this.sleep(T.hold, gen))) return false;
    const k = this.screen.clientWidth / this.viewW;
    const ease = `transform ${T.drag}ms cubic-bezier(.45,.05,.2,1)`;
    el.classList.add('dragging');
    el.style.transition = ease;
    el.style.transform = `translate(${a.dx}px, ${a.dy}px)`;
    this.touch.style.transition = `${ease.replace('transform', 'translate')}, opacity .28s ease, scale .28s ease`;
    this.touch.style.translate = `${x + a.dx * k}px ${y + a.dy * k}px`;
    const ok = await this.sleep(T.drag + 60, gen);
    this.touch.style.transition = '';
    this.touch.classList.remove('hold');
    el.classList.remove('hl', 'dragging');
    if (!ok) return false;
    this.lift();
    return this.sleep(T.after, gen);
  }

  async act(a, gen) {
    if (a.type) {
      if (!(await this.tap(a, gen))) return false;
      const box = this.find(`[data-type="${a.type}"]`);
      const val = box && box.querySelector('.gx-val');
      if (val) {
        const caret = document.createElement('span');
        caret.className = 'gx-caret';
        for (let k = 1; k <= a.text.length; k++) {
          val.textContent = a.text.slice(0, k);
          val.appendChild(caret);
          if (!(await this.sleep(T.char, gen))) return false;
        }
        if (!(await this.sleep(320, gen))) return false;
        caret.remove();
      }
      return true;
    }
    if (a.tap) {
      if (!(await this.tap(a, gen))) return false;
      return this.sleep(a.fast ? T.fastAfter : T.after, gen);
    }
    if (a.drag) return this.drag(a, gen);
    if (a.mark) { this.applyState(a); return this.sleep(420, gen); }
    if (a.wait) return this.sleep(a.wait, gen);
    return true;
  }

  async run(from, firstRendered = false) {
    const gen = ++this.gen;
    let i = from;
    let first = firstRendered;
    for (;;) {
      if (!first) this.enter(i); else { this.caption(i, true); first = false; }
      if (!(await this.sleep(T.enter + T.settle, gen))) return;
      for (const a of this.frames[i].acts || []) {
        if (!(await this.act(a, gen))) return;
      }
      if (i === this.frames.length - 1) {
        if (!(await this.sleep(T.end, gen))) return;
        this.touch.classList.remove('on');
        // С начала: экран гаснет и собирается заново.
        this.screen.querySelectorAll('.gx-layer').forEach((l) => l.classList.add('out-fade'));
        if (!(await this.sleep(320, gen))) return;
        this.render(0);
        this.screen.querySelectorAll('.gx-layer').forEach((l) => { l.style.animation = ''; l.classList.add('in-fade'); });
        i = 0;
        first = true;
      } else {
        i += 1;
      }
    }
  }

  jump(i) {
    this.gen++;
    this.onResume = null;
    this.render(i);
    this.started = this.playing;
    if (this.playing) this.run(i, true);
    else this.pointAt(this.frames[i]);
  }
}

const players = new Map();

// Кабинет перерисовывает вкладку целиком — проигрыватели снятых со
// страницы иллюстраций освобождаем при следующем запуске.
function sweep() {
  for (const [fig, p] of players) if (!fig.isConnected) { p.destroy(); players.delete(fig); }
}

// Экран кабинета в иллюстрации — в теме сайта, и меняется вместе с ней.
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.querySelectorAll('.gx-screen.web, .gx-screen.webm').forEach((el) => el.classList.toggle('dark', dark));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/** Запустить иллюстрацию в <figure class="gx" data-scene="…">. */
export function mountScene(fig) {
  sweep();
  if (!fig || players.has(fig)) return;
  const scene = SCENES[fig.dataset.scene];
  if (!scene || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
  players.set(fig, new Player(fig, scene));
}

/** Остановить и освободить (статья свернулась). */
export function unmountScene(fig) {
  const p = fig && players.get(fig);
  if (!p) return;
  p.destroy();
  players.delete(fig);
}

export const hasScene = (id) => Boolean(id && SCENES[id]);

/** Текст для экрана: названия кнопок и разделов в «ёлочках» — жирным, без кавычек. */
export function uiText(s) {
  let out = String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Изнутри наружу: «Открыть «Склад»» — сперва «Склад».
  for (let prev = ''; prev !== out;) {
    prev = out;
    // Короткое название не рвём на строки («Тайм-кафе» не делится по дефису).
    out = out.replace(/«([^«»]+)»/g, (_, t) => `<b class="gx-ui${t.length <= 18 ? ' nw' : ''}">${t}</b>`);
  }
  return out;
}
export const isWideScene = (id) => Boolean(id && SCENES[id] && (['web', 'windows'].includes(SCENES[id].device) || deviceChoice() === 'tablet'));
