import 'package:cloud_firestore/cloud_firestore.dart';

/// Единицы измерения остатков склада. Одного набора достаточно, чтобы вести
/// в общем журнале и граммовку табака, и миллилитры/литры сиропов, ликёров,
/// пива в кегах, и штуки — банки пива, бутылки, угли, чашки, крышки и любые
/// другие штучные позиции. При добавлении позиции админ просто выбирает
/// подходящую единицу — сама складская логика (остаток, движения,
/// инвентаризация) от выбора единицы не зависит.
enum InventoryUnit { g, kg, ml, l, pcs }

extension InventoryUnitX on InventoryUnit {
  String get label {
    switch (this) {
      case InventoryUnit.g:
        return 'г';
      case InventoryUnit.kg:
        return 'кг';
      case InventoryUnit.ml:
        return 'мл';
      case InventoryUnit.l:
        return 'л';
      case InventoryUnit.pcs:
        return 'шт';
    }
  }

  String get fullLabel {
    switch (this) {
      case InventoryUnit.g:
        return 'граммы (г)';
      case InventoryUnit.kg:
        return 'килограммы (кг)';
      case InventoryUnit.ml:
        return 'миллилитры (мл)';
      case InventoryUnit.l:
        return 'литры (л)';
      case InventoryUnit.pcs:
        return 'штуки (шт)';
    }
  }

  /// Шаг быстрых кнопок +/- на карточке позиции — подобран так, чтобы не
  /// приходилось по 20 раз нажимать для типичного прихода/расхода этой
  /// единицы (граммы табака шагают десятками, литры — целыми и т.д.).
  double get quickStep {
    switch (this) {
      case InventoryUnit.g:
        return 10;
      case InventoryUnit.kg:
        return 0.5;
      case InventoryUnit.ml:
        return 50;
      case InventoryUnit.l:
        return 1;
      case InventoryUnit.pcs:
        return 1;
    }
  }

  /// Сколько знаков после запятой разумно показывать/вводить для единицы —
  /// дробные килограммы и литры (0.5 кг, 1.5 л) имеют смысл, дробные граммы,
  /// миллилитры и штуки — нет.
  int get decimals => (this == InventoryUnit.kg || this == InventoryUnit.l) ? 3 : 0;

  static InventoryUnit fromName(String? name) => InventoryUnit.values
      .firstWhere((u) => u.name == name, orElse: () => InventoryUnit.pcs);

  /// Компактное отображение числа без лишних нулей после запятой —
  /// "1.5 кг", а не "1.500 кг"; "10 г", а не "10.000 г".
  String format(double value) {
    var s = value.toStringAsFixed(decimals);
    if (decimals > 0 && s.contains('.')) {
      s = s.replaceFirst(RegExp(r'0+$'), '');
      s = s.replaceFirst(RegExp(r'\.$'), '');
    }
    return s;
  }

  String formatWithLabel(double value) => '${format(value)} $label';
}

/// Позиция склада — любой отслеживаемый ресурс: сорт табака в граммах,
/// сироп/алкоголь в мл или л, банки/бутылки пива в штуках, угли, расходники
/// и т.п. Список позиций полностью произвольный — админ заводит и убирает
/// то, что нужно именно этому заведению.
class InventoryItem {
  final String id;
  final String name;

  /// Произвольная категория для группировки в списке ("Табак", "Пиво",
  /// "Бар", "Расходники" и т.д.) — не отдельный справочник, просто текст,
  /// чтобы не заставлять админа заранее ничего настраивать.
  final String category;
  final InventoryUnit unit;

  /// Текущий остаток в единицах [unit].
  final double quantity;

  /// Порог "мало на складе" в тех же единицах. 0 — порог не задан, позиция
  /// никогда не подсвечивается как заканчивающаяся.
  final double minQuantity;

  /// Отслеживается ли позиция сейчас. Позволяет админу временно убрать
  /// позицию из активного учёта и инвентаризаций, не теряя её остаток и
  /// историю движений (в отличие от полного удаления).
  final bool active;

  final String note;
  final DateTime? updatedAt;

  InventoryItem({
    required this.id,
    required this.name,
    this.category = '',
    required this.unit,
    this.quantity = 0,
    this.minQuantity = 0,
    this.active = true,
    this.note = '',
    this.updatedAt,
  });

  /// Мало на складе — только если порог явно задан админом.
  bool get isLow => minQuantity > 0 && quantity <= minQuantity;

  factory InventoryItem.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return InventoryItem(
      id: doc.id,
      name: data['name'] ?? '',
      category: data['category'] ?? '',
      unit: InventoryUnitX.fromName(data['unit'] as String?),
      quantity: (data['quantity'] as num?)?.toDouble() ?? 0,
      minQuantity: (data['minQuantity'] as num?)?.toDouble() ?? 0,
      active: data['active'] ?? true,
      note: data['note'] ?? '',
      updatedAt: (data['updatedAt'] as Timestamp?)?.toDate(),
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'category': category,
        'unit': unit.name,
        'quantity': quantity,
        'minQuantity': minQuantity,
        'active': active,
        'note': note,
        'updatedAt': Timestamp.fromDate(DateTime.now()),
      };

  InventoryItem copyWith({
    String? name,
    String? category,
    InventoryUnit? unit,
    double? quantity,
    double? minQuantity,
    bool? active,
    String? note,
  }) =>
      InventoryItem(
        id: id,
        name: name ?? this.name,
        category: category ?? this.category,
        unit: unit ?? this.unit,
        quantity: quantity ?? this.quantity,
        minQuantity: minQuantity ?? this.minQuantity,
        active: active ?? this.active,
        note: note ?? this.note,
        updatedAt: updatedAt,
      );
}

