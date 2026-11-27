"use strict";
// Обновление «как у Google Play»: касса и приложение гостя скачивают не весь
// APK (~90 МБ), а только разницу с версией, которая уже стоит на устройстве.
//
// Патч строится по записям ZIP (APK — это ZIP):
//   • запись не изменилась (движок Flutter, шрифты, картинки) — COPY: взять
//     байты из установленного APK;
//   • изменилась несжатая крупная запись (код приложения libapp.so) — BSDIFF:
//     разница байтов (алгоритм bsdiff, К. Персиваль), она сжимается в разы;
//   • всё остальное (заголовки ZIP, подпись, мелкие и сжатые файлы) — DATA.
// Устройство собирает из установленного APK и патча новый файл байт в байт и
// сверяет SHA-256 — не сошлось, качает полный APK, как раньше. Подпись APK
// при этом цела: файл тот же, что собрал GitHub.
//
// Формат (весь поток сжат gzip):
//   "ZPATCH1\n", u64 newSize, sha256(new)[32], u64 oldSize, sha256(old)[32],
//   операции: 1 COPY u64 oldOff, u64 len
//             2 DATA u64 len, байты
//             3 BSDIFF u64 oldOff, u64 oldLen, u64 newLen, u32 n,
//                      n × (i64 x, i64 y, i64 z), u64 diffLen, diff, u64 extraLen, extra
//             0 END
// Разбор — lib/services/apk_patch.dart (касса и приложение гостя).

const crypto = require("crypto");
const zlib = require("zlib");

const MAGIC = Buffer.from("ZPATCH1\n", "latin1");
const BSDIFF_MIN = 64 * 1024; // меньше — проще отдать как есть
const BSDIFF_MAX = 48 * 1024 * 1024; // больше — слишком тяжело для сервера

// ---------------------------------------------------------------- ZIP

