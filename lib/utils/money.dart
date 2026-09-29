import 'bill_split.dart';

/// Сумма для экрана: «12 500 ₽», «766,50 ₽» — с пробелом между тысячами,
/// копейки только когда они есть.
String rub(num value) => formatKopecks((value * 100).round());
