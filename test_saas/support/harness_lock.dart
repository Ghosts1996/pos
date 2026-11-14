// Тестовый сервер данных (saas-gateway/test-data-harness.js) — один на все
// файлы тестов, а flutter test гоняет файлы параллельно. Файл, который
// «выдёргивает интернет» или закрывает запись, ломал бы соседний. Поэтому
// каждый файл занимает стенд целиком на время своих тестов.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:http/http.dart' as http;

/// Занять стенд в setUpAll и освободить в tearDownAll. Без LOCAL_DB_URL —
/// ничего (тесты стенда тогда пропускаются сами).
void useHarnessExclusively(String url) {
  if (url.isEmpty) return;
  final owner = '${Platform.script.pathSegments.last}#$pid#${DateTime.now().microsecondsSinceEpoch}';
  setUpAll(() async {
    await http
        .post(Uri.parse('$url/__lock'), body: jsonEncode({'owner': owner}))
        .timeout(const Duration(minutes: 12));
  });
  tearDownAll(() async {
    await http.post(Uri.parse('$url/__unlock'), body: jsonEncode({'owner': owner})).catchError((Object _) => http.Response('', 0));
  });
}

/// Тесты test_saas/ — только для сборки платформы и со стендом. Без них
/// не «пропускаемся», а падаем с подсказкой, как запускать.
void requireSaasHarness({String url = '', bool harness = true}) {
  setUpAll(() {
    if (!kSaasMode || (harness && url.isEmpty)) {
      fail('test_saas/ запускается так: node saas-gateway/test-data-harness.js 8787 & '
          'LOCAL_DB_URL=http://127.0.0.1:8787 flutter test --dart-define=SAAS_MODE=true '
          '--dart-define=SAAS_GATEWAY_URL=http://127.0.0.1:9 test_saas');
    }
  });
}
