import 'package:firebase_core/firebase_core.dart';

import '../data/app_db.dart';
import '../firebase_options.dart';
import 'app_auth.dart';

/// Подготовка фоновой службы кассы или приложения гостя.
///
/// Служба живёт в своём изоляте со своей памятью: там всё поднимается
/// заново. Данные и вход — те же, что у приложения (сервер данных в РФ и
/// свой вход платформы), но только сохранённое: новый вход и обмен входа
/// Firebase делает само приложение, иначе два изолята делали бы это
/// наперегонки. Данные — в памяти, без папки устройства (её ведёт
/// приложение). true — вход есть.
Future<bool> bootBackgroundIsolate() async {
  if (Firebase.apps.isEmpty) {
    await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  }
  await AppDb.init(background: true);
  await AppAuth.instance.init(restoreOnly: true);
  return AppAuth.instance.currentUser != null;
}
