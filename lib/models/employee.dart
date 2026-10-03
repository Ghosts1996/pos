import 'package:cloud_firestore/cloud_firestore.dart';
import '../utils/constants.dart';
import 'pay_terms.dart';

class Employee {
  final String id;
  final String name;
  final String pinCode; // 4-значный пин для входа
  final String role;    // 'admin' | 'employee'

  /// Специализация — официант/кальянщик/бармен/универсал (см.
  /// AppConstants.position* и её же комментарий). Определяет, какие
  /// вызовы гостя из-за стола этому сотруднику показывать/присылать —
  /// НЕ то же самое, что [role] (та про доступ, эта про адресацию).
  final String position;

  // ---- Зарплата ----
  // Оплата времени — ОДНО из двух (в редакторе они взаимоисключающие):
  //  • почасовая ставка;
  //  • оклад за смену — фиксированная сумма за каждую отработанную смену.
  final bool hourlyRateEnabled;
  final double hourlyRate; // ₽/час
  final bool shiftRateEnabled;
  final double shiftRate; // ₽ за смену
  // Переработка — надбавка к оплате времени за часы сверх нормы В ПРЕДЕЛАХ
  // ОДНОЙ СМЕНЫ (см. PayrollCalculator). При почасовой ставке час
  // переработки = ставка × множитель, при окладе за смену — отдельная
  // цена часа [overtimeHourRate].
  final bool overtimeEnabled;
  final double overtimeThresholdHours; // после скольких часов В СМЕНЕ начинается переработка
  final double overtimeMultiplier; // во сколько раз ставка выше на переработке
  final double overtimeHourRate; // ₽ за час переработки при окладе за смену
  // Проценты с продаж (см. PayTerms): с чеков, которые сотрудник вёл, с
  // кальянов и с напитков бара.
  final bool salesPercentEnabled;
  final double salesPercentRate; // % с чеков, напр. 5 = 5%
  final bool checkPercentExcludesHookah;
  final double hookahPercentRate;
  final double barPercentRate;

  /// История изменений оплаты — по ней прошлые смены считаются по старым
  /// ставкам. Пишется только FirestoreService.saveEmployee (дописывает
  /// запись), в [toMap] её нет.
  final List<PayChange> payHistory;

  /// Личная ссылка для чаевых (Нетмонет, CloudTips, страница банка) —
  /// необязательно. Если задана, гость может перевести чаевые напрямую
  /// сотруднику, минуя кассу. Без неё чаевые добавляются к счёту.
  final String tipsLink;

  Employee({
    required this.id,
    required this.name,
    required this.pinCode,
    required this.role,
    this.position = AppConstants.positionUniversal,
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
    this.payHistory = const [],
    this.tipsLink = '',
  });

  /// Текущие условия оплаты.
  PayTerms get payTerms => PayTerms(
        hourlyRateEnabled: hourlyRateEnabled,
        hourlyRate: hourlyRate,
        shiftRateEnabled: shiftRateEnabled,
        shiftRate: shiftRate,
        overtimeEnabled: overtimeEnabled,
        overtimeThresholdHours: overtimeThresholdHours,
        overtimeMultiplier: overtimeMultiplier,
        overtimeHourRate: overtimeHourRate,
        salesPercentEnabled: salesPercentEnabled,
        salesPercentRate: salesPercentRate,
        checkPercentExcludesHookah: checkPercentExcludesHookah,
        hookahPercentRate: hookahPercentRate,
        barPercentRate: barPercentRate,
      );

  /// Условия, действовавшие в момент [t] (см. [payTermsAt]).
  PayTerms termsAt(DateTime t) => payTermsAt(payHistory, payTerms, t);

  /// Хоть один способ расчёта зарплаты настроен — иначе отчёт по сотруднику
  /// будет пустым (не ошибка, но стоит показать подсказку в интерфейсе).
  bool get payrollConfigured =>
      hourlyRateEnabled || shiftRateEnabled || salesPercentEnabled ||
      // зарплату отключили, но в отчётный период она ещё действовала
      payHistory.any((c) => c.terms.configured);

