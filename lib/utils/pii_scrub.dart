/// Вычистка персональных данных перед отправкой провайдеру ИИ — та же, что
/// на сервере (saas-gateway/pii-scrub.js). Провайдеры ИИ работают за рубежом:
/// телефон, почта, номер карты или документа в запросе были бы
/// трансграничной передачей персональных данных, которую платформа не ведёт.
/// Суммы, номера столов и чеков, время и граммы не трогаются.
class PiiScrub {
  PiiScrub._();

  static final List<(RegExp, String)> _rules = [
    (RegExp(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), '[почта]'),
    (RegExp(r'\b(?:\d[ -]?){12,18}\d\b'), '[номер]'),
    (RegExp(r'(?:\+7|\b8|\b7)[\s\-().]*\d{3}[\s\-().]*\d{3}[\s\-().]*\d{2}[\s\-().]*\d{2}\b'), '[телефон]'),
    (RegExp(r'\b9\d{2}[\s\-().]*\d{3}[\s\-().]*\d{2}[\s\-().]*\d{2}\b'), '[телефон]'),
    (RegExp(r'\b\d{3}-\d{3}-\d{3}[ -]?\d{2}\b'), '[номер]'),
    (RegExp(r'\b\d{2}\s?\d{2}\s?\d{6}\b'), '[номер]'),
    (RegExp(r'\b\d{12}\b'), '[номер]'),
  ];

  static const _keepKeys = {'model', 'role', 'type', 'tool_choice', 'id', 'name', 'media_type', 'url', 'data', 'image_url'};

  static String text(String s) {
    var out = s;
    for (final (re, mark) in _rules) {
      out = out.replaceAll(re, mark);
    }
    return out;
  }

  /// Копия тела запроса к ИИ (OpenAI или Anthropic) с вычищенными строками.
  static Object? payload(Object? v, [String key = '']) {
    if (v is String) return _keepKeys.contains(key) ? v : text(v);
    if (v is List) return [for (final x in v) payload(x, key)];
    if (v is Map) {
      return {
        for (final e in v.entries)
          e.key: _keepKeys.contains('${e.key}') && e.value is! Map && e.value is! List ? e.value : payload(e.value, '${e.key}'),
      };
    }
    return v;
  }
}
