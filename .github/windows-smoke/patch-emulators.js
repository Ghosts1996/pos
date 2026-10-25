// Только для windows-smoke.yml: касса ходит в эмуляторы Firestore/Auth на
// этой же машине. Настройки офлайн-кэша остаются как в боевой сборке —
// проверяется ровно то, что получает заведение.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '..', 'lib', 'main.dart');
// На Windows checkout отдаёт файлы с CRLF — сравниваем по LF.
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
// Сразу после присваивания настроек Firestore (оператор целиком, до «;»).
const m = s.match(/\n( *)FirebaseFirestore\.instance\.settings = [\s\S]*?;\n/);
if (!m) throw new Error('не нашли настройки Firestore в lib/main.dart');
const anchor = m[0];
s = s.replace(anchor, anchor +
  "      FirebaseFirestore.instance.useFirestoreEmulator('127.0.0.1', 8080);\n" +
  "      await FirebaseAuth.instance.useAuthEmulator('127.0.0.1', 9099);\n");
// Вход теперь через AppAuth, и main.dart сам firebase_auth не импортирует.
if (!s.includes("package:firebase_auth/firebase_auth.dart")) {
  s = s.replace("import 'package:firebase_core/firebase_core.dart';\n",
    "import 'package:firebase_core/firebase_core.dart';\nimport 'package:firebase_auth/firebase_auth.dart';\n");
  if (!s.includes("package:firebase_auth/firebase_auth.dart")) throw new Error('не нашли импорт firebase_core в lib/main.dart');
}
fs.writeFileSync(file, s);
console.log('lib/main.dart: эмуляторы подключены');
