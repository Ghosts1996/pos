#!/usr/bin/env node
"use strict";
/**
 * Минимальный клиент S3 (подпись AWS Signature V4) для offsite-backup.sh —
 * без aws-cli и без curl --aws-sigv4 (в curl из Ubuntu 22.04 подпись
 * загрузки файла считается неверно: SignatureDoesNotMatch).
 *
 *   node s3-mini.js GET|PUT|DELETE "ключ" [--upload файл] [--out файл]
 *   node s3-mini.js GET "?list-type=2&prefix=hourly/"     список (XML в stdout)
 *
 * Настройки — из окружения: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET,
 * OFFSITE_S3_REGION, OFFSITE_S3_ACCESS_KEY, OFFSITE_S3_SECRET_KEY.
 * Отказ хранилища — в stderr строкой «S3 ответил 403 Code Message», код выхода 1.
 */
const crypto = require("crypto");
const fs = require("fs");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
// RFC 3986, как требует подпись: всё, кроме A–Z a–z 0–9 - _ . ~
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Заголовок Authorization для запроса. headers — уже с host, x-amz-date, x-amz-content-sha256. */
function authorization({ method, path, query, headers, payloadHash, accessKey, secretKey, region, amzDate }) {
  const date = amzDate.slice(0, 8);
  const canonicalUri = path.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/") || "/";
  const canonicalQuery = [...query]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function request(method, target, { upload = null, env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const endpoint = String(env.OFFSITE_S3_ENDPOINT || "").replace(/\/+$/, "");
  const bucket = env.OFFSITE_S3_BUCKET;
  const region = env.OFFSITE_S3_REGION || "ru-1";
  // Путь в стиле path-style: /бакет/ключ; «?…» — запрос к самому бакету.
  const [keyPart, qs = ""] = String(target || "").split("?");
  const url = new URL(`${endpoint}/${bucket}${keyPart ? `/${keyPart.replace(/^\/+/, "")}` : ""}`);
  const query = new URLSearchParams(qs);
  const body = upload ? fs.readFileSync(upload) : null;
  const payloadHash = sha256(body || "");
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (body) headers["content-type"] = "application/octet-stream";
  headers.authorization = authorization({
    method, path: url.pathname, query, headers: { ...headers }, payloadHash,
    accessKey: env.OFFSITE_S3_ACCESS_KEY, secretKey: env.OFFSITE_S3_SECRET_KEY, region, amzDate,
  });
  const qsOut = [...query].length ? `?${[...query].map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")}` : "";
  const fetchHeaders = { ...headers };
  delete fetchHeaders.host;
  const res = await fetchImpl(`${url.origin}${url.pathname}${qsOut}`, {
    method, headers: fetchHeaders, body: body || undefined, signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, body: buf };
}

async function main(argv) {
  const [method, target, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  if (!/^(GET|PUT|DELETE|HEAD)$/.test(method || "")) {
    process.stderr.write("использование: node s3-mini.js GET|PUT|DELETE ключ [--upload файл] [--out файл]\n");
    return 2;
  }
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await request(method, target, { upload: opt("--upload") });
      if (r.status < 500 || attempt >= 3) break;
    } catch (e) {
      if (attempt >= 3) { process.stderr.write(`S3 недоступен: ${e.message || e}\n`); return 1; }
    }
    await new Promise((ok) => setTimeout(ok, 5000 * attempt));
  }
  if (!r.ok) {
    const text = r.body.toString("utf8");
    const pick = (tag) => (text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || "";
    process.stderr.write(`S3 ответил ${r.status} ${pick("Code")} ${pick("Message")}`.trim() + "\n");
    return 1;
  }
  const out = opt("--out");
  if (out) { if (out !== "/dev/null") fs.writeFileSync(out, r.body, { mode: 0o600 }); } else process.stdout.write(r.body);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
module.exports = { authorization, request, main };
