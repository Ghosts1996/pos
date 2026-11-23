// «Для бухгалтера»: выгрузка за период одним файлом Excel (.xlsx) — продажи,
// чеки с видами оплаты, возвраты, приходы по накладным, смены сотрудников и
// корректировки зарплаты. Excel, «1С: загрузка из табличного документа» и
// бухгалтерские сервисы открывают такой файл без настроек. Листы «1С — …» —
// в виде табличных частей «Отчёта о розничных продажах» и справочника номенклатуры.
// Чистые функции без DOM и сети — их проверяет saas-gateway/test.accounting.mjs.

const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v.toMillis === 'function') return new Date(v.toMillis());
  if (typeof v === 'number') return new Date(v);
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
// Как в «Обзоре» кабинета (BILL_TOBACCO_RE в console.js) и на кассе.
export const BILL_TOBACCO_RE = /кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар/i;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** «14.11.2026 21:05» в поясе заведения. */
export function fmtDateTime(v, tz = 'Europe/Moscow') {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(d).replace(',', '');
}

/** Сумма чека — как на кассе и в «Обзоре» (sessionBill): позиции минус скидка, кальяны без скидки. */
export function checkTotal(s, excludeTobacco = true, tobaccoRe = BILL_TOBACCO_RE) {
  let total = 0;
  let promoBase = 0;
  for (const i of Array.isArray(s.orderItems) ? s.orderItems : []) {
    const sum = num(i.price) * num(i.qty);
    total += sum;
    if (!(i.menuItemId === 'zalpos_service' || (excludeTobacco && (i.noPromo === true || tobaccoRe.test(String(i.name || '')))))) promoBase += sum;
  }
  return r2(total - (promoBase * num(s.discountPercent)) / 100);
}

/**
 * Листы выгрузки. data: { sessions (закрытые за период), refunds (возвраты за
 * период), movements (движения склада за период), shifts (смены сотрудников),
 * adjustments (корректировки зарплаты) }. Возвращает [{ name, rows }], первая
 * строка — заголовки.
 */
