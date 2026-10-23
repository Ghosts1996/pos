// Чат поддержки: круглая кнопка в углу и небольшое окно с ИИ-ассистентом.
// Один на весь сайт, режим задаёт console.js (setContext):
//  • site — посетитель сайта или вошедший без своего заведения: продукт,
//    тарифы, демо, регистрация. Пишет без входа: сервер обезличивает текст
//    (152-ФЗ), диалог держится на токене в localStorage этого браузера;
//  • cabinet — владелец или администратор в кабинете: обращение заведения,
//    ИИ видит его состояние и раздел, где человек сейчас; то же обращение
//    видно в кабинете → «Поддержка»;
//  • hidden — не показываем (страница «Поддержка», панель платформы, печать).
// Ответ специалиста из Telegram приходит в это же окно.

const SITE_KEY = 'zalposSiteChat_v1';
const CAB_KEY = (tenantId) => `zalposCabChat_v1_${tenantId}`;
// Постоянный случайный ключ браузера (не диалога): по нему сотрудники видят
// «Гость 4821» и в новом диалоге того же человека. Имени не спрашиваем — в
// Telegram сотрудникам персональные данные не уходят.
const VISITOR_KEY = 'zalposSiteVisitor_v1';
function visitorKey() {
  try {
    let v = window.localStorage.getItem(VISITOR_KEY) || '';
    if (!/^[\w-]{20,80}$/.test(v)) {
      const b = new Uint8Array(24);
      crypto.getRandomValues(b);
      v = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      window.localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch (_) {
    return '';
  }
}

const ICON = {
  // Гарнитура: дуга, амбушюры и микрофон — как у служб поддержки.
  headset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 13.25V12a7.25 7.25 0 0 1 14.5 0v1.25"/><rect x="3.5" y="12.75" width="3.75" height="6" rx="1.6"/><rect x="16.75" y="12.75" width="3.75" height="6" rx="1.6"/><path d="M18.6 18.75v.35a2.4 2.4 0 0 1-2.4 2.4h-2.45"/><rect x="10.25" y="20.35" width="3.5" height="2.3" rx="1.15" class="sc-fill"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.75V8.5h3.75"/></svg>',
};

const TEXT = {
  site: {
    welcome: 'Здравствуйте! Я ИИ-ассистент ZalPOS: расскажу, что умеет касса, помогу выбрать тариф, '
      + 'попробовать демо и начать.\n\n' + 'Я знаю продукт так же, как специалисты поддержки, и отвечу сразу. Специалист-человек отвечает в течение 24 часов — позвать его можно словом «оператор».',
    status: 'ИИ-ассистент · отвечает сразу',
    suggest: ['Сколько стоит?', 'Какой тариф мне подойдёт?', 'Почему ZalPOS?', 'Демо без регистрации', 'Как начать работу?'],
    legal: 'Отвечает ИИ-ассистент. Телефон и имя писать не нужно.',
  },
  account: {
    welcome: 'Здравствуйте! Я ИИ-ассистент ZalPOS. Помогу создать заведение, выбрать тариф и пройти '
      + 'первые шаги.\n\n' + 'Я знаю продукт так же, как специалисты поддержки, и отвечу сразу. Специалист-человек отвечает в течение 24 часов — позвать его можно словом «оператор».',
    status: 'ИИ-ассистент · отвечает сразу',
    suggest: ['Как создать заведение?', 'С чего начать настройку?', 'Какой тариф мне подойдёт?', 'Как поставить кассу?'],
    legal: 'Отвечает ИИ-ассистент. Телефон и имя писать не нужно.',
  },
  member: {
    welcome: 'Здравствуйте! Я ИИ-ассистент ZalPOS: подскажу, как работать в кассе и кабинете.\n\n' + 'Я знаю продукт так же, как специалисты поддержки, и отвечу сразу. Специалист-человек отвечает в течение 24 часов — позвать его можно словом «оператор».',
    status: 'ИИ-ассистент · отвечает сразу',
    suggest: ['Как открыть стол и принять заказ?', 'Как закрыть смену?', 'Как провести инвентаризацию?', 'Забыли PIN'],
    legal: 'Отвечает ИИ-ассистент. Пароли и коды из СМС не присылайте.',
  },
  cabinet: {
    welcome: 'Здравствуйте! Я ИИ-ассистент поддержки ZalPOS. Вижу, что уже настроено в вашем заведении, '
      + 'и подскажу шаги именно для него.\n\n' + 'Я знаю продукт так же, как специалисты поддержки, и отвечу сразу. Специалист-человек отвечает в течение 24 часов — позвать его можно словом «оператор».',
    status: 'ИИ-ассистент · видит ваше заведение',
    suggest: ['Что ещё настроить?', 'Подключить онлайн-кассу', 'Оплата картой и СБП', 'Склад и рецепты', 'Принтеры и бегунки'],
    legal: 'Отвечает ИИ-ассистент. Пароли, коды из СМС и данные карт не присылайте.',
  },
};

// Первая подсказка — по разделу, где человек сейчас.
const PAGE_SUGGEST = {
  'Устройства': 'Как поставить кассу на планшет?',
  'Брендинг': 'Как сменить логотип и цвета?',
  'Тарифы': 'Какой тариф мне подойдёт?',
  'Оплата': 'Как оплатить по счёту для ИП?',
  'Команда': 'Как добавить сотрудника?',
  'ИИ': 'Как подключить ИИ-помощника?',
  'Настройки': 'Как подключить Telegram-бота?',
  'Обзор': 'Что ещё настроить?',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Ссылка из ответа: страницы сайта — без перезагрузки (окно не закроется). */
function link(url) {
  const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
  let href = full;
  let same = false;
  try {
    const u = new URL(full);
    same = /(^|\.)zalpos\.ru$/.test(u.hostname) && u.hostname === location.hostname;
    if (same && u.hash.startsWith('#/') && (u.pathname === '/' || u.pathname === location.pathname)) href = u.hash;
  } catch (_) {}
  return `<a href="${esc(href)}"${same ? '' : ' target="_blank" rel="noopener"'}>${esc(url)}</a>`;
}

/** Текст ответа → HTML: **жирный**, ссылки, переносы строк. */
function richText(text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"«»]+[^\s<>"«».,;:!?)]|(?:[a-z0-9-]+\.)*zalpos\.ru(?:\/[^\s<>"«»]*[^\s<>"«».,;:!?)])?)/g);
  // Жирное — после ссылок: «**zalpos.ru**» тоже станет жирной ссылкой; лишние «**» не показываем.
  return parts.map((p, i) => (i % 2 ? link(p) : esc(p))).join('')
    .replace(/\*\*((?:(?!\*\*)[^\n]){1,200}?)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '')
    .replace(/\n/g, '<br>');
}

