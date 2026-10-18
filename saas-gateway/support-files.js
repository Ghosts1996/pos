"use strict";

/**
 * Вложения обращений в поддержку: скриншоты и файлы из кабинета и от
 * специалистов. Лежат на диске сервера, наружу не раздаются (в отличие от
 * branding-uploads): отдаёт их только /supportFile тем, у кого есть доступ к
 * обращению. Папка — по заведению, чтобы удалялась вместе с ним.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.SUPPORT_UPLOADS_DIR || path.join(__dirname, "support-uploads");
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PER_MESSAGE = 5;

// Тип → расширение. Только то, что реально нужно поддержке.
const TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const EXT_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID = /^[a-f0-9]{24}\.(png|jpg|webp|gif|pdf|txt|mp4|zip|docx|xlsx)$/;

const isImage = (type) => /^image\//.test(String(type || ""));

/** Содержимое похоже на заявленный тип — чтобы под видом картинки не
 *  положили что-то исполняемое. */
function matches(buffer, ext) {
  const b = buffer;
  const head = (n) => b.slice(0, n).toString("latin1");
  switch (ext) {
    case "png": return b.length > 8 && b[0] === 0x89 && head(4).slice(1) === "PNG";
    case "jpg": return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "webp": return head(4) === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP";
    case "gif": return head(4) === "GIF8";
    case "pdf": return head(5) === "%PDF-";
    case "mp4": return b.slice(4, 8).toString("latin1") === "ftyp";
    case "zip": case "docx": case "xlsx": return head(2) === "PK";
    case "txt": return !b.includes(0);
    default: return false;
  }
}

/** Имя файла для показа: без путей и управляющих символов. */
function cleanName(name, ext) {
  let n = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) n = `file.${ext}`;
  return n.slice(0, 120);
}

const folder = (tenantId, ticketId) => path.join(DIR, SAFE_ID.test(String(tenantId || "")) ? tenantId : "_", ticketId);

/** Сохранить вложение обращения. Возвращает описание для сообщения. */
async function save({ tenantId, ticketId, buffer, type, name }) {
  if (!SAFE_ID.test(String(ticketId || ""))) throw new Error("некорректное обращение");
  const mime = String(type || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[mime];
  if (!ext) throw new Error("такой тип файла не принимаем — пришлите картинку, PDF, текст, Word, Excel, ZIP или видео MP4");
  if (!buffer || !buffer.length) throw new Error("пустой файл");
  if (buffer.length > MAX_BYTES) throw new Error("файл больше 15 МБ");
  if (!matches(buffer, ext)) throw new Error("содержимое не похоже на заявленный тип файла");
  const id = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const dir = folder(tenantId, ticketId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, id), buffer);
  return { id, name: cleanName(name, ext), type: mime, size: buffer.length };
}

/** Прочитать вложение; null — нет такого. */
async function read({ tenantId, ticketId, id }) {
  if (!SAFE_ID.test(String(ticketId || "")) || !FILE_ID.test(String(id || ""))) return null;
  try {
    const buffer = await fs.promises.readFile(path.join(folder(tenantId, ticketId), id));
    return { buffer, type: EXT_TYPE[id.split(".").pop()] || "application/octet-stream" };
  } catch (_) {
    return null;
  }
}

/** Все вложения заведения — вместе с его данными. */
async function removeTenant(tenantId) {
  if (!SAFE_ID.test(String(tenantId || ""))) return;
  await fs.promises.rm(path.join(DIR, tenantId), { recursive: true, force: true }).catch(() => {});
}

/** Описания вложений из сообщения — только корректные, не больше лимита. */
function listOf(m) {
  const list = Array.isArray(m && m.attachments) ? m.attachments : [];
  return list.filter((a) => a && FILE_ID.test(String(a.id || ""))).slice(0, MAX_PER_MESSAGE)
    .map((a) => ({ id: a.id, name: cleanName(a.name, a.id.split(".").pop()), type: EXT_TYPE[a.id.split(".").pop()], size: Number(a.size) || 0 }));
}

module.exports = { DIR, MAX_BYTES, MAX_PER_MESSAGE, TYPES, isImage, matches, save, read, removeTenant, listOf, cleanName };
