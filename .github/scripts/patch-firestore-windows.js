// Исправление плагина cloud_firestore для Windows перед сборкой кассы
// (saas-on-demand-build.yml, windows-smoke.yml). Запускать после
// `flutter pub get` из корня проекта.
//
// Ошибка плагина (найдена проверкой windows-smoke, стек и текст исключения
// из отладчика): у него два кэша экземпляров Firestore с разными ключами.
// Обычные вызовы кладут экземпляр под «имя-приложения-база», а кодек —
// когда экземпляр приходит из Dart значением (runTransaction,
// snapshotsInSync, ссылки на документы в данных) — ищет его по одному
// имени приложения, не находит и снова вызывает set_settings у уже
// запущенного экземпляра. Firebase C++ SDK бросает исключение «Firestore
// instance has already been started…», плагин его не ловит — касса
// закрывается без сообщения на первой же транзакции.
//
// Там же размер кэша читался только как 64-битное число, а Dart передаёт
// -1 и всё, что меньше 2^31, 32-битным (std::bad_variant_access).
//
// Комментарии в C++ — по-английски: плагин собирается с /WX, а кириллица
// в файле без BOM на английской кодовой странице — предупреждение C4819.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const config = JSON.parse(fs.readFileSync(path.join('.dart_tool', 'package_config.json'), 'utf8'));

// firebase_auth (Windows): `&getProviderFromArguments(...)` берёт адрес
// временного объекта. Новый MSVC на windows-latest (ноябрь 2026) выдаёт на
// это C4238, плагин собирается с /WX — сборка кассы падала. Заменяем на
// функцию, которая возвращает адрес того же временного объекта: он живёт до
// конца выражения, как и раньше, поведение не меняется.
patchFirebaseAuth();

function patchFirebaseAuth() {
  const auth = config.packages.find((p) => p.name === 'firebase_auth');
  if (!auth) return;
  const authRoot = auth.rootUri.startsWith('file:')
    ? fileURLToPath(auth.rootUri)
    : path.resolve('.dart_tool', auth.rootUri);
  const authFile = path.join(authRoot, 'windows', 'firebase_auth_plugin.cpp');
  if (!fs.existsSync(authFile)) return;
  const AUTH_MARK = '// ZalPOS patch: C4238';
  let a = fs.readFileSync(authFile, 'utf8');
  if (a.includes(AUTH_MARK)) {
    console.log(`${authFile}: уже исправлен`);
    return;
  }
  const take = '&getProviderFromArguments(sign_in_provider)';
  if (!a.includes(take)) {
    console.log(`${authFile}: правка C4238 не нужна`);
    return;
  }
  const decl = 'firebase::auth::FederatedOAuthProvider getProviderFromArguments(';
  if (!a.includes(decl)) throw new Error(`${authFile}: не нашли getProviderFromArguments — версия плагина изменилась`);
  const eolA = a.includes('\r\n') ? '\r\n' : '\n';
  const helper = [
    AUTH_MARK + ' (address of a temporary is a warning, /WX makes it an error).',
    'static firebase::auth::FederatedOAuthProvider* zalProviderPtr(',
    '    firebase::auth::FederatedOAuthProvider&& provider) {',
    '  return &provider;',
    '}',
    '',
    '',
  ].join(eolA);
  a = a.replace(decl, helper + decl);
  a = a.split(take).join('zalProviderPtr(getProviderFromArguments(sign_in_provider))');
  fs.writeFileSync(authFile, a);
  console.log(`${authFile}: исправлен (C4238)`);
}

const pkg = config.packages.find((p) => p.name === 'cloud_firestore');
if (!pkg) throw new Error('cloud_firestore нет в .dart_tool/package_config.json — сначала flutter pub get');
const root = pkg.rootUri.startsWith('file:')
  ? fileURLToPath(pkg.rootUri)
  : path.resolve('.dart_tool', pkg.rootUri);
const file = path.join(root, 'windows', 'firestore_codec.cpp');
const MARK = '// ZalPOS patch';

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log(`${file}: уже исправлен`);
  process.exit(0);
}
const eol = src.includes('\r\n') ? '\r\n' : '\n';
src = src.replace(/\r\n/g, '\n');

const instanceOld = `      if (CloudFirestorePlugin::firestoreInstances_.find(appName) !=
          CloudFirestorePlugin::firestoreInstances_.end()) {
        return CustomEncodableValue(
            CloudFirestorePlugin::firestoreInstances_[appName].get());
      }

      firebase::App* app = firebase::App::GetInstance(appName.c_str());

      Firestore* firestore = Firestore::GetInstance(app);
      firestore->set_settings(settings);

      CloudFirestorePlugin::firestoreInstances_[appName] =
          std::unique_ptr<firebase::firestore::Firestore>(firestore);

      return CustomEncodableValue(firestore);`;

const instanceNew = `      ${MARK}: same cache key as GetFirestoreFromPigeon and no
      // set_settings on an instance that is already running (the SDK throws
      // and the uncaught exception terminates the app).
      const std::string cacheKey = appName + "-" + databaseUrl;
      auto& instances = CloudFirestorePlugin::firestoreInstances_;
      auto found = instances.find(cacheKey);
      if (found != instances.end()) {
        return CustomEncodableValue(found->second.get());
      }

      firebase::App* app = firebase::App::GetInstance(appName.c_str());

      Firestore* firestore = Firestore::GetInstance(app, databaseUrl.c_str());
      for (const auto& entry : instances) {
        if (entry.second.get() == firestore) {
          return CustomEncodableValue(firestore);
        }
      }
      try {
        firestore->set_settings(settings);
      } catch (const std::exception&) {
        // Already started: keep the settings it was started with.
      }

      instances[cacheKey] =
          std::unique_ptr<firebase::firestore::Firestore>(firestore);

      return CustomEncodableValue(firestore);`;

const cacheOld = 'int64_t cacheSizeBytes = std::get<int64_t>(map["cacheSizeBytes"]);';
const cacheNew = 'int64_t cacheSizeBytes = map["cacheSizeBytes"].LongValue();  // ZalPOS patch: int32 or int64';

for (const [name, from] of [['экземпляр Firestore', instanceOld], ['размер кэша', cacheOld]]) {
  if (!src.includes(from)) {
    throw new Error(`${file}: не нашли место правки «${name}» — версия плагина изменилась, проверьте исправление заново`);
  }
}
src = src.replace(instanceOld, instanceNew).replace(cacheOld, cacheNew);
fs.writeFileSync(file, src.replace(/\n/g, eol));
console.log(`${file}: исправлен (кэш экземпляров Firestore, размер кэша)`);
