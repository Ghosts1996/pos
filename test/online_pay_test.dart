import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/online_pay.dart';
import 'package:hookah_pos/services/gateway_api.dart';
import 'package:hookah_pos/services/payment_terminal_service.dart';

void main() {
  test('банки приложения — те же, что знает шлюз (guest-pay.js PROVIDERS)', () {
    final js = File('saas-gateway/guest-pay.js').readAsStringSync();
    final block = RegExp(r'const PROVIDERS = \{([^}]*)\}').firstMatch(js)!.group(1)!;
    final gateway = RegExp(r'^\s*(\w+):', multiLine: true).allMatches(block).map((m) => m.group(1)).toSet();
    expect(OnlinePayProvider.all.map((p) => p.id).toSet(), gateway);
    final web = File('saas/guest-web/app/app.js').readAsStringSync();
    final webList = RegExp(r"const PAY_PROVIDERS = \[([^\]]*)\]").firstMatch(web)!.group(1)!;
    expect(RegExp(r"'(\w+)'").allMatches(webList).map((m) => m.group(1)).toSet(), gateway);
  });

  test('по СБП платят Т-Банк (QR) и Райффайзенбанк, остальные — страница банка', () {
    expect(OnlinePayProvider.payLabel('tinkoff'), 'Оплатить по СБП');
    expect(OnlinePayProvider.payLabel('raiffeisen'), 'Оплатить по СБП');
    expect(OnlinePayProvider.payLabel('vtb'), 'Оплатить онлайн');
    expect(OnlinePayProvider.payLabel('tinkoff_form'), 'Оплатить онлайн');
  });

  test('адрес API другого банка: https-домен с путём /payment/rest', () {
    expect(OnlinePayProvider.urlProblem('https://pay.examplebank.ru/payment/rest'), isNull);
    expect(OnlinePayProvider.urlProblem('https://pay.examplebank.ru/ab/payment/rest/'), isNull);
    for (final bad in [
      '',
      'http://pay.bank.ru/payment/rest',
      'https://10.0.0.1/payment/rest',
      'https://[::1]/payment/rest',
      'https://localhost/payment/rest',
      'https://pay.bank.ru:8443/payment/rest',
      'https://pay.bank.ru/payment/rest?a=1',
      'https://pay.bank.ru/admin',
    ]) {
      expect(OnlinePayProvider.urlProblem(bad), isNotNull, reason: bad);
    }
  });

  group('QR на экране кассы через шлюз', () {
    test('гость заплатил — оплата прошла, номер платежа сохраняется', () async {
      final calls = <String>[];
      var polls = 0;
      final svc = GatewayQrTerminalService(
        pollEvery: const Duration(milliseconds: 1),
        post: (path, body) async {
          calls.add(path);
          if (path == 'kassaPayStart') {
            expect(body['amount'], 1250.5);
            return {'paymentId': 'k_1', 'url': 'https://qr.nspk.ru/X', 'ttlSec': 5, 'sbp': true, 'bank': 'Т-Банк'};
          }
          if (path == 'kassaPayStatus') return {'status': ++polls >= 2 ? 'paid' : 'pending'};
          return {'status': 'cancelled'};
        },
      );
      final r = await svc.pay(1250.5);
      expect(r.success, isTrue);
      expect(r.operationId, 'k_1');
      expect(calls, isNot(contains('kassaPayCancel')));
    });

    test('код истёк — платёж отменяется; успел заплатить в последний момент — засчитан', () async {
      for (final last in ['cancelled', 'paid']) {
        final calls = <String>[];
        final svc = GatewayQrTerminalService(
          pollEvery: const Duration(milliseconds: 1),
          post: (path, body) async {
            calls.add(path);
            if (path == 'kassaPayStart') return {'paymentId': 'k_2', 'url': 'https://pay.bank.ru/x', 'ttlSec': 0};
            if (path == 'kassaPayStatus') return {'status': 'pending'};
            return {'status': last};
          },
        );
        final r = await svc.pay(300);
        expect(calls.last, 'kassaPayCancel');
        expect(r.success, last == 'paid', reason: last);
      }
    });

    test('банк не подключён — понятная ошибка шлюза', () async {
      final svc = GatewayQrTerminalService(
        post: (path, body) async => throw GatewayException('Банк не подключён: Настройки → Интеграции'),
      );
      final r = await svc.pay(100);
      expect(r.success, isFalse);
      expect(r.errorMessage, contains('Банк не подключён'));
    });

    test('банк отклонил — отказ без отмены', () async {
      final calls = <String>[];
      final svc = GatewayQrTerminalService(
        pollEvery: const Duration(milliseconds: 1),
        post: (path, body) async {
          calls.add(path);
          if (path == 'kassaPayStart') return {'paymentId': 'k_3', 'url': 'https://pay.bank.ru/x', 'ttlSec': 5};
          return {'status': 'failed'};
        },
      );
      final r = await svc.pay(100);
      expect(r.success, isFalse);
      expect(r.errorMessage, 'Банк отклонил оплату');
      expect(calls, isNot(contains('kassaPayCancel')));
    });

    testWidgets('окно с QR: сумма и банк, закрывается само, когда гость заплатил', (tester) async {
      var paid = false;
      final svc = GatewayQrTerminalService(
        post: (path, body) async {
          if (path == 'kassaPayStart') {
            return {'paymentId': 'k_9', 'url': 'https://qr.nspk.ru/AD1', 'ttlSec': 300, 'sbp': true, 'bank': 'Райффайзенбанк', 'test': true};
          }
          if (path == 'kassaPayStatus') return {'status': paid ? 'paid' : 'pending'};
          return {'status': 'cancelled'};
        },
      );
      TerminalPaymentResult? result;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (ctx) => TextButton(
              onPressed: () async => result = await svc.pay(450, context: ctx),
              child: const Text('Оплатить'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Оплатить'));
      await tester.pump();
      await tester.pump();
      expect(find.text('Оплата по QR (СБП)'), findsOneWidget);
      expect(find.text('Райффайзенбанк'), findsOneWidget);
      expect(find.textContaining('деньги не списываются'), findsOneWidget);
      expect(find.textContaining('код действует 4:5'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(result, isNull, reason: 'пока не оплачено — ждём');
      paid = true;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Оплата по QR (СБП)'), findsNothing);
      expect(result?.success, isTrue);
    });

    test('выбор «QR на экране кассы» сохраняется и собирается в нужный сервис', () {
      expect(TerminalProvider.fromId('online_qr'), TerminalProvider.onlineQr);
      expect(buildTerminalService({'terminalProvider': 'online_qr'}), isA<GatewayQrTerminalService>());
    });
  });
}
