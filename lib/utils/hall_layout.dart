import 'dart:math' as math;
import 'dart:ui' show Rect, Size;

import '../models/reservation_model.dart';
import '../models/table_model.dart';
import 'constants.dart';

/// Схема зала рисуется на «логическом холсте» одного и того же размера на
/// всех устройствах и масштабируется под экран. Раньше столы раскладывались
/// прямо по ширине экрана: схема, расставленная на планшете, на телефоне
/// сжималась, и плитки налезали друг на друга. Теперь редактор и зал
/// видят одну и ту же картинку, отличается только масштаб.
const Size kHallCanvas = Size(1000, 640);

/// Размер плитки стола на логическом холсте.
const double kHallTile = 104;

/// Формы столов для конструктора зала.
const kTableShapes = ['rect', 'circle', 'long', 'triangle'];

/// Размер плитки стола: длинный — две клетки вдоль (или поперёк, если
/// повёрнут), остальные — одна клетка. Клетки совпадают с шагом сетки
/// редактора, поэтому столы можно ставить вплотную и собирать из них
/// длинные и угловые конструкции.
Size hallTileSize(TableModel t) {
  if (t.shape == 'long') {
    return t.rotation.isOdd ? const Size(kHallTile, kHallTile * 2) : const Size(kHallTile * 2, kHallTile);
  }
  return const Size(kHallTile, kHallTile);
}

/// Левый верхний угол плитки стола на холсте: x/y — доли 0..1 свободного
/// места (холст минус плитка), чтобы крайние столы не уезжали за край.
({double left, double top}) hallTileOffset(TableModel t) {
  final s = hallTileSize(t);
  return (
    left: t.x.clamp(0.0, 1.0) * (kHallCanvas.width - s.width),
    top: t.y.clamp(0.0, 1.0) * (kHallCanvas.height - s.height),
  );
}

/// Обратное преобразование: центр плитки на холсте → доли x/y стола.
({double x, double y}) hallFractionForCenter(double cx, double cy, [Size size = const Size(kHallTile, kHallTile)]) => (
      x: ((cx - size.width / 2) / (kHallCanvas.width - size.width)).clamp(0.0, 1.0),
      y: ((cy - size.height / 2) / (kHallCanvas.height - size.height)).clamp(0.0, 1.0),
    );

/// Часть холста, где стоят столы, с полями вокруг — её и показываем на
/// экране. Раньше показывался весь холст: если столы стоят в одном углу,
/// на телефоне они получались мелкими, а половина экрана — пустой.
/// Не меньше [minSize], чтобы два-три стола не раздувались на весь экран.
Rect hallContentRect(
  List<TableModel> tables, {
  double margin = 36,
  Size minSize = const Size(kHallTile * 3.2, kHallTile * 2.4),
}) {
  if (tables.isEmpty) return kHallCanvasRect;
  var l = double.infinity, t = double.infinity, r = -double.infinity, b = -double.infinity;
  for (final x in tables) {
    final o = hallTileOffset(x);
    final s = hallTileSize(x);
    l = math.min(l, o.left);
    t = math.min(t, o.top);
    r = math.max(r, o.left + s.width);
    b = math.max(b, o.top + s.height);
  }
  l -= margin;
  t -= margin;
  r += margin;
  b += margin;
  // Расширяем до минимального размера вокруг центра, не выходя за холст.
  final gx = math.max(0.0, minSize.width - (r - l)) / 2;
  final gy = math.max(0.0, minSize.height - (b - t)) / 2;
  l -= gx;
  r += gx;
  t -= gy;
  b += gy;
  // Сдвигаем внутрь холста, сохраняя размер.
  if (l < 0) {
    r -= l;
    l = 0;
  }
  if (t < 0) {
    b -= t;
    t = 0;
  }
  if (r > kHallCanvas.width) {
    l -= r - kHallCanvas.width;
    r = kHallCanvas.width;
  }
  if (b > kHallCanvas.height) {
    t -= b - kHallCanvas.height;
    b = kHallCanvas.height;
  }
  return Rect.fromLTRB(math.max(0, l), math.max(0, t), r, b);
}

/// Весь холст — для пустого зала.
final Rect kHallCanvasRect = Rect.fromLTWH(0, 0, kHallCanvas.width, kHallCanvas.height);