export function buildAccountingSheets(data, { tz = 'Europe/Moscow', excludeTobacco = true, tobaccoRe } = {}) {
  const sessions = (data.sessions || []).filter((s) => s && s.status === 'closed' && !s.closedWithoutPayment && s.training !== true);
  const refunds = (data.refunds || []).filter((s) => s && s.refunded === true && !s.closedWithoutPayment && s.training !== true);

  const checks = [['Дата', 'Чек', 'Стол / заказ', 'Сумма, ₽', 'Скидка, %', 'Наличные, ₽', 'Карта (СБП/перевод), ₽', 'Терминал, ₽', 'Агрегатор, ₽', 'Агрегатор', 'За счёт заведения, ₽', 'Чаевые, ₽', 'Фискальный чек']];
  const items = [['Дата', 'Чек', 'Позиция', 'Количество', 'Цена, ₽', 'Сумма, ₽']];
  let sumChecks = 0;
  for (const s of sessions.slice().sort((a, b) => (toDate(a.closedAt) || 0) - (toDate(b.closedAt) || 0))) {
    const total = checkTotal(s, excludeTobacco, tobaccoRe);
    sumChecks += total;
    const no = String(s.checkNumber || s.number || s.id || '');
    checks.push([fmtDateTime(s.closedAt, tz), no, String(s.tableName || s.tableId || s.orderNumber || ''), total, num(s.discountPercent),
      r2(s.paymentCash), r2(s.paymentCard), r2(s.paymentTerminal), r2(s.paymentAggregator), String(s.aggregatorName || ''),
      r2(s.paymentComp), r2(num(s.tipsCash) + num(s.tipsCard)), s.fiscalReceiptPrinted ? 'да' : 'нет']);
    for (const i of Array.isArray(s.orderItems) ? s.orderItems : []) {
      items.push([fmtDateTime(s.closedAt, tz), no, String(i.name || ''), num(i.qty), r2(i.price), r2(num(i.price) * num(i.qty))]);
    }
  }
  checks.push(['Итого', '', '', r2(sumChecks), '', '', '', '', '', '', '', '', '']);

  const ret = [['Дата возврата', 'Чек', 'Сумма возврата, ₽', 'Кто оформил', 'Причина']];
  let sumRefunds = 0;
  for (const s of refunds) {
    const total = checkTotal(s, excludeTobacco, tobaccoRe);
    sumRefunds += total;
    ret.push([fmtDateTime(s.refundedAt, tz), String(s.checkNumber || s.number || s.id || ''), total, String(s.refundedBy || ''), String(s.refundReason || '')]);
  }
  ret.push(['Итого', '', r2(sumRefunds), '', '']);

  const rec = [['Дата', 'Позиция', 'Количество', 'Ед.', 'Основание (накладная)']];
  for (const m of (data.movements || []).filter((x) => x && x.type === 'receipt')) {
    rec.push([fmtDateTime(m.createdAt, tz), String(m.itemName || ''), num(m.delta), String(m.unit || ''), String(m.reason || '')]);
  }

  const sh = [['Сотрудник', 'Начало', 'Конец', 'Часов', 'Отмечено без интернета']];
  for (const x of data.shifts || []) {
    const a = toDate(x.startedAt);
    const b = toDate(x.endedAt);
    const hours = a && b ? r2((b - a) / 3600000) : '';
    sh.push([String(x.employeeName || x.employeeId || ''), fmtDateTime(a, tz), fmtDateTime(b, tz), hours,
      x.offlineTap === true || (x.syncedAt && a && toDate(x.syncedAt) - a > 120000) ? 'да' : 'нет']);
  }

  const adj = [['Дата', 'Сотрудник', 'Вид', 'Сумма, ₽', 'Комментарий', 'Отменена']];
  const KIND = { bonus: 'Премия', penalty: 'Штраф', advance: 'Аванс', payout: 'Выплата', correction: 'Корректировка' };
  for (const x of data.adjustments || []) {
    adj.push([fmtDateTime(x.at || x.createdAt, tz), String(x.employeeName || x.employeeId || ''), KIND[x.type] || String(x.type || ''),
      r2(x.amount), String(x.comment || ''), x.cancelled === true || x.cancelledAt ? 'да' : 'нет']);
  }

  const summary = [['Показатель', 'Значение'],
    ['Чеков', sessions.length], ['Выручка по чекам, ₽', r2(sumChecks)], ['Возвраты, ₽', r2(sumRefunds)],
    ['Выручка за вычетом возвратов, ₽', r2(sumChecks - sumRefunds)],
    ['Наличными, ₽', r2(sessions.reduce((a, s) => a + num(s.paymentCash), 0))],
    ['Картой и переводом, ₽', r2(sessions.reduce((a, s) => a + num(s.paymentCard) + num(s.paymentTerminal), 0))],
    ['Через агрегаторы, ₽', r2(sessions.reduce((a, s) => a + num(s.paymentAggregator), 0))]];

  const for1c = build1cSheets(sessions, data.menu || null, { tz, excludeTobacco, tobaccoRe });

  return [
    { name: 'Сводка', rows: summary },
    { name: 'Чеки', rows: checks },
    { name: 'Продажи по позициям', rows: items },
    { name: 'Возвраты', rows: ret },
    { name: 'Приходы по накладным', rows: rec },
    { name: 'Смены сотрудников', rows: sh },
    { name: 'Зарплата — корректировки', rows: adj },
    ...for1c,
  ];
}

// ------------------------------------------------------------- листы для 1С

// Ставка НДС позиции меню (FiscalVatRate в кассе) → как в 1С.
const VAT_1C = { none: 'Без НДС', vat0: '0%', vat5: '5%', vat7: '7%', vat10: '10%', vat20: '20%', vat22: '22%' };

/** «21.11.2026» в поясе заведения. */
export function fmtDay(v, tz = 'Europe/Moscow') {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d) : '';
}

/**
 * Листы в виде табличных частей документов 1С («Загрузить из файла» /
 * «Загрузка данных из табличного документа»):
 *  • «1С — розничные продажи»: по дням — номенклатура, количество, цена,
 *    сумма со скидкой, ставка НДС (для «Отчёта о розничных продажах»).
 *    Скидка чека разнесена по строкам так же, как на кассе (кальяны и
 *    позиции «без скидок» — без скидки), сумма дня = сумма чеков дня.
 *  • «1С — оплаты по дням»: наличные, безналичные, агрегаторы, за счёт заведения.
 *  • «1С — номенклатура»: наименование, ед., ставка НДС, вид (товар/услуга).
 * menu — { id: позиция меню } (ставка НДС и вид); без него ставка пустая.
 */
