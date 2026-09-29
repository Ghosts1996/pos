// Файл конфигурации Firebase с заполненными ключами проекта
import 'dart:convert';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:http/http.dart' as http;
import 'build_info.dart';

class DefaultFirebaseOptions {
  // В SaaS-сборке (kSaasMode) ключи ниже не используются вовсе — вместо
  // них подставляются ключи ОТДЕЛЬНОГО Firebase-проекта платформы (см.
  // _saasAndroid) — поэтому "сконфигурировано" там означает не "заданы
  // ли эти константы" (они всегда заданы), а "передал ли сборщик реальные
  // --dart-define для SaaS-проекта".
  //
  // Windows — особый случай: у него нет своих SAAS_FIREBASE_*-констант
  // (см. _saasAndroid) — единственное, что нужно заранее знать, это адрес
  // самого шлюза, откуда конфигурация придёт уже в рантайме (см.
  // resolveWindowsOptions).
  static bool get isConfigured {
    if (!kSaasMode) return true;
    if (defaultTargetPlatform == TargetPlatform.windows) return kSaasGatewayUrl.isNotEmpty;
    return _saasAndroid.projectId.isNotEmpty;
  }

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('Web не настроен.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return kSaasMode ? _saasAndroid : android;
      case TargetPlatform.windows:
        final opts = _windowsOptions;
        if (opts == null) {
          throw StateError('Firebase для Windows не настроен — вызовите resolveWindowsOptions() до Firebase.initializeApp().');
        }
        return opts;
      default:
        throw UnsupportedError('Платформа не настроена.');
    }
  }

  static FirebaseOptions? _windowsOptions;

  /// Конфигурация Firebase для кассы на Windows приходит запросом к
  /// /firebaseConfig saas-gateway, а не через --dart-define: конфиг публичный,
  /// а десктопным плагинам хватает apiKey и projectId веб-приложения — лишняя
  /// регистрация и секреты не нужны. Вызывается до Firebase.initializeApp().
  static Future<void> resolveWindowsOptions() async {
    if (_windowsOptions != null) return;
    final uri = Uri.parse('$kSaasGatewayUrl/firebaseConfig');
    final res = await http.get(uri).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) {
      throw StateError('saas-gateway /firebaseConfig ответил ${res.statusCode}');
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    final projectId = json['projectId'] as String?;
    final apiKey = json['apiKey'] as String?;
    if (projectId == null || projectId.isEmpty || apiKey == null || apiKey.isEmpty) {
      throw StateError('saas-gateway /firebaseConfig вернул неполную конфигурацию');
    }
    _windowsOptions = FirebaseOptions(
      apiKey: apiKey,
      appId: (json['appId'] as String?) ?? '',
      messagingSenderId: (json['messagingSenderId'] as String?) ?? '',
      projectId: projectId,
      storageBucket: json['storageBucket'] as String?,
      authDomain: json['authDomain'] as String?,
    );
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
