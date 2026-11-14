// Тейбл-тенты (настольные «домики») с QR стола — кабинет · «Брендинг».
//
// Лист A4 складывается пополам поперёк: верхняя половина повёрнута на 180°,
// и с обеих сторон стола видно одно и то же — логотип, название заведения,
// номер стола и QR. В QR — та же ссылка, что печатает касса
// (TableQrScreen.linkFor): https://<код>.zalpos.ru/table/<стол>?k=<секрет>.
// Без секрета стола гость не займёт чек (правило tableKeyOk), поэтому
// ссылка берётся только из tableKeys.
//
// PDF собирается здесь же, без библиотек: каждая страница — картинка JPEG
// (холст 150 dpi), вставленная на лист A4. Ничего не уходит на сервер.

export const A4_MM = { w: 210, h: 297 };
const MM_TO_PT = 72 / 25.4;

/** Ссылка стола — как у кассы (TableQrScreen.linkFor в SaaS). */
export function tableTentUrl({ slug, tenantId }, tableId, key = '') {
  const host = slug || tenantId;
  const k = key ? `?k=${encodeURIComponent(key)}` : '';
  return `https://${host}.zalpos.ru/table/${encodeURIComponent(tableId)}${k}`;
}

/**
 * Столы для печати: по имени «как люди считают» (Стол 2 < Стол 10),
 * только с секретом (без него наклейка не откроет счёт), без дублей.
 */
export function tentTables(tables, keys) {
  const seen = new Set();
  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  const out = [];
  const missing = [];
  for (const t of tables) {
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    const name = String(t.name || '').trim() || 'Стол';
    const key = keys[t.id] || '';
    if (!key) missing.push(name);
    else out.push({ id: t.id, name, key });
  }
  out.sort((a, b) => collator.compare(a.name, b.name));
  return { tables: out, missing };
}

/** Подпись стола крупно: «5» → «Стол 5», «Стол 5»/«VIP» — как есть. */
export function tentTitle(name) {
  const s = String(name || '').trim();
  return /^\d+[a-zа-я]?$/i.test(s) ? `Стол ${s}` : s || 'Стол';
}

function bytesOf(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** Размер JPEG (ширина/высота) из маркера SOF — для словаря картинки PDF. */
export function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  throw new Error('Это не JPEG');
}

/**
 * PDF: каждая страница — одна JPEG-картинка на весь лист.
 * @param {Uint8Array[]} jpegs
 * @param {{w:number,h:number}} pageMm
 * @param {string} title
 */
export function buildImagePdf(jpegs, pageMm = A4_MM, title = 'ZalPOS') {
  if (!jpegs.length) throw new Error('Нет страниц');
  const W = (pageMm.w * MM_TO_PT).toFixed(2);
  const H = (pageMm.h * MM_TO_PT).toFixed(2);
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (part) => {
    const b = typeof part === 'string' ? bytesOf(part) : part;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    for (const p of body) push(p);
    push('\nendobj\n');
  };
  // 1 — каталог, 2 — страницы, 3 — сведения; дальше по три объекта на страницу.
  const pageIds = jpegs.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Count ${jpegs.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`]);
  // Название — только латиница и цифры (строка PDF без перекодировки).
  const safeTitle = String(title).replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '') || 'ZalPOS';
  obj(3, [`<< /Title (${safeTitle}) /Producer (ZalPOS) >>`]);
  jpegs.forEach((jpg, i) => {
    const page = pageIds[i];
    const { w, h } = jpegSize(jpg);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(page, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`]);
    obj(page + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(page + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
  });
  const total = 4 + jpegs.length * 3;
  const xref = pos;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------- Рисование (только в браузере) ----------

function fitText(ctx, text, maxW, size, weight, family) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 10 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Цвет для текста на белом: слишком светлый фирменный цвет — тёмно-серый. */
export function inkColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#1F1F1F';
  const n = parseInt(m[1], 16);
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Контраст с белым ≥ 4.5 (WCAG AA) — иначе текст на бумаге не читается.
  return 1.05 / (L + 0.05) >= 4.5 ? `#${m[1]}` : '#1F1F1F';
}

/**
 * Половина домика: x0,y0 — левый верх, w×h — размер (в пикселях холста).
 * qr — матрица ZQR.matrix(url), logo — загруженная картинка или null.
 */
