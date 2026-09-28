import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/ai/ai_context_service.dart';
import 'package:hookah_pos/utils/promo_policy.dart';

void main() {
  final items = [
    OrderItem(name: 'Классический кальян', price: 1200, qty: 1),
    OrderItem(name: 'Премиум-микс', price: 1800, qty: 1, noPromo: true),
    OrderItem(name: 'Чай чёрный', price: 350, qty: 2),
  ];

  tearDown(() => PromoPolicy.excludeTobacco = true);

  test('по умолчанию кальяны исключены из скидок и бонусов', () {
    expect(PromoPolicy.excludeTobacco, isTrue);
    expect(PromoPolicy.promoBase(items), 700);
    expect(PromoPolicy.restricted(items[0]), isTrue); // по названию
    expect(PromoPolicy.restricted(items[1]), isTrue); // по категории (флаг)
    expect(PromoPolicy.restricted(items[2]), isFalse);
  });

  test('переключатель выключен — скидка на всё', () {
    PromoPolicy.apply({PromoPolicy.field: false});
    expect(PromoPolicy.promoBase(items), 3700);
  });

  test('флаг сохраняется в заказе', () {
    final m = items[1].toMap();
    expect(m['noPromo'], isTrue);
    expect(OrderItem.fromMap(m).noPromo, isTrue);
    expect(items[2].toMap().containsKey('noPromo'), isFalse);
    expect(items[1].copyWith(qty: 3).noPromo, isTrue);
  });

  test('табак в меню: флаг владельца, название или категория', () {
    MenuItem item(String name, {bool tobacco = false}) =>
        MenuItem(id: 'x', categoryId: 'c', name: name, price: 900, tobacco: tobacco);
    expect(PromoPolicy.menuTobacco(item('Двойное яблоко', tobacco: true)), isTrue);
    expect(PromoPolicy.menuTobacco(item('Двойное яблоко'), 'Миксы'), isFalse);
    expect(PromoPolicy.menuTobacco(item('Двойное яблоко'), 'Кальяны'), isTrue);
    expect(PromoPolicy.menuTobacco(item('Кальян на молоке')), isTrue);
    expect(PromoPolicy.menuTobacco(item('Паста')), isFalse);
    // Флаг сохраняется в Firestore и переживает правку позиции.
    expect(item('Микс', tobacco: true).toMap()['tobacco'], isTrue);
    expect(item('Микс', tobacco: true).copyWith(price: 1000).tobacco, isTrue);
  });

  test('в ИИ не уходят имена и контакты гостей', () {
    expect(AiContextService.guestAlias('Анна Петрова'), 'гость А.');
    expect(AiContextService.guestAlias('  '), 'гость');
    expect(AiContextService.scrubContacts('Позвонить +7 (912) 345-67-89 за час'),
        'Позвонить [телефон скрыт] за час');
    expect(AiContextService.scrubContacts('почта anna@mail.ru, стол у окна'),
        'почта [почта скрыта], стол у окна');
    expect(AiContextService.scrubContacts('День рождения, 6 человек, к 19:30'),
        'День рождения, 6 человек, к 19:30');
  });
}
