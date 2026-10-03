import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/sale_kind.dart';
import 'package:hookah_pos/widgets/order_note_sheet.dart';

void main() {
  OrderItem item({String note = '', int qty = 2}) =>
      OrderItem(menuItemId: 'h', name: 'Кальян', price: 1500, qty: qty, kind: SaleKind.hookah, by: const {'h1': 2}, note: note);

  group('Пожелание к позиции', () {
    test('сохраняется и читается, пустое не пишется', () {
      final back = OrderItem.fromMap(item(note: 'Крепкий').toMap());
      expect(back.note, 'Крепкий');
      expect(item().toMap().containsKey('note'), isFalse);
    });

    test('лишние пробелы убираются, длина ограничена', () {
      expect(OrderItem.cleanNote('  без   льда \n'), 'без льда');
      expect(OrderItem.cleanNote('а' * 500).length, OrderItem.noteMaxLength);
      expect(OrderItem.fromMap({'name': 'x', 'note': 42}).note, '42');
      expect(OrderItem.fromMap({'name': 'x'}).note, '');
    });

    test('переживает плюс, минус и раздел счёта', () {
      final i = item(note: 'Крепкий');
      expect(i.plus(1, employeeId: 'h2').note, 'Крепкий');
      expect(i.minus(1).note, 'Крепкий');
      expect(i.copyWith(qty: 5).note, 'Крепкий');
      final (out, rest) = i.split(1);
      expect(out.note, 'Крепкий');
      expect(rest!.note, 'Крепкий');
      expect(i.withNote('').note, '');
      expect(i.withNote('Лёгкий').by, {'h1': 2});
    });

    test('быстрые варианты добавляются и убираются', () {
      var n = toggleNotePreset('', 'Без льда');
      expect(n, 'Без льда');
      n = toggleNotePreset(n, 'Без сахара');
      expect(n, 'Без льда, без сахара');
      n = toggleNotePreset(n, 'Без льда');
      expect(n, 'без сахара');
      expect(toggleNotePreset('один крепкий', 'С холодком'), 'один крепкий, с холодком');
    });

    test('у каждого вида свои варианты', () {
      expect(orderNotePresets.keys, containsAll([SaleKind.hookah, SaleKind.bar, SaleKind.kitchen]));
    });
  });
}
