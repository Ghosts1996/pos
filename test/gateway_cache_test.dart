import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/pay_terms.dart';
import 'package:hookah_pos/utils/parse.dart';

void main() {
  test('дата из JSON сервера, миллисекунд и строки', () {
    expect(asDate({'_seconds': 1760000000, '_nanoseconds': 500000000})!.millisecondsSinceEpoch, 1760000000500);
    expect(asDate({'seconds': 10, 'nanoseconds': 0})!.millisecondsSinceEpoch, 10000);
    expect(asDate(1760000000000)!.year, 2025);
    expect(asDate('2026-10-17T19:00:00Z')!.hour, 19);
    expect(asDate('мусор'), isNull);
    expect(asDate(null), isNull);
  });

  test('история ставок из кеша сервера сохраняет даты правок', () {
    final e = Employee.fromMap({
      'id': 'e1',
      'name': 'Анна',
      'shiftRateEnabled': true,
      'shiftRate': 3000,
      'payHistory': [
        {'at': {'_seconds': 0, '_nanoseconds': 0}, 'terms': {'shiftRateEnabled': true, 'shiftRate': 2000}},
        {'at': {'_seconds': 1760000000, '_nanoseconds': 0}, 'terms': {'shiftRateEnabled': true, 'shiftRate': 3000}},
      ],
    });
    expect(e.payHistory[1].at, DateTime.fromMillisecondsSinceEpoch(1760000000000));
    expect(e.termsAt(DateTime.fromMillisecondsSinceEpoch(1700000000000)).shiftRate, 2000,
        reason: 'смена до повышения — по старой ставке');
    expect(e.termsAt(DateTime.fromMillisecondsSinceEpoch(1770000000000)).shiftRate, 3000);
    expect(PayChange.fromMap(const {'terms': {}}).at, PayChange.since);
  });
}
