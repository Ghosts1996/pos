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
  final String? closedBy;
  final String status; // 'open' | 'closed'

  ShiftModel({
    required this.id,
    required this.openedAt,
    this.closedAt,
    required this.openedBy,
    this.closedBy,
    this.status = 'open',
  });

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
      closedBy: data['closedBy'],
      status: data['status'] ?? 'open',
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'openedAt': Timestamp.fromDate(openedAt),
      'closedAt': closedAt != null ? Timestamp.fromDate(closedAt!) : null,
      'openedBy': openedBy,
      'closedBy': closedBy,
      'status': status,
    };
  }
}