// Файл конфигурации Firebase с заполненными ключами проекта
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'build_info.dart';

class DefaultFirebaseOptions {
  // В SaaS-сборке (kSaasMode) ключи ниже не используются вовсе — вместо
  // них подставляются ключи ОТДЕЛЬНОГО Firebase-проекта платформы (см.
  // _saasAndroid) — поэтому "сконфигурировано" там означает не "заданы
  // ли эти константы" (они всегда заданы), а "передал ли сборщик реальные
  // --dart-define для SaaS-проекта".
  static bool get isConfigured => kSaasMode ? _saasAndroid.projectId.isNotEmpty : true;

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('Web не настроен.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return kSaasMode ? _saasAndroid : android;
      default:
        throw UnsupportedError('Платформа не настроена.');
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyCXrbD9OOUtJG1G7L06fj-TQC8tmNLvL4k',
    appId: '1:1021237024665:android:4f2e1fe3e6c0e625756508',
    messagingSenderId: '1021237024665',
    projectId: 'hoocah-pos',
    storageBucket: 'hoocah-pos.firebasestorage.app',
  );

  /// Ключи SaaS-проекта платформы (saas/.firebaserc) — передаются сборщику
  /// через --dart-define (см. .github/workflows/saas-on-demand-build.yml),
  /// а не хранятся здесь константой: этот файл общий для обеих сборок, а
  /// SaaS-проект — отдельный от продового hoocah-pos и заводится каждым
  /// оператором платформы самостоятельно (saas/README.md, шаг 1).
  static const FirebaseOptions _saasAndroid = FirebaseOptions(
    apiKey: String.fromEnvironment('SAAS_FIREBASE_API_KEY'),
    appId: String.fromEnvironment('SAAS_FIREBASE_APP_ID'),
    messagingSenderId: String.fromEnvironment('SAAS_FIREBASE_MESSAGING_SENDER_ID'),
    projectId: String.fromEnvironment('SAAS_FIREBASE_PROJECT_ID'),
    storageBucket: String.fromEnvironment('SAAS_FIREBASE_STORAGE_BUCKET'),
  );
}
