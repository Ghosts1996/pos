// Весовой товар (SaaS): позиция меню «на вес» — цена за 1 кг. Каждое
// взвешивание — своя строка счёта: вес лежит в модификаторах строки
// («0,350 кг»), цена строки = цена за кг × вес. Так вес переживает любые
// правки строки (копии, перенос, разделение счёта) и виден в чеке и на
// бегунке. В фискальный чек строка идёт как «количество 0,350, мера — кг».

final _re = RegExp(r'^(\d{1,3}),(\d{3}) кг$');

/// «0,350 кг» — подпись веса для строки счёта.
String weightLabel(double kg) => '${kg.toStringAsFixed(3).replaceAll('.', ',')} кг';

/// Вес строки в кг из её модификаторов; 0 — строка не взвешивалась.
double weightKgOf(List<String> mods) {
  for (final m in mods) {
    final x = _re.firstMatch(m);
    if (x != null) return double.parse('${x.group(1)}.${x.group(2)}');
  }
  return 0;
}

bool isWeightMod(String mod) => _re.hasMatch(mod);

/// Цена строки: цена за кг × вес, до копейки.
double weighedPrice(double perKg, double kg) => (perKg * kg * 100).roundToDouble() / 100;

/// Ввод веса кассиром: «350» — граммы, «0,35» / «1.2» — килограммы.
/// null — не разобрали или вне 1 г … 100 кг.
double? parseWeightInput(String raw) {
  final t = raw.trim().replaceAll(' ', '').replaceAll(',', '.').toLowerCase();
  if (t.isEmpty) return null;
  final m = RegExp(r'^(\d+(?:\.\d+)?)(кг|kg|г|g)?$').firstMatch(t);
  if (m == null) return null;
  final v = double.parse(m.group(1)!);
  final unit = m.group(2) ?? '';
  final kg = unit.startsWith('к') || unit == 'kg'
      ? v
      : unit.isNotEmpty
          ? v / 1000
          : (t.contains('.') ? v : v / 1000);
  if (kg < 0.001 || kg > 100) return null;
  return (kg * 1000).roundToDouble() / 1000;
}
