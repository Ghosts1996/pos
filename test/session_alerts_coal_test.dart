import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/session_alerts_service.dart';

SessionModel _session({required DateTime start, List<DateTime> refills = const []}) => SessionModel(
      id: 's1',
      tableId: 't1',
      tableName: 'Стол 1',
      employeeName: 'Аня',
      startTime: start,
      plannedEnd: start.add(const Duration(minutes: 90)),
      refillCount: refills.length,
      refillHistory: refills.map(RefillEvent.new).toList(),
    );

void main() {
  final start = DateTime(2026, 9, 29, 20, 0);

  test('без перезабивок угли считаются от начала сеанса', () {
    expect(SessionAlertsService.coalBase(_session(start: start)), start);
  });

  test('после перезабивки — от последней, в каком бы порядке ни пришла история', () {
    final first = start.add(const Duration(minutes: 40));
    final second = start.add(const Duration(minutes: 95));
    final s = _session(start: start, refills: [second, first]);
    expect(SessionAlertsService.coalBase(s), second);
  });
}
