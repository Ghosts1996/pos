/// Подпись стола для текста гостю и персоналу.
///
/// Имя стола в зале обычно уже «Стол 2», но бывает и «VIP» или «Диван у
/// окна». Раньше везде писали «Стол ${name}» — и получалось «Стол Стол 2».
/// Слово «Стол» добавляется, только если его в имени ещё нет.
String tableLabel(String name) {
  final n = name.trim();
  if (n.isEmpty) return 'Стол';
  return n.toLowerCase().startsWith('стол') ? n : 'Стол $n';
}

/// Русское согласование числа: 1 бонус, 2 бонуса, 5 бонусов, 21 бонус.
String pluralRu(num value, String one, String few, String many) {
  final n = value.abs().round();
  final mod100 = n % 100;
  final mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 == 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/// «81 бонус», «3 бонуса», «100 бонусов».
String bonusesLabel(num value) =>
    '${value.toStringAsFixed(0)} ${pluralRu(value, 'бонус', 'бонуса', 'бонусов')}';
