import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/gateway_api.dart';
import 'package:hookah_pos/services/hookah/tobacco_shelf.dart';

// Фото большой полки: ИИ читает дольше минуты. Касса отдаёт снимок заданием
// и забирает результат опросами; короткий обрыв связи — не «нет связи».
void main() {
  setUp(() => TobaccoShelf.scanPollEvery = Duration.zero);
  tearDown(() => TobaccoShelf.gatewayPost = GatewayApi.post);

  test('задание: «читаю», обрыв связи, затем готово', () async {
    final calls = <String>[];
    var polls = 0;
    TobaccoShelf.gatewayPost = (path, body, timeout) async {
      calls.add(body['action'] as String);
      if (body['action'] == 'scanStart') {
        expect(timeout.inSeconds, greaterThanOrEqualTo(60));
        return {'job': 'j1'};
      }
      polls++;
      if (polls == 2) throw GatewayException('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
      if (polls < 4) return {'status': 'running'};
      return {
        'status': 'done',
        'items': [
          {'brand': 'Blanch', 'name': 'Мангомания', 'flavors': ['манго']},
        ],
      };
    };
    final r = await TobaccoShelf.scanPageForTest({'mediaType': 'image/jpeg', 'data': 'QUJD'});
    expect((r['items'] as List).length, 1);
    expect(calls.first, 'scanStart');
    expect(polls, 4);
  });

  test('ИИ не прочитал — понятная причина, а не «нет связи»', () async {
    TobaccoShelf.gatewayPost = (path, body, timeout) async =>
        body['action'] == 'scanStart' ? {'job': 'j2'} : {'status': 'failed', 'error': 'ИИ не распознал полку: модель занята'};
    expect(
      () => TobaccoShelf.scanPageForTest({'mediaType': 'image/jpeg', 'data': 'QUJD'}),
      throwsA(isA<GatewayException>().having((e) => e.message, 'message', contains('модель занята'))),
    );
  });

  test('сервер старой версии — по-старому, одним запросом', () async {
    TobaccoShelf.gatewayPost = (path, body, timeout) async {
      if (body['action'] == 'scanStart') throw GatewayException('Неизвестное действие');
      return {'items': []};
    };
    final r = await TobaccoShelf.scanPageForTest({'mediaType': 'image/jpeg', 'data': 'QUJD'});
    expect(r['items'], isEmpty);
  });
}
