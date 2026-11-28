import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/phone_suggest.dart';

// Подсказки номера гостя при закрытии чека: «последние 4 цифры» — первыми.
void main() {
  final guests = [
    ('Ира', '79443312345'), // 4433 в середине, пришла с сервера первой
    ('Олег', '79001114433'), // кончается на 4433
    ('Анна', '74433000000'), // начинается с 4433 (без кода страны)
    ('Пётр', '79005554433'), // тоже кончается на 4433
    ('Без совпадения', '79000000000'),
  ];

  test('кончается на набранные цифры — первыми, затем начало, затем середина', () {
    final out = rankByPhone(guests, '4433', (g) => g.$2).map((g) => g.$1).toList();
    expect(out.take(2), ['Олег', 'Пётр'], reason: 'оба кончаются на 4433, порядок сервера сохранён');
    expect(out[2], 'Анна');
    expect(out[3], 'Ира');
    expect(out.last, 'Без совпадения');
  });

  test('ранг совпадения', () {
    expect(phoneMatchRank('79001114433', '4433'), 0);
    expect(phoneMatchRank('84433000000', '4433'), 1);
    expect(phoneMatchRank('79443312345', '4433'), 2);
    expect(phoneMatchRank('79000000000', '4433'), 3);
    expect(phoneMatchRank('+7 (900) 111-44-33', '4433'), 0, reason: 'номер с пробелами и скобками');
  });

  test('имя — порядок не трогаем; меньше 3 цифр — тоже', () {
    final out = rankByPhone(guests, 'Ол', (g) => g.$2);
    expect(out.first.$1, 'Ира');
    expect(rankByPhone(guests, '44', (g) => g.$2).first.$1, 'Ира');
  });

  test('подсветка: совпадение в конце, иначе первое', () {
    expect(matchedDigits('79001114433', '4433'), (7, 11));
    expect(matchedDigits('79443312345', '4433'), (2, 6));
    expect(matchedDigits('79000000000', '4433'), isNull);
  });
}
