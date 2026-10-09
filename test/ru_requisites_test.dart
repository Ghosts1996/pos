import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/ru_requisites.dart';

void main() {
  test('настоящие ИНН и ОГРН проходят, выдуманные — нет', () {
    expect(innValid('7707083893'), isTrue);
    expect(innValid('500100732259'), isTrue);
    expect(innValid('111664888423'), isFalse);
    expect(ogrnValid('1027700132195'), isTrue);
    expect(ogrnValid('304500116000157'), isTrue);
    expect(ogrnValid('494855721555528'), isFalse);
  });

  test('тип: организация 10+13, ИП 12+15', () {
    expect(requisitesValid('7707083893', '1027700132195'), isTrue);
    expect(requisitesValid('500100732259', '304500116000157'), isTrue);
    expect(requisitesValid('7707083893', '304500116000157'), isFalse);
    expect(ogrnProblem('1027700132195', inn: '500100732259'), contains('15'));
    expect(innProblem(''), isNull);
    expect(innProblem('123'), contains('10 цифр'));
  });
}
