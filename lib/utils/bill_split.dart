/// Счёт поровну на [people] человек — в копейках, без потерь: сумма долей
/// всегда равна счёту. Остаток от деления достаётся первым гостям по
/// копейке (или по рублю, если счёт в целых рублях): 1000 ₽ на троих —
/// 334 + 333 + 333, а не три раза по 333,33 и «куда-то пропавшая» копейка.
List<int> splitEvenlyKopecks(int totalKopecks, int people) {
  if (people <= 0 || totalKopecks <= 0) return const [];
  // Счёт в целых рублях делим целыми рублями — считать копейки гостям
  // незачем; иначе делим до копейки.
  final unit = totalKopecks % 100 == 0 ? 100 : 1;
  final units = totalKopecks ~/ unit;
  final base = units ~/ people;
  final extra = units % people;
  return [for (var i = 0; i < people; i++) (base + (i < extra ? 1 : 0)) * unit];
}

/// «1 150 ₽», «766,67 ₽» — сумма из копеек для экрана.
String formatKopecks(int kopecks) {
  final rub = kopecks ~/ 100;
  final kop = kopecks % 100;
  final rubStr = rub.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ' ');
  return kop == 0 ? '$rubStr ₽' : '$rubStr,${kop.toString().padLeft(2, '0')} ₽';
}
