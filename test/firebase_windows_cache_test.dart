import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:hookah_pos/firebase_options.dart';

void main() {
  const config = {
    'apiKey': 'AIza-public',
    'appId': '1:2:web:3',
    'messagingSenderId': '2',
    'projectId': 'zalpos-saas',
    'storageBucket': 'zalpos-saas.appspot.com',
    'authDomain': 'zalpos-saas.firebaseapp.com',
  };

  test('конфигурация собирается из ответа шлюза', () {
    final o = DefaultFirebaseOptions.optionsFromJson(config);
    expect(o.projectId, 'zalpos-saas');
    expect(o.apiKey, 'AIza-public');
    expect(o.authDomain, 'zalpos-saas.firebaseapp.com');
  });

  test('неполная конфигурация отклоняется', () {
    expect(() => DefaultFirebaseOptions.optionsFromJson({'projectId': 'x'}), throwsStateError);
  });

  test('без сети касса берёт последнюю сохранённую конфигурацию', () async {
    SharedPreferences.setMockInitialValues({'firebase_web_config_v1': jsonEncode(config)});
    final o = await DefaultFirebaseOptions.cachedWindowsOptions();
    expect(o?.projectId, 'zalpos-saas');
  });

  test('нет сохранённой конфигурации — null, а не мусор', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await DefaultFirebaseOptions.cachedWindowsOptions(), isNull);
    SharedPreferences.setMockInitialValues({'firebase_web_config_v1': '{broken'});
    expect(await DefaultFirebaseOptions.cachedWindowsOptions(), isNull);
  });
}