function drawHalf(ctx, { x0, y0, w, h, venue, title, qr, logo, accent, hint }) {
  const pad = Math.round(w * 0.06);
  const family = '"Inter", "Segoe UI", Roboto, Arial, sans-serif';
  // Полоса фирменного цвета внизу стороны (у стола).
  ctx.fillStyle = accent;
  ctx.fillRect(x0, y0 + h - Math.round(h * 0.035), w, Math.round(h * 0.035));
  // QR справа: квадрат ~45% ширины, с тихой зоной 4 модуля.
  const qrBox = Math.round(Math.min(w * 0.45, h * 0.78));
  const qx = x0 + w - pad - qrBox;
  const qy = y0 + Math.round((h - qrBox) / 2) - Math.round(h * 0.02);
  const n = qr.length;
  const cell = Math.floor(qrBox / (n + 8));
  const size = cell * (n + 8);
  const ox = qx + Math.round((qrBox - size) / 2);
  const oy = qy + Math.round((qrBox - size) / 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(ox, oy, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr[r][c]) ctx.fillRect(ox + (c + 4) * cell, oy + (r + 4) * cell, cell, cell);
  }
  // Слева: логотип, заведение, стол, подсказка.
  const leftW = qx - x0 - pad * 2;
  let y = y0 + pad;
  if (logo) {
    const lh = Math.round(h * 0.2);
    const lw = Math.min(leftW, Math.round((logo.width / logo.height) * lh));
    const realH = Math.round((logo.height / logo.width) * lw);
    ctx.drawImage(logo, x0 + pad, y, lw, realH);
    y += realH + Math.round(h * 0.05);
  }
  ctx.fillStyle = inkColor(accent);
  ctx.textBaseline = 'top';
  const vs = fitText(ctx, venue, leftW, Math.round(h * 0.075), 700, family);
  ctx.fillText(venue, x0 + pad, y);
  y += vs + Math.round(h * 0.035);
  ctx.fillStyle = '#111111';
  const ts = fitText(ctx, title, leftW, Math.round(h * 0.17), 800, family);
  ctx.fillText(title, x0 + pad, y);
  y += ts + Math.round(h * 0.05);
  ctx.fillStyle = '#444444';
  const hs = Math.round(h * 0.042);
  ctx.font = `500 ${hs}px ${family}`;
  // Перенос подсказки по словам.
  const words = hint.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > leftW && line) {
      ctx.fillText(line, x0 + pad, y);
      y += Math.round(hs * 1.3);
      line = word;
    } else line = test;
  }
  if (line) ctx.fillText(line, x0 + pad, y);
}

/**
 * Рисует один лист A4 (домик) на холсте и отдаёт JPEG-байты.
 * @param {{venue:string, table:{name:string,url:string}, qr:boolean[][], logo:?CanvasImageSource, accent:string, dpi?:number}} o
 */
export async function renderTentPage(o) {
  const dpi = o.dpi || 150;
  const W = Math.round((A4_MM.w / 25.4) * dpi);
  const H = Math.round((A4_MM.h / 25.4) * dpi);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  const half = Math.round(H / 2);
  const opts = {
    w: W, h: half, venue: o.venue, title: tentTitle(o.table.name), qr: o.qr, logo: o.logo, accent: o.accent,
    hint: 'Наведите камеру телефона: меню, заказ, вызов официанта и счёт',
  };
  // Нижняя половина — как есть, верхняя — повёрнута (читается с другой стороны стола).
  drawHalf(ctx, { ...opts, x0: 0, y0: half });
  ctx.save();
  ctx.translate(W, half);
  ctx.rotate(Math.PI);
  drawHalf(ctx, { ...opts, x0: 0, y0: 0 });
  ctx.restore();
  // Линия сгиба пунктиром.
  ctx.strokeStyle = '#BBBBBB';
  ctx.lineWidth = Math.max(1, Math.round(dpi / 100));
  ctx.setLineDash([Math.round(dpi / 10), Math.round(dpi / 12)]);
  ctx.beginPath();
  ctx.moveTo(0, half);
  ctx.lineTo(W, half);
  ctx.stroke();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Браузер не смог нарисовать страницу');
  return new Uint8Array(await blob.arrayBuffer());
}
