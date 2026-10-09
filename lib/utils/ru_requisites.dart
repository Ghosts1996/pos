/// Проверка ИНН и ОГРН/ОГРНИП по контрольным цифрам и типу (организация
/// или ИП) — выдуманные номера почти никогда не проходят. Те же правила на
/// сервере (saas-gateway/requisites.js); там же сверка с ЕГРЮЛ ФНС.
library;

String _digits(String v) => v.replaceAll(RegExp(r'\D'), '');

int _checksum(String d, List<int> weights) {
  var s = 0;
  for (var i = 0; i < weights.length; i++) {
    s += int.parse(d[i]) * weights[i];
  }
  return (s % 11) % 10;
}

bool innValid(String value) {
  final d = _digits(value);
  if (d.length == 10) return _checksum(d, const [2, 4, 10, 3, 5, 9, 4, 6, 8]) == int.parse(d[9]);
  if (d.length == 12) {
    return _checksum(d, const [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int.parse(d[10]) &&
        _checksum(d, const [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int.parse(d[11]);
  }
  return false;
}

/// Остаток от деления длинного числа — столбиком, без переполнения.
int _mod(String d, int m) {
  var r = 0;
  for (final c in d.codeUnits) {
    r = (r * 10 + (c - 48)) % m;
  }
  return r;
}

bool ogrnValid(String value) {
  final d = _digits(value);
  if (d.length == 13) {
    return (d[0] == '1' || d[0] == '5') && _mod(d.substring(0, 12), 11) % 10 == int.parse(d[12]);
  }
  if (d.length == 15) return d[0] == '3' && _mod(d.substring(0, 14), 13) % 10 == int.parse(d[14]);
  return false;
}

/// Ошибка в ИНН — для подписи под полем; null — номер в порядке.
String? innProblem(String value) {
  final d = _digits(value);
  if (d.isEmpty) return null;
  if (d.length != 10 && d.length != 12) return '10 цифр у организации, 12 у ИП';
  if (!innValid(d)) return 'Не сходится контрольная цифра — проверьте по выписке';
  return null;
}

/// Ошибка в ОГРН/ОГРНИП с учётом ИНН (у организации 13 цифр, у ИП 15).
String? ogrnProblem(String value, {String inn = ''}) {
  final d = _digits(value);
  if (d.isEmpty) return null;
  if (d.length != 13 && d.length != 15) return '13 цифр у организации, 15 у ИП';
  if (!ogrnValid(d)) return 'Не сходится контрольная цифра — проверьте по выписке';
  final i = _digits(inn);
  if (i.length == 10 && d.length != 13) return 'ИНН организации — нужен ОГРН из 13 цифр';
  if (i.length == 12 && d.length != 15) return 'ИНН ИП — нужен ОГРНИП из 15 цифр';
  return null;
}

/// Пара ИНН и ОГРН годится для «Реквизитов продавца».
bool requisitesValid(String inn, String ogrn) =>
    _digits(inn).isNotEmpty &&
    _digits(ogrn).isNotEmpty &&
    innProblem(inn) == null &&
    ogrnProblem(ogrn, inn: inn) == null;
