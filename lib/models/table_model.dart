import 'package:cloud_firestore/cloud_firestore.dart';

/// Модель стола на карте зала
class TableModel {
  final String id;
  final String name; // Название/номер стола, напр. "Стол 3"
  final double x; // Позиция X на карте (0..1, относительно ширины)
  final double y; // Позиция Y на карте (0..1, относительно высоты)
  final int seats; // Количество мест
  /// Форма: 'rect' (квадрат), 'circle', 'long' (длинный, 2×1), 'oval'
  /// (2×1), 'corner' (угловой буквой «Г», 2×2 без одной клетки), 'bar'
  /// (барная стойка, 3×1).
  final String shape;

  /// Поворот на четверти оборота (0..3): у длинного стола 0/2 — вдоль,
  /// 1/3 — поперёк; у углового — где сгиб (0 — левый нижний угол, дальше по
  /// часовой стрелке); у барной стойки — сторона бармена.
  final int rotation;
  final String status; // 'free' | 'occupied'

  /// Зона зала: «Основной зал», «Терраса», «VIP», «Бар»… Пусто — без зоны
  /// (одна общая схема, как было раньше). У каждой зоны своя схема: x/y
  /// стола — доли внутри схемы ЕГО зоны.
  final String zone;

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
  /// firestore.rules), поэтому расчёт свободных слотов в «Colibri Lounge»
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
    this.rotation = 0,
    this.status = 'free',
    this.zone = '',
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
      // 'triangle' — прежний угловой элемент, теперь это угловой стол.
      shape: data['shape'] == 'triangle' ? 'corner' : (data['shape'] ?? 'rect'),
      rotation: (((data['rotation'] as num?)?.toInt() ?? 0) % 4 + 4) % 4,
      status: data['status'] ?? 'free',
      zone: (data['zone'] ?? '').toString().trim(),
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
      'rotation': rotation,
      'status': status,
      'zone': zone,
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
    int? rotation,
    String? status,
    String? zone,
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
      rotation: rotation ?? this.rotation,
      status: status ?? this.status,
      zone: zone ?? this.zone,
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

  /// Чек уже закреплён за другим гостем. Поле вычисляемое: в базе его нет,
  /// занятость лежит в отдельной коллекции sessionClaims.
  final bool taken;

  const TableCheck({
    required this.id,
    this.label = '',
    this.openedAt,
    this.taken = false,
  });

  TableCheck copyWith({bool? taken}) => TableCheck(
        id: id,
        label: label,
        openedAt: openedAt,
        taken: taken ?? this.taken,
      );

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
