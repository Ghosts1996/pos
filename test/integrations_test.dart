import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/services/kassa_service.dart';
import 'package:hookah_pos/services/printer_service.dart';

void main() {
  group('Чековый принтер (ESC/POS)', () {
    test('CP866: кириллица кодируется, а не роняет печать', () {
      expect(Cp866Codec.encodeString('Стол'), [0x91, 0xE2, 0xAE, 0xAB]);
      expect(Cp866Codec.encodeString('Ёж ё'), [0xF0, 0xA6, 0x20, 0xF1]);
      expect(const Cp866Codec().decode(Cp866Codec.encodeString('500 ₽')), '500 р.');
      expect(Cp866Codec.encodeString('😀'), [0x3F]);
      expect(const Cp866Codec().decode(Cp866Codec.encodeString('Итого: 1 200')), 'Итого: 1 200');
    });

    test('сетевой принтер получает чек с кодовой страницей CP866 и русским текстом', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final received = <int>[];
      final done = Completer<void>();
      server.listen((socket) {
        socket.listen(received.addAll, onDone: () {
          if (!done.isCompleted) done.complete();
        });
      });
      final printer = NetworkReceiptPrinter(ip: '127.0.0.1', port: server.port);
      await printer.printReceipt(ReceiptData(
        venueName: 'Лаунж',
        tableName: 'VIP 1',
        employeeName: 'Анна',
        closedAt: DateTime(2026, 9, 26, 21, 5),
        items: const [ReceiptLine('Кальян x1', right: '1500')],
        total: 1500,
        paymentMethod: 'наличные 1500₽',
      ));
      await done.future.timeout(const Duration(seconds: 5));
      await server.close();

      bool contains(List<int> needle) {
        for (var i = 0; i + needle.length <= received.length; i++) {
          var ok = true;
          for (var j = 0; j < needle.length; j++) {
            if (received[i + j] != needle[j]) {
              ok = false;
              break;
            }
          }
          if (ok) return true;
        }
        return false;
      }

      expect(contains([0x1B, 0x74, 17]), isTrue, reason: 'ESC t 17 — кодовая страница CP866');
      expect(contains(Cp866Codec.encodeString('Лаунж')), isTrue);
      expect(contains(Cp866Codec.encodeString('Официант: Анна')), isTrue);
      expect(contains(Cp866Codec.encodeString('Кальян x1')), isTrue);
      expect(contains(Cp866Codec.encodeString('1500 р.')), isTrue);
    });
  });

  group('Фискальный чек: суммы', () {
    test('сумма позиции и чека — ровно с копейками', () {
      const item = FiscalReceiptItem(name: 'Чай', price: 333.33, quantity: 3);
      expect(item.sum, 999.99);
      const r = FiscalReceipt(receiptId: 'r', items: [item, item], payments: []);
      expect(r.total, 1999.98);
    });

    test('лишняя копейка от скидки снимается с наличных', () {
      final p = balancePayments(const [FiscalPayment('cash', 200), FiscalPayment('card', 800)], 999.99);
      expect(p.map((e) => '${e.type}:${e.amount}'), ['cash:199.99', 'card:800.0']);
    });

    test('недостающие копейки добавляются к самому крупному платежу', () {
      final p = balancePayments(const [FiscalPayment('cash', 200), FiscalPayment('card', 799.98)], 999.99);
      expect(p.map((e) => '${e.type}:${e.amount}'), ['cash:200.0', 'card:799.99']);
    });

    test('сдача: в чек идёт только причитающееся, лишнее снимается с наличных', () {
      final p = balancePayments(const [FiscalPayment('cash', 2000), FiscalPayment('prepayment', 100)], 1500);
      expect(p.map((e) => '${e.type}:${e.amount}'), ['cash:1400.0', 'prepayment:100.0']);
    });

    test('сдача больше наличных снимается и с карты, пустые платежи убираются', () {
      final p = balancePayments(const [FiscalPayment('cash', 100), FiscalPayment('card', 1000)], 900);
      expect(p.map((e) => '${e.type}:${e.amount}'), ['card:900.0']);
    });

    test('недоплату больше рубля не «дорисовываем»', () {
      final p = balancePayments(const [FiscalPayment('cash', 500)], 900);
      expect(p.single.amount, 500);
    });
  });

  group('Облачная касса АТОЛ Онлайн (протокол v4)', () {
    late HttpServer server;
    final requests = <String>[];
    var tokenCalls = 0;
    var failFirstSell = false;
    var lastVersion = '';
    Map<String, dynamic>? lastSell;

    setUp(() async {
      // TestWidgetsFlutterBinding (тест принтера выше) подменяет HTTP
      // заглушкой с ответом 400 — здесь нужен настоящий клиент.
      HttpOverrides.global = null;
      requests.clear();
      tokenCalls = 0;
      lastSell = null;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        final body = await utf8.decodeStream(req);
        requests.add('${req.method} ${req.uri.path} ${req.headers.value('Token') ?? ''}');
        req.response.headers.contentType = ContentType.json;
        final path = req.uri.path.replaceFirst('/possystem/v4/', '/possystem/v5/');
        lastVersion = req.uri.path.contains('/v4/') ? 'v4' : 'v5';
        if (path == '/possystem/v5/getToken') {
          tokenCalls++;
          final creds = jsonDecode(body) as Map;
          if (creds['pass'] != 'secret') {
            req.response.statusCode = 401;
            req.response.write(jsonEncode({
              'error': {'code': 12, 'text': 'Неверный логин или пароль', 'type': 'system'},
            }));
          } else {
            req.response.write(jsonEncode({'token': 'T$tokenCalls', 'error': null}));
          }
        } else if (path == '/possystem/v5/G1/sell') {
          if (failFirstSell && req.headers.value('Token') == 'T1') {
            req.response.statusCode = 401;
            req.response.write(jsonEncode({'error': {'code': 11, 'text': 'Токен устарел'}}));
          } else {
            lastSell = jsonDecode(body) as Map<String, dynamic>;
            req.response.write(jsonEncode({'uuid': 'u-1', 'status': 'wait', 'error': null}));
          }
        } else if (path == '/possystem/v5/G1/report/u-1') {
          req.response.write(jsonEncode({
            'status': 'done',
            'payload': {'fiscal_document_number': 42, 'fiscal_document_attribute': 777, 'fn_number': '999'},
          }));
        } else {
          req.response.statusCode = 404;
        }
        await req.response.close();
      });
    });

    tearDown(() => server.close(force: true));

    AtolCloudKassaService kassa({String pass = 'secret', String? url, String version = 'v5'}) => AtolCloudKassaService(
          apiVersion: version,
          baseUrl: url ?? 'http://127.0.0.1:${server.port}/',
          groupCode: 'G1',
          login: 'l',
          password: pass,
          companyInn: '7700000000',
          companyEmail: 'a@b.ru',
          companyPaymentAddress: 'Москва',
          companySno: FiscalTaxSystem.usnIncome,
        );

    const receipt = FiscalReceipt(
      receiptId: 'sess-1',
      items: [FiscalReceiptItem(name: 'Кальян', price: 333.33, quantity: 3)],
      payments: [FiscalPayment('card', 999.99)],
      buyerContact: 'guest@mail.ru',
    );

    test('чек пробивается, суммы — с копейками, ФД из отчёта', () async {
      final res = await kassa().sendReceipt(receipt);
      expect(res.success, isTrue, reason: res.errorMessage);
      expect(res.fiscalDocumentNumber, '42');
      expect(res.fiscalSign, '777');
      final r = lastSell!['receipt'] as Map;
      expect(lastSell!['external_id'], 'sess-1');
      expect((r['items'] as List).first['sum'], 999.99);
      expect(r['total'], 999.99);
      // Безналичная оплата — код 1 (раньше уходил 2 — «зачёт аванса»).
      expect((r['payments'] as List).first, {'type': 1, 'sum': 999.99});
      expect(lastVersion, 'v5');
      final item = (r['items'] as List).first as Map;
      expect(item['payment_object'], 1);
      expect(item['measure'], 0);
      expect((r['company'] as Map)['sno'], 'usn_income');
      expect((r['client'] as Map)['email'], 'guest@mail.ru');
      expect(requests.first, startsWith('POST /possystem/v5/getToken'), reason: 'адрес без двойного слэша');
    });

    test('протухший токен: касса берёт новый и повторяет чек', () async {
      failFirstSell = true;
      final res = await kassa().sendReceipt(receipt);
      failFirstSell = false;
      expect(res.success, isTrue, reason: res.errorMessage);
      expect(tokenCalls, 2);
    });

    test('неверный пароль — понятная ошибка, а не Map', () async {
      final res = await kassa(pass: 'bad').sendReceipt(receipt);
      expect(res.success, isFalse);
      expect(res.errorMessage, contains('Неверный логин или пароль'));
      expect(res.errorMessage, isNot(contains('{')));
    });

    test('v4 (ФФД 1.05): старые пути и строковый предмет расчёта; маркировку не пробивает', () async {
      final res = await kassa(version: 'v4').sendReceipt(receipt);
      expect(res.success, isTrue, reason: res.errorMessage);
      expect(lastVersion, 'v4');
      expect(((lastSell!['receipt'] as Map)['items'] as List).first['payment_object'], 'commodity');
      final marked = await kassa(version: 'v4').sendReceipt(const FiscalReceipt(
        receiptId: 'm',
        items: [FiscalReceiptItem(name: 'Табак', price: 900, quantity: 1, markingCode: '0104600000000001215abc')],
        payments: [FiscalPayment('cash', 900)],
      ));
      expect(marked.success, isFalse);
      expect(marked.errorMessage, contains('ФФД 1.2'));
    });

    test('пустой адрес — АТОЛ Онлайн по умолчанию', () {
      expect(kassa(url: '').baseUrl, AtolCloudKassaService.defaultBaseUrl);
      expect(buildKassaService({'kassaType': 'orange_data'}), isA<OrangeDataKassaService>());
      expect((buildKassaService({'kassaType': 'orange_data'}) as OrangeDataKassaService).baseUrl,
          'https://api.orangedata.ru:12003/api/v2');
    });
  });

  group('Тело чека v5 / OrangeData ФФД 1.2', () {
    final atol = AtolCloudKassaService(
      baseUrl: '',
      groupCode: 'G',
      login: 'l',
      password: 'p',
      companyInn: '7700000000',
      companyEmail: 'lounge@mail.ru',
      companyPaymentAddress: 'Москва',
    );
    const code = '0104600000000001215abcdef\u001d93ABCD';
    const permit = MarkingPermit(reqId: 'b1c2', reqTimestamp: '1727337600000');
    const receipt = FiscalReceipt(
      receiptId: 'r1',
      items: [
        FiscalReceiptItem(name: 'Кальян', price: 1500, quantity: 1, paymentObject: FiscalPaymentObject.service, vat: FiscalVatRate.vat22),
        FiscalReceiptItem(
          name: 'Табак',
          price: 900,
          quantity: 1,
          paymentObject: FiscalPaymentObject.excise,
          vat: FiscalVatRate.vat5,
          markingCode: code,
          markingPermit: permit,
        ),
        FiscalReceiptItem(name: 'Вода', price: 150, quantity: 2, markingCode: code),
      ],
      payments: [FiscalPayment('cash', 2000), FiscalPayment('card', 500), FiscalPayment('prepayment', 200)],
      buyerContact: '8 (999) 123-45-67',
    );

    test('АТОЛ v5: предмет расчёта, НДС, код маркировки и разрешительный режим', () {
      final r = atol.buildReceiptBody(receipt)['receipt'] as Map;
      final items = (r['items'] as List).cast<Map>();
      expect(items[0]['payment_object'], 4);
      expect(items[0]['vat'], {'type': 'vat22'});
      expect(items[0].containsKey('mark_code'), isFalse);
      expect(items[1]['payment_object'], 31, reason: 'подакцизный с маркировкой');
      expect(items[1]['vat'], {'type': 'vat5'});
      expect(items[1]['mark_processing_mode'], '0');
      expect(utf8.decode(base64.decode((items[1]['mark_code'] as Map)['gs1m'] as String)), code);
      expect(items[1]['sectoral_item_props'], [
        {'federal_id': '030', 'date': '21.11.2023', 'number': '1944', 'value': 'UUID=b1c2&Time=1727337600000'},
      ]);
      expect(items[2]['payment_object'], 33, reason: 'товар с маркировкой');
      expect(items[2].containsKey('sectoral_item_props'), isFalse);
      expect((r['payments'] as List).map((p) => (p as Map)['type']), [0, 1, 2]);
      expect(r['client'], {'phone': '+79991234567'});
    });

    test('АТОЛ: без контакта гостя чек уходит на e-mail заведения', () {
      final r = atol.buildReceiptBody(const FiscalReceipt(
        receiptId: 'r2',
        items: [FiscalReceiptItem(name: 'Чай', price: 300, quantity: 1)],
        payments: [FiscalPayment('cash', 300)],
      ))['receipt'] as Map;
      expect(r['client'], {'email': 'lounge@mail.ru'});
    });

    test('OrangeData: ФФД 1.2, коды НДС 22/5/без НДС, itemCode и отраслевой реквизит', () {
      final od = OrangeDataKassaService(inn: '7700000000', clientCertPem: 'c', clientKeyPem: 'k');
      final c = od.buildDocument(receipt)['content'] as Map;
      expect(c['ffdVersion'], 4);
      final p = (c['positions'] as List).cast<Map>();
      expect(p.map((e) => e['tax']), [1, 7, 6]);
      expect(p.map((e) => e['paymentSubjectType']), [4, 31, 33]);
      expect(p.every((e) => e['quantityMeasurementUnit'] == 0), isTrue);
      expect(p[1]['itemCode'], code);
      expect(p[1]['plannedStatus'], 1);
      expect((p[1]['industryAttribute'] as Map)['foivId'], '030');
      expect(c['customerContact'], '+79991234567');
      expect(((c['checkClose'] as Map)['payments'] as List).map((e) => (e as Map)['type']), [1, 2, 14]);
    });

    test('коды НДС для всех ставок', () {
      expect(FiscalVatRate.values.map((v) => v.providerCode),
          ['none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22']);
      expect(FiscalVatRate.values.map((v) => v.orangeDataCode), [6, 5, 7, 8, 2, 1, 1]);
      expect(FiscalVatRateX.fromId('bogus'), FiscalVatRate.none);
      expect(normalizeReceiptPhone('+7 (999) 000-11-22'), '+79990001122');
      expect(normalizeReceiptPhone('9990001122'), '+79990001122');
    });
  });
}