/// Запись в истории движений одной позиции склада — приход, списание,
/// ручная корректировка или результат инвентаризации. История ведётся
/// отдельной коллекцией (а не переписыванием остатка "молча"), чтобы всегда
/// можно было посмотреть, откуда взялась та или иная цифра остатка.
class InventoryMovement {
  final String id;
  final String itemId;
  final String itemName;
  final InventoryUnit unit;

  /// receipt — приход, writeoff — списание/расход, correction — ручная
  /// корректировка, count — результат инвентаризации.
  final String type;

  /// Изменение остатка (может быть отрицательным).
  final double delta;

  /// Остаток сразу после этого движения — чтобы в истории было видно
  /// не только "что изменилось", но и "сколько стало".
  final double resultingQty;

  final String reason;
  final String employeeName;
  final DateTime createdAt;

  InventoryMovement({
    required this.id,
    required this.itemId,
    required this.itemName,
    required this.unit,
    required this.type,
    required this.delta,
    required this.resultingQty,
    this.reason = '',
    required this.employeeName,
    required this.createdAt,
  });

  String get typeLabel {
    switch (type) {
      case 'receipt':
        return 'Приход';
      case 'writeoff':
        return 'Списание';
      case 'count':
        return 'Инвентаризация';
      default:
        return 'Корректировка';
    }
  }

  factory InventoryMovement.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return InventoryMovement(
      id: doc.id,
      itemId: data['itemId'] ?? '',
      itemName: data['itemName'] ?? '',
      unit: InventoryUnitX.fromName(data['unit'] as String?),
      type: data['type'] ?? 'correction',
      delta: (data['delta'] as num?)?.toDouble() ?? 0,
      resultingQty: (data['resultingQty'] as num?)?.toDouble() ?? 0,
      reason: data['reason'] ?? '',
      employeeName: data['employeeName'] ?? '',
      createdAt: (data['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
  }

  Map<String, dynamic> toMap() => {
        'itemId': itemId,
        'itemName': itemName,
        'unit': unit.name,
        'type': type,
        'delta': delta,
        'resultingQty': resultingQty,
        'reason': reason,
        'employeeName': employeeName,
        'createdAt': Timestamp.fromDate(createdAt),
      };
}

/// Одна строка инвентаризации — снимок ожидаемого (системного) остатка
/// позиции на момент старта пересчёта плюс фактически введённое количество.
class InventoryCountEntry {
  final String itemId;
  final String name;
  final String category;
  final InventoryUnit unit;

  /// Остаток по системе на момент старта инвентаризации.
  final double expectedQty;

  /// Фактически посчитанное количество; null — ещё не введено.
  final double? countedQty;

  InventoryCountEntry({
    required this.itemId,
    required this.name,
    this.category = '',
    required this.unit,
    required this.expectedQty,
    this.countedQty,
  });

  bool get isCounted => countedQty != null;
  double? get diff => countedQty == null ? null : countedQty! - expectedQty;

  factory InventoryCountEntry.fromMap(Map<String, dynamic> data) => InventoryCountEntry(
        itemId: data['itemId'] ?? '',
        name: data['name'] ?? '',
        category: data['category'] ?? '',
        unit: InventoryUnitX.fromName(data['unit'] as String?),
        expectedQty: (data['expectedQty'] as num?)?.toDouble() ?? 0,
        countedQty: (data['countedQty'] as num?)?.toDouble(),
      );

  Map<String, dynamic> toMap() => {
        'itemId': itemId,
        'name': name,
        'category': category,
        'unit': unit.name,
        'expectedQty': expectedQty,
        'countedQty': countedQty,
      };

  InventoryCountEntry copyWith({double? countedQty, bool clear = false}) => InventoryCountEntry(
        itemId: itemId,
        name: name,
        category: category,
        unit: unit,
        expectedQty: expectedQty,
        countedQty: clear ? null : (countedQty ?? this.countedQty),
      );
}

/// Сессия инвентаризации (пересчёта остатков). В один момент времени
/// активна максимум одна — как и со сменой кассы, это отражает реальный
/// процесс: пересчёт склада делают за один проход, а не параллельно
/// несколькими людьми по разным спискам.
class InventoryCount {
  final String id;

  /// in_progress — идёт пересчёт, completed — завершена и остатки
  /// применены, cancelled — отменена без применения.
  final String status;
  final DateTime startedAt;
  final String startedBy;
  final DateTime? closedAt;
  final String closedBy;
  final List<InventoryCountEntry> entries;

  InventoryCount({
    required this.id,
    required this.status,
    required this.startedAt,
    required this.startedBy,
    this.closedAt,
    this.closedBy = '',
    this.entries = const [],
  });

  int get totalCount => entries.length;
  int get countedCount => entries.where((e) => e.isCounted).length;
  int get discrepancyCount =>
      entries.where((e) => e.isCounted && (e.diff ?? 0).abs() > 0.0001).length;

  factory InventoryCount.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return InventoryCount(
      id: doc.id,
      status: data['status'] ?? 'in_progress',
      startedAt: (data['startedAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
      startedBy: data['startedBy'] ?? '',
      closedAt: (data['closedAt'] as Timestamp?)?.toDate(),
      closedBy: data['closedBy'] ?? '',
      entries: ((data['entries'] ?? []) as List)
          .map((e) => InventoryCountEntry.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
    );
  }

  Map<String, dynamic> toMap() => {
        'status': status,
        'startedAt': Timestamp.fromDate(startedAt),
        'startedBy': startedBy,
        'closedAt': closedAt != null ? Timestamp.fromDate(closedAt!) : null,
        'closedBy': closedBy,
        'entries': entries.map((e) => e.toMap()).toList(),
      };
}