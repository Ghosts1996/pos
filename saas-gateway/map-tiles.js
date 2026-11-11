"use strict";
/**
 * Своя карта ZalPOS: чтение файла плиток PMTiles v3 без сторонних пакетов
 * (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *
 * Шлюз отдаёт обычные векторные плитки /map/tiles/{z}/{x}/{y}.mvt — карта в
 * браузере (MapLibre) берёт их как любые другие. Файл плиток готовит
 * map-build.sh из открытых данных OpenStreetMap (© участники OSM, ODbL) и
 * держит на нашем сервере в России: ни карта, ни маршрут не ходят к
 * сторонним сервисам, координаты курьеров и гостей никуда не уходят.
 */
const fs = require("fs");
const zlib = require("zlib");

const HEADER_LEN = 127;
const COMPRESSION = { 0: "unknown", 1: "none", 2: "gzip", 3: "br", 4: "zstd" };

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = buf[pos.i++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return result;
}

const u64 = (buf, off) => Number(buf.readBigUInt64LE(off));

function parseHeader(buf) {
  if (buf.length < HEADER_LEN || buf.toString("latin1", 0, 7) !== "PMTiles") throw new Error("Это не файл PMTiles");
  if (buf[7] !== 3) throw new Error(`Версия PMTiles ${buf[7]} не поддерживается (нужна 3)`);
  return {
    rootOffset: u64(buf, 8), rootLength: u64(buf, 16),
    metadataOffset: u64(buf, 24), metadataLength: u64(buf, 32),
    leafOffset: u64(buf, 40), leafLength: u64(buf, 48),
    dataOffset: u64(buf, 56), dataLength: u64(buf, 64),
    addressed: u64(buf, 72), entries: u64(buf, 80), contents: u64(buf, 88),
    clustered: buf[96] === 1,
    internalCompression: buf[97], tileCompression: buf[98], tileType: buf[99],
    minZoom: buf[100], maxZoom: buf[101],
    minLon: buf.readInt32LE(102) / 1e7, minLat: buf.readInt32LE(106) / 1e7,
    maxLon: buf.readInt32LE(110) / 1e7, maxLat: buf.readInt32LE(114) / 1e7,
    centerZoom: buf[118], centerLon: buf.readInt32LE(119) / 1e7, centerLat: buf.readInt32LE(123) / 1e7,
  };
}

function decompress(buf, kind) {
  if (kind === 1 || kind === 0) return buf;
  if (kind === 2) return zlib.gunzipSync(buf);
  if (kind === 3) return zlib.brotliDecompressSync(buf);
  throw new Error(`Сжатие ${COMPRESSION[kind] || kind} не поддерживается`);
}

function parseDirectory(buf) {
  const pos = { i: 0 };
  const n = readVarint(buf, pos);
  const ids = new Array(n);
  let last = 0;
  for (let k = 0; k < n; k++) { last += readVarint(buf, pos); ids[k] = last; }
  const runs = new Array(n);
  for (let k = 0; k < n; k++) runs[k] = readVarint(buf, pos);
  const lens = new Array(n);
  for (let k = 0; k < n; k++) lens[k] = readVarint(buf, pos);
  const offs = new Array(n);
  for (let k = 0; k < n; k++) {
    const v = readVarint(buf, pos);
    offs[k] = v === 0 && k > 0 ? offs[k - 1] + lens[k - 1] : v - 1;
  }
  return { ids, runs, lens, offs };
}

/** Номер плитки по Гильберту, как в спецификации PMTiles. */
function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error("Слишком большой масштаб");
  const max = 2 ** z;
  if (x < 0 || y < 0 || x >= max || y >= max) throw new Error("Плитка вне карты");
  const acc = (4 ** z - 1) / 3;
  let tx = x;
  let ty = y;
  let d = 0;
  for (let s = max / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      const t = tx; tx = ty; ty = t;
    }
  }
  return acc + d;
}

function findEntry(dir, id) {
  let lo = 0;
  let hi = dir.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = id - dir.ids[mid];
    if (c > 0) lo = mid + 1;
    else if (c < 0) hi = mid - 1;
    else return mid;
  }
  // Ближайшая запись слева: плитка внутри её серии или каталог-лист.
  if (hi >= 0) {
    if (dir.runs[hi] === 0) return hi;
    if (id - dir.ids[hi] < dir.runs[hi]) return hi;
  }
  return -1;
}

/**
 * Открыть файл плиток. Каталоги-листья кэшируются (до 64), сам файл
 * читается кусками — памяти нужно немного даже для больших файлов.
 */
function openPmtiles(file) {
  const fd = fs.openSync(file, "r");
  const read = (off, len) => {
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, b, got, len - got, off + got);
      if (!n) break;
      got += n;
    }
    return got === len ? b : b.subarray(0, got);
  };
  const header = parseHeader(read(0, HEADER_LEN));
  const root = parseDirectory(decompress(read(header.rootOffset, header.rootLength), header.internalCompression));
  let metadata = {};
  if (header.metadataLength) {
    try { metadata = JSON.parse(decompress(read(header.metadataOffset, header.metadataLength), header.internalCompression).toString("utf8")); } catch (_) { metadata = {}; }
  }
  const leafCache = new Map();
  const leaf = (off, len) => {
    const key = `${off}:${len}`;
    let d = leafCache.get(key);
    if (!d) {
      d = parseDirectory(decompress(read(header.leafOffset + off, len), header.internalCompression));
      if (leafCache.size >= 64) leafCache.delete(leafCache.keys().next().value);
      leafCache.set(key, d);
    } else {
      leafCache.delete(key);
      leafCache.set(key, d);
    }
    return d;
  };
  /** Плитка как есть (сжатая, как в файле) или null, если её нет. */
  function tile(z, x, y) {
    if (z < header.minZoom || z > header.maxZoom) return null;
    const id = zxyToTileId(z, x, y);
    let dir = root;
    for (let depth = 0; depth < 4; depth++) {
      const i = findEntry(dir, id);
      if (i < 0) return null;
      if (dir.runs[i] === 0) { dir = leaf(dir.offs[i], dir.lens[i]); continue; }
      return read(header.dataOffset + dir.offs[i], dir.lens[i]);
    }
    return null;
  }
  return {
    header, metadata, tile,
    encoding: COMPRESSION[header.tileCompression] || "none",
    close: () => { try { fs.closeSync(fd); } catch (_) { /* уже закрыт */ } },
  };
}

module.exports = { openPmtiles, zxyToTileId, parseHeader, parseDirectory, readVarint };
