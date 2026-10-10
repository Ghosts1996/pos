import '../utils/parse.dart';

/// Агрегатор доставки — Яндекс Еда, Купер, Мегамаркет. Заказ оплачен на его
/// стороне: деньги заведению он переводит позже, по своему графику и за
/// вычетом комиссии. Касса закрывает такой чек отдельным способом оплаты
/// «Агрегатор», чтобы выручка не смешивалась с наличными и эквайрингом, а
/// отчёты показывали, сколько агрегатор должен перевести.
class Aggregator {
  final String id;
  final String name;
  const Aggregator(this.id, this.name);

  static const all = [
    Aggregator('yandex_eda', 'Яндекс Еда'),
    Aggregator('kuper', 'Купер'),
    Aggregator('megamarket', 'Мегамаркет'),
    Aggregator('custom', 'Другой агрегатор'),
  ];

  static Aggregator? byId(String? id) {
    for (final a in all) {
      if (a.id == id) return a;
    }
    return null;
  }
}

/// Агрегатор в заведении: подключён ли, его комиссия и кто пробивает чек
/// покупателю. Хранится в settings/integrations.aggregators.
class AggregatorSettings {
  final String id;
  final bool enabled;

  /// Название для «Другого агрегатора» (у остальных — своё).
  final String customName;

  /// Комиссия по договору, % — для отчёта «к выплате».
  final double commission;

  /// Чек покупателю пробивает сам агрегатор (обычно так, когда гость платит
  /// в его приложении): тогда касса фискальный чек не пробивает, иначе
  /// продажа попала бы в налоговую дважды. Если по договору чек за вами —
  /// касса пробьёт его как оплату безналичными.
  final bool aggregatorIssuesReceipt;

  const AggregatorSettings({
    required this.id,
    this.enabled = false,
    this.customName = '',
    this.commission = 0,
    this.aggregatorIssuesReceipt = true,
  });

  String get label {
    if (id == 'custom') return customName.trim().isEmpty ? 'Агрегатор' : customName.trim();
    return Aggregator.byId(id)?.name ?? 'Агрегатор';
  }

  /// Сколько агрегатор переведёт заведению с суммы [amount].
  double payout(double amount) => amount * (1 - commission.clamp(0, 100) / 100);

  factory AggregatorSettings.fromMap(String id, Map<String, dynamic>? m) => AggregatorSettings(
        id: id,
        enabled: m?['enabled'] == true,
        customName: asText(m?['name']),
        commission: (asNum(m?['commission'])?.toDouble() ?? 0).clamp(0, 100).toDouble(),
        aggregatorIssuesReceipt: m?['aggregatorIssuesReceipt'] != false,
      );

  Map<String, dynamic> toMap() => {
        'enabled': enabled,
        if (id == 'custom') 'name': customName.trim(),
        'commission': commission,
        'aggregatorIssuesReceipt': aggregatorIssuesReceipt,
      };

  AggregatorSettings copyWith({bool? enabled, String? customName, double? commission, bool? aggregatorIssuesReceipt}) =>
      AggregatorSettings(
        id: id,
        enabled: enabled ?? this.enabled,
        customName: customName ?? this.customName,
        commission: commission ?? this.commission,
        aggregatorIssuesReceipt: aggregatorIssuesReceipt ?? this.aggregatorIssuesReceipt,
      );

  /// Все агрегаторы из settings/integrations (неизвестные пропускаем).
  static List<AggregatorSettings> listFrom(Map<String, dynamic>? integrations) {
    final raw = integrations?['aggregators'];
    final map = raw is Map ? raw : const {};
    return [
      for (final a in Aggregator.all)
        AggregatorSettings.fromMap(a.id, map[a.id] is Map ? Map<String, dynamic>.from(map[a.id] as Map) : null),
    ];
  }
}

/// Подключённые агрегаторы заведения — их видит окно оплаты. Заполняется
/// при старте кассы и при сохранении «Интеграций».
List<AggregatorSettings> enabledAggregators = const [];

void applyAggregatorSettings(Map<String, dynamic>? integrations) {
  enabledAggregators = AggregatorSettings.listFrom(integrations).where((a) => a.enabled).toList();
}

/// Подключённый агрегатор по id (или по сохранённому в чеке названию).
AggregatorSettings? aggregatorById(String id) {
  for (final a in enabledAggregators) {
    if (a.id == id) return a;
  }
  return null;
}

/// Можно ли закрыть чек с оплатой [amount] через агрегатор [choice]:
/// null — можно, иначе — что сказать кассиру. [otherPaid] — выручка по
/// чеку другими способами (наличные, карта, терминал, за счёт заведения,
/// бонусы), без чаевых.
String? aggregatorPaymentProblem({
  required double amount,
  required AggregatorSettings? choice,
  required double otherPaid,
}) {
  if (amount <= 0.004) return null;
  if (choice == null) return 'Выберите, через какой агрегатор оплачен заказ';
  // Свой чек агрегатор пробивает на весь заказ — доплат по нашей кассе в
  // нём быть не может (их пришлось бы пробивать отдельным чеком).
  if (choice.aggregatorIssuesReceipt && otherPaid > 0.009) {
    return 'Чек покупателю пробивает агрегатор (${choice.label}) — проведите через него весь счёт, '
        'без других способов оплаты и бонусов';
  }
  return null;
}
