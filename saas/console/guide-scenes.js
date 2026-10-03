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

function appBar({ title, sub = '', left = 'menu', right = [], tapLeft = '', tapRight = {} }) {
  return `<div class="gx-bar">
    <div class="gx-bar-btn"${tp(tapLeft)}>${ic(left === 'menu' ? 'menu' : 'back', 24)}</div>
    <div class="gx-bar-title"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
    ${right.map((r) => `<div class="gx-bar-btn"${tp(tapRight[r])}>${ic(r, 22)}</div>`).join('')}
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

function hall({ who = 'Алина', tapTable = '', tapMenu = '', tapBanner = '', tables = HALL } = {}) {
  return `<div class="gx-app">${status()}
    ${appBar({ title: 'Зал', sub: who, left: 'menu', right: ['map', 'spark'], tapLeft: tapMenu })}
    <div class="gx-banner">${ic('bell', 17)}<span>Гости зовут: 3 · ждут 3 мин</span><span class="gx-mu"${tp(tapBanner)}>Показать ›</span></div>
    <div class="gx-chips"><span class="gx-chip on">${ic('check', 14, 2.2)} Все зоны</span><span class="gx-chip">Основной зал</span><span class="gx-chip">2 этаж</span><span class="gx-chip">Терраса</span></div>
    <div class="gx-chips"><span class="gx-chip on">Все 27</span><span class="gx-chip"><span class="dot" style="background:var(--ok)"></span>Свободны 19</span><span class="gx-chip"><span class="dot" style="background:var(--busy)"></span>Заняты 8</span></div>
    <div class="gx-h">Основной зал · 11</div>
    <div class="gx-tables">${tables.map((t) => tableCard(t, { tap: t.n === tapTable ? 'table' : '' })).join('')}</div>
  </div>`;
}

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
function tableCheck({ name = 'Стол 2', who = 'Алина', items = [], total = '0 ₽', tap = {} } = {}) {
  const list = items.length
    ? `<div class="gx-card" style="margin:0 14px">${items.map((i) => `<div class="gx-row"${mk(i.mark)}>
        <div class="gx-row-t"><b>${i.n}</b><span>${i.p} × ${i.q}</span></div>
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

function payment({ total = '1 420', tap = {} } = {}) {
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
    ${sw('Закрыть без оплаты', '')}${sw('Распечатать чек', 'print')}</div>
    <div class="gx-bottom">${btn('Оплатить', { tap: 'pay' })}</div></div>`;
}

/* ---- Админ ---- */
const ADMIN_TILES = [
  ['chart', 'Отчёты'], ['map', 'Карта зала'], ['timer', 'Длительность сеанса'], ['fork', 'Меню'],
  ['box', 'Склад'], ['users', 'Сотрудники'], ['timer', 'Смены сотрудников'], ['wallet', 'Зарплата'],
];

function adminHome({ tap = '' } = {}) {
  return `<div class="gx-app">${status()}
    <div class="gx-bar" style="padding-left:16px"><div class="gx-bar-title"><b style="font-size:17px">Админ · Ольга</b></div>
      <div class="gx-bar-btn">${ic('dl', 20)}</div><div class="gx-bar-btn">${ic('logout', 20)}</div></div>
    <div class="gx-h" style="color:var(--tx);font-size:14px">Работа заведения</div>
    <div class="gx-tiles" style="gap:10px">${ADMIN_TILES.map(([icn, t]) => `<div class="gx-card" style="height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px"${tp(t === tap ? 'tile' : '')}>
      ${ic(icn, 24)}<span style="font-size:13px;font-weight:500">${t}</span></div>`).join('')}</div></div>`;
}

const switchRow = (t, s, { on = false, tap = '', mark = '' } = {}) =>
  `<div class="${cls(on && 'on')}" style="display:flex;align-items:flex-start;gap:12px;padding:12px 0"${mk(mark)}>
    <div style="flex:1"><b style="display:block;font-size:14.5px">${t}</b>${s ? `<span class="gx-mu" style="font-size:12px;line-height:1.35">${s}</span>` : ''}</div>
    <span class="gx-sw"${tp(tap)}></span></div>`;

/* ---- Кабинет (браузер) ---- */
const WEB_NAV = [['grid', 'Обзор'], ['phone', 'Устройства'], ['palette', 'Брендинг'], ['users', 'Команда'], ['card', 'Оплата'], ['doc', 'Инструкция']];
function web(active, main, { tap = {} } = {}) {
  return `<div class="gx-web"><div class="gx-web-nav"><div class="gx-web-brand">Zal<em>POS</em></div>
    ${WEB_NAV.map(([icn, t]) => `<div class="${cls('gx-web-ni', t === active && 'on')}"${tp(tap[t])}>${ic(icn, 18)}${t}</div>`).join('')}</div>
    <div class="gx-web-main">${main}</div></div>`;
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

function printerSettings() {
  return `<div class="gx-app">${status()}${appBar({ title: 'Интеграции', left: 'back' })}<div style="padding:0 14px">
    <div class="gx-card" style="padding:14px">
      <b style="display:flex;align-items:center;gap:8px;font-size:16px"><span class="gx-brass">${ic('printer', 19)}</span>Чековый принтер</b>
      <div class="gx-mu" style="font-size:11.5px;margin:4px 0 12px">Печатается информационный чек (не фискальный).</div>
      <div class="gx-seg2" style="width:100%;height:38px;margin-bottom:12px"><span>Не подключён</span><span class="on">Bluetooth</span><span>Wi‑Fi / LAN</span></div>
      <div style="display:flex;align-items:center;gap:10px;font-size:13.5px;margin-bottom:6px"><span class="gx-brass">${ic('printer', 17)}</span><span style="flex:1">XP-58 · подключён</span><span style="color:#D98A5C;font-size:12.5px">Выбрать устройство</span></div>
      ${switchRow('Кальяны — отдельным чеком', 'Если в счёте есть кальяны и что-то ещё, печатаются два чека: «Кальяны» и «Кухня и бар», каждый со своим итогом.', { tap: 'split', mark: 'split' })}
      ${btn('Тестовая печать', { kind: 'ghost sm', icon: 'printer', style: 'margin-top:6px' })}</div></div></div>`;
}

const slip = (title, lines, total, note, delay) => `<div class="gx-slip" style="animation-delay:${delay}ms">
  <div style="text-align:center;font-weight:700;font-size:14px">КАФЕ «ЛЕТО»</div>
  <div style="text-align:center;font-weight:700;font-size:13px;margin:2px 0 6px">${title}</div>
  <div style="text-align:center;font-size:11px">Стол: Стол 2 · Официант: Алина</div>
  <div class="gx-slip-hr"></div>${lines.map(([n, v]) => `<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:1px 0"><span>${n}</span><span>${v}</span></div>`).join('')}
  <div class="gx-slip-hr"></div><div style="display:flex;justify-content:space-between;font-weight:700;font-size:13px"><span>ИТОГО</span><span>${total}</span></div>
  ${note ? `<div style="text-align:center;font-size:10.5px;margin-top:6px">${note}</div>` : ''}</div>`;

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

/* ---- Кабинет ---- */
function webDevices() {
  return web('Устройства', `<h3>Устройства</h3><div style="color:var(--mu);font-size:14px">Код приглашения, сборка касс и приложения гостей</div>
    <div class="gx-web-card"><h5>Сборка APK</h5><div style="color:var(--mu);font-size:13px;line-height:1.5;margin-bottom:14px;max-width:560px">Одна кнопка — сразу три личных приложения этого заведения: касса для Android-планшета, касса для Windows и гостевое приложение.</div>
      <div style="display:flex;align-items:center;gap:16px"><div class="gx-web-btn ghost"${tp('build')}><span class="gx-show"${mk('q')}>Собрать APK</span><span class="gx-alt"${mk('q')}><span class="gx-show"${mk('done')}>Сборка уже идёт…</span><span class="gx-alt"${mk('done')}>Собрать APK</span></span></div>
      <div class="gx-show"${mk('done')}><div class="gx-hide"${mk('q')} style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--mu)"><div class="gx-prog"><i${mk('q')}></i></div>собираем, это займёт минут 10</div></div></div>
      <div style="margin-top:16px">
        ${[['Касса', 'b1'], ['Касса (Windows)', 'b2'], ['Гостевое приложение', 'b3']].map(([n, k]) => `<div class="gx-web-row"><span style="flex:1;color:var(--mu)">${n} · сегодня, 19:42 · <span class="gx-show"${mk('done')}>в очереди</span><span class="gx-alt"${mk('done')}>готова</span></span><span class="gx-web-link gx-hide"${mk('done')}${tp(k === 'b1' ? 'dl' : '')}>Скачать</span></div>`).join('')}
      </div></div>`);
}

function webBranding() {
  const sw = (a, b, on, k) => `<div style="width:54px;height:54px;border-radius:14px;padding:4px;border:2px solid ${on ? 'var(--pr)' : 'transparent'}"${tp(k)}${mk(k)}><div style="width:100%;height:100%;border-radius:10px;background:linear-gradient(135deg,${a} 50%,${b} 50%)"></div></div>`;
  return web('Брендинг', `<h3>Брендинг</h3><div style="color:var(--mu);font-size:14px">Название, логотип и цвета — для приложения гостей и веб-меню</div>
    <div style="display:flex;gap:28px;margin-top:16px"><div class="gx-web-card" style="flex:1;margin:0">
      <div style="font-size:13px;color:var(--mu);margin-bottom:6px">Имя приложения</div>
      <div style="height:42px;border:1px solid var(--bd);border-radius:10px;display:flex;align-items:center;padding:0 12px;font-size:14px;margin-bottom:14px;background:var(--bg)">Кафе «Лето»</div>
      <div style="font-size:13px;color:var(--mu);margin-bottom:8px">Цвета</div>
      <div style="display:flex;gap:6px">${sw('#A4502A', '#1D1A16', true)}${sw('#2F6B4F', '#14201A', false, 'sage')}${sw('#3D5A80', '#121A24', false)}${sw('#8E3B5B', '#211219', false)}</div>
      <div class="gx-web-btn" style="margin-top:18px"${tp('save')}>Сохранить брендинг</div></div>
      <div style="width:190px;flex:none;border-radius:22px;background:#15120F;padding:16px 14px;color:#F2EADF;box-shadow:0 18px 40px -20px rgba(0,0,0,.5)">
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
const startDialog = (since = '17:40') => dialog('Начать вашу смену?',
  `<p>Смена заведения открыта в ${since}.<br>Начните смену, если вы сейчас работаете: вызовы гостей будут приходить и вам, а время посчитается в зарплату.</p>`,
  `${btn('Не сейчас', { kind: 'text' })}${btn('Начать смену', { kind: 'sm', tap: 'go' })}`);

export const SCENES = {
  login: {
    label: 'Вход в кассу по PIN',
    frames: [
      { screen: pinScreen(), cap: 'Наберите свой PIN — четыре цифры. Администратор сначала нажимает «Администратор», у него шесть цифр.', acts: DIGITS('2580') },
      { screen: pinScreen(), over: { kind: 'dialog', html: startDialog() }, cap: 'Касса спросит про смену. Вы на работе — «Начать смену».', acts: [{ tap: 'go' }] },
      { screen: hall(), enter: 'fade', over: { kind: 'toast', html: toast('Ваша смена началась') }, cap: 'Готово: открылся зал, рабочее время пошло.', acts: [{ wait: 1300 }] },
    ],
  },

  shift: {
    label: 'Начать и закончить свою смену',
    frames: [
      { screen: hall({ tapMenu: 'menu' }), cap: 'Откройте меню — кнопка ☰ слева вверху.', acts: [{ tap: 'menu' }] },
      { screen: hall(), over: { kind: 'drawer', html: drawer({ shift: 'off', tap: { my: 'my' } }) }, cap: 'Нажмите «Моя смена не начата».', acts: [{ tap: 'my' }] },
      { screen: hall(), over: { kind: 'dialog', html: startDialog() }, cap: 'Подтвердите — «Начать смену».', acts: [{ tap: 'go' }] },
      { screen: hall(), over: { kind: 'drawer', html: drawer({ shift: 'on', since: '18:02', tap: { my: 'my' } }) }, cap: 'Смена идёт. Уходя домой, нажмите сюда же — «Моя смена идёт».', acts: [{ wait: 900 }, { tap: 'my' }] },
      {
        screen: hall(), over: { kind: 'dialog', html: dialog('Закончить вашу смену?', '<p>Смена началась в 18:02 · отработано 8 ч 10 мин.<br>Смена заведения продолжается — их касса, X-отчёт и вызовы гостей не изменятся.</p>', `${btn('Отмена', { kind: 'text' })}${btn('Закончить смену', { kind: 'sm', tap: 'end' })}`) },
        cap: '«Закончить смену» — время ухода касса запишет сама.', acts: [{ tap: 'end' }],
      },
      { screen: hall(), over: { kind: 'toast', html: toast('Смена закончена. Смена заведения продолжается') }, cap: 'Часы попали в табель и в зарплату.', acts: [{ wait: 1400 }] },
    ],
  },

  'open-table': {
    label: 'Открыть стол',
    frames: [
      { screen: hall({ tapTable: 'Стол 2' }), cap: 'Нажмите на свободный стол — с зелёной точкой и надписью «Свободен».', acts: [{ tap: 'table' }] },
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
      { screen: bookingsScreen(), cap: 'Гость пришёл — «Посадить».', acts: [{ wait: 500 }, { tap: 'seat' }] },
      { screen: tableCheck({ name: 'Стол 6', who: 'Алина' }), enter: 'push', over: { kind: 'toast', html: toast('Гость посажен, чек открыт') }, cap: 'Стол занят, счёт открыт — дальше как обычно.', acts: [{ wait: 1600 }] },
    ],
  },

  'close-venue': {
    label: 'Закрыть смену заведения',
    frames: [
      { screen: hall(), over: { kind: 'drawer', html: drawer({ tap: { venue: 'venue' } }) }, cap: 'В конце дня: меню ☰ → «Смена заведения открыта».', acts: [{ tap: 'venue' }] },
      { screen: hall(), over: { kind: 'sheet', html: venueSheet }, cap: 'Видно, кто ещё на смене. Нажмите «Закрыть смену заведения».', acts: [{ wait: 700 }, { tap: 'closev' }] },
      { screen: hall(), over: { kind: 'dialog', html: closeDialog() }, cap: 'Пересчитайте наличные в ящике и впишите сумму. Касса сравнит её с «Должно быть в кассе».', acts: [{ type: 'cnt', text: '12580' }, { mark: 'ok' }, { wait: 900 }] },
      { screen: hall(), over: { kind: 'dialog', html: closeDialog() }, cap: 'Сколько оставить на размен, решаете вы, остальное — инкассация. «Закрыть смену».', acts: [{ tap: 'done' }] },
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
      { screen: payForm(), cap: 'Бармену — процент «С бара и напитков». Кальянщику — «С кальянов», официанту — «С чеков, которые он вёл».', acts: [{ type: 'bar', text: '5' }, { wait: 400 }, { tap: 'save' }] },
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
    label: 'Кальяны — отдельным чеком',
    frames: [
      { screen: printerSettings(), cap: 'Админ → «Интеграции» → «Чековый принтер». Включите «Кальяны — отдельным чеком».', acts: [{ wait: 600 }, { tap: 'split', mark: 'split' }, { wait: 500 }] },
      { screen: payment(), enter: 'push', cap: 'Теперь при оплате с включённым «Распечатать чек»…', acts: [{ tap: 'print', mark: 'print' }, { tap: 'pay' }] },
      { screen: payment(), over: { kind: 'slips', html: receipts }, cap: '…принтер выдаст два чека: «Кальяны» и «Кухня и бар», у каждого свой итог.', acts: [{ wait: 2600 }] },
    ],
  },

  'hall-edit': {
    label: 'Добавить стол на карту зала',
    frames: [
      { screen: hallEditor(), cap: 'Админ → «Карта зала». Нажмите «Стол» внизу справа.', acts: [{ wait: 500 }, { tap: 'add' }] },
      { screen: hallEditor(), over: { kind: 'dialog', html: newTableDialog }, cap: 'Название, сколько мест и форма — «Сохранить».', acts: [{ type: 'tname', text: 'Стол 12' }, { tap: 'save' }] },
      { screen: hallEditor(), cap: 'Стол появился. Удерживайте его и тяните на место — схема сразу обновится на всех кассах и у гостей.', acts: [{ mark: 'newt' }, { wait: 500 }, { drag: 'drag', dx: -40, dy: -70 }, { wait: 1200 }] },
    ],
  },

  devices: {
    label: 'Собрать и скачать кассу',
    device: 'web',
    frames: [
      { screen: webDevices(), cap: 'Кабинет → «Устройства» → «Собрать APK».', acts: [{ wait: 500 }, { tap: 'build', mark: 'q' }] },
      { screen: webDevices(), cap: 'Сборка идёт около 10 минут, страницу можно закрыть — придёт уведомление.', acts: [{ wait: 2200 }, { mark: 'done' }] },
      { screen: webDevices(), cap: 'Нажмите «Скачать» на том устройстве, где будет касса, и откройте файл.', acts: [{ tap: 'dl' }, { wait: 1200 }] },
    ],
  },

  branding: {
    label: 'Цвета и название приложения гостя',
    device: 'web',
    frames: [
      { screen: webBranding(), cap: 'Кабинет → «Брендинг»: название, логотип и цвета приложения гостя.', acts: [{ wait: 600 }, { tap: 'sage', mark: 'sage' }] },
      { screen: webBranding(), cap: 'Справа сразу видно, как это будет выглядеть. «Сохранить брендинг».', acts: [{ wait: 900 }, { tap: 'save' }, { wait: 1200 }] },
    ],
  },
};

/* ------------------------------------------------------------------ *
 *  Проигрыватель
 * ------------------------------------------------------------------ */
const T = { enter: 520, settle: 420, move: 640, hl: 280, press: 340, after: 300, fastMove: 300, fastAfter: 120, char: 95, end: 2200, hold: 520, drag: 1000 };

function actTime(a) {
  if (a.tap) return (a.fast ? T.fastMove + T.fastAfter : T.move + T.hl + T.after) + T.press;
  if (a.type) return T.move + T.hl + T.press + a.text.length * T.char + 320;
  if (a.drag) return T.move + T.hold + T.drag + 60 + T.after;
  if (a.mark) return 420;
  if (a.wait) return a.wait;
  return 0;
}
const frameTime = (f, last) => T.enter + T.settle + (f.acts || []).reduce((s, a) => s + actTime(a), 0) + (last ? T.end : 0);

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const VIEW_W = { phone: 360, web: 960 };

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
    const web = scene.device === 'web';
    fig.innerHTML = `
      <div class="gx-stage">
        ${web
          ? `<div class="gx-browser" aria-hidden="true"><div class="gx-browser-bar"><i></i><i></i><i></i><span>zalpos.ru</span></div><div class="gx-screen web"></div></div>`
          : `<div class="gx-phone" aria-hidden="true"><div class="gx-screen"><div class="gx-island"></div></div></div>`}
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
    if (web && document.documentElement.dataset.theme === 'dark') this.screen.classList.add('dark');
    this.capN = fig.querySelector('.gx-cap-n');
    this.capT = fig.querySelector('.gx-cap-t');
    this.segs = [...fig.querySelectorAll('.gx-seg')];
    this.ppBtn = fig.querySelector('.gx-btn');
    this.touch = document.createElement('div');
    this.touch.className = 'gx-touch';
    this.screen.appendChild(this.touch);
    this.viewW = VIEW_W[web ? 'web' : 'phone'];

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
    for (const f of this.frames) { probe.textContent = f.cap || ''; h = Math.max(h, probe.offsetHeight); }
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
    // Сначала в верхнем слое (окно, меню), потом в экране под ним.
    const layers = [...this.screen.querySelectorAll('.gx-layer:not(.out):not(.out-push):not(.out-back):not(.out-fade)')].reverse();
    for (const l of layers) { const el = l.querySelector(sel); if (el) return el; }
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
      if (base) drop(base, kind === 'none' ? 'out' : `out-${kind}`, 520);
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
    this.capN.textContent = String(i + 1);
    this.capT.textContent = f.cap || '';
    if (animate) { this.capT.classList.remove('swap'); void this.capT.offsetWidth; this.capT.classList.add('swap'); }
    this.segs.forEach((s, j) => {
      s.classList.toggle('done', j < i);
      s.classList.remove('run');
      s.querySelector('i').style.removeProperty('--p');
    });
    const seg = this.segs[i];
    seg.style.setProperty('--d', `${frameTime(f, i === this.frames.length - 1)}ms`);
    if (animate) { void seg.offsetWidth; seg.classList.add('run'); } else seg.querySelector('i').style.setProperty('--p', '0');
  }

  pos(el) {
    const s = this.screen.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }

  moveTo(el) {
    const { x, y } = this.pos(el);
    this.touch.style.transform = `translate(${x}px, ${y}px)`;
    this.touch.classList.add('on');
    return { x, y };
  }

  // Статичная подсказка: палец над первой кнопкой кадра (без анимации).
  pointAt(f) {
    const a = (f.acts || []).find((x) => x.tap || x.type);
    const el = a && this.find(`[data-tap="${a.tap || a.type}"]`);
    if (!el) { this.touch.classList.remove('on'); return; }
    const prevT = this.touch.style.transition;
    this.touch.style.transition = 'none';
    this.moveTo(el);
    void this.touch.offsetWidth;
    this.touch.style.transition = prevT;
    el.classList.add('hl');
  }

  async tap(a, gen) {
    const el = this.find(`[data-tap="${a.tap || a.type}"]`);
    if (!el) return true;
    const { x, y } = this.moveTo(el);
    if (!(await this.sleep(a.fast ? T.fastMove : T.move, gen))) return false;
    if (!a.fast) {
      el.classList.add('hl');
      if (!(await this.sleep(T.hl, gen))) return false;
    }
    this.touch.classList.remove('press'); void this.touch.offsetWidth; this.touch.classList.add('press');
    const rip = document.createElement('div');
    rip.className = 'gx-ripple';
    rip.style.left = `${x}px`; rip.style.top = `${y}px`;
    this.screen.appendChild(rip);
    setTimeout(() => rip.remove(), 760);
    el.classList.add('pressed');
    if (!(await this.sleep(T.press, gen))) return false;
    el.classList.remove('pressed', 'hl');
    if (a.mark) this.applyState({ mark: a.mark });
    return true;
  }

  // Удерживать и тянуть: элемент едет вместе с пальцем.
  async drag(a, gen) {
    const el = this.find(`[data-tap="${a.drag}"]`);
    if (!el) return true;
    const { x, y } = this.moveTo(el);
    if (!(await this.sleep(T.move, gen))) return false;
    el.classList.add('hl');
    this.touch.classList.add('hold');
    if (!(await this.sleep(T.hold, gen))) return false;
    const k = this.screen.clientWidth / this.viewW;
    const ease = `transform ${T.drag}ms cubic-bezier(.45,.05,.2,1)`;
    el.classList.add('dragging');
    el.style.transition = ease;
    el.style.transform = `translate(${a.dx}px, ${a.dy}px)`;
    this.touch.style.transition = `${ease}, opacity .28s ease`;
    this.touch.style.transform = `translate(${x + a.dx * k}px, ${y + a.dy * k}px)`;
    const ok = await this.sleep(T.drag + 60, gen);
    this.touch.style.transition = '';
    this.touch.classList.remove('hold');
    el.classList.remove('hl', 'dragging');
    if (!ok) return false;
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
    document.querySelectorAll('.gx-screen.web').forEach((el) => el.classList.toggle('dark', dark));
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
export const isWideScene = (id) => Boolean(id && SCENES[id] && SCENES[id].device === 'web');
