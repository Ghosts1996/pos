"use strict";
// Тесты правил доступа (saas/test/firestore.rules.test.js) — против
// собственного сервера данных, без эмулятора Firebase:
//   node saas-gateway/test.rules-local.js
const Module = require("module");
const path = require("path");
const shim = require("./test-firestore-shim");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "firebase/firestore") return shim.firestore;
  if (request === "@firebase/rules-unit-testing") return shim.rulesTesting;
  return origLoad.apply(this, arguments);
};
const testDir = path.join(__dirname, "..", "saas", "test");
let mochaPath;
try {
  mochaPath = require.resolve("mocha", { paths: [testDir] });
} catch (_) {
  // Не пропускаем молча: без mocha тест правил доступа — провал.
  console.error("rules-local: нет mocha — выполните: cd saas/test && npm ci");
  process.exit(1);
}
const Mocha = require(mochaPath);
const mocha = new Mocha({ timeout: 20000, reporter: process.env.RULES_REPORTER || "dot" });
mocha.addFile(path.join(testDir, "firestore.rules.test.js"));
// Без исключений: каждый тест правил должен пройти на своём сервере данных.
// Запрос с чужим документом в выдаче отклоняется целиком (data-server.js
// queryDocs), как «правила — не фильтр» в Firestore.
const failed = [];
const runner = mocha.run(() => {
  if (failed.length) console.error(`\nrules-local: упало ${failed.length}`);
  else console.log("\nrules-local: все тесты правил прошли");
  process.exitCode = failed.length ? 1 : 0;
});
runner.on("fail", (test) => failed.push(test.title));
