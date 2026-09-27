import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/human_error.dart';

void main() {
  group('Понятные ошибки', () {
    test('Firebase: нет сети и нет доступа — по-русски', () {
      expect(humanError(FirebaseException(plugin: 'cloud_firestore', code: 'unavailable', message: 'The service is currently unavailable')),
          'Нет связи с сервером — проверьте интернет');
      expect(humanError(FirebaseException(plugin: 'cloud_firestore', code: 'permission-denied'), lower: true),
          startsWith('нет доступа'));
    });
    test('веб-строка с кодом Firebase распознаётся', () {
      expect(humanError('[cloud_firestore/unauthenticated] Missing or insufficient permissions.'), 'Сессия истекла — войдите заново');
    });
    test('свои русские исключения показываются без служебного префикса', () {
      expect(humanError(StateError('Стол уже занят')), 'Стол уже занят');
      expect(humanError(Exception('Код приглашения неверный'), lower: true), 'код приглашения неверный');
      expect(humanError(Exception('PIN не подходит'), lower: true), 'PIN не подходит', reason: 'аббревиатуры не трогаем');
    });
    test('сеть и таймауты', () {
      expect(humanError('SocketException: Failed host lookup: firestore.googleapis.com'), 'Нет связи с сервером — проверьте интернет');
      expect(humanError(TimeoutException('x')), 'Сервер не ответил вовремя — проверьте интернет');
    });
    test('непонятное английское — без технических деталей', () {
      expect(humanError(Exception('Null check operator used on a null value')), 'Что-то пошло не так — попробуйте ещё раз');
      expect(humanError(null), 'Что-то пошло не так — попробуйте ещё раз');
    });
  });
}
