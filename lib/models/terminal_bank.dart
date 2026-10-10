/// Банк-эквайер, чей терминал стоит в заведении.
///
/// Касса не обязана быть связана с терминалом кабелем: кассир набирает
/// сумму на терминале (или в приложении «терминал в телефоне»), касса
/// спрашивает, прошла ли оплата, и записывает в чек, через какой банк —
/// деньги от каждого банка приходят своим платежом, и в отчёте их видно
/// отдельно. Подходит любой терминал любого банка: и стационарный, и
/// переносной, и Tap on Phone.
class TerminalBank {
  final String id;
  final String name;

  const TerminalBank(this.id, this.name);

  /// Банки с эквайрингом для торговых точек — крупнейшие по числу
  /// терминалов и региональные, у которых много ресторанов и кафе.
  /// Остальные — «Другой банк» с названием.
  static const all = <TerminalBank>[
    TerminalBank('sber', 'Сбер'),
    TerminalBank('vtb', 'ВТБ'),
    TerminalBank('alfa', 'Альфа-Банк'),
    TerminalBank('tbank', 'Т-Банк'),
    TerminalBank('gpb', 'Газпромбанк'),
    TerminalBank('psb', 'ПСБ'),
    TerminalBank('raif', 'Райффайзенбанк'),
    TerminalBank('sovcom', 'Совкомбанк'),
    TerminalBank('rshb', 'Россельхозбанк'),
    TerminalBank('mts', 'МТС Банк'),
    TerminalBank('tochka', 'Точка'),
    TerminalBank('modul', 'Модульбанк'),
    TerminalBank('tkb', 'ТКБ Банк'),
    TerminalBank('uralsib', 'Уралсиб'),
    TerminalBank('akbars', 'Ак Барс Банк'),
    TerminalBank('bspb', 'Банк «Санкт-Петербург»'),
    TerminalBank('rosbank', 'Росбанк'),
    TerminalBank('rsb', 'Банк Русский Стандарт'),
    TerminalBank('mkb', 'МКБ'),
    TerminalBank('zenit', 'Банк Зенит'),
    TerminalBank('rossiya', 'Банк «Россия»'),
    TerminalBank('domrf', 'Банк ДОМ.РФ'),
    TerminalBank('otp', 'ОТП Банк'),
    TerminalBank('rnkb', 'РНКБ'),
    TerminalBank('centrinvest', 'Центр-инвест'),
    TerminalBank('kubankredit', 'Кубань Кредит'),
    TerminalBank('ozon', 'Озон Банк'),
    TerminalBank('wb', 'Вайлдберриз Банк'),
  ];

  /// «Другой банк» — название пишут сами.
  static const otherId = 'other';

  static TerminalBank? byId(String id) {
    for (final b in all) {
      if (b.id == id) return b;
    }
    return null;
  }

  /// Подпись банка для чека и отчёта; [other] — название «другого банка».
  static String label(String id, {String other = ''}) {
    if (id == otherId) return other.trim().isEmpty ? 'Другой банк' : other.trim();
    return byId(id)?.name ?? '';
  }

  /// Список выбранных банков из настроек: только известные id и «другой»,
  /// без повторов, в порядке выбора.
  static List<String> parseIds(Object? raw) {
    if (raw is! List) return const [];
    final out = <String>[];
    for (final v in raw) {
      final id = v is String ? v : '';
      if ((id == otherId || byId(id) != null) && !out.contains(id)) out.add(id);
    }
    return out;
  }
}
