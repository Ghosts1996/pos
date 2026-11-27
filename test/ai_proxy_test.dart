import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/ai/ai_settings.dart';
import 'package:hookah_pos/services/ai/tooken_client.dart';

/// ИИ через сервер платформы (/aiProxy): сбой провайдера основного ключа —
/// сразу резервный ключ, без лишних повторов (сервер уже повторял); номер
/// вопроса гостя уходит в каждом запросе; отказ платформы — без перебора.
void main() {
  late HttpServer srv;
  final calls = <Map<String, dynamic>>[];
  var mode = 'primary502';

  setUpAll(() async {
    srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    srv.listen((req) async {
      final body = jsonDecode(await utf8.decodeStream(req)) as Map<String, dynamic>;
      calls.add(body);
      req.response.headers.contentType = ContentType.json;
      if (mode == 'gateway') {
        req.response.statusCode = 403;
        req.response.write(jsonEncode({'error': 'ИИ в этом заведении выключен', 'gateway': true}));
      } else if (body['slot'] == 'primary') {
        req.response.statusCode = 502;
        req.response.write(jsonEncode({'error': 'Провайдер ИИ не ответил: таймаут'}));
      } else {
        req.response.write(jsonEncode({
          'choices': [
            {'message': {'content': 'Ответ резервного'}, 'finish_reason': 'stop'}
          ],
          'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
        }));
      }
      await req.response.close();
    });
    TookenClient.instance.useGatewayProxy('http://127.0.0.1:${srv.port}');
    AiSettingsStore.instance.debugCurrent = AiSettings.fromMap({
      'enabled': true,
      'vendor': 'tooken',
      'fallbackVendor': 'darkapi',
      'vendors': {
        'tooken': {'hasKey': true},
        'darkapi': {'hasKey': true},
      },
    });
  });

  tearDownAll(() => srv.close(force: true));

  test('сбой провайдера: один запрос к основному, затем резервный; номер вопроса в каждом', () async {
    calls.clear();
    final turn = TookenClient.instance.newTurn();
    final res = await TookenClient.instance.complete(messages: const [AiMessage.user('привет')]);
    expect(res.text, 'Ответ резервного');
    expect(calls.map((c) => c['slot']).toList(), ['primary', 'fallback']);
    expect(calls.every((c) => c['turn'] == turn), isTrue);
  });

  test('отказ платформы (gateway) — без перебора ключей и повторов', () async {
    mode = 'gateway';
    calls.clear();
    await expectLater(
      TookenClient.instance.complete(messages: const [AiMessage.user('привет')]),
      throwsA(isA<AiException>().having((e) => e.message, 'message', contains('выключен'))),
    );
    expect(calls.length, 1);
  });
}
