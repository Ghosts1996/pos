import 'package:cloud_firestore/cloud_firestore.dart';

class Employee {
  final String id;
  final String name;
  final String pinCode; // 4-значный пин для входа
  final String role;    // 'admin' | 'employee'

  // ---- Зарплата: три независимо включаемых способа расчёта ----
  // Оклад — почасовая ставка.
  final bool hourlyRateEnabled;
  final double hourlyRate; // ₽/час
  // Переработка имеет смысл только вместе с окладом — это надбавка к нему за
  // часы сверх нормы В ПРЕДЕЛАХ ОДНОЙ СМЕНЫ (см. PayrollCalculator).
  final bool overtimeEnabled;
  final double overtimeThresholdHours; // после скольких часов В СМЕНЕ начинается переработка
  final double overtimeMultiplier; // во сколько раз ставка выше на переработке
  // Процент с личных продаж сотрудника (по SessionModel.employeeName).
  final bool salesPercentEnabled;
  final double salesPercentRate; // %, напр. 5 = 5%

  Employee({
    required this.id,
    required this.name,
    required this.pinCode,
    required this.role,
    this.hourlyRateEnabled = false,
    this.hourlyRate = 0,
    this.overtimeEnabled = false,
    this.overtimeThresholdHours = 8,
    this.overtimeMultiplier = 1.5,
    this.salesPercentEnabled = false,
    this.salesPercentRate = 0,
  });

  /// Хоть один способ расчёта зарплаты настроен — иначе отчёт по сотруднику
  /// будет пустым (не ошибка, но стоит показать подсказку в интерфейсе).
  bool get payrollConfigured => hourlyRateEnabled || salesPercentEnabled;

  factory Employee.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return Employee(
      id: doc.id,
      name: data['name'] ?? '',
      pinCode: data['pinCode'] ?? '',
      role: data['role'] ?? 'employee',
      hourlyRateEnabled: data['hourlyRateEnabled'] ?? false,
      hourlyRate: (data['hourlyRate'] ?? 0).toDouble(),
      overtimeEnabled: data['overtimeEnabled'] ?? false,
      overtimeThresholdHours: (data['overtimeThresholdHours'] ?? 8).toDouble(),
      overtimeMultiplier: (data['overtimeMultiplier'] ?? 1.5).toDouble(),
      salesPercentEnabled: data['salesPercentEnabled'] ?? false,
      salesPercentRate: (data['salesPercentRate'] ?? 0).toDouble(),
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'pinCode': pinCode,
        'role': role,
        'hourlyRateEnabled': hourlyRateEnabled,
        'hourlyRate': hourlyRate,
        'overtimeEnabled': overtimeEnabled,
        'overtimeThresholdHours': overtimeThresholdHours,
        'overtimeMultiplier': overtimeMultiplier,
        'salesPercentEnabled': salesPercentEnabled,
        'salesPercentRate': salesPercentRate,
      };

  Employee copyWith({
    String? name,
    String? pinCode,
    String? role,
    bool? hourlyRateEnabled,
    double? hourlyRate,
    bool? overtimeEnabled,
    double? overtimeThresholdHours,
    double? overtimeMultiplier,
    bool? salesPercentEnabled,
    double? salesPercentRate,
  }) {
    return Employee(
      id: id,
      name: name ?? this.name,
      pinCode: pinCode ?? this.pinCode,
      role: role ?? this.role,
      hourlyRateEnabled: hourlyRateEnabled ?? this.hourlyRateEnabled,
      hourlyRate: hourlyRate ?? this.hourlyRate,
      overtimeEnabled: overtimeEnabled ?? this.overtimeEnabled,
      overtimeThresholdHours: overtimeThresholdHours ?? this.overtimeThresholdHours,
      overtimeMultiplier: overtimeMultiplier ?? this.overtimeMultiplier,
      salesPercentEnabled: salesPercentEnabled ?? this.salesPercentEnabled,
      salesPercentRate: salesPercentRate ?? this.salesPercentRate,
    );
  }
}
