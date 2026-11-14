// Тейбл-тенты (saas/console/table-tents.js): ссылка как у кассы, столы с секретом,
// настоящий PDF (его читают pdfinfo/pdftoppm из poppler — как любой просмотрщик).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tableTentUrl, tentTables, tentTitle, buildImagePdf, jpegSize, inkColor, A4_MM } from '../saas/console/table-tents.js';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0;

// Ссылка — та же, что у кассы (TableQrScreen.linkFor): поддомен, /table/<id>, ?k=секрет.
const dart = readFileSync(join(here, '..', 'lib', 'screens', 'admin', 'table_qr_screen.dart'), 'utf8');
assert.ok(dart.includes("return 'https://$host.$saasDomain/table/$tableId$k';"));
assert.ok(dart.includes("static const saasDomain = 'zalpos.ru';"));
assert.equal(tableTentUrl({ slug: 'kafe', tenantId: 't1' }, 'tbl5', 'a b+c'), 'https://kafe.zalpos.ru/table/tbl5?k=a%20b%2Bc');
assert.equal(tableTentUrl({ slug: '', tenantId: 't1' }, 'x', ''), 'https://t1.zalpos.ru/table/x'); n++;

// Столы: по-человечески по номеру, без секрета — в «нет кода», без дублей.
const { tables, missing } = tentTables(
  [{ id: 'a', name: 'Стол 10' }, { id: 'b', name: 'Стол 2' }, { id: 'c', name: 'VIP' }, { id: 'b', name: 'Стол 2' }, { id: 'd', name: '' }, null],
  { a: 'k1', b: 'k2', d: 'k4' });
assert.deepEqual(tables.map((t) => t.name), ['Стол', 'Стол 2', 'Стол 10']);
assert.deepEqual(tables.map((t) => t.id), ['d', 'b', 'a']);
assert.deepEqual(missing, ['VIP']); n++;
assert.equal(tentTitle('5'), 'Стол 5');
assert.equal(tentTitle('Стол 5'), 'Стол 5');
assert.equal(tentTitle('Веранда 3'), 'Веранда 3'); n++;

// Текст на бумаге читается: светлый фирменный цвет → тёмно-серый.
assert.equal(inkColor('#FFE066'), '#1F1F1F');
assert.equal(inkColor('#1E3A8A'), '#1E3A8A');
assert.equal(inkColor('нет'), '#1F1F1F'); n++;

// PDF из JPEG: настоящий файл с N страницами A4.
const dir = mkdtempSync(join(tmpdir(), 'tents-'));
// Образец JPEG 16×8 (нарисован браузером, оранжевый).
const jpegBytes = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKQAI2f/2Q==', 'base64'));
assert.deepEqual(jpegSize(jpegBytes), { w: 16, h: 8 });
assert.throws(() => jpegSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /не JPEG/); n++;
const pdf = buildImagePdf([jpegBytes, jpegBytes, jpegBytes], A4_MM, 'Table tents');
const file = join(dir, 'tents.pdf');
writeFileSync(file, pdf);
const info = execFileSync('pdfinfo', [file]).toString();
assert.match(info, /Pages:\s+3/);
assert.match(info, /Page size:\s+595\.2\d? x 841\.8\d? pts \(A4\)/);
assert.match(info, /Title:\s+Table tents/); n++;
// Страница рисуется (xref и потоки верные): pdftoppm даёт картинку цвета JPEG.
execFileSync('pdftoppm', ['-r', '10', '-f', '2', '-l', '2', '-png', file, join(dir, 'pg')]);
assert.ok(readFileSync(join(dir, 'pg-2.png')).length > 50);
n++;
assert.throws(() => buildImagePdf([]), /Нет страниц/); n++;

// В кабинете: кнопка в «Брендинге», QR-кодировщик свой (не CDN), логотип — через /brandingLogoFile (CORS).
const con = readFileSync(join(here, '..', 'saas', 'console', 'console.js'), 'utf8');
assert.ok(con.includes("id=\"f-tents\""));
assert.ok(con.includes("await import('./vendor/qr.js')"));
assert.ok(con.includes('/brandingLogoFile?tenantId='));
assert.ok(existsSync(join(here, '..', 'saas', 'console', 'vendor', 'qr.js'))); n++;
console.log(`table-tents: ${n} проверок`);