export function build1cSheets(sessions, menu, { tz = 'Europe/Moscow', excludeTobacco = true, tobaccoRe = BILL_TOBACCO_RE } = {}) {
  const days = new Map(); // день → { lines: Map(ключ → {name, vat, kind, qty, sum}), total, pay }
  const items = new Map(); // наименование → {vat, kind}
  const vatOf = (i) => {
    const m = (menu && i.menuItemId && menu[i.menuItemId]) || null;
    return m && VAT_1C[m.vat] ? VAT_1C[m.vat] : '';
  };
  const kindOf = (i) => {
    const m = (menu && i.menuItemId && menu[i.menuItemId]) || null;
    const subj = m ? String(m.fiscalSubject || '') : '';
    return subj === 'service' || i.menuItemId === 'zalpos_delivery' || i.menuItemId === 'zalpos_service' ? 'Услуга' : 'Товар';
  };
  for (const s of sessions) {
    const day = fmtDay(s.closedAt, tz);
    if (!day) continue;
    if (!days.has(day)) days.set(day, { lines: new Map(), total: 0, pay: { cash: 0, card: 0, agg: 0, comp: 0 } });
    const d = days.get(day);
    const disc = num(s.discountPercent);
    d.total += checkTotal(s, excludeTobacco, tobaccoRe);
    d.pay.cash += num(s.paymentCash);
    d.pay.card += num(s.paymentCard) + num(s.paymentTerminal);
    d.pay.agg += num(s.paymentAggregator);
    d.pay.comp += num(s.paymentComp);
    for (const i of Array.isArray(s.orderItems) ? s.orderItems : []) {
      const qty = num(i.qty);
      if (qty <= 0) continue;
      const name = String(i.name || '').trim() || 'Позиция';
      const noDisc = i.menuItemId === 'zalpos_service' || (excludeTobacco && (i.noPromo === true || tobaccoRe.test(name)));
      const sum = num(i.price) * qty * (noDisc ? 1 : 1 - disc / 100);
      const vat = vatOf(i);
      const kind = kindOf(i);
      const key = `${name}\u0000${vat}`;
      const line = d.lines.get(key) || { name, vat, kind, qty: 0, sum: 0 };
      line.qty += qty;
      line.sum += sum;
      d.lines.set(key, line);
      if (!items.has(name)) items.set(name, { vat, kind });
    }
  }
  const sales = [['Дата', 'Номенклатура', 'Количество', 'Цена, ₽', 'Сумма, ₽', 'Ставка НДС', 'Вид']];
  const pays = [['Дата', 'Наличные, ₽', 'Безналичные (карта, СБП, терминал), ₽', 'Агрегаторы, ₽', 'За счёт заведения, ₽', 'Итого выручка, ₽']];
  const order = [...days.keys()].sort((a, b) => a.split('.').reverse().join('').localeCompare(b.split('.').reverse().join('')));
  for (const day of order) {
    const d = days.get(day);
    const lines = [...d.lines.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    for (const l of lines) l.sum = r2(l.sum);
    // Копейки от разнесения скидки — в самую большую строку: сумма дня = сумме чеков.
    const diff = r2(r2(d.total) - lines.reduce((a, l) => a + l.sum, 0));
    if (diff && lines.length) { const big = lines.reduce((a, l) => (l.sum > a.sum ? l : a)); big.sum = r2(big.sum + diff); }
    for (const l of lines) sales.push([day, l.name, r2(l.qty), l.qty ? r2(l.sum / l.qty) : 0, l.sum, l.vat, l.kind]);
    pays.push([day, r2(d.pay.cash), r2(d.pay.card), r2(d.pay.agg), r2(d.pay.comp), r2(d.total)]);
  }
  const nom = [['Наименование', 'Единица', 'Ставка НДС', 'Вид номенклатуры']];
  for (const [name, x] of [...items.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) nom.push([name, 'шт', x.vat, x.kind]);
  return [
    { name: '1С — розничные продажи', rows: sales },
    { name: '1С — оплаты по дням', rows: pays },
    { name: '1С — номенклатура', rows: nom },
  ];
}

// ------------------------------------------------------------- .xlsx без библиотек

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
// Управляющие символы Excel не открывает — убираем; формулы (=, +, -, @ в начале
// строки) не нужны и опасны (CSV/XLSX-инъекция) — такие строки идут как текст.
const xmlText = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, (c) => XML_ESC[c]);
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function sheetXml(rows) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = `${colName(c)}${r + 1}`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (v === '' || v === null || v === undefined) return '';
    return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const widths = (rows[0] || []).map((_, c) => {
    const w = Math.min(60, Math.max(10, ...rows.slice(0, 200).map((row) => String(row[c] ?? '').length + 2)));
    return `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${widths ? `<cols>${widths}</cols>` : ''}<sheetData>${body}</sheetData></worksheet>`;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** ZIP без сжатия (store) — Excel его открывает. files: [{ name, data: Uint8Array }]. */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true); head.setUint32(14, crc, true); head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true); head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/** Книга Excel из листов [{ name, rows }] → Uint8Array (.xlsx). */
export function buildXlsx(sheets) {
  const enc = new TextEncoder();
  const safeName = (s, i) => (String(s).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Лист${i + 1}`);
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlText(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>') },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) })),
  ];
  return zipStore(files);
}
