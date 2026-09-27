import 'package:cloud_firestore/cloud_firestore.dart';

/// Модель кассовой смены. Смена — это не календарный день, а период между
/// открытием и закрытием кассы: официант/админ открывает смену при входе в
/// приложение (или вручную), а закрывает — кнопкой "Закрыть смену" на
/// экране X-отчёта. Все чеки, закрытые в промежутке [openedAt; closedAt),
/// относятся к этой смене — независимо от того, что смена перешла через
/// полночь.
class ShiftModel {
  final String id;
  final DateTime openedAt;
  final DateTime? closedAt;
  final String openedBy;

  /// Id сотрудника, открывшего смену. Имя для человека, id — для техники:
  /// по нему устройство понимает, оно ли сейчас «на смене», и показывать
  /// ли уведомления о вызовах гостей именно здесь.
  final String openedById;

  final String? closedBy;
  final String status; // 'open' | 'closed'

  // ---- Наличные (см. CashDrawerSummary) ----
  /// Размен на начало смены — сколько оставили в кассе в конце прошлой.
  final double openingCash;

  /// Пересчёт кассы при закрытии: сколько должно было быть, сколько
  /// насчитали, сколько инкассировали и сколько оставили на размен.
  final double? closingExpectedCash;
  final double? closingCountedCash;
  final double? closingCollected;
  final double? closingLeftCash;

  ShiftModel({
    required this.id,
    required this.openedAt,
    this.closedAt,
    required this.openedBy,
    this.openedById = '',
    this.closedBy,
    this.status = 'open',
    this.openingCash = 0,
    this.closingExpectedCash,
    this.closingCountedCash,
    this.closingCollected,
    this.closingLeftCash,
  });

  /// Недостача (<0) или излишек (>0) при пересчёте, если он был.
  double? get closingDiff =>
      closingCountedCash == null || closingExpectedCash == null ? null : closingCountedCash! - closingExpectedCash!;

  bool get isOpen => status == 'open';

  factory ShiftModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final opened = data['openedAt'];
    final closed = data['closedAt'];
    return ShiftModel(
      id: doc.id,
      openedAt: opened is Timestamp ? opened.toDate() : DateTime.now(),
      closedAt: closed is Timestamp ? closed.toDate() : null,
      openedBy: data['openedBy'] ?? '',
      openedById: data['openedById'] ?? '',
      closedBy: data['closedBy'],
      status: data['status'] ?? 'open',
      openingCash: ((data['openingCash'] ?? 0) as num).toDouble(),
      closingExpectedCash: (data['closingExpectedCash'] as num?)?.toDouble(),
      closingCountedCash: (data['closingCountedCash'] as num?)?.toDouble(),
      closingCollected: (data['closingCollected'] as num?)?.toDouble(),
      closingLeftCash: (data['closingLeftCash'] as num?)?.toDouble(),
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'openedAt': Timestamp.fromDate(openedAt),
      'closedAt': closedAt != null ? Timestamp.fromDate(closedAt!) : null,
      'openedBy': openedBy,
      // Без этой строки id открывшего смену никогда не доезжал до базы:
      // читался он исправно, а записывался только openedBy. Из-за этого
      // устройства не могли понять, кто на смене, и уведомления о вызовах
      // гостей приходили на все планшеты сразу.
      'openedById': openedById,
      'closedBy': closedBy,
      'status': status,
      'openingCash': openingCash,
    };
  }
}