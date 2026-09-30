import 'dart:math' as math;
import 'dart:ui' show Rect, Size;

import '../models/reservation_model.dart';
import '../models/table_model.dart';
import 'constants.dart';

/// Схема зала рисуется на логическом холсте одного размера на всех
/// устройствах и масштабируется под экран: редактор и зал видят одну
/// картинку, на телефоне столы не налезают друг на друга.
///
/// Координаты столов (x/y) — доли «базовый холст минус плитка», и базовый
/// холст не меняется: иначе уехали бы все уже расставленные залы.
const Size kHallBasis = Size(1000, 640);

/// Площадка зала — шире и заметно выше базового холста (на телефоне
/// столам не хватало места вниз): столы правее и ниже прежней границы
/// получают x/y больше 1, уже расставленные остаются на местах. Прежние
/// версии приложений такие столы прижимают к краю схемы.
const Size kHallCanvas = Size(1248, 1040);

/// Размер плитки стола на логическом холсте.
const double kHallTile = 104;

/// Формы столов для конструктора зала.
const kTableShapes = ['rect', 'circle', 'long', 'oval', 'corner', 'bar'];

/// Шаг сетки редактора: четверть плитки. Размеры всех столов кратны
/// плитке, поэтому края встают вплотную друг к другу.
const double kHallGridStep = kHallTile / 4;

/// Форму можно поворачивать: у квадрата и круга поворот ничего не меняет.
bool tableShapeRotates(String shape) => shape != 'rect' && shape != 'circle';

/// Сколько клеток в длину: длинный, овальный и угловой (2×2 буквой «Г») —
/// две, барная стойка — три.
int tableShapeCells(String shape) => switch (shape) {
      'long' || 'oval' || 'corner' => 2,
      'bar' => 3,
      _ => 1,
    };

/// Размер плитки стола: вытянутые формы — несколько клеток вдоль (или
/// поперёк, если повёрнуты), остальные — одна клетка. Клетки совпадают с
/// сеткой редактора, поэтому столы можно ставить вплотную и собирать из
/// них длинные и угловые конструкции.
Size hallTileSize(TableModel t) {
  if (t.shape == 'corner') return const Size(kHallTile * 2, kHallTile * 2);
  final n = tableShapeCells(t.shape);
  if (n == 1) return const Size(kHallTile, kHallTile);
  return t.rotation.isOdd ? Size(kHallTile, kHallTile * n) : Size(kHallTile * n, kHallTile);
}

/// Доли x/y для плитки [size], левый верхний угол которой в (left, top):
/// с привязкой к сетке и в пределах холста.
({double x, double y}) hallFractionForTopLeft(double left, double top, Size size) {
  double snap(double v) => (v / kHallGridStep).round() * kHallGridStep;
  final freeW = kHallBasis.width - size.width, freeH = kHallBasis.height - size.height;
  final l = snap(left).clamp(0.0, kHallCanvas.width - size.width);
  final t = snap(top).clamp(0.0, kHallCanvas.height - size.height);
  return (x: freeW <= 0 ? 0.0 : l / freeW, y: freeH <= 0 ? 0.0 : t / freeH);
}

/// Стол [after] (другая форма или поворот) на месте [before]: центр плитки
/// остаётся где был — стол поворачивается «на месте», а не уезжает.
TableModel hallRefit(TableModel before, TableModel after) {
  final o = hallTileOffset(before), s = hallTileSize(before), n = hallTileSize(after);
  final f = hallFractionForTopLeft(o.left + (s.width - n.width) / 2, o.top + (s.height - n.height) / 2, n);
  return after.copyWith(x: f.x, y: f.y);
}

/// Стол, повёрнутый на четверть оборота по часовой стрелке.
TableModel hallRotated(TableModel t) => hallRefit(t, t.copyWith(rotation: (t.rotation + 1) % 4));

/// Левый верхний угол плитки стола на холсте: x/y — доли свободного места
/// базового холста (холст минус плитка), см. [kHallBasis]; плитка не
/// выходит за край площадки.
({double left, double top}) hallTileOffset(TableModel t) {
  final s = hallTileSize(t);
  return (
    left: (t.x * (kHallBasis.width - s.width)).clamp(0.0, kHallCanvas.width - s.width),
    top: (t.y * (kHallBasis.height - s.height)).clamp(0.0, kHallCanvas.height - s.height),
  );
}

/// Клетки, которые стол занимает на холсте. У углового стола их три из
/// четырёх: пустая клетка напротив сгиба свободна, в неё можно поставить
/// другой стол.
List<Rect> hallTileCells(TableModel t) {
  final o = hallTileOffset(t);
  final s = hallTileSize(t);
  if (t.shape != 'corner') return [Rect.fromLTWH(o.left, o.top, s.width, s.height)];
  // (колонка, строка) пустой клетки: сгиб слева снизу — пусто справа сверху,
  // дальше по часовой стрелке (как tableFreeCorner).
  final empty = switch (t.rotation % 4) { 1 => (1, 1), 2 => (0, 1), 3 => (0, 0), _ => (1, 0) };
  return [
    for (var col = 0; col < 2; col++)
      for (var row = 0; row < 2; row++)
        if ((col, row) != empty) Rect.fromLTWH(o.left + col * kHallTile, o.top + row * kHallTile, kHallTile, kHallTile),
  ];
}

/// Столы наезжают друг на друга. Касаться краями можно — так собирают
/// длинные и угловые столы.
bool hallTablesOverlap(TableModel a, TableModel b) {
  final cb = hallTileCells(b).map((r) => r.deflate(0.5)).toList();
  return hallTileCells(a).any((x) => cb.any((y) => x.deflate(0.5).overlaps(y)));
}

/// Обратное преобразование: центр плитки на холсте → доли x/y стола.
({double x, double y}) hallFractionForCenter(double cx, double cy, [Size size = const Size(kHallTile, kHallTile)]) => (
      x: (cx - size.width / 2).clamp(0.0, kHallCanvas.width - size.width) / (kHallBasis.width - size.width),
      y: (cy - size.height / 2).clamp(0.0, kHallCanvas.height - size.height) / (kHallBasis.height - size.height),
    );

/// Часть холста со столами и полями вокруг — её и показываем, чтобы столы
/// в одном углу не выглядели мелкими. Не меньше [minSize], чтобы два-три
/// стола не раздувались на весь экран.
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
