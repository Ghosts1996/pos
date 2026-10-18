// Чат поддержки на сайте: круглая кнопка в углу и небольшое окно с
// ИИ-ассистентом. Посетитель пишет без входа: сервер обезличивает текст
// (152-ФЗ), отвечает ИИ, при необходимости подключается специалист —
// его ответ приходит сюда же. Диалог живёт в этом браузере (токен в
// localStorage), закрыли страницу — история вернётся при следующем открытии.

const STORE_KEY = 'zalposSiteChat_v1';
const CONSENT_EDITION = 'site-chat-2026-10';

const ICON = {
  // Гарнитура: дуга, амбушюры и микрофон — как у служб поддержки.
  headset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 13.25V12a7.25 7.25 0 0 1 14.5 0v1.25"/><rect x="3.5" y="12.75" width="3.75" height="6" rx="1.6"/><rect x="16.75" y="12.75" width="3.75" height="6" rx="1.6"/><path d="M18.6 18.75v.35a2.4 2.4 0 0 1-2.4 2.4h-2.45"/><rect x="10.25" y="20.35" width="3.5" height="2.3" rx="1.15" class="sc-fill"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.75V8.5h3.75"/></svg>',
};

const SUGGEST = [
  'Сколько стоит?',
  'Как попробовать бесплатно?',
  'Почему ZalPOS?',
  'Как поставить кассу?',
  'Приложение гостя и брендинг',
];

const WELCOME = 'Здравствуйте! Я ИИ-ассистент ZalPOS: помогу выбрать тариф, попробовать демо, '
  + 'поставить кассу и всё настроить. Нужен человек — напишите «оператор».';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Текст ответа → HTML: **жирный**, ссылки, переносы строк. */
function richText(text) {
  let h = esc(text);
  h = h.replace(/\*\*([^*\n]{1,120})\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)»])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/(^|[\s(«])((?:[a-z0-9-]+\.)*zalpos\.ru)(?![\w/])/g, '$1<a href="https://$2" target="_blank" rel="noopener">$2</a>');
  return h.replace(/\n/g, '<br>');
}

