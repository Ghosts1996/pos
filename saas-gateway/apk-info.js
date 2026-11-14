"use strict";
/**
 * Версия APK (versionCode, versionName, пакет) прямо из файла — без Android SDK:
 * APK — zip-архив, в нём AndroidManifest.xml в двоичном виде (AXML).
 * Нужен приложению курьера: «Проверить обновления» сравнивает свою версию с
 * файлом на сервере (publicdemo/courier.apk), который кладёт сборка.
 */
const fs = require("fs");
const zlib = require("zlib");

/** Один файл из zip по имени (по центральному каталогу). */
function zipEntry(buf, name) {
  // Конец центрального каталога: подпись 0x06054b50, ищем с конца (комментарий ≤ 64 КБ).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("не zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const fname = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (fname === name) {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("битый zip");
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`сжатие ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

function stringPool(b, off) {
  const count = b.readUInt32LE(off + 8);
  const flags = b.readUInt32LE(off + 16);
  const strStart = b.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    let p = off + strStart + b.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      // длина в символах и в байтах — по 1–2 байта каждая
      p += (b[p] & 0x80) ? 2 : 1;
      let len = b[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | b[p + 1]; p += 2; } else p += 1;
      out.push(b.toString("utf8", p, p + len));
    } else {
      let len = b.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(p + 2); p += 4; } else p += 2;
      out.push(b.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

const ATTR = { 0x0101021b: "versionCode", 0x0101021c: "versionName" };

/** Атрибуты корневого <manifest> из двоичного AndroidManifest.xml. */
function manifestInfo(b) {
  if (b.readUInt16LE(0) !== 0x0003) throw new Error("не AXML");
  let strings = [];
  let resIds = [];
  let p = b.readUInt16LE(2);
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p);
    const size = b.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = stringPool(b, p);
    else if (type === 0x0180) {
      for (let q = p + 8; q + 4 <= p + size; q += 4) resIds.push(b.readUInt32LE(q));
    } else if (type === 0x0102) {
      const name = strings[b.readUInt32LE(p + 20)];
      if (name !== "manifest") { p += size; continue; }
      const attrStart = b.readUInt16LE(p + 24);
      const attrSize = b.readUInt16LE(p + 26);
      const attrCount = b.readUInt16LE(p + 28);
      const info = {};
      for (let i = 0; i < attrCount; i++) {
        const a = p + 16 + attrStart + i * attrSize;
        const nameIdx = b.readUInt32LE(a + 4);
        const raw = b.readUInt32LE(a + 8);
        const dataType = b[a + 15];
        const data = b.readUInt32LE(a + 16);
        const key = ATTR[resIds[nameIdx]] || strings[nameIdx];
        const val = dataType === 0x03 ? strings[data] : raw !== 0xffffffff ? strings[raw] : data;
        if (key === "versionCode") info.versionCode = Number(val);
        else if (key === "versionName") info.versionName = String(val);
        else if (key === "package") info.package = String(val);
      }
      return info;
    }
    p += size;
  }
  throw new Error("нет <manifest>");
}

/** Версия APK по буферу файла. */
function apkVersion(buf) {
  const m = zipEntry(buf, "AndroidManifest.xml");
  if (!m) throw new Error("нет AndroidManifest.xml");
  return manifestInfo(m);
}

/** То же по пути, с памятью по времени изменения и размеру: файл читается раз на сборку. */
function createApkInfo(file) {
  let memo = null;
  return function info() {
    let st;
    try { st = fs.statSync(file); } catch (_) { return null; }
    const key = `${st.mtimeMs}:${st.size}`;
    if (memo && memo.key === key) return memo.value;
    let value = null;
    try {
      value = { ...apkVersion(fs.readFileSync(file)), size: st.size, at: Math.round(st.mtimeMs) };
    } catch (e) {
      value = { size: st.size, at: Math.round(st.mtimeMs), error: String(e.message || e) };
    }
    memo = { key, value };
    return value;
  };
}

module.exports = { apkVersion, createApkInfo, zipEntry, manifestInfo };