/// Столы по срочности: где гость зовёт, потом время вышло (дольше всех
/// первыми), скоро освободятся, заняты (кто раньше освободится — выше),
/// бронь (ближайшая выше), свободные — по номеру.
List<TableModel> tablesByUrgency(
  List<TableModel> tables,
  Map<String, TableState> states, {
  Set<String> calls = const {},
  Map<String, ReservationModel> reservations = const {},
}) {
  int rank(TableState s) => switch (s) {
        TableState.overdue => 0,
        TableState.ending => 1,
        TableState.occupied => 2,
        TableState.reserved => 3,
        TableState.free => 4,
      };
  DateTime key(TableModel t) {
    final s = states[t.id] ?? TableState.free;
    if (s == TableState.reserved) return reservations[t.id]?.startTime ?? DateTime(9999);
    return t.busyUntil ?? DateTime(9999);
  }

  return [...tables]..sort((a, b) {
      final call = (calls.contains(b.id) ? 1 : 0) - (calls.contains(a.id) ? 1 : 0);
      if (call != 0) return call;
      final ra = rank(states[a.id] ?? TableState.free), rb = rank(states[b.id] ?? TableState.free);
      if (ra != rb) return ra.compareTo(rb);
      if (ra == 4) return compareTables(a, b);
      final k = key(a).compareTo(key(b));
      return k != 0 ? k : compareTables(a, b);
    });
}

/// Зоны зала в порядке «как завёл администратор»: по первому появлению в
/// отсортированном по имени списке столов. Столы без зоны — ''.
List<String> hallZones(List<TableModel> tables) {
  final sorted = [...tables]..sort(compareTables);
  final zones = <String>[];
  for (final t in sorted) {
    final z = t.zone.trim();
    if (z.isNotEmpty && !zones.contains(z)) zones.add(z);
  }
  return zones;
}

/// Подпись для столов без зоны, когда зоны в заведении всё-таки есть.
const String kNoZoneLabel = 'Без зоны';

/// «Стол 2» раньше «Стол 10»: числа в названиях сравниваются как числа.
int compareTables(TableModel a, TableModel b) => naturalCompare(a.name, b.name);

int naturalCompare(String a, String b) {
  final re = RegExp(r'(\d+)|(\D+)');
  final pa = re.allMatches(a.toLowerCase()).map((m) => m.group(0)!).toList();
  final pb = re.allMatches(b.toLowerCase()).map((m) => m.group(0)!).toList();
  for (var i = 0; i < pa.length && i < pb.length; i++) {
    final na = int.tryParse(pa[i]);
    final nb = int.tryParse(pb[i]);
    final c = na != null && nb != null ? na.compareTo(nb) : pa[i].compareTo(pb[i]);
    if (c != 0) return c;
  }
  return pa.length.compareTo(pb.length);
}

/// Что сейчас со столом — определяет цвет плитки и фильтры зала.
enum TableState {
  /// Свободен.
  free,

  /// Свободен, но скоро бронь — сажать «на подольше» нельзя.
  reserved,

  /// Гости сидят.
  occupied,

  /// Время сеанса скоро закончится.
  ending,

  /// Время вышло, а гости ещё за столом.
  overdue,
}

extension TableStateX on TableState {
  bool get isBusy => this == TableState.occupied || this == TableState.ending || this == TableState.overdue;

  String get label {
    switch (this) {
      case TableState.free:
        return 'Свободен';
      case TableState.reserved:
        return 'Бронь';
      case TableState.occupied:
        return 'Занят';
      case TableState.ending:
        return 'Скоро освободится';
      case TableState.overdue:
        return 'Время вышло';
    }
  }
}

/// Состояние стола. [plannedEnd] — конец ближайшего чека, если он известен
/// (иначе берётся [TableModel.busyUntil], который касса держит на самом
/// столе); [reservation] — ближайшая бронь на этот стол.
TableState tableStateOf(
  TableModel t, {
  required DateTime now,
  DateTime? plannedEnd,
  ReservationModel? reservation,
}) {
  final busy = t.activeSessionIds.isNotEmpty || t.status == 'occupied';
  if (!busy) return reservation != null ? TableState.reserved : TableState.free;
  final end = plannedEnd ?? t.busyUntil;
  if (end == null) return TableState.occupied;
  final left = end.difference(now);
  if (AppConstants.isUnlimitedRemaining(left)) return TableState.occupied;
  if (left.isNegative) return TableState.overdue;
  if (left.inMinutes < AppConstants.warningThresholdMinutes) return TableState.ending;
  return TableState.occupied;
}

/// Ближайшая «живая» бронь на каждый стол: от получаса назад (гость
/// опаздывает, стол ещё держим) до [ahead] вперёд.
Map<String, ReservationModel> nextReservationsByTable(
  List<ReservationModel> reservations, {
  required DateTime now,
  Duration ahead = const Duration(hours: 2),
}) {
  final out = <String, ReservationModel>{};
  for (final r in reservations) {
    if (r.tableId.isEmpty || !r.status.blocksTable) continue;
    if (r.startTime.isBefore(now.subtract(const Duration(minutes: 30)))) continue;
    if (r.startTime.isAfter(now.add(ahead))) continue;
    final prev = out[r.tableId];
    if (prev == null || r.startTime.isBefore(prev.startTime)) out[r.tableId] = r;
  }
  return out;
}

/// «19:30» — время брони для плитки.
String hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