/** Записи ZIP: имя, способ сжатия, CRC, размеры и границы данных в файле. */
function zipEntries(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("не ZIP: нет конца каталога");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error("не ZIP: каталог за концом файла");
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("не ZIP: битый каталог");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("не ZIP: битый заголовок записи");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const end = start + compSize;
    if (end > buf.length) throw new Error("не ZIP: запись за концом файла");
    out.push({ name, method, crc, compSize, size, start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------- bsdiff

function split(I, V, start, len, h) {
  let i, j, k, x, tmp, jj, kk;
  if (len < 16) {
    for (k = start; k < start + len; k += j) {
      j = 1;
      x = V[I[k] + h];
      for (i = 1; k + i < start + len; i++) {
        if (V[I[k + i] + h] < x) { x = V[I[k + i] + h]; j = 0; }
        if (V[I[k + i] + h] === x) { tmp = I[k + j]; I[k + j] = I[k + i]; I[k + i] = tmp; j++; }
      }
      for (i = 0; i < j; i++) V[I[k + i]] = k + j - 1;
      if (j === 1) I[k] = -1;
    }
    return;
  }
  x = V[I[start + (len >> 1)] + h];
  jj = 0; kk = 0;
  for (i = start; i < start + len; i++) {
    if (V[I[i] + h] < x) jj++;
    if (V[I[i] + h] === x) kk++;
  }
  jj += start; kk += jj;
  i = start; j = 0; k = 0;
  while (i < jj) {
    if (V[I[i] + h] < x) i++;
    else if (V[I[i] + h] === x) { tmp = I[i]; I[i] = I[jj + j]; I[jj + j] = tmp; j++; }
    else { tmp = I[i]; I[i] = I[kk + k]; I[kk + k] = tmp; k++; }
  }
  while (jj + j < kk) {
    if (V[I[jj + j] + h] === x) j++;
    else { tmp = I[jj + j]; I[jj + j] = I[kk + k]; I[kk + k] = tmp; k++; }
  }
  if (jj > start) split(I, V, start, jj - start, h);
  for (i = 0; i < kk - jj; i++) V[I[jj + i]] = kk - 1;
  if (jj === kk - 1) I[jj] = -1;
  if (start + len > kk) split(I, V, kk, start + len - kk, h);
}

/** Суффиксный массив (Ларссон — Садакане), как в bsdiff 4.3. */
function qsufsort(old) {
  const n = old.length;
  const I = new Int32Array(n + 1);
  const V = new Int32Array(n + 1);
  const buckets = new Int32Array(256);
  let i, h, len;
  for (i = 0; i < n; i++) buckets[old[i]]++;
  for (i = 1; i < 256; i++) buckets[i] += buckets[i - 1];
  for (i = 255; i > 0; i--) buckets[i] = buckets[i - 1];
  buckets[0] = 0;
  for (i = 0; i < n; i++) I[++buckets[old[i]]] = i;
  I[0] = n;
  for (i = 0; i < n; i++) V[i] = buckets[old[i]];
  V[n] = 0;
  for (i = 1; i < 256; i++) if (buckets[i] === buckets[i - 1] + 1) I[buckets[i]] = -1;
  I[0] = -1;
  for (h = 1; I[0] !== -(n + 1); h += h) {
    len = 0;
    for (i = 0; i < n + 1;) {
      if (I[i] < 0) {
        len -= I[i];
        i -= I[i];
      } else {
        if (len) I[i - len] = -len;
        len = V[I[i]] + 1 - i;
        split(I, V, i, len, h);
        i += len;
        len = 0;
      }
    }
    if (len) I[i - len] = -len;
  }
  for (i = 0; i < n + 1; i++) I[V[i]] = i;
  return I;
}

function matchlen(a, ai, b, bi) {
  const n = Math.min(a.length - ai, b.length - bi);
  let i = 0;
  while (i < n && a[ai + i] === b[bi + i]) i++;
  return i;
}

/** Самое длинное совпадение new[scan..] со старыми данными (по суффиксному массиву). */
function search(I, old, neu, scan) {
  let st = 0;
  let en = old.length;
  while (en - st >= 2) {
    const x = st + ((en - st) >> 1);
    const m = Math.min(old.length - I[x], neu.length - scan);
    const c = Buffer.compare(old.subarray(I[x], I[x] + m), neu.subarray(scan, scan + m));
    if (c < 0) st = x; else en = x;
  }
  const x = matchlen(old, I[st], neu, scan);
  const y = matchlen(old, I[en], neu, scan);
  return x > y ? { len: x, pos: I[st] } : { len: y, pos: I[en] };
}

/**
 * bsdiff: тройки (x, y, z) — x байт «старое + разница», y байт «как есть»,
 * сдвиг по старому на z. deadline — время, после которого сдаёмся (null).
 */
function bsdiff(old, neu, deadline = 0) {
  const I = qsufsort(old);
  const oldsize = old.length;
  const newsize = neu.length;
  const ctrl = [];
  const db = Buffer.alloc(newsize);
  const eb = Buffer.alloc(newsize);
  let dblen = 0, eblen = 0;
  let scan = 0, len = 0, pos = 0;
  let lastscan = 0, lastpos = 0, lastoffset = 0;
  let steps = 0;
  while (scan < newsize) {
    let oldscore = 0;
    let scsc;
    for (scsc = scan += len; scan < newsize; scan++) {
      if (deadline && (++steps & 0xfff) === 0 && Date.now() > deadline) return null;
      const r = search(I, old, neu, scan);
      len = r.len; pos = r.pos;
      for (; scsc < scan + len; scsc++) {
        if (scsc + lastoffset < oldsize && old[scsc + lastoffset] === neu[scsc]) oldscore++;
      }
      if ((len === oldscore && len !== 0) || len > oldscore + 8) break;
      if (scan + lastoffset < oldsize && old[scan + lastoffset] === neu[scan]) oldscore--;
    }
    if (len !== oldscore || scan === newsize) {
      let s = 0, Sf = 0, lenf = 0, i;
      for (i = 0; lastscan + i < scan && lastpos + i < oldsize;) {
        if (old[lastpos + i] === neu[lastscan + i]) s++;
        i++;
        if (s * 2 - i > Sf * 2 - lenf) { Sf = s; lenf = i; }
      }
      let lenb = 0;
      if (scan < newsize) {
        let Sb = 0;
        s = 0;
        for (i = 1; scan >= lastscan + i && pos >= i; i++) {
          if (old[pos - i] === neu[scan - i]) s++;
          if (s * 2 - i > Sb * 2 - lenb) { Sb = s; lenb = i; }
        }
      }
      if (lastscan + lenf > scan - lenb) {
        const overlap = lastscan + lenf - (scan - lenb);
        let Ss = 0, lens = 0;
        s = 0;
        for (i = 0; i < overlap; i++) {
          if (neu[lastscan + lenf - overlap + i] === old[lastpos + lenf - overlap + i]) s++;
          if (neu[scan - lenb + i] === old[pos - lenb + i]) s--;
          if (s > Ss) { Ss = s; lens = i + 1; }
        }
        lenf += lens - overlap;
        lenb -= lens;
      }
      for (i = 0; i < lenf; i++) db[dblen + i] = (neu[lastscan + i] - old[lastpos + i]) & 0xff;
      const extra = scan - lenb - (lastscan + lenf);
      for (i = 0; i < extra; i++) eb[eblen + i] = neu[lastscan + lenf + i];
      dblen += lenf;
      eblen += extra;
      ctrl.push([lenf, extra, pos - lenb - (lastpos + lenf)]);
      lastscan = scan - lenb;
      lastpos = pos - lenb;
      lastoffset = pos - scan;
    }
  }
  return { ctrl, diff: db.subarray(0, dblen), extra: eb.subarray(0, eblen) };
}

/** Применить bsdiff (для проверки на сервере и в тестах). */
function bspatch(old, newsize, { ctrl, diff, extra }) {
  const out = Buffer.alloc(newsize);
  let oldpos = 0, newpos = 0, di = 0, ei = 0;
  for (const [x, y, z] of ctrl) {
    if (newpos + x > newsize) throw new Error("bsdiff: выход за конец");
    for (let i = 0; i < x; i++) {
      const o = oldpos + i;
      out[newpos + i] = (diff[di + i] + (o >= 0 && o < old.length ? old[o] : 0)) & 0xff;
    }
    di += x; newpos += x; oldpos += x;
    if (newpos + y > newsize) throw new Error("bsdiff: выход за конец");
    extra.copy(out, newpos, ei, ei + y);
    ei += y; newpos += y; oldpos += z;
  }
  if (newpos !== newsize) throw new Error("bsdiff: неполный результат");
  return out;
}

// ------------------------------------------------------------- патч

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

class Writer {
  constructor() { this.parts = []; }
  u8(v) { const b = Buffer.alloc(1); b[0] = v; this.parts.push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.parts.push(b); }
  bytes(b) { this.parts.push(Buffer.from(b.buffer, b.byteOffset, b.length)); }
}

/**
 * Патч от старого APK к новому. opts.deadlineMs — сколько можно думать над
 * bsdiff одной записи (дальше запись идёт как есть). Возвращает
 * { patch (gzip), stats } или бросает, если файлы не ZIP.
 */
function makePatch(oldBuf, newBuf, opts = {}) {
  const oldEntries = new Map(zipEntries(oldBuf).map((e) => [e.name, e]));
  const segs = []; // {op:'copy', off, len} | {op:'data', start, end} | {op:'bsdiff', ...}
  const stats = { copy: 0, data: 0, bsdiff: 0, bsdiffIn: 0, entries: 0 };
  let cur = 0;
  const pushData = (start, end) => {
    if (end <= start) return;
    const last = segs[segs.length - 1];
    if (last && last.op === "data" && last.end === start) last.end = end;
    else segs.push({ op: "data", start, end });
    stats.data += end - start;
  };
  const pushCopy = (off, len) => {
    if (!len) return;
    const last = segs[segs.length - 1];
    if (last && last.op === "copy" && last.off + last.len === off) last.len += len;
    else segs.push({ op: "copy", off, len });
    stats.copy += len;
  };
  for (const e of zipEntries(newBuf)) {
    stats.entries++;
    pushData(cur, e.start);
    const o = oldEntries.get(e.name);
    const nb = newBuf.subarray(e.start, e.end);
    let done = false;
    if (o && o.method === e.method && o.crc === e.crc && o.compSize === e.compSize
        && oldBuf.subarray(o.start, o.end).equals(nb)) {
      pushCopy(o.start, o.end - o.start);
      done = true;
    } else if (o && e.method === 0 && o.method === 0 && e.compSize >= BSDIFF_MIN
        && e.compSize <= BSDIFF_MAX && o.compSize <= BSDIFF_MAX) {
      const ob = oldBuf.subarray(o.start, o.end);
      const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : 0;
      const d = bsdiff(ob, nb, deadline);
      if (d) {
        segs.push({ op: "bsdiff", off: o.start, oldLen: ob.length, newLen: nb.length, d });
        stats.bsdiff += nb.length;
        stats.bsdiffIn += d.diff.length + d.extra.length;
        done = true;
      }
    }
    if (!done) pushData(e.start, e.end);
    cur = e.end;
  }
  pushData(cur, newBuf.length);

  const w = new Writer();
  w.bytes(MAGIC);
  w.u64(newBuf.length); w.bytes(sha256(newBuf));
  w.u64(oldBuf.length); w.bytes(sha256(oldBuf));
  for (const s of segs) {
    if (s.op === "copy") { w.u8(1); w.u64(s.off); w.u64(s.len); }
    else if (s.op === "data") { w.u8(2); w.u64(s.end - s.start); w.bytes(newBuf.subarray(s.start, s.end)); }
    else {
      w.u8(3); w.u64(s.off); w.u64(s.oldLen); w.u64(s.newLen);
      w.u32(s.d.ctrl.length);
      for (const [x, y, z] of s.d.ctrl) { w.i64(x); w.i64(y); w.i64(z); }
      w.u64(s.d.diff.length); w.bytes(s.d.diff);
      w.u64(s.d.extra.length); w.bytes(s.d.extra);
    }
  }
  w.u8(0);
  const raw = Buffer.concat(w.parts);
  const patch = zlib.gzipSync(raw, { level: 9 });
  return { patch, stats: { ...stats, raw: raw.length, size: patch.length, newSize: newBuf.length } };
}

/** Собрать новый файл из старого и патча (сервер проверяет патч сам перед раздачей). */
function applyPatch(oldBuf, patchBuf) {
  const raw = zlib.gunzipSync(patchBuf);
  let p = 0;
  const u8 = () => raw[p++];
  const u32 = () => { const v = raw.readUInt32LE(p); p += 4; return v; };
  const u64 = () => { const v = Number(raw.readBigUInt64LE(p)); p += 8; return v; };
  const i64 = () => { const v = Number(raw.readBigInt64LE(p)); p += 8; return v; };
  const take = (n) => { const b = raw.subarray(p, p + n); p += n; return b; };
  if (!take(MAGIC.length).equals(MAGIC)) throw new Error("не патч");
  const newSize = u64();
  const newSha = take(32);
  const oldSize = u64();
  const oldSha = take(32);
  if (oldBuf.length !== oldSize || !sha256(oldBuf).equals(oldSha)) throw new Error("патч не к этой версии");
  const out = Buffer.alloc(newSize);
  let o = 0;
  for (;;) {
    const op = u8();
    if (op === 0) break;
    if (op === 1) { const off = u64(); const len = u64(); oldBuf.copy(out, o, off, off + len); o += len; }
    else if (op === 2) { const len = u64(); take(len).copy(out, o); o += len; }
    else if (op === 3) {
      const off = u64(); const oldLen = u64(); const newLen = u64();
      const n = u32();
      const ctrl = [];
      for (let i = 0; i < n; i++) ctrl.push([i64(), i64(), i64()]);
      const diff = take(u64());
      const extra = take(u64());
      bspatch(oldBuf.subarray(off, off + oldLen), newLen, { ctrl, diff, extra }).copy(out, o);
      o += newLen;
    } else throw new Error("неизвестная операция патча");
  }
  if (o !== newSize || !sha256(out).equals(newSha)) throw new Error("патч дал не тот файл");
  return out;
}

module.exports = { makePatch, applyPatch, zipEntries, bsdiff, bspatch, sha256 };
