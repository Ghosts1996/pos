import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/models/session_model.dart';

void main() {
  // «Стажёр» есть только в SaaS: в hookah-pos признак не читается и не пишется.
  test('признак стажёра у сотрудника — только в SaaS', () {
    final e = Employee.fromMap({'id': 'e1', 'name': 'Аня', 'role': 'employee', 'trainee': true});
    expect(e.trainee, kSaasMode);
    expect(e.toMap().containsKey('trainee'), kSaasMode);
    expect(e.copyWith(name: 'Анна').trainee, e.trainee);
    final plain = Employee.fromMap({'id': 'e2', 'name': 'Оля', 'role': 'employee'});
    expect(plain.trainee, isFalse);
  });

  test('учебный чек сохраняется признаком training, обычный — без него', () {
    SessionModel make({bool training = false}) => SessionModel(
          id: 's', tableId: 't', tableName: 'Стол 1', employeeName: 'Аня',
          startTime: DateTime(2026, 11, 14, 18), plannedEnd: DateTime(2026, 11, 14, 20), status: 'closed', training: training,
        );
    expect(make(training: true).toMap()['training'], isTrue);
    expect(make().toMap().containsKey('training'), isFalse);
  });
}
