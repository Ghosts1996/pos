import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../services/app_scope.dart';

/// Скидки и бонусы на табачную и никотинсодержащую продукцию (кальяны).
///
/// Закон запрещает стимулировать продажу табака — в том числе скидками,
/// бонусами и кешбэком на неё (ст. 16 закона № 15-ФЗ). Поэтому по
/// умолчанию кальяны исключены из скидок по картам и акциям, из начисления
/// и списания бонусов. Владелец может снять запрет переключателем в
/// «Программе лояльности» — например, если кальяны у него без табака и
/// никотина; ответственность за это по оферте на заведении.
class PromoPolicy {
  PromoPolicy._();

  /// Поле в settings/loyalty.
  static const field = 'excludeTobaccoFromPromo';

  static bool excludeTobacco = true;

  static final _tobacco = RegExp(r'кальян|табак|никотин|hookah|shisha|снюс|вейп|сигар', caseSensitive: false);

  /// Название позиции или её категории похоже на табачную продукцию.
  static bool looksTobacco(String name) => _tobacco.hasMatch(name);

  /// Позиция меню — табак: отмечена владельцем или похожа по названию
  /// позиции/категории. Не зависит от [excludeTobacco]: реклама и показ вне
  /// заведения запрещены всегда.
  static bool menuTobacco(MenuItem item, [String categoryName = '']) =>
      item.tobacco || looksTobacco(item.name) || looksTobacco(categoryName);

  /// Позицию нельзя удешевлять скидкой и бонусами.
  static bool restricted(OrderItem item) => excludeTobacco && (item.noPromo || looksTobacco(item.name));

  /// Сумма позиций, на которые можно дать скидку и начислить/списать бонусы.
  static double promoBase(Iterable<OrderItem> items) =>
      items.where((i) => !restricted(i)).fold(0.0, (a, i) => a + i.total);

  static void apply(Map<String, dynamic>? loyaltySettings) {
    final v = loyaltySettings?[field];
    excludeTobacco = v is bool ? v : true;
  }

  static Future<void> save(bool value) async {
    await AppScope.col('settings').doc('loyalty').set({field: value}, SetOptions(merge: true));
    excludeTobacco = value;
  }
}
