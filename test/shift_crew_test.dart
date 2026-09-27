import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/staff_shift_model.dart';
import 'package:hookah_pos/utils/constants.dart';
import 'package:hookah_pos/utils/shift_crew.dart';
import 'package:hookah_pos/widgets/shift_flow.dart';

StaffShiftModel _s(String id, String emp, DateTime start, {String status = 'open'}) =>
    StaffShiftModel(id: id, employeeId: emp, employeeName: 'имя-$emp', startedAt: start, status: status);

Employee _e(String id, String name, String position) =>
    Employee(id: id, name: name, pinCode: '0000', role: AppConstants.roleEmployee, position: position);

void main() {
  final t0 = DateTime(2026, 9, 27, 18);
  final employees = {
    'w': _e('w', 'Аня', AppConstants.positionWaiter),
    'h': _e('h', 'Игорь', AppConstants.positionHookahMaster),
    'b': _e('b', 'Олег', AppConstants.positionBartender),
    'u': _e('u', 'Саша', AppConstants.positionUniversal),
  };

  ShiftCrew crewOf(List<StaffShiftModel> open) =>
      ShiftCrew(open, employees: employees, now: t0.add(const Duration(hours: 2)));

  group('кто на смене', () {
    test('кальянщик уходит — остаются официант и бармен, он не последний', () {
      final crew = crewOf([_s('1', 'w', t0), _s('2', 'h', t0), _s('3', 'b', t0)]);
      expect(crew.count, 3);
      expect(crew.isLast('h'), isFalse);
      expect(crew.othersThan('h').map(crew.labelOf), ['Аня · официант', 'Олег · бармен']);
    });

    test('последний на смене', () {
      final crew = crewOf([_s('3', 'b', t0)]);
      expect(crew.isLast('b'), isTrue);
      // Тот, кого нет на смене (админ), «последним» считается, только если
      // в зале никого.
      expect(crew.isLast('admin'), isFalse);
      expect(crewOf(const []).isLast('admin'), isTrue);
    });

    test('закрытые смены и дубли одного сотрудника не считаются', () {
      final crew = crewOf([
        _s('1', 'w', t0),
        _s('2', 'w', t0.add(const Duration(hours: 1))),
        _s('3', 'h', t0, status: 'closed'),
      ]);
      expect(crew.count, 1);
      expect(crew.of('w')!.id, '2');
      expect(crew.has('h'), isFalse);
    });

    test('подписи: универсал без должности, имя из смены, если карточки нет', () {
      final crew = crewOf([_s('1', 'u', t0), _s('2', 'x', t0)]);
      expect(crew.shifts.map(crew.labelOf), ['Саша', 'имя-x']);
    });

    test('сводка для меню', () {
      expect(crewOf(const []).summary(), 'Никто не отметил начало смены');
      final crew = crewOf([
        _s('1', 'w', t0),
        _s('2', 'h', t0.add(const Duration(minutes: 1))),
        _s('3', 'b', t0.add(const Duration(minutes: 2))),
        _s('4', 'u', t0.add(const Duration(minutes: 3))),
      ]);
      expect(crew.summary(), 'На смене 4: Аня, Игорь, Олег и ещё 1');
      expect(ShiftCrew.peopleCount(3), '3 человека');
      expect(ShiftCrew.peopleCount(5), '5 человек');
    });
  });

  test('забытая вчера личная смена — не «на смене»', () {
    final crew = ShiftCrew([
      _s('1', 'w', t0.subtract(const Duration(hours: 20))),
      _s('2', 'b', t0),
    ], employees: employees, now: t0.add(const Duration(hours: 1)));
    expect(crew.has('w'), isFalse);
    expect(crew.forgotten.single.employeeId, 'w');
    expect(crew.of('w')!.id, '1');
    expect(crew.isLast('b'), isTrue);
  });

  test('зависшая смена — открыта 16 часов и дольше', () {
    expect(isStaleShift(t0, now: t0.add(const Duration(hours: 15, minutes: 59))), isFalse);
    expect(isStaleShift(t0, now: t0.add(const Duration(hours: 16))), isTrue);
  });

  test('отработано', () {
    expect(workedLabel(const Duration(minutes: 45)), '45 мин');
    expect(workedLabel(const Duration(hours: 6)), '6 ч');
    expect(workedLabel(const Duration(hours: 6, minutes: 10)), '6 ч 10 мин');
  });

  group('кому вызовы гостей', () {
    test('на смене официант и кальянщик — уведомления обоим, ушедшему нет', () {
      final on = {'w', 'h'};
      bool here(String me) => alertsForThisDevice(onShift: on, myId: me, deviceOwnerId: '', shiftOpenerId: 'b');
      expect(here('w'), isTrue);
      expect(here('h'), isTrue);
      // Бармен открыл смену заведения, но уже ушёл домой.
      expect(here('b'), isFalse);
    });

    test('общий планшет: вошёл админ, смену открыли на кальянщика', () {
      expect(
          alertsForThisDevice(onShift: {'h'}, myId: 'admin', deviceOwnerId: 'h', shiftOpenerId: 'h'), isTrue);
    });

    test('никто не отмечал начало смены — как раньше, по открывшему смену', () {
      expect(alertsForThisDevice(onShift: {}, myId: 'w', deviceOwnerId: '', shiftOpenerId: 'w'), isTrue);
      expect(alertsForThisDevice(onShift: {}, myId: 'w', deviceOwnerId: '', shiftOpenerId: 'h'), isFalse);
      expect(alertsForThisDevice(onShift: {}, myId: 'w', deviceOwnerId: '', shiftOpenerId: ''), isTrue);
    });

    test('вход не сохранён — уведомляем', () {
      expect(alertsForThisDevice(onShift: {'h'}, myId: '', deviceOwnerId: '', shiftOpenerId: 'h'), isTrue);
    });
  });

  group('время ухода из забытой смены', () {
    test('ушёл после полуночи — это уже следующие сутки', () {
      expect(leftAtFromTime(t0, 2, 30), DateTime(2026, 9, 28, 2, 30));
    });
    test('ушёл в тот же вечер', () {
      expect(leftAtFromTime(t0, 23, 0), DateTime(2026, 9, 27, 23, 0));
    });
    test('ровно во время начала — через сутки, а не ноль часов', () {
      expect(leftAtFromTime(t0, 18, 0), DateTime(2026, 9, 28, 18, 0));
    });
  });

  test('подпись времени: сегодня — только часы, другой день — с датой', () {
    expect(shiftTimeLabel(t0, now: t0.add(const Duration(hours: 3))), 'в 18:00');
    expect(shiftTimeLabel(t0, now: t0.add(const Duration(days: 1))), '27.09 в 18:00');
  });
}
