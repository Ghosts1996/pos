import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/delivery_status.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/promo_policy.dart';
import 'package:hookah_pos/utils/service_charge.dart';

void main() {
  setUp(() => ServiceCharge.apply({'enabled': true, 'percent': 10}));
  tearDown(() {
    ServiceCharge.apply(null);
    PromoPolicy.excludeTobacco = true;
  });

  List<OrderItem> bill() => [
        OrderItem(menuItemId: 'tea', name: 'Чай', price: 350, qty: 2),
        OrderItem(menuItemId: 'mix', name: 'Кальян классический', price: 1200, qty: 1),
      ];

  test('процент — от счёта со скидкой, целые рубли, строка последней', () {
    final items = bill();
    expect(ServiceCharge.syncList(items, want: true, discountPercent: 0), isTrue);
    final line = items.last;
    expect(ServiceCharge.isLine(line), isTrue);
    expect(line.price, 190); // 10 % от 1 900
    expect(line.name, 'Обслуживание 10 %');
    expect(line.noPromo, isTrue);
    // Уже «подана» — на кухню и в бегунки не идёт.
    expect(line.sent, 1);
    expect(line.ready, 1);
    expect(line.served, 1);

    // Скидка 20 % — только на чай (кальян без скидки): 1 900 − 140 = 1 760.
    expect(ServiceCharge.syncList(items, want: true, discountPercent: 20), isTrue);
    expect(items.where(ServiceCharge.isLine).single.price, 176);
    // Повтор с теми же данными ничего не меняет.
    expect(ServiceCharge.syncList(items, want: true, discountPercent: 20), isFalse);
  });

  test('строка обслуживания не получает скидку и в итоге чека', () {
    final items = bill();
    ServiceCharge.syncList(items, want: true, discountPercent: 0);
    PromoPolicy.excludeTobacco = false; // заведение разрешило скидки на всё
    final s = SessionModel(
      id: 's1',
      tableId: 't1',
      tableName: 'Стол 1',
      employeeName: '',
      employeeId: '',
      guestTag: '',
      startTime: DateTime(2026, 11, 23, 20),
      plannedEnd: DateTime(2026, 11, 23, 22),
      orderItems: items,
      discountPercent: 10,
    );
    // Скидка 10 % — на 1 900, а 190 за обслуживание — как есть.
    expect(s.totalWithDiscount, closeTo(1900 - 190 + 190, 0.001));
    expect(PromoPolicy.restricted(items.last), isTrue);
  });

  test('позиции изменились — сумма пересчитана; счёт пуст — строки нет', () {
    final items = bill();
    ServiceCharge.syncList(items, want: true, discountPercent: 0);
    items.insert(0, OrderItem(menuItemId: 'cake', name: 'Торт', price: 450, qty: 1));
    expect(ServiceCharge.syncList(items, want: true, discountPercent: 0), isTrue);
    expect(items.where(ServiceCharge.isLine).single.price, 235); // 10 % от 2 350
    expect(ServiceCharge.isLine(items.last), isTrue);

    items.removeWhere((i) => !ServiceCharge.isLine(i));
    expect(ServiceCharge.syncList(items, want: true, discountPercent: 0), isTrue);
    expect(items, isEmpty);
  });

  test('гость отказался — строка уходит; две копии — остаётся одна', () {
    final items = bill();
    ServiceCharge.syncList(items, want: true, discountPercent: 0);
    expect(ServiceCharge.syncList(items, want: false, discountPercent: 0), isTrue);
    expect(items.any(ServiceCharge.isLine), isFalse);

    final twice = [...bill(), ServiceCharge.line(190, 10), ServiceCharge.line(190, 10)];
    expect(ServiceCharge.syncList(twice, want: true, discountPercent: 0), isTrue);
    expect(twice.where(ServiceCharge.isLine).length, 1);
  });

  test('доставка в базу процента не входит', () {
    final items = [...bill(), OrderItem(menuItemId: kDeliveryFeeItemId, name: 'Доставка', price: 300, qty: 1, noPromo: true)];
    expect(ServiceCharge.baseOf(items, 0), 1900);
  });

  test('процент из настройки: запятая, границы', () {
    expect(ServiceCharge.cleanPercent('7,5'), 7.5);
    expect(ServiceCharge.cleanPercent('10 %'), 10);
    expect(ServiceCharge.cleanPercent(0), 0);
    expect(ServiceCharge.cleanPercent(31), 0);
    expect(ServiceCharge.cleanPercent('abc'), 0);
    expect(ServiceCharge.percentLabel(7.5), '7,5 %');
    expect(ServiceCharge.amountOf(1235, 10), 124); // 123,5 → 124
  });

  test('когда процент начисляется', () {
    if (!kSaasMode) {
      // В hookah-pos функции нет вовсе.
      expect(ServiceCharge.ready, isFalse);
      expect(ServiceCharge.syncItems(bill(), {'guests': 4}), isFalse);
      return;
    }
    ServiceCharge.apply({'enabled': true, 'percent': 10, 'minGuests': 4});
    expect(ServiceCharge.appliesTo(orderType: '', serviceOff: false, guests: 4), isTrue);
    expect(ServiceCharge.appliesTo(orderType: '', serviceOff: false, guests: 3), isFalse);
    expect(ServiceCharge.appliesTo(orderType: 'takeaway', serviceOff: false, guests: 6), isFalse);
    expect(ServiceCharge.appliesTo(orderType: 'delivery', serviceOff: false, guests: 6), isFalse);
    expect(ServiceCharge.appliesTo(orderType: '', serviceOff: true, guests: 6), isFalse);
    expect(ServiceCharge.appliesTo(orderType: '', serviceOff: false, guests: 6, training: true), isFalse);

    final items = bill();
    expect(ServiceCharge.syncItems(items, {'guests': 5, 'discountPercent': 0}), isTrue);
    expect(items.last.price, 190);
    expect(ServiceCharge.syncItems(items, {'guests': 5, 'serviceOff': true}), isTrue);
    expect(items.any(ServiceCharge.isLine), isFalse);

    ServiceCharge.apply({'enabled': false, 'percent': 10});
    expect(ServiceCharge.syncItems(items, {'guests': 5}), isFalse);
  });
}