function loadState() {
  try {
    const v = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
    return v && v.ticketId && v.token ? v : null;
  } catch (_) {
    return null;
  }
}
function saveState(v) {
  try {
    if (v) window.localStorage.setItem(STORE_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(STORE_KEY);
  } catch (_) {}
}

/**
 * Показать чат на странице. Возвращает функцию, которая его убирает.
 * [gatewayUrl] — адрес сервера (saas-gateway).
 */
export function mountSupportChat({ gatewayUrl, privacyHref = '#/legal/privacy' }) {
  if (document.getElementById('sc-root')) return () => {};
  if (!document.getElementById('sc-css')) {
    const link = document.createElement('link');
    link.id = 'sc-css';
    link.rel = 'stylesheet';
    link.href = 'support-chat.css';
    document.head.appendChild(link);
  }

  const root = document.createElement('div');
  root.id = 'sc-root';
  root.className = 'sc-root';
  root.hidden = true; // покажем, когда сервер скажет, что чат работает
  root.innerHTML = `
    <div class="sc-backdrop" id="sc-backdrop"></div>
    <section class="sc-panel" id="sc-panel" role="dialog" aria-modal="false" aria-labelledby="sc-title" hidden>
      <header class="sc-head">
        <span class="sc-avatar">${ICON.headset}</span>
        <div class="sc-head-text">
          <div class="sc-title" id="sc-title">Поддержка ZalPOS</div>
          <div class="sc-sub"><i class="sc-dot"></i><span id="sc-status">ИИ-ассистент · отвечает сразу</span></div>
        </div>
        <button type="button" class="sc-icon-btn" id="sc-restart" title="Начать новый диалог" aria-label="Начать новый диалог">${ICON.restart}</button>
        <button type="button" class="sc-icon-btn" id="sc-close" title="Свернуть" aria-label="Свернуть чат">${ICON.close}</button>
      </header>
      <div class="sc-body" id="sc-body" aria-live="polite"></div>
      <form class="sc-compose" id="sc-form" autocomplete="off">
        <textarea id="sc-input" rows="1" maxlength="1000" placeholder="Напишите вопрос…" aria-label="Сообщение"></textarea>
        <button type="submit" class="sc-send" id="sc-send" aria-label="Отправить" disabled>${ICON.send}</button>
      </form>
      <p class="sc-legal">Отвечает ИИ-ассистент. Телефон и имя писать не нужно.
        Отправляя сообщение, вы соглашаетесь с <a href="${esc(privacyHref)}">политикой конфиденциальности</a>.</p>
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

  let conv = loadState(); // { ticketId, token, last }
  let messages = []; // { role: 'you'|'ai'|'staff', text, at }
  let typing = false;
  let waitingHuman = false;
  let waitingAi = false;
  let error = '';
  let sending = false;
  let open = false;
  let timer = null;
  let waitSince = 0;
  let destroyed = false;

  const api = async (path, data) => {
    const res = await fetch(`${gatewayUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  function render() {
    const rows = [];
    rows.push(`<div class="sc-msg sc-ai"><div class="sc-bubble">${richText(WELCOME)}</div></div>`);
    if (!messages.length) {
      rows.push(`<div class="sc-chips">${SUGGEST.map((s) => `<button type="button" class="sc-chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`);
    }
    for (const m of messages) {
      const label = m.role === 'staff' ? '<div class="sc-who">Специалист поддержки</div>' : '';
      rows.push(`<div class="sc-msg sc-${m.role === 'you' ? 'you' : m.role}">${label}<div class="sc-bubble">${richText(m.text)}</div></div>`);
    }
    if (typing || waitingAi) rows.push('<div class="sc-msg sc-ai"><div class="sc-bubble sc-typing" aria-label="Ассистент печатает"><i></i><i></i><i></i></div></div>');
    if (error) rows.push(`<div class="sc-error">${esc(error)}</div>`);
    body.innerHTML = rows.join('');
    body.querySelectorAll('.sc-chip').forEach((b) => { b.onclick = () => send(b.dataset.q); });
    body.scrollTop = body.scrollHeight;
    $('sc-status').textContent = waitingHuman ? 'Подключаем специалиста — ответ придёт сюда' : 'ИИ-ассистент · отвечает сразу';
    $('sc-restart').hidden = !conv;
    sendBtn.disabled = sending || !input.value.trim();
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed || !conv) return;
    // Ждём ответ — опрашиваем часто; просто открыт — реже; свёрнут — редко.
    const fast = waitingAi && Date.now() - waitSince < 120000;
    const ms = fast ? 1500 : open ? 6000 : (waitingHuman ? 20000 : 0);
    if (!ms) return;
    timer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!conv || destroyed) return;
    try {
      const r = await api('supportSiteMessages', { ticketId: conv.ticketId, token: conv.token, after: conv.last || 0 });
      if (r.gone) {
        conv = null;
        saveState(null);
        messages = [];
        waitingAi = false;
      } else {
        const fresh = r.messages || [];
        for (const m of fresh) {
          // Своё сообщение уже показали сразу при отправке.
          if (m.role === 'you' && messages.some((x) => x.role === 'you' && x.local && x.text.trim() === m.text.trim())) {
            const mine = messages.find((x) => x.role === 'you' && x.local && x.text.trim() === m.text.trim());
            Object.assign(mine, m, { local: false });
            continue;
          }
          messages.push(m);
          if (m.role !== 'you') waitingAi = false;
          if (m.role !== 'you' && !open) $('sc-badge').hidden = false;
        }
        if (fresh.length) {
          conv.last = Math.max(conv.last || 0, ...fresh.map((m) => m.at || 0));
          saveState(conv);
        }
        typing = !!r.typing;
        waitingHuman = !!r.waitingHuman;
        if (waitingAi && Date.now() - waitSince > 120000) waitingAi = false;
      }
      error = '';
    } catch (e) {
      if (e.status === 429) error = '';
    }
    render();
    schedule();
  }

  async function send(raw) {
    const text = String(raw || '').trim();
    if (!text || sending) return;
    sending = true;
    error = '';
    messages.push({ role: 'you', text, at: Date.now(), local: true });
    input.value = '';
    autosize();
    waitingAi = true;
    waitSince = Date.now();
    render();
    try {
      const r = await api('supportSiteSend', conv
        ? { ticketId: conv.ticketId, token: conv.token, text }
        : { text, consent: true, consentEdition: CONSENT_EDITION });
      if (r.token) conv = { ticketId: r.ticketId, token: r.token, last: 0 };
      saveState(conv);
      if (r.masked) {
        messages.push({ role: 'ai', text: 'Телефон, почту и имена я скрыл — для помощи они не нужны.', at: Date.now(), local: true, note: true });
      }
    } catch (e) {
      waitingAi = false;
      messages = messages.filter((m) => !(m.local && m.text === text));
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
      render();
      if (conv && !messages.length) poll();
      else schedule();
      if (window.matchMedia('(min-width: 600px)').matches) setTimeout(() => input.focus(), 60);
    } else {
      schedule();
    }
  }

  fab.onclick = () => setOpen(!open);
  $('sc-close').onclick = () => setOpen(false);
  $('sc-backdrop').onclick = () => setOpen(false);
  $('sc-restart').onclick = () => {
    conv = null;
    saveState(null);
    messages = [];
    waitingAi = false;
    waitingHuman = false;
    typing = false;
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

  // Показываем кнопку, только если чат на сервере включён.
  api('supportSiteMessages', {}).then((r) => {
    if (destroyed || !r.enabled) return;
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('sc-ready'));
    // Был незаконченный диалог и ждали специалиста — проверим ответ.
    if (conv) poll();
  }).catch(() => {});

  return () => {
    destroyed = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
    root.remove();
  };
}
