// Тесты чистой логики — той части приложения, что считает деньги, остатки
// и время и не требует ни Firebase, ни виджетов.
//
// Раньше в test/ лежал пустой файл без main(), из-за чего `flutter test`
// падал на загрузке и проверять было нечего.

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/marking_code.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/phone_utils.dart';
import 'package:hookah_pos/widgets/timer_display.dart';

/// Разделитель групп (GS, 0x1D) внутри кода маркировки.
const gs = '\u001D';

void main() {
  group('Нормализация телефона', () {
    test('все привычные форматы дают один и тот же номер', () {
      const expected = '79995061580';
      expect(normalizePhone('+7 999 506-15-80'), expected);
      expect(normalizePhone('7(999)506-15-80'), expected);
      expect(normalizePhone('8 999 506 15 80'), expected);
      expect(normalizePhone('9995061580'), expected);
      expect(normalizePhone('+79995061580'), expected);
    });

    test('нераспознанный номер не выдаёт себя за российский', () {
      expect(isValidRuPhone(normalizePhone('12345')), isFalse);
      expect(isValidRuPhone(normalizePhone('+44 20 7946 0958')), isFalse);
      expect(isValidRuPhone(normalizePhone('8 999 506 15 80')), isTrue);
    });

    test('пустая строка не превращается в мусорный номер', () {
      expect(normalizePhone('   '), '');
    });
  });

  group('Единицы измерения склада', () {
    test('перевод между совместимыми единицами', () {
      expect(InventoryUnit.g.convertTo(500, InventoryUnit.kg), 0.5);
      expect(InventoryUnit.kg.convertTo(1.5, InventoryUnit.g), 1500);
      expect(InventoryUnit.ml.convertTo(250, InventoryUnit.l), 0.25);
      expect(InventoryUnit.l.convertTo(2, InventoryUnit.ml), 2000);
    });

    test('несовместимые единицы не домысливаются', () {
      // «шт» и «г» физически несопоставимы: величина возвращается как есть,
      // чтобы ошибка настройки позиции не превратилась в тихое умножение
      // остатка на 1000.
      expect(InventoryUnit.pcs.convertTo(5, InventoryUnit.g), 5);
      expect(InventoryUnit.g.convertTo(5, InventoryUnit.pcs), 5);
    });

    test('перевод в ту же единицу ничего не меняет', () {
      for (final u in InventoryUnit.values) {
        expect(u.convertTo(7.25, u), 7.25);
      }
    });

    test('формат числа без лишних нулей', () {
      expect(InventoryUnit.kg.format(1.5), '1.5');
      expect(InventoryUnit.g.format(10), '10');
    });
  });

  group('Итоги чека', () {
    SessionModel session({
      List<OrderItem> items = const [],
      double discountPercent = 0,
      double cash = 0,
      double card = 0,
      double terminal = 0,
      double comp = 0,
    }) {
      final now = DateTime(2026, 1, 1, 20);
      return SessionModel(
        id: 's1',
        tableId: 't1',
        tableName: 'Стол 1',
        employeeName: 'Аня',
        startTime: now,
        plannedEnd: now.add(const Duration(minutes: 90)),
        orderItems: items,
        discountPercent: discountPercent,
        paymentCash: cash,
        paymentCard: card,
        paymentTerminal: terminal,
        paymentComp: comp,
      );
    }

    test('сумма заказа складывается по позициям с учётом количества', () {
      final s = session(items: [
        OrderItem(name: 'Кальян', price: 1200, qty: 2),
        OrderItem(name: 'Чай', price: 300, qty: 3),
      ]);
      expect(s.orderTotal, 3300);
    });

    test('скидка применяется ко всему чеку', () {
      final s = session(
        items: [OrderItem(name: 'Кальян', price: 1000, qty: 1)],
        discountPercent: 15,
      );
      expect(s.totalWithDiscount, 850);
    });

    test('итог оплаты — сумма всех способов', () {
      final s = session(cash: 500, card: 300, terminal: 200, comp: 100);
      expect(s.paymentTotal, 1100);
    });

    test('оплата сходится со счётом со скидкой', () {
      // Так закрывает чек экран оплаты: бонусы и сертификат уезжают в
      // paymentComp, поэтому сумма способов оплаты обязана совпасть с
      // суммой чека после скидки — иначе X-отчёт покажет недостачу.
      final s = session(
        items: [OrderItem(name: 'Кальян', price: 2000, qty: 1)],
        discountPercent: 10,
        cash: 1300,
        comp: 500, // 500 списано бонусами
      );
      expect(s.paymentTotal, s.totalWithDiscount);
    });

    test('пустой заказ не даёт отрицательного итога', () {
      final s = session(discountPercent: 20);
      expect(s.orderTotal, 0);
      expect(s.totalWithDiscount, 0);
    });
  });

  group('Строка заказа', () {
    test('copyWith меняет только количество', () {
      final item = OrderItem(menuItemId: 'm1', name: 'Кальян', price: 1200, qty: 1);
      final updated = item.copyWith(qty: 3);
      expect(updated.menuItemId, 'm1');
      expect(updated.price, 1200);
      expect(updated.qty, 3);
      expect(updated.total, 3600);
    });

    test('сериализация туда-обратно не теряет полей', () {
      final item = OrderItem(menuItemId: 'm1', name: 'Чай', price: 350.5, qty: 2);
      final restored = OrderItem.fromMap(item.toMap());
      expect(restored.menuItemId, item.menuItemId);
      expect(restored.name, item.name);
      expect(restored.price, item.price);
      expect(restored.qty, item.qty);
    });
  });

  group('Таймер стола', () {
    test('формат остатка', () {
      expect(TimerDisplay.formatRemaining(const Duration(minutes: 90)), '01:30:00');
      expect(TimerDisplay.formatRemaining(const Duration(minutes: 5, seconds: 7)), '05:07');
      expect(TimerDisplay.formatRemaining(const Duration(minutes: -3)), '-03:00');
    });

    test('цвет меняется по мере истечения сеанса', () {
      // Именно эта логика раньше вычислялась один раз при построении плитки,
      // и стол на карте зала не краснел по истечении времени.
      expect(TimerDisplay.colorFor(const Duration(minutes: 40)),
          isNot(TimerDisplay.colorFor(const Duration(minutes: 10))));
      expect(TimerDisplay.colorFor(const Duration(minutes: 10)),
          isNot(TimerDisplay.colorFor(const Duration(minutes: -1))));
    });
  });

  group('Уровни лояльности', () {
    ClientProfile guest(double spent) =>
        ClientProfile(uid: 'u1', totalSpent: spent, createdAt: DateTime(2026));

    test('порог каждого уровня', () {
      expect(guest(0).tier, 'Бронза');
      expect(guest(9999).tier, 'Бронза');
      expect(guest(10000).tier, 'Серебро');
      expect(guest(24999).tier, 'Серебро');
      expect(guest(25000).tier, 'Золото');
      expect(guest(49999).tier, 'Золото');
      expect(guest(50000).tier, 'Платина');
      expect(guest(99999).tier, 'Платина');
      expect(guest(100000).tier, 'Алмаз');
      expect(guest(1000000).tier, 'Алмаз');
    });

    test('кешбэк растёт вместе с уровнем', () {
      expect(guest(0).cashbackPercent, 3);
      expect(guest(10000).cashbackPercent, 5);
      expect(guest(25000).cashbackPercent, 7);
      expect(guest(50000).cashbackPercent, 10);
      expect(guest(100000).cashbackPercent, 15);
    });

    test('сколько осталось до следующего уровня', () {
      expect(guest(0).nextTier?.name, 'Серебро');
      expect(guest(0).toNextTier, 10000);
      expect(guest(24000).nextTier?.name, 'Золото');
      expect(guest(24000).toNextTier, 1000);
    });

    test('на максимальном уровне следующего нет', () {
      final top = guest(150000);
      expect(top.nextTier, isNull);
      expect(top.toNextTier, 0);
      expect(top.tierProgress, 1);
    });

    test('прогресс считается внутри текущего уровня', () {
      // Серебро 10 000 → Золото 25 000: на 17 500 пройдена половина.
      expect(guest(17500).tierProgress, closeTo(0.5, 0.001));
      expect(guest(10000).tierProgress, 0);
    });
  });

  group('Код маркировки «Честный знак»', () {
    test('разбор кода с разделителем GS', () {
      const raw = '010460406000005621abcd1234${gs}93XYZW';
      final code = MarkingCode.tryParse(raw);
      expect(code, isNotNull);
      expect(code!.gtin, '04604060000056');
      expect(code.serial, 'abcd1234');
      expect(code.cryptoTail, 'XYZW');
    });

    test('обычный штрихкод меню кодом маркировки не считается', () {
      expect(MarkingCode.tryParse('4604060000056'), isNull);
      expect(MarkingCode.tryParse('https://example.com/menu'), isNull);
      expect(MarkingCode.tryParse(''), isNull);
    });

    test('код без серийного номера отбрасывается', () {
      expect(MarkingCode.tryParse('010460406000005621'), isNull);
    });
  });
}
