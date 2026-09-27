import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/reservation_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/utils/constants.dart';
import 'package:hookah_pos/utils/hall_layout.dart';

TableModel _t(String name, {String zone = '', List<String> checks = const [], DateTime? busyUntil, double x = 0, double y = 0}) =>
    TableModel(
      id: name,
      name: name,
      x: x,
      y: y,
      zone: zone,
      activeSessionIds: checks,
      status: checks.isEmpty ? 'free' : 'occupied',
      busyUntil: busyUntil,
    );

ReservationModel _r(String tableId, DateTime start, {ReservationStatus status = ReservationStatus.confirmed}) =>
    ReservationModel(
      id: 'r$tableId${start.millisecondsSinceEpoch}',
      guestName: 'Иван',
      phone: '',
      tableId: tableId,
      startTime: start,
      status: status,
      createdAt: start,
    );

void main() {
  final now = DateTime(2026, 9, 27, 19, 0);

  group('Порядок столов', () {
    test('номера сравниваются как числа', () {
      final names = ['Стол 10', 'Стол 2', 'Бар 1', 'Стол 1', 'VIP'];
      names.sort(naturalCompare);
      expect(names, ['VIP', 'Бар 1', 'Стол 1', 'Стол 2', 'Стол 10']);
    });
  });

  group('Зоны', () {
    test('зоны в порядке столов, без пустой', () {
      final zones = hallZones([
        _t('Стол 3', zone: 'Терраса'),
        _t('Стол 1', zone: 'Основной зал'),
        _t('Стол 2'),
        _t('Стол 4', zone: 'Терраса'),
      ]);
      expect(zones, ['Основной зал', 'Терраса']);
    });
    test('зона сохраняется в документ стола', () {
      expect(_t('Стол 1', zone: 'VIP').toMap()['zone'], 'VIP');
      expect(_t('Стол 1', zone: 'VIP').copyWith(zone: '').zone, '');
    });
  });

  group('Состояние стола', () {
    test('свободный и свободный с бронью', () {
      expect(tableStateOf(_t('1'), now: now), TableState.free);
      expect(tableStateOf(_t('1'), now: now, reservation: _r('1', now.add(const Duration(hours: 1)))), TableState.reserved);
    });
    test('занят → скоро освободится → время вышло', () {
      final t = _t('1', checks: ['s1']);
      expect(tableStateOf(t, now: now, plannedEnd: now.add(const Duration(hours: 1))), TableState.occupied);
      expect(tableStateOf(t, now: now, plannedEnd: now.add(const Duration(minutes: 5))), TableState.ending);
      expect(tableStateOf(t, now: now, plannedEnd: now.subtract(const Duration(minutes: 1))), TableState.overdue);
    });
    test('без ограничений времени — просто занят, без «время вышло»', () {
      final t = _t('1', checks: ['s1'], busyUntil: now.add(const Duration(minutes: AppConstants.unlimitedSessionMinutes)));
      expect(tableStateOf(t, now: now), TableState.occupied);
    });
    test('если чек ещё не подгрузился — по busyUntil стола', () {
      final t = _t('1', checks: ['s1'], busyUntil: now.subtract(const Duration(minutes: 3)));
      expect(tableStateOf(t, now: now), TableState.overdue);
    });
  });

  group('Ближайшие брони', () {
    test('берётся ближайшая живая бронь в окне', () {
      final m = nextReservationsByTable([
        _r('a', now.add(const Duration(hours: 1, minutes: 30))),
        _r('a', now.add(const Duration(minutes: 40))),
        _r('b', now.add(const Duration(hours: 5))), // слишком далеко
        _r('c', now.add(const Duration(minutes: 20)), status: ReservationStatus.cancelled),
        _r('d', now.subtract(const Duration(minutes: 10))), // опаздывает — стол ещё держим
        _r('e', now.subtract(const Duration(hours: 1))), // давно прошла
      ], now: now);
      expect(m.keys.toSet(), {'a', 'd'});
      expect(m['a']!.startTime, now.add(const Duration(minutes: 40)));
    });
  });

  group('Координаты схемы', () {
    test('доли стола ↔ центр плитки на холсте', () {
      final t = _t('1', x: 0.25, y: 0.75);
      final o = hallTileOffset(t);
      final back = hallFractionForCenter(o.left + kHallTile / 2, o.top + kHallTile / 2);
      expect(back.x, closeTo(0.25, 1e-9));
      expect(back.y, closeTo(0.75, 1e-9));
    });
    test('за край холста стол не уезжает', () {
      final f = hallFractionForCenter(-500, 99999);
      expect(f.x, 0);
      expect(f.y, 1);
    });
  });
}
