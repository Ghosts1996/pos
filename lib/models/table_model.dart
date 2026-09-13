import 'package:cloud_firestore/cloud_firestore.dart';

/// Модель стола на карте зала
class TableModel {
  final String id;
  final String name; // Название/номер стола, напр. "Стол 3"
  final double x; // Позиция X на карте (0..1, относительно ширины)
  final double y; // Позиция Y на карте (0..1, относительно высоты)
  final int seats; // Количество мест
  final String shape; // 'rect' или 'circle'
  final String status; // 'free' | 'occupied'

  /// Id всех сейчас открытых чеков за этим столом. Раньше был единственный
  /// currentSessionId (String?) — на стол можно было открыть только один
  /// счёт. Теперь это список: на стол можно открыть несколько отдельных
  /// чеков (например, для раздельной оплаты гостями), см. [maxOpenSessions].
  final List<String> activeSessionIds;

  /// Сколько чеков разрешено держать открытыми одновременно на этом столе.
  /// Настраивается администратором в карте зала. По умолчанию — 2.
  final int maxOpenSessions;

  /// До какого момента стол занят живым гостем — максимальный plannedEnd
  /// среди открытых на нём чеков. Денормализовано СПЕЦИАЛЬНО: карточку
  /// стола гостю читать можно, а коллекцию sessions — нет (см.
  /// firestore.rules), поэтому расчёт свободных слотов в «Колибри Лаундж»
  /// и оценка ожидания в листе ожидания опираются именно на это поле, а
  /// не на запрос к чекам, который у гостя падал с permission-denied.
  /// Поддерживается в актуальном состоянии POS-ом (см.
  /// FirestoreService.syncTableBusyUntil). null — стол свободен.
  final DateTime? busyUntil;

  /// Краткая витрина открытых чеков стола — для выбора «своего» чека в
  /// гостевом приложении. Заполняется кассой (см.
  /// FirestoreService.syncTableBusyUntil). Персональных данных не несёт:
  /// только id, подпись кассира и время открытия.
  final List<TableCheck> openChecks;

  TableModel({
    required this.id,
    required this.name,
    required this.x,
    required this.y,
    this.seats = 4,
    this.shape = 'rect',
    this.status = 'free',
    this.activeSessionIds = const [],
    this.maxOpenSessions = 2,
    this.busyUntil,
    this.openChecks = const [],
  });

  factory TableModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};

    // Обратная совместимость со старыми документами, где было одиночное
    // поле currentSessionId вместо списка activeSessionIds.
    List<String> ids;
    if (data['activeSessionIds'] != null) {
      ids = (data['activeSessionIds'] as List).map((e) => e.toString()).toList();
    } else if (data['currentSessionId'] != null) {
      ids = [data['currentSessionId'].toString()];
    } else {
      ids = [];
    }

    return TableModel(
      id: doc.id,
      name: data['name'] ?? '',
      x: (data['x'] ?? 0.1).toDouble(),
      y: (data['y'] ?? 0.1).toDouble(),
      seats: data['seats'] ?? 4,
      shape: data['shape'] ?? 'rect',
      status: data['status'] ?? 'free',
      activeSessionIds: ids,
      maxOpenSessions: ((data['maxOpenSessions'] as num?)?.toInt()) ?? 2,
      busyUntil: data['busyUntil'] is Timestamp
          ? (data['busyUntil'] as Timestamp).toDate()
          : null,
      openChecks: ((data['openChecks'] ?? []) as List)
          .map((e) => TableCheck.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'name': name,
      'x': x,
      'y': y,
      'seats': seats,
      'shape': shape,
      'status': status,
      'activeSessionIds': activeSessionIds,
      'maxOpenSessions': maxOpenSessions,
      'busyUntil': busyUntil == null ? null : Timestamp.fromDate(busyUntil!),
      'openChecks': openChecks.map((e) => e.toMap()).toList(),
    };
  }

  /// true, если на столе уже открыто максимально допустимое число чеков
  bool get isFull => activeSessionIds.length >= maxOpenSessions;

  TableModel copyWith({
    String? name,
    double? x,
    double? y,
    int? seats,
    String? shape,
    String? status,
    List<String>? activeSessionIds,
    int? maxOpenSessions,
    DateTime? busyUntil,
    List<TableCheck>? openChecks,
  }) {
    return TableModel(
      id: id,
      name: name ?? this.name,
      x: x ?? this.x,
      y: y ?? this.y,
      seats: seats ?? this.seats,
      shape: shape ?? this.shape,
      status: status ?? this.status,
      activeSessionIds: activeSessionIds ?? this.activeSessionIds,
      maxOpenSessions: maxOpenSessions ?? this.maxOpenSessions,
      busyUntil: busyUntil ?? this.busyUntil,
      openChecks: openChecks ?? this.openChecks,
    );
  }
}

/// Один открытый чек стола в витрине [TableModel.openChecks].
///
/// Ровно столько, сколько нужно гостю, чтобы отличить свой чек от соседнего:
/// подпись, которую кассир поставил чеку, и время его открытия. Ни позиций,
/// ни суммы здесь нет — за соседний счёт гость платить не будет, а видеть
/// его не должен.
class TableCheck {
  final String id;
  final String label;
  final DateTime? openedAt;

  const TableCheck({required this.id, this.label = '', this.openedAt});

  factory TableCheck.fromMap(Map<String, dynamic> m) {
    final ts = m['openedAt'];
    return TableCheck(
      id: m['id']?.toString() ?? '',
      label: m['label']?.toString() ?? '',
      openedAt: ts is Timestamp ? ts.toDate() : null,
    );
  }

  Map<String, dynamic> toMap() => {
        'id': id,
        'label': label,
        'openedAt': openedAt == null ? null : Timestamp.fromDate(openedAt!),
      };
}
