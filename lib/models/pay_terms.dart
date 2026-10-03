import 'package:cloud_firestore/cloud_firestore.dart';

/// Условия оплаты сотрудника: ставка за час или оклад за смену,
/// переработка и проценты с продаж. Хранятся в карточке сотрудника
/// (текущие) и в истории изменений [PayChange] — по ней зарплата за
/// прошлые смены считается по тем ставкам, что действовали тогда, а не по
/// сегодняшним: поднять себе ставку в конце месяца и пересчитать весь
/// месяц нельзя.
class PayTerms {
  final bool hourlyRateEnabled;
  final double hourlyRate; // ₽/час
  final bool shiftRateEnabled;
  final double shiftRate; // ₽ за смену
  final bool overtimeEnabled;
  final double overtimeThresholdHours;
  final double overtimeMultiplier;
  final double overtimeHourRate; // ₽ за час переработки при окладе за смену

  /// Проценты с продаж включены. Дальше — с чего именно:
  final bool salesPercentEnabled;

  /// % с чеков, которые сотрудник вёл (столы, которые он открыл), — так
  /// обычно платят официанту. Исторически единственный процент.
  final double salesPercentRate;

  /// Процент «с чеков» не берёт кальяны: за них платят кальянщику.
  final bool checkPercentExcludesHookah;

  /// % с кальянов — кальянщику.
  final double hookahPercentRate;

  /// % с напитков и бара (алкоголь, коктейли, кофе) — бармену.
  final double barPercentRate;

  const PayTerms({
    this.hourlyRateEnabled = false,
    this.hourlyRate = 0,
    this.shiftRateEnabled = false,
    this.shiftRate = 0,
    this.overtimeEnabled = false,
    this.overtimeThresholdHours = 8,
    this.overtimeMultiplier = 1.5,
    this.overtimeHourRate = 0,
    this.salesPercentEnabled = false,
    this.salesPercentRate = 0,
    this.checkPercentExcludesHookah = false,
    this.hookahPercentRate = 0,
    this.barPercentRate = 0,
  });

  /// Хоть один способ оплаты включён.
  bool get configured => hourlyRateEnabled || shiftRateEnabled || salesPercentEnabled;

  // Границы — как при сохранении карточки; старые данные могли их нарушать.
  double get safeHourlyRate => hourlyRate < 0 ? 0 : hourlyRate;
  double get safeShiftRate => shiftRate < 0 ? 0 : shiftRate;
  double get safeOvertimeThreshold => overtimeThresholdHours < 0 ? 0 : overtimeThresholdHours;
  double get safeOvertimeMultiplier => overtimeMultiplier < 1 ? 1 : overtimeMultiplier;
  double get safeOvertimeHourRate => overtimeHourRate < 0 ? 0 : overtimeHourRate;

  /// Процент для вида продаж: 'check' — с чеков, 'hookah', 'bar'.
  double percentFor(String base) {
    if (!salesPercentEnabled) return 0;
    final v = switch (base) {
      'hookah' => hookahPercentRate,
      'bar' => barPercentRate,
      _ => salesPercentRate,
    };
    return v.clamp(0.0, 100.0).toDouble();
  }

  factory PayTerms.fromMap(Map<String, dynamic> d) => PayTerms(
        hourlyRateEnabled: d['hourlyRateEnabled'] == true,
        hourlyRate: _num(d['hourlyRate']),
        shiftRateEnabled: d['shiftRateEnabled'] == true,
        shiftRate: _num(d['shiftRate']),
        overtimeEnabled: d['overtimeEnabled'] == true,
        overtimeThresholdHours: _num(d['overtimeThresholdHours'], 8),
        overtimeMultiplier: _num(d['overtimeMultiplier'], 1.5),
        overtimeHourRate: _num(d['overtimeHourRate']),
        salesPercentEnabled: d['salesPercentEnabled'] == true,
        salesPercentRate: _num(d['salesPercentRate']),
        checkPercentExcludesHookah: d['checkPercentExcludesHookah'] == true,
        hookahPercentRate: _num(d['hookahPercentRate']),
        barPercentRate: _num(d['barPercentRate']),
      );

