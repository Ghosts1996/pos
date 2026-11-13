import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/chestny_znak_api_service.dart';
import 'package:hookah_pos/services/piot_service.dart';

void main() {
  group('ТС ПИоТ: разбор ответа', () {
    Map<String, dynamic> code({bool found = true, bool? verified = true, bool? realizable = true, bool blocked = false, bool sold = false, String? expire}) => {
          'cis': '0104650072140874215abc',
          'found': found,
          'valid': true,
          'verified': verified,
          'realizable': realizable,
          'isBlocked': blocked,
          'sold': sold,
          'errorCode': 0,
          if (expire != null) 'expireDate': expire,
        };

    test('вложенный codesResponse: reqId и время — для чека, можно продавать', () {
      final r = parsePiotResponse({
        'codesResponse': {
          'codesResponse': [
            {'code': 0, 'description': 'ok', 'codes': [code()], 'reqId': 'b2f1-uuid', 'reqTimestamp': 1794560000000, 'isCheckedOffline': false},
          ],
        },
      }, ['raw']);
      expect(r, hasLength(1));
      expect(r.first.valid, isTrue);
      expect(r.first.alreadyRetired, isFalse);
      expect(r.first.reqId, 'b2f1-uuid');
      expect(r.first.reqTimestamp, '1794560000000');
      expect(r.first.offline, isFalse);
    });

    test('плоский ответ как у True API и проверка без связи', () {
      final r = parsePiotResponse({
        'code': 0,
        'codes': [code()],
        'reqId': 'x1',
        'reqTimestamp': '1794560000001',
        'isCheckedOffline': true,
      }, ['raw']);
      expect(r.first.valid, isTrue);
      expect(r.first.reqId, 'x1');
    });

    test('причины отказа — понятным текстом', () {
      List<ChestnyZnakCodeCheck> one(Map<String, dynamic> c) => parsePiotResponse({'codesResponse': [{'code': 0, 'codes': [c], 'reqId': 'r', 'reqTimestamp': 1}]}, ['raw']);
      expect(one(code(found: false)).first.valid, isFalse);
      expect(one(code(found: false)).first.errorMessage, contains('не найден'));
      expect(one(code(verified: false)).first.errorMessage, contains('подлинности'));
      expect(one(code(realizable: false)).first.errorMessage, contains('не введён в оборот'));
      expect(one(code(blocked: true)).first.errorMessage, contains('заблокирован'));
      expect(one(code(expire: '2020-01-01T00:00:00Z')).first.errorMessage, contains('срок годности'));
      final sold = one(code(sold: true)).first;
      expect(sold.valid, isTrue);
      expect(sold.alreadyRetired, isTrue, reason: 'продан — касса не даст продать повторно');
    });

    test('ошибка группы (514) — исключение с подсказкой', () {
      expect(
        () => parsePiotResponse({'codesResponse': [{'code': 514, 'description': 'timeout', 'codes': []}]}, ['raw']),
        throwsA(isA<ChestnyZnakApiException>().having((e) => e.message, 'message', contains('антивирус'))),
      );
    });
  });

  group('ТС ПИоТ: настройки и адрес', () {
    test('адрес без пути — стандартный путь проверки, с путём — как есть', () {
      expect(PiotService(url: 'https://localhost:51401').checkUri.toString(), 'https://localhost:51401/api/v1/codes/check');
      expect(PiotService(url: '192.168.1.10:51402').checkUri.toString(), 'https://192.168.1.10:51402/api/v1/codes/check');
      expect(PiotService(url: 'https://localhost:51401/api/v2/codes/check').checkUri.path, '/api/v2/codes/check');
    });

    test('свой сертификат принимаем только от своего компьютера и локальной сети', () {
      for (final h in ['localhost', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.10', 'kassa.local']) {
        expect(PiotService.isLocalHost(h), isTrue, reason: h);
      }
      for (final h in ['8.8.8.8', 'markirovka.crpt.ru', '172.32.0.1', 'evil.example.com']) {
        expect(PiotService.isLocalHost(h), isFalse, reason: h);
      }
    });

    test('сведения о кассовой программе и включение из настроек', () {
      final p = piotFromSettings({'czMode': 'piot', 'czPiotUrl': '', 'czPiotId': 'abc', 'czPiotToken': 't'})!;
      expect(p.url, PiotService.defaultUrl);
      expect(p.clientInfo['name'], 'ZalPOS');
      expect(p.clientInfo['id'], 'abc');
      expect(p.clientInfo['token'], 't');
      expect(piotFromSettings({'czMode': 'token'}), isNull);
      expect(PiotService(url: 'https://localhost:51401').clientInfo.containsKey('id'), isFalse, reason: 'пустые поля не отправляем');
    });
  });

  test('запрос к ТС ПИоТ: путь, коды, сведения о кассе, логин; ответ разобран', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    Map<String, dynamic>? got;
    String? auth;
    String? path;
    server.listen((req) async {
      path = req.uri.path;
      auth = req.headers.value('authorization');
      got = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({
        'codesResponse': [
          {'code': 0, 'description': 'ok', 'reqId': 'req-42', 'reqTimestamp': 1794560000000, 'isCheckedOffline': false,
            'codes': [{'cis': got!['codes'][0], 'found': true, 'verified': true, 'realizable': true, 'isBlocked': false, 'sold': false}]},
        ],
      }));
      await req.response.close();
    });
    final p = PiotService(url: 'http://127.0.0.1:${server.port}', softId: 'zalpos-1', login: 'kassa', password: 'p');
    final r = await p.checkCodes(['0104650072140874215abc\u001d93dGVz']);
    await server.close(force: true);
    expect(path, '/api/v1/codes/check');
    expect(got!['codes'], ['0104650072140874215abc\u001d93dGVz']);
    expect(got!['client_info']['name'], 'ZalPOS');
    expect(got!['client_info']['id'], 'zalpos-1');
    expect(auth, 'Basic ${base64Encode(utf8.encode('kassa:p'))}');
    expect(r.single.valid, isTrue);
    expect(r.single.reqId, 'req-42');
  });

  test('ТС ПИоТ не запущен — понятная ошибка, а не зависание', () async {
    final p = PiotService(url: 'http://127.0.0.1:1');
    await expectLater(p.checkCodes(['x']), throwsA(isA<ChestnyZnakApiException>().having((e) => e.message, 'm', contains('не отвечает'))));
  });
}
