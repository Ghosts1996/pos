// ЭТОТ ФАЙЛ — ШАБЛОН. Сгенерируйте настоящий автоматически:
//   1) dart pub global activate flutterfire_cli
//   2) flutterfire configure
// Команда сама создаст проект в Firebase и перезапишет этот файл
// реальными ключами (android/ios/web). Ничего вручную вписывать не нужно.
//
// Пока в этом файле заглушка ('REPLACE_ME'), приложение при запуске
// покажет экран с инструкцией по настройке вместо аварийного закрытия —
// см. main.dart и screens/setup_required_screen.dart.

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  /// true, если flutterfire configure уже подставил реальные ключи.
  static bool get isConfigured => android.apiKey != 'REPLACE_ME';

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('Web не настроен. Запустите flutterfire configure.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      default:
        throw UnsupportedError('Платформа не настроена. Запустите flutterfire configure.');
    }
  }

  // Заглушка — будет заменена реальными значениями командой flutterfire configure
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'REPLACE_ME',
    appId: 'REPLACE_ME',
    messagingSenderId: 'REPLACE_ME',
    projectId: 'REPLACE_ME',
    storageBucket: 'REPLACE_ME',
  );
}
