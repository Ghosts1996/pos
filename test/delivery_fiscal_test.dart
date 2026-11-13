import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/delivery_status.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/atol_local_kassa.dart';
import 'package:hookah_pos/services/delivery_fiscal_service.dart';
import 'package:hookah_pos/services/kassa_service.dart';

Map<String, dynamic> order({String status = 'accepted', Map<String, dynamic>? auto, Map<String, dynamic>? courier}) => {
      'orderType': 'delivery',
      'deliveryStatus': status,
      if (auto != null) 'fiscalAuto': auto,
      if (courier != null) 'courierPayment': courier,
    };

List<String> pays(DeliveryFiscalStep? s) => [for (final p in s!.payments) '${p.type}:${p.amount}'];

void main() {
  group('Какой чек доставки пробить', () {
    test('оплачено онлайн целиком до вручения — предоплата 100% на всю сумму', () {
      final s = planDeliveryFiscal(raw: order(), total: 1350, guestPaid: 1350);
      expect(s!.kind, DeliveryFiscalKind.prepay);
      expect(pays(s), ['card:1350.0']);
    });

    test('оплачено не всё или ничего — до вручения чека нет', () {
      expect(planDeliveryFiscal(raw: order(), total: 1350, guestPaid: 500), isNull);
      expect(planDeliveryFiscal(raw: order(), total: 1350, guestPaid: 0), isNull);
    });

    test('чаевые сверх счёта в чек не идут', () {
      expect(pays(planDeliveryFiscal(raw: order(), total: 1000, guestPaid: 1100)), ['card:1000.0']);
    });

    test('вручил после предоплаты — полный расчёт зачётом предоплаты', () {
      final s = planDeliveryFiscal(
        raw: order(status: 'done', auto: {'prepay': {'ok': true, 'amount': 1350}}, courier: {'method': 'online', 'amount': 0}),
        total: 1350,
        guestPaid: 1350,
      );
      expect(s!.kind, DeliveryFiscalKind.full);
      expect(pays(s), ['prepayment:1350.0']);
    });

    test('наличные и карта у двери — полный расчёт этими деньгами', () {
      expect(pays(planDeliveryFiscal(raw: order(status: 'done', courier: {'method': 'cash', 'amount': 750}), total: 750, guestPaid: 0)),
          ['cash:750.0']);
      expect(pays(planDeliveryFiscal(raw: order(status: 'done', courier: {'method': 'card', 'amount': 750}), total: 750, guestPaid: 0)),
          ['card:750.0']);
    });

    test('QR у двери без чека предоплаты — один полный расчёт безналом', () {
      expect(pays(planDeliveryFiscal(raw: order(status: 'done', courier: {'method': 'online', 'amount': 0}), total: 900, guestPaid: 900)),
          ['card:900.0']);
    });

    test('доставлен, а оплаты не видно (деньги на кассе) — чек пробьёт кассир', () {
      expect(planDeliveryFiscal(raw: order(status: 'done'), total: 900, guestPaid: 0), isNull);
    });

    test('кассир уже пробил чек на экране оплаты — автоматически ничего', () {
      expect(planDeliveryFiscal(raw: {...order(), 'fiscalReceipt': {'receiptId': 'x'}}, total: 900, guestPaid: 900), isNull);
    });

    test('уже пробит или отклонён — повторно не пробиваем', () {
      expect(planDeliveryFiscal(raw: order(auto: {'prepay': {'ok': true, 'amount': 900}}), total: 900, guestPaid: 900), isNull);
      expect(planDeliveryFiscal(raw: order(auto: {'prepay': {'error': 'нет связи'}}), total: 900, guestPaid: 900), isNull);
      expect(
          planDeliveryFiscal(
              raw: order(status: 'done', auto: {'prepay': {'ok': true, 'amount': 900}, 'full': {'ok': true}}), total: 900, guestPaid: 900),
          isNull);
    });

    test('отменили после предоплаты — возврат предоплаты; без предоплаты — ничего', () {
      expect(planDeliveryFiscal(raw: order(status: 'cancelled', auto: {'prepay': {'ok': true, 'amount': 900}}), total: 900, guestPaid: 900)!.kind,
          DeliveryFiscalKind.refund);
      expect(planDeliveryFiscal(raw: order(status: 'cancelled'), total: 900, guestPaid: 900), isNull);
      expect(
          planDeliveryFiscal(
              raw: order(status: 'cancelled', auto: {'prepay': {'ok': true}, 'refund': {'ok': true}}), total: 900, guestPaid: 900),
          isNull);
    });

    test('заказ за столом не трогаем', () {
      expect(planDeliveryFiscal(raw: {'orderType': '', 'deliveryStatus': ''}, total: 900, guestPaid: 900), isNull);
    });

    test('состояние для экрана оплаты', () {
      expect(deliveryFiscalState(null), '');
      expect(deliveryFiscalState({'fiscalAuto': {'prepay': {'ok': true}}}), 'prepay');
      expect(deliveryFiscalState({'fiscalAuto': {'prepay': {'ok': true}, 'full': {'ok': true}}}), 'full');
      expect(deliveryFiscalState({'fiscalAuto': {'prepay': {'ok': true}, 'refund': {'ok': true}}}), '');
      expect(deliveryFiscalState({'fiscalAuto': {'prepay': {'error': 'x'}}}), '');
    });
  });

  test('позиции: скидка, строка «Доставка» — услуга без скидки', () {
    final s = SessionModel(
      id: 's1',
      tableId: 't',
      tableName: 'С собой',
      employeeName: '',
      startTime: DateTime(2026),
      plannedEnd: DateTime(2026),
      discountPercent: 10,
      orderItems: [
        OrderItem(menuItemId: 'pizza', name: 'Пицца', price: 600, qty: 2),
        OrderItem(menuItemId: kDeliveryFeeItemId, name: 'Доставка', price: 249, qty: 1, noPromo: true),
      ],
    );
    final items = buildDeliveryFiscalItems(s, (_) => null);
    expect(items.map((i) => i.price), [540, 249]);
    expect(items.map((i) => i.paymentObject), [FiscalPaymentObject.commodity, FiscalPaymentObject.service]);
    expect(fiscalItemsTotal(items), 1329);
  });

  group('Предоплата 100% у касс', () {
    const prepay = FiscalReceipt(
      receiptId: 's1-dprepay',
      items: [FiscalReceiptItem(name: 'Пицца', price: 600, quantity: 1, markingCode: '0104600000000001215abc')],
      payments: [FiscalPayment('card', 600)],
      buyerContact: '+79990000000',
      fullPrepayment: true,
    );

    test('АТОЛ Онлайн: full_prepayment, без кода маркировки', () {
      final atol = AtolCloudKassaService(
          baseUrl: '', groupCode: 'G', login: 'l', password: 'p', companyInn: '1', companyEmail: 'a@b.ru', companyPaymentAddress: 'М');
      final item = ((atol.buildReceiptBody(prepay)['receipt'] as Map)['items'] as List).first as Map;
      expect(item['payment_method'], 'full_prepayment');
      expect(item.containsKey('mark_code'), isFalse);
      final full = FiscalReceipt(receiptId: 's1-dfull', items: prepay.items, payments: const [FiscalPayment('prepayment', 600)]);
      final r = atol.buildReceiptBody(full)['receipt'] as Map;
      expect(((r['items'] as List).first as Map)['payment_method'], 'full_payment');
      expect(((r['payments'] as List).first as Map)['type'], 2, reason: 'зачёт аванса');
    });

    test('OrangeData: способ расчёта 1, полный расчёт — 4', () {
      final od = OrangeDataKassaService(inn: '7700000000', clientCertPem: 'c', clientKeyPem: 'k');
      final p = ((od.buildDocument(prepay)['content'] as Map)['positions'] as List).first as Map;
      expect(p['paymentMethodType'], 1);
      expect(p.containsKey('itemCode'), isFalse);
    });

    test('АТОЛ в заведении: fullPrepayment', () {
      final t = AtolLocalKassaService(address: '10.0.0.5').buildTask(prepay);
      final item = (t['items'] as List).first as Map;
      expect(item['paymentMethod'], 'fullPrepayment');
      expect(item['paymentObject'], 'commodity');
    });

    test('чек предоплаты переживает очередь и возврат', () {
      final back = FiscalReceipt.fromJson(prepay.toJson());
      expect(back.fullPrepayment, isTrue);
      expect(back.asRefund().fullPrepayment, isTrue);
      expect(back.asRefund().receiptId, 's1-dprepay-refund');
    });
  });
}