  Map<String, dynamic> toMap() => {
        'hourlyRateEnabled': hourlyRateEnabled,
        'hourlyRate': hourlyRate,
        'shiftRateEnabled': shiftRateEnabled,
        'shiftRate': shiftRate,
        'overtimeEnabled': overtimeEnabled,
        'overtimeThresholdHours': overtimeThresholdHours,
        'overtimeMultiplier': overtimeMultiplier,
        'overtimeHourRate': overtimeHourRate,
        'salesPercentEnabled': salesPercentEnabled,
        'salesPercentRate': salesPercentRate,
        'checkPercentExcludesHookah': checkPercentExcludesHookah,
        'hookahPercentRate': hookahPercentRate,
        'barPercentRate': barPercentRate,
      };

  /// Сводка для журнала и отчёта: «оклад 2 500 ₽/смена, 5% с чеков».
  String summary() {
    String n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ',');
    final parts = <String>[
      if (hourlyRateEnabled) '${n(hourlyRate)} ₽/ч',
      if (shiftRateEnabled) '${n(shiftRate)} ₽ за смену',
      if (overtimeEnabled)
        shiftRateEnabled
            ? 'переработка ${n(overtimeHourRate)} ₽/ч после ${n(overtimeThresholdHours)} ч'
            : 'переработка ×${n(overtimeMultiplier)} после ${n(overtimeThresholdHours)} ч',
      if (salesPercentEnabled && salesPercentRate > 0)
        '${n(salesPercentRate)}% с чеков${checkPercentExcludesHookah ? ' без кальянов' : ''}',
      if (salesPercentEnabled && hookahPercentRate > 0) '${n(hookahPercentRate)}% с кальянов',
      if (salesPercentEnabled && barPercentRate > 0) '${n(barPercentRate)}% с бара',
    ];
    return parts.isEmpty ? 'не настроена' : parts.join(', ');
  }

  @override
  bool operator ==(Object other) =>
      other is PayTerms && _mapEquals(toMap(), other.toMap());

  @override
  int get hashCode => Object.hashAll(toMap().values);

  static bool _mapEquals(Map<String, dynamic> a, Map<String, dynamic> b) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (a[k] != b[k]) return false;
    }
    return true;
  }

  static double _num(Object? v, [double fallback = 0]) => v is num ? v.toDouble() : fallback;
}

/// Запись истории изменений оплаты: с какого момента действуют условия и
/// кто их поменял. Записи только добавляются (это проверяют и правила
/// базы), задним числом их не переписать.
class PayChange {
  /// С этого момента действуют [terms]. Нулевой момент (1970 год) — так
  /// записываются условия «как было до первой правки».
  final DateTime at;
  final PayTerms terms;
  final String byId;
  final String byName;

  const PayChange({required this.at, required this.terms, this.byId = '', this.byName = ''});

  static final DateTime since = DateTime.fromMillisecondsSinceEpoch(0);

  factory PayChange.fromMap(Map<String, dynamic> m) {
    final at = m['at'];
    return PayChange(
      at: at is Timestamp ? at.toDate() : since,
      terms: PayTerms.fromMap(Map<String, dynamic>.from((m['terms'] as Map?) ?? const {})),
      byId: (m['byId'] ?? '').toString(),
      byName: (m['byName'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toMap() => {
        'at': Timestamp.fromDate(at),
        'terms': terms.toMap(),
        'byId': byId,
        'byName': byName,
      };
}

/// Условия, действовавшие в момент [t]: последняя запись истории с
/// `at <= t`. Без истории — текущие условия карточки.
PayTerms payTermsAt(List<PayChange> history, PayTerms current, DateTime t) {
  if (history.isEmpty) return current;
  PayChange? best;
  for (final c in history) {
    if (!c.at.isAfter(t) && (best == null || !c.at.isBefore(best.at))) best = c;
  }
  // Раньше первой записи — те же условия, что в первой: до первой правки
  // ставки не менялись.
  return (best ?? history.reduce((a, b) => a.at.isBefore(b.at) ? a : b)).terms;
}
