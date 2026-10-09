import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/ai/ai_context_service.dart';

void main() {
  test('сотрудники уходят в ИИ под номерами и возвращаются по имени', () {
    final staff = AiPseudonyms();
    expect(staff.of('Анна'), 'Сотрудник №1');
    expect(staff.of('Пётр'), 'Сотрудник №2');
    expect(staff.of(' Анна '), 'Сотрудник №1');
    expect(staff.of(''), 'сотрудник без имени');

    const answer = 'Сотрудник №2 закрыл больше всех. Сотруднику № 1 стоит помочь, '
        'у сотрудника №1 три отмены; Сотрудник №9 — нет в данных.';
    expect(
      staff.restore(answer),
      'Пётр закрыл больше всех. Сотруднику Анна стоит помочь, '
          'у сотрудника Анна три отмены; Сотрудник №9 — нет в данных.',
    );
  });

  test('контакты вырезаются из текста', () {
    expect(AiContextService.scrubContacts('звоните +7 (900) 123-45-67 или a.b@mail.ru'),
        'звоните [телефон скрыт] или [почта скрыта]');
  });
}
