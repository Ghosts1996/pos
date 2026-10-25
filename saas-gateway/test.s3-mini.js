"use strict";
// Подпись S3 (s3-mini.js) — на официальных примерах AWS Signature V4 для S3.
const { authorization } = require("./s3-mini");
const crypto = require("crypto");
const base = { accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", amzDate: "20130524T000000Z" };
const E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const host = "examplebucket.s3.amazonaws.com";
const cases = [
  ["GET object", { method: "GET", path: "/test.txt", query: new URLSearchParams(""), payloadHash: E,
    headers: { host, range: "bytes=0-9", "x-amz-content-sha256": E, "x-amz-date": base.amzDate } }, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"],
  ["PUT object", (() => { const h = crypto.createHash("sha256").update("Welcome to Amazon S3.").digest("hex"); return { method: "PUT", path: "/test%24file.text", query: new URLSearchParams(""), payloadHash: h,
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", host, "x-amz-content-sha256": h, "x-amz-date": base.amzDate, "x-amz-storage-class": "REDUCED_REDUNDANCY" } }; })(), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"],
  ["GET ?lifecycle", { method: "GET", path: "/", query: new URLSearchParams("lifecycle"), payloadHash: E,
    headers: { host, "x-amz-content-sha256": E, "x-amz-date": base.amzDate } }, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"],
  ["LIST", { method: "GET", path: "/", query: new URLSearchParams("max-keys=2&prefix=J"), payloadHash: E,
    headers: { host, "x-amz-content-sha256": E, "x-amz-date": base.amzDate } }, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"],
];
let bad = 0;
for (const [name, c, want] of cases) {
  const sig = authorization({ ...base, ...c }).match(/Signature=(\w+)/)[1];
  console.log(sig === want ? "ok  " : "FAIL", name, sig === want ? "" : sig);
  if (sig !== want) bad++;
}
console.log(`s3-mini: ${cases.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
