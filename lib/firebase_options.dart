// Файл конфигурации Firebase с заполненными ключами проекта
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;

class DefaultFirebaseOptions {
  static bool get isConfigured => true;

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError('Web не настроен.');
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
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
}