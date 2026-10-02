// Только для windows-smoke.yml: касса ходит в эмуляторы Firestore/Auth на
// этой же машине. Настройки офлайн-кэша остаются как в боевой сборке —
// проверяется ровно то, что получает заведение.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '..', 'lib', 'main.dart');
let s = fs.readFileSync(file, 'utf8');
const anchor = '        cacheSizeBytes: Settings.CACHE_SIZE_UNLIMITED,\n      );\n';
if (!s.includes(anchor)) throw new Error('не нашли настройки Firestore в lib/main.dart');
s = s.replace(anchor, anchor +
  "      FirebaseFirestore.instance.useFirestoreEmulator('127.0.0.1', 8080);\n" +
  "      await FirebaseAuth.instance.useAuthEmulator('127.0.0.1', 9099);\n");
fs.writeFileSync(file, s);
console.log('lib/main.dart: эмуляторы подключены');
