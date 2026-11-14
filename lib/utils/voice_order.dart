/// Разбор голосового заказа на кассе: «два латте, одну колу и пиццу
/// маргарита» → строки «позиция меню × количество».
///
/// Только чистая логика (без Flutter и без сети): распознаёт речь сам
/// телефон (на устройстве, звук никуда не уходит), а здесь — сопоставление
/// слов с названиями позиций меню. Русские окончания учитываются по общему
/// началу слова («колу» = «кола», «пиццы» = «пицца»). Ничего не добавляется
/// в чек само — кассир видит разбор и подтверждает.
library;

class VoiceOrderLine<T> {
  final T item;
  int qty;
  VoiceOrderLine(this.item, this.qty);
}

/// Слова, которые подошли к нескольким позициям одинаково хорошо:
/// «пицца» при «Пицца Маргарита» и «Пицца Пепперони» — кассир выбирает сам.
class VoiceOrderChoice<T> {
  final String phrase;
  final int qty;
  final List<T> options;
  const VoiceOrderChoice(this.phrase, this.qty, this.options);
}

class VoiceOrderResult<T> {
  final List<VoiceOrderLine<T>> lines;
  final List<VoiceOrderChoice<T>> choices;

  /// Слова, которые не подошли ни к одной позиции (кроме служебных).
  final List<String> unknown;
  const VoiceOrderResult(this.lines, this.choices, this.unknown);

  bool get isEmpty => lines.isEmpty && choices.isEmpty;
}

/// Больше этого за одну фразу не ставим — «двести латте» скорее ошибка
/// распознавания, чем заказ.
const int kVoiceMaxQty = 50;

const Map<String, int> _numberWords = {
  'один': 1, 'одна': 1, 'одно': 1, 'одну': 1, 'одного': 1,
  'два': 2, 'две': 2, 'пару': 2, 'пара': 2, 'парочку': 2,
  'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7,
  'восемь': 8, 'девять': 9, 'десять': 10,
  'одиннадцать': 11, 'двенадцать': 12, 'пятнадцать': 15, 'двадцать': 20,
};

const Set<String> _filler = {
  'и', 'еще', 'плюс', 'пожалуйста', 'штук', 'штуки', 'штука', 'шт',
  'порция', 'порции', 'порций', 'порцию', 'по', 'x', 'х', 'а', 'также', 'так', 'же',
  'добавь', 'добавьте', 'добавить', 'давай', 'давайте', 'нам', 'мне', 'нужно',
  'на', 'стол', 'столик', 'заказ', 'в', 'с', 'со',
};

String _norm(String s) => s.toLowerCase().replaceAll('ё', 'е');

List<String> voiceTokens(String text) => _norm(text)
    .split(RegExp(r'[^a-zа-я0-9]+'))
    .where((t) => t.isNotEmpty)
    .toList();

/// Одно ли это слово с учётом окончаний: «колу»/«кола», «пиццы»/«пицца»,
/// «чая»/«чай». Короткие слова — строже, иначе «сок» совпал бы с «соус».
bool voiceWordsMatch(String a, String b) => _wordQuality(a, b) > 0;

/// Насколько хорошо совпали слова: 0 — не совпали, 1 — одинаковые.
/// Для слов из трёх букв окончание может отличаться только при равной длине
/// («чай»/«чая»), иначе нужно всё слово («сок» ≠ «соус»).
double _wordQuality(String a, String b) {
  if (a == b) return 1;
  final minLen = a.length < b.length ? a.length : b.length;
  final maxLen = a.length < b.length ? b.length : a.length;
  if (minLen < 3) return 0;
  var cp = 0;
  while (cp < minLen && a.codeUnitAt(cp) == b.codeUnitAt(cp)) {
    cp++;
  }
  final need = minLen == 3 ? (a.length == b.length ? 2 : 3) : (minLen - 2 < 3 ? 3 : minLen - 2);
  return cp >= need ? cp / maxLen : 0;
}