  /// «Перезабивка» и напоминания про угли — см. AppConstants.handlesHookah.
  bool handlesHookah({required bool hookahVenue}) =>
      AppConstants.handlesHookah(position: position, role: role, hookahVenue: hookahVenue);

  /// Кнопка «Перезабивка» — см. AppConstants.canRefillHookah.
  bool canRefillHookah({required bool hookahVenue}) =>
      AppConstants.canRefillHookah(position: position, role: role, hookahVenue: hookahVenue);

  factory Employee.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return Employee(
      id: doc.id,
      name: data['name'] ?? '',
      pinCode: data['pinCode'] ?? '',
      role: data['role'] ?? 'employee',
      position: AppConstants.normalizePosition(data['position'] as String?),
      hourlyRateEnabled: data['hourlyRateEnabled'] ?? false,
      hourlyRate: (data['hourlyRate'] ?? 0).toDouble(),
      shiftRateEnabled: data['shiftRateEnabled'] ?? false,
      shiftRate: (data['shiftRate'] ?? 0).toDouble(),
      overtimeEnabled: data['overtimeEnabled'] ?? false,
      overtimeThresholdHours: (data['overtimeThresholdHours'] ?? 8).toDouble(),
      overtimeMultiplier: (data['overtimeMultiplier'] ?? 1.5).toDouble(),
      overtimeHourRate: (data['overtimeHourRate'] ?? 0).toDouble(),
      salesPercentEnabled: data['salesPercentEnabled'] ?? false,
      salesPercentRate: (data['salesPercentRate'] ?? 0).toDouble(),
      checkPercentExcludesHookah: data['checkPercentExcludesHookah'] == true,
      hookahPercentRate: (data['hookahPercentRate'] as num?)?.toDouble() ?? 0,
      barPercentRate: (data['barPercentRate'] as num?)?.toDouble() ?? 0,
      payHistory: ((data['payHistory'] as List?) ?? const [])
          .whereType<Map>()
          .map((m) => PayChange.fromMap(Map<String, dynamic>.from(m)))
          .toList(),
      tipsLink: (data['tipsLink'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'pinCode': pinCode,
        'role': role,
        'position': position,
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
        'tipsLink': tipsLink,
      };

  Employee copyWith({
    String? name,
    String? pinCode,
    String? role,
    String? position,
    bool? hourlyRateEnabled,
    double? hourlyRate,
    bool? shiftRateEnabled,
    double? shiftRate,
    bool? overtimeEnabled,
    double? overtimeThresholdHours,
    double? overtimeMultiplier,
    double? overtimeHourRate,
    bool? salesPercentEnabled,
    double? salesPercentRate,
    bool? checkPercentExcludesHookah,
    double? hookahPercentRate,
    double? barPercentRate,
    String? tipsLink,
  }) {
    return Employee(
      id: id,
      name: name ?? this.name,
      pinCode: pinCode ?? this.pinCode,
      role: role ?? this.role,
      position: position ?? this.position,
      hourlyRateEnabled: hourlyRateEnabled ?? this.hourlyRateEnabled,
      hourlyRate: hourlyRate ?? this.hourlyRate,
      shiftRateEnabled: shiftRateEnabled ?? this.shiftRateEnabled,
      shiftRate: shiftRate ?? this.shiftRate,
      overtimeEnabled: overtimeEnabled ?? this.overtimeEnabled,
      overtimeThresholdHours: overtimeThresholdHours ?? this.overtimeThresholdHours,
      overtimeMultiplier: overtimeMultiplier ?? this.overtimeMultiplier,
      overtimeHourRate: overtimeHourRate ?? this.overtimeHourRate,
      salesPercentEnabled: salesPercentEnabled ?? this.salesPercentEnabled,
      salesPercentRate: salesPercentRate ?? this.salesPercentRate,
      checkPercentExcludesHookah: checkPercentExcludesHookah ?? this.checkPercentExcludesHookah,
      hookahPercentRate: hookahPercentRate ?? this.hookahPercentRate,
      barPercentRate: barPercentRate ?? this.barPercentRate,
      payHistory: payHistory,
      tipsLink: tipsLink ?? this.tipsLink,
    );
  }
}