function load(key) {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || 'null');
    return v && v.ticketId ? v : null;
  } catch (_) {
    return null;
  }
}
function save(key, v) {
  try {
    if (v) window.localStorage.setItem(key, JSON.stringify(v));
    else window.localStorage.removeItem(key);
  } catch (_) {}
}

/**
 * Чат на странице. [getToken] — ID-токен вошедшего (или null).
 * Возвращает { setContext({ mode, tenantId, role, page }), destroy }.
 */
export function mountSupportChat({ gatewayUrl, getToken = async () => null, privacyHref = '#/legal/privacy', consentEdition = '' }) {
  if (!document.getElementById('sc-css')) {
    const l = document.createElement('link');
    l.id = 'sc-css';
    l.rel = 'stylesheet';
    l.href = 'support-chat.css';
    document.head.appendChild(l);
  }
  const root = document.createElement('div');
  root.id = 'sc-root';
  root.className = 'sc-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="sc-backdrop" id="sc-backdrop"></div>
    <section class="sc-panel" id="sc-panel" role="dialog" aria-modal="false" aria-labelledby="sc-title" hidden>
      <header class="sc-head">
        <span class="sc-avatar">${ICON.headset}</span>
        <div class="sc-head-text">
          <div class="sc-title" id="sc-title">Поддержка ZalPOS</div>
          <div class="sc-sub"><i class="sc-dot"></i><span id="sc-status"></span></div>
        </div>
        <button type="button" class="sc-icon-btn" id="sc-restart" title="Начать новый диалог" aria-label="Начать новый диалог">${ICON.restart}</button>
        <button type="button" class="sc-icon-btn" id="sc-close" title="Свернуть" aria-label="Свернуть чат">${ICON.close}</button>
      </header>
      <div class="sc-body" id="sc-body" aria-live="polite"></div>
      <form class="sc-compose" id="sc-form" autocomplete="off">
        <textarea id="sc-input" rows="1" maxlength="1000" placeholder="Напишите вопрос…" aria-label="Сообщение"></textarea>
        <button type="submit" class="sc-send" id="sc-send" aria-label="Отправить" disabled>${ICON.send}</button>
      </form>
      <p class="sc-legal"><span id="sc-legal"></span> Отправляя сообщение, вы соглашаетесь
        с <a href="${esc(privacyHref)}">политикой конфиденциальности</a>.</p>
    </section>
    <button type="button" class="sc-fab" id="sc-fab" aria-label="Открыть чат поддержки" aria-expanded="false" aria-controls="sc-panel">
      <span class="sc-fab-icon sc-fab-open">${ICON.headset}</span>
      <span class="sc-fab-icon sc-fab-close">${ICON.close}</span>
      <i class="sc-fab-badge" id="sc-badge" hidden></i>
    </button>
  `;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector(`#${id}`);
  const panel = $('sc-panel');
  const body = $('sc-body');
  const input = $('sc-input');
  const sendBtn = $('sc-send');
  const fab = $('sc-fab');

  let ctx = { mode: 'hidden', tenantId: '', role: '', page: '' };
  let kind = 'site'; // site | account | cabinet — тексты окна
  let key = SITE_KEY;
  let conv = null; // { ticketId, token?, last }
  let messages = [];
  let typing = false;
  let waitingHuman = false;
  let waitingAi = false;
  let error = '';
  let sending = false;
  let open = false;
  let timer = null;
  let waitSince = 0;
  let destroyed = false;
  let gen = 0; // смена режима: ответы старых запросов отбрасываем
  const enabled = {};

  const isCab = () => ctx.mode === 'cabinet';
  const api = async (path, data, { auth = false } = {}) => {
    const token = auth || ctx.mode !== 'cabinet' ? await getToken().catch(() => null) : null;
    const res = await fetch(`${gatewayUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data || {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((json && json.error) || 'Не получилось связаться с поддержкой — проверьте интернет');
      e.status = res.status;
      throw e;
    }
    return json || {};
  };
  const pollPath = () => (isCab() ? 'supportCabinetMessages' : 'supportSiteMessages');
  const pollBody = () => (isCab() ? { ticketId: conv.ticketId, after: conv.last || 0 } : { ticketId: conv.ticketId, token: conv.token, after: conv.last || 0 });

  let lastHtml = '';
  let stick = false; // после своего сообщения — всегда вниз
  /** Перерисовка только при изменениях: иначе опрос раз в несколько секунд
   *  дёргал бы окно и сбивал прокрутку. Вниз — только если человек и так
   *  внизу (или сам отправил сообщение); читает выше — не мешаем. */
  function render() {
    const T = TEXT[kind];
    const rows = [`<div class="sc-msg sc-ai"><div class="sc-bubble">${richText(T.welcome)}</div></div>`];
    if (!messages.length) {
      const first = PAGE_SUGGEST[ctx.page];
      const list = [...new Set([...(first && isCab() ? [first] : []), ...T.suggest])].slice(0, 5);
      rows.push(`<div class="sc-chips">${list.map((s) => `<button type="button" class="sc-chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`);
    }
    for (const m of messages) {
      const label = m.role === 'staff' ? '<div class="sc-who">Специалист поддержки</div>' : '';
      rows.push(`<div class="sc-msg sc-${m.role === 'you' ? 'you' : m.role}">${label}<div class="sc-bubble">${richText(m.text)}</div></div>`);
    }
    if (typing || waitingAi) rows.push('<div class="sc-msg sc-ai"><div class="sc-bubble sc-typing" aria-label="Ассистент печатает"><i></i><i></i><i></i></div></div>');
    if (error) rows.push(`<div class="sc-error">${esc(error)}</div>`);
    const html = rows.join('');
    if (html !== lastHtml) {
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 72;
      const keep = body.scrollTop;
      body.innerHTML = html;
      lastHtml = html;
      body.querySelectorAll('.sc-chip').forEach((b) => { b.onclick = () => send(b.dataset.q); });
      body.scrollTop = nearBottom || stick ? body.scrollHeight : keep;
      stick = false;
    }
    $('sc-status').textContent = waitingHuman ? 'Специалист ответит здесь' : T.status;
    $('sc-legal').textContent = T.legal;
    $('sc-restart').hidden = !conv;
    sendBtn.disabled = sending || !input.value.trim();
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed || !conv || ctx.mode === 'hidden') return;
    // Ждём ответ — опрашиваем часто; окно открыто — реже; свёрнуто — только
    // если ждём специалиста.
    const fast = waitingAi && Date.now() - waitSince < 120000;
    const ms = fast ? 1500 : open ? 6000 : (waitingHuman ? 20000 : 0);
    if (ms) timer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!conv || destroyed) return;
    const my = gen;
    try {
      const r = await api(pollPath(), pollBody(), { auth: isCab() });
      if (my !== gen) return;
      if (r.gone) {
        conv = null;
        save(key, null);
        messages = [];
        waitingAi = false;
      } else {
        const fresh = r.messages || [];
        for (const m of fresh) {
          // Своё сообщение уже на экране с момента отправки.
          const mine = m.role === 'you' && messages.find((x) => x.local && x.role === 'you' && x.text.trim() === m.text.trim());
          if (mine) { Object.assign(mine, m, { local: false }); continue; }
          if (messages.some((x) => !x.local && x.at === m.at && x.text === m.text)) continue;
          messages.push(m);
          if (m.role !== 'you') {
            waitingAi = false;
            if (!open) $('sc-badge').hidden = false;
          }
        }
        if (fresh.length) {
          conv.last = Math.max(conv.last || 0, ...fresh.map((m) => m.at || 0));
          save(key, conv);
        }
        typing = !!r.typing;
        waitingHuman = !!r.waitingHuman;
        if (waitingAi && Date.now() - waitSince > 120000) waitingAi = false;
      }
      error = '';
    } catch (e) {
      if (my !== gen) return;
      if (e.status === 401 || e.status === 403 || e.status === 404) { conv = null; save(key, null); messages = []; waitingAi = false; }
    }
    render();
    schedule();
  }

  async function send(raw) {
    const text = String(raw || '').trim();
    if (!text || sending || ctx.mode === 'hidden') return;
    const my = gen;
    sending = true;
    error = '';
    messages.push({ role: 'you', text, at: Date.now(), local: true });
    stick = true;
    input.value = '';
    autosize();
    waitingAi = true;
    waitSince = Date.now();
    render();
    try {
      let r;
      if (isCab()) {
        r = await api('supportSend', conv
          ? { ticketId: conv.ticketId, text, page: ctx.page }
          : { tenantId: ctx.tenantId, text, source: 'widget', consent: true, consentEdition, page: ctx.page }, { auth: true });
        if (!conv && r.ticketId) conv = { ticketId: r.ticketId, last: 0 };
      } else {
        r = await api('supportSiteSend', conv
          ? { ticketId: conv.ticketId, token: conv.token, text, page: ctx.page }
          : { text, consent: true, consentEdition, page: ctx.page, role: ctx.role, visitor: visitorKey() });
        if (r.token) conv = { ticketId: r.ticketId, token: r.token, last: 0 };
      }
      if (my !== gen) return;
      save(key, conv);
      if (r.masked) messages.push({ role: 'ai', text: 'Телефон, почту и имена я скрыл — для помощи они не нужны.', at: Date.now(), local: true });
    } catch (e) {
      if (my !== gen) return;
      waitingAi = false;
      messages = messages.filter((m) => !(m.local && m.role === 'you' && m.text === text));
      input.value = text;
      error = e.message;
    }
    sending = false;
    render();
    schedule();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  function setOpen(v) {
    open = v;
    panel.hidden = !v;
    root.classList.toggle('sc-open', v);
    fab.setAttribute('aria-expanded', String(v));
    fab.setAttribute('aria-label', v ? 'Свернуть чат поддержки' : 'Открыть чат поддержки');
    if (v) {
      $('sc-badge').hidden = true;
      stick = true;
      lastHtml = '';
      render();
      if (conv && !messages.length) poll();
      else schedule();
      if (window.matchMedia('(min-width: 600px)').matches) setTimeout(() => input.focus(), 60);
    } else {
      schedule();
    }
  }

  async function checkEnabled(mode) {
    if (enabled[mode] !== undefined) return enabled[mode];
    try {
      const r = await api(mode === 'cabinet' ? 'supportCabinetMessages' : 'supportSiteMessages', {}, { auth: mode === 'cabinet' });
      enabled[mode] = !!r.enabled;
    } catch (_) {
      return false; // сеть — спросим в следующий раз
    }
    return enabled[mode];
  }

  /** Режим и раздел. Тот же режим и заведение — диалог продолжается. */
  async function setContext(next) {
    const n = { mode: 'site', tenantId: '', role: '', page: '', ...next };
    const same = n.mode === ctx.mode && n.tenantId === ctx.tenantId && n.role === ctx.role;
    ctx = n;
    if (same) return;
    gen++;
    clearTimeout(timer);
    if (n.mode === 'hidden') {
      setOpen(false);
      root.hidden = true;
      document.body.classList.remove('has-sc');
      return;
    }
    kind = n.mode === 'cabinet' ? 'cabinet' : n.role === 'account' ? 'account' : n.role ? 'member' : 'site';
    key = n.mode === 'cabinet' ? CAB_KEY(n.tenantId) : SITE_KEY;
    conv = load(key);
    if (conv && n.mode !== 'cabinet' && !conv.token) conv = null;
    messages = [];
    typing = waitingHuman = waitingAi = false;
    error = '';
    render();
    const my = gen;
    const ok = await checkEnabled(n.mode);
    if (my !== gen || destroyed) return;
    root.hidden = !ok;
    document.body.classList.toggle('has-sc', ok);
    if (!ok) return;
    requestAnimationFrame(() => root.classList.add('sc-ready'));
    if (conv) poll();
  }

  fab.onclick = () => setOpen(!open);
  $('sc-close').onclick = () => setOpen(false);
  $('sc-backdrop').onclick = () => setOpen(false);
  $('sc-restart').onclick = () => {
    gen++;
    conv = null;
    save(key, null);
    messages = [];
    waitingAi = waitingHuman = typing = false;
    error = '';
    render();
    input.focus();
  };
  $('sc-form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  input.addEventListener('input', () => { autosize(); sendBtn.disabled = sending || !input.value.trim(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  const onKey = (e) => { if (e.key === 'Escape' && open) setOpen(false); };
  document.addEventListener('keydown', onKey);

  return {
    setContext,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-sc');
      root.remove();
    },
  };
}
