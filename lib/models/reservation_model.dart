import 'package:cloud_firestore/cloud_firestore.dart';
import 'session_model.dart';

/// Статус брони.
///
/// new       — гость создал бронь в «Colibri Lounge», ждёт подтверждения
/// confirmed — администратор подтвердил, стол держим
/// seated    — гость пришёл, по брони открыт чек (sessionId заполнен)
/// cancelled — отменена (гостем или заведением)
/// noShow    — гость не пришёл (ставится вручную или авто-скриптом)
enum ReservationStatus { newRequest, confirmed, seated, cancelled, noShow }

extension ReservationStatusX on ReservationStatus {
  String get code {
    switch (this) {
      case ReservationStatus.newRequest:
        return 'new';
      case ReservationStatus.confirmed:
        return 'confirmed';
      case ReservationStatus.seated:
        return 'seated';
      case ReservationStatus.cancelled:
        return 'cancelled';
      case ReservationStatus.noShow:
        return 'noShow';
    }
  }

  String get label {
    switch (this) {
      case ReservationStatus.newRequest:
        return 'Новая';
      case ReservationStatus.confirmed:
        return 'Подтверждена';
      case ReservationStatus.seated:
        return 'Гость за столом';
      case ReservationStatus.cancelled:
        return 'Отменена';
      case ReservationStatus.noShow:
        return 'Не пришёл';
    }
  }

  /// Бронь ещё «живая» — занимает стол в сетке доступности слотов.
  bool get blocksTable =>
      this == ReservationStatus.newRequest || this == ReservationStatus.confirmed;

  static ReservationStatus fromCode(String? code) {
    switch (code) {
      case 'confirmed':
        return ReservationStatus.confirmed;
      case 'seated':
        return ReservationStatus.seated;
      case 'cancelled':
        return ReservationStatus.cancelled;
      case 'noShow':
        return ReservationStatus.noShow;
      default:
        return ReservationStatus.newRequest;
    }
  }
}

/// Бронь стола. Создаётся из клиентского приложения «Colibri Lounge»
/// (source = 'kolibri') либо вручную сотрудником на POS (source = 'pos').
/// Один и тот же документ в реальном времени видят оба приложения.
class ReservationModel {
  final String id;

  /// UID гостя в Firebase Auth клиентского приложения. Пусто — бронь
  /// заведена сотрудником вручную (например, по телефону).
  final String clientUid;

  final String guestName;
  final String phone;
  final int guestsCount;

  /// Желаемый/назначенный стол. Пусто — «любой свободный»,
  /// администратор назначит стол при подтверждении.
  final String tableId;
  final String tableName;

  final DateTime startTime;
  final int durationMinutes;

  final ReservationStatus status;
  final String comment;

  /// 'kolibri' | 'pos' | 'phone'
  final String source;

  /// Предзаказ: гость собрал позиции заранее, при посадке они переносятся
  /// в чек одним нажатием (см. ReservationService.seat).
  final List<OrderItem> preOrder;

  /// Короткая заметка ИИ-агента «Хостес»: риск неявки, пожелания гостя,
  /// рекомендации по рассадке. Заполняется агентом, не гостем.
  final String aiNote;

  /// Чек, открытый по этой брони (после посадки).
  final String sessionId;

  final DateTime createdAt;
  final DateTime? confirmedAt;
  final String handledBy;

  ReservationModel({
    required this.id,
    this.clientUid = '',
    required this.guestName,
    required this.phone,
    this.guestsCount = 2,
    this.tableId = '',
    this.tableName = '',
    required this.startTime,
    this.durationMinutes = 90,
    this.status = ReservationStatus.newRequest,
    this.comment = '',
    this.source = 'kolibri',
    this.preOrder = const [],
    this.aiNote = '',
    this.sessionId = '',
    required this.createdAt,
    this.confirmedAt,
    this.handledBy = '',
  });

  DateTime get endTime => startTime.add(Duration(minutes: durationMinutes));

  double get preOrderTotal => preOrder.fold(0.0, (s, i) => s + i.total);

  /// Пересекается ли бронь по времени с интервалом [from]..[to].
  bool overlaps(DateTime from, DateTime to) =>
      startTime.isBefore(to) && endTime.isAfter(from);

  factory ReservationModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final start = data['startTime'];
    final created = data['createdAt'];
    final confirmed = data['confirmedAt'];
    return ReservationModel(
      id: doc.id,
      clientUid: data['clientUid'] ?? '',
      guestName: data['guestName'] ?? '',
      phone: data['phone'] ?? '',
      guestsCount: (data['guestsCount'] as num?)?.toInt() ?? 2,
      tableId: data['tableId'] ?? '',
      tableName: data['tableName'] ?? '',
      startTime: start is Timestamp ? start.toDate() : DateTime.now(),
      durationMinutes: (data['durationMinutes'] as num?)?.toInt() ?? 90,
      status: ReservationStatusX.fromCode(data['status'] as String?),
      comment: data['comment'] ?? '',
      source: data['source'] ?? 'kolibri',
      preOrder: ((data['preOrder'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      aiNote: data['aiNote'] ?? '',
      sessionId: data['sessionId'] ?? '',
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      confirmedAt: confirmed is Timestamp ? confirmed.toDate() : null,
      handledBy: data['handledBy'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {
        'clientUid': clientUid,
        'guestName': guestName,
        'phone': phone,
        'guestsCount': guestsCount,
        'tableId': tableId,
        'tableName': tableName,
        'startTime': Timestamp.fromDate(startTime),
        'durationMinutes': durationMinutes,
        'status': status.code,
        'comment': comment,
        'source': source,
        'preOrder': preOrder.map((e) => e.toMap()).toList(),
        'aiNote': aiNote,
        'sessionId': sessionId,
        'createdAt': Timestamp.fromDate(createdAt),
        'confirmedAt': confirmedAt != null ? Timestamp.fromDate(confirmedAt!) : null,
        'handledBy': handledBy,
      };

  ReservationModel copyWith({
    String? guestName,
    String? phone,
    int? guestsCount,
    String? tableId,
    String? tableName,
    DateTime? startTime,
    int? durationMinutes,
    ReservationStatus? status,
    String? comment,
    List<OrderItem>? preOrder,
    String? aiNote,
    String? sessionId,
    DateTime? confirmedAt,
    String? handledBy,
  }) =>
      ReservationModel(
        id: id,
        clientUid: clientUid,
        guestName: guestName ?? this.guestName,
        phone: phone ?? this.phone,
        guestsCount: guestsCount ?? this.guestsCount,
        tableId: tableId ?? this.tableId,
        tableName: tableName ?? this.tableName,
        startTime: startTime ?? this.startTime,
        durationMinutes: durationMinutes ?? this.durationMinutes,
        status: status ?? this.status,
        comment: comment ?? this.comment,
        source: source,
        preOrder: preOrder ?? this.preOrder,
        aiNote: aiNote ?? this.aiNote,
        sessionId: sessionId ?? this.sessionId,
        createdAt: createdAt,
        confirmedAt: confirmedAt ?? this.confirmedAt,
        handledBy: handledBy ?? this.handledBy,
      );
}