int? _qtyOf(String t) {
  final w = _numberWords[t];
  if (w != null) return w;
  if (RegExp(r'^\d{1,3}$').hasMatch(t)) {
    final n = int.parse(t);
    return n > 0 ? n : null;
  }
  return null;
}

/// Значимые слова названия: буквы, длина ≥ 2 (объём «0,5 л» и цифры не нужны).
List<String> _nameWords(String name) =>
    voiceTokens(name).where((t) => t.length >= 2 && !RegExp(r'^\d+$').hasMatch(t)).toList();

/// Разбирает фразу. [items] — доступные позиции меню, [nameOf] — их названия.
VoiceOrderResult<T> parseVoiceOrder<T>(String text, List<T> items, String Function(T) nameOf) {
  final tokens = voiceTokens(text);
  final names = [for (final i in items) _nameWords(nameOf(i))];
  final lines = <VoiceOrderLine<T>>[];
  final choices = <VoiceOrderChoice<T>>[];
  final unknown = <String>[];

  void addLine(T item, int qty) {
    for (final l in lines) {
      if (identical(l.item, item) || l.item == item) {
        l.qty = (l.qty + qty).clamp(1, kVoiceMaxQty);
        return;
      }
    }
    lines.add(VoiceOrderLine<T>(item, qty.clamp(1, kVoiceMaxQty)));
  }

  var p = 0;
  while (p < tokens.length) {
    var t = tokens[p];
    var qty = 1;
    final q = _qtyOf(t);
    if (q != null) {
      qty = q;
      p++;
      if (p >= tokens.length) break;
      t = tokens[p];
    }
    if (_filler.contains(t) || _qtyOf(t) != null) {
      // «два и три» — служебное слово после числа: число относится к следующему.
      if (_qtyOf(t) == null) p++;
      continue;
    }
    // Ищем позиции, у которых слово названия совпадает с этим словом, и
    // сколько слов названия подряд (в пределах окна) нашлось во фразе.
    var bestScore = 0.0;
    var bestQuality = 0.0;
    var bestMatched = 0;
    var bestEnd = p;
    final best = <int>[];
    for (var k = 0; k < items.length; k++) {
      final words = names[k];
      if (words.isEmpty || !words.any((w) => voiceWordsMatch(w, t))) continue;
      final used = <int>{};
      var matched = 0;
      var quality = 0.0;
      var end = p;
      final limit = p + words.length + 1;
      for (var j = p; j < tokens.length && j < limit; j++) {
        if (j > p && _qtyOf(tokens[j]) != null) break;
        var hit = -1;
        var hq = 0.0;
        for (var w = 0; w < words.length; w++) {
          if (used.contains(w)) continue;
          final wq = _wordQuality(words[w], tokens[j]);
          if (wq > hq) {
            hq = wq;
            hit = w;
          }
        }
        if (hit < 0) continue;
        used.add(hit);
        matched++;
        quality += hq;
        end = j;
      }
      final score = matched / words.length;
      // Больше совпавших слов → точнее совпали слова («сырников» ближе к
      // «сырники», чем к «сырный») → больше доля названия.
      final cmp = matched != bestMatched
          ? matched.compareTo(bestMatched)
          : (quality - bestQuality).abs() > 1e-9
              ? quality.compareTo(bestQuality)
              : (score - bestScore).abs() > 1e-9
                  ? score.compareTo(bestScore)
                  : 0;
      if (cmp > 0) {
        bestScore = score;
        bestQuality = quality;
        bestMatched = matched;
        bestEnd = end;
        best
          ..clear()
          ..add(k);
      } else if (cmp == 0) {
        best.add(k);
        if (end > bestEnd) bestEnd = end;
      }
    }
    if (best.isEmpty) {
      unknown.add(t);
      p++;
      continue;
    }
    if (best.length == 1) {
      addLine(items[best.first], qty);
    } else {
      choices.add(VoiceOrderChoice<T>(
          tokens.sublist(p, bestEnd + 1).join(' '), qty.clamp(1, kVoiceMaxQty), [for (final k in best) items[k]]));
    }
    p = bestEnd + 1;
  }
  return VoiceOrderResult<T>(lines, choices, unknown);
}
