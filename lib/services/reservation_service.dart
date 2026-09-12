import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/reservation_model.dart';
import '../models/session_model.dart';
import '../models/table_model.dart';

/// Работа с бронями. Один и тот же сервис используется и в POS
/// (подтверждение/посадка), и в клиентском приложении «Колибри Лаундж»
/// (создание/отмена своей брони). Всё в реальном времени через snapshots().
class ReservationService {
  final _db = FirebaseFirestore.instance;

  CollectionReference<Map<String, dynamic>> get _col => _db.collection('reservations');

  // ---------- ЧТЕНИЕ ----------

  /// Брони на конкретный день (для экрана хостес на POS).
  Stream<List<ReservationModel>> dayStream(DateTime day) {
    final from = DateTime(day.year, day.month, day.day);
    final to = from.add(const Duration(days: 1));
    return _col
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('startTime', isLessThan: Timestamp.fromDate(to))
        .orderBy('startTime')
        .snapshots()
        .map((s) => s.docs.map(ReservationModel.fromDoc).toList());
  }

  /// Активные брони на ближайшие [hours] часов — для баннера «скоро придут»
  /// и для ИИ-агента «Хостес».
  Stream<List<ReservationModel>> upcomingStream({int hours = 12}) {
    final now = DateTime.now().subtract(const Duration(minutes: 30));
    final to = now.add(Duration(hours: hours));
    return _col
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
        .where('startTime', isLessThan: Timestamp.fromDate(to))
        .orderBy('startTime')
        .snapshots()
        .map((s) => s.docs
            .map(ReservationModel.fromDoc)
            .where((r) =>
                r.status != ReservationStatus.cancelled &&
                r.status != ReservationStatus.noShow)
            .toList());
  }

  /// Брони конкретного гостя (клиентское приложение).
  Stream<List<ReservationModel>> clientStream(String clientUid) {
    return _col
        .where('clientUid', isEqualTo: clientUid)
        .orderBy('startTime', descending: true)
        .limit(50)
        .snapshots()
        .map((s) => s.docs.map(ReservationModel.fromDoc).toList());
  }

  Stream<ReservationModel?> reservationStream(String id) => _col
      .doc(id)
      .snapshots()
      .map((d) => d.exists ? ReservationModel.fromDoc(d) : null);

  // ---------- ДОСТУПНОСТЬ СЛОТОВ ----------

  /// Столы, свободные на интервал [start] + [durationMinutes].
  ///
  /// Стол считается занятым, если:
  ///  • на него уже есть живая бронь, пересекающаяся по времени, ИЛИ
  ///  • прямо сейчас за ним открыт чек, а бронь начинается в ближайший час
  ///    (гость физически не успеет сесть).
  Future<List<TableModel>> availableTables({
    required DateTime start,
    int durationMinutes = 90,
    int guestsCount = 2,
  }) async {
    final end = start.add(Duration(minutes: durationMinutes));

    final tablesSnap = await _db.collection('tables').get();
    final tables = tablesSnap.docs.map(TableModel.fromDoc).toList();

    // Берём брони на сутки вокруг запрошенного времени — этого достаточно,
    // чтобы поймать все пересечения, и дёшево по чтениям.
    final dayFrom = start.subtract(const Duration(hours: 12));
    final dayTo = start.add(const Duration(hours: 12));
    final resSnap = await _col
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(dayFrom))
        .where('startTime', isLessThan: Timestamp.fromDate(dayTo))
        .get();
    final reservations = resSnap.docs
        .map(ReservationModel.fromDoc)
        .where((r) => r.status.blocksTable)
        .toList();

    final busyByReservation = reservations
        .where((r) => r.overlaps(start, end) && r.tableId.isNotEmpty)
        .map((r) => r.tableId)
        .toSet();

    // Столы, за которыми прямо сейчас сидят гости. Стол нельзя отдать под
    // бронь, пока сеанс не закончится: раньше проверялся только ближайший
    // час, и гостя могли «забронировать» прямо во время его визита.
    // Закладываем 20 минут на уборку и посадку после ухода.
    final sessionsSnap =
        await _db.collection('sessions').where('status', isEqualTo: 'active').get();

    final busyUntil = <String, DateTime>{};
    for (final doc in sessionsSnap.docs) {
      final data = doc.data();
      final tableId = data['tableId']?.toString() ?? '';
      if (tableId.isEmpty) continue;

      final ts = data['plannedEnd'];
      var until = ts is Timestamp ? ts.toDate() : DateTime.now();
      // Сеанс уже просрочен — гость всё ещё за столом, считаем занятым
      // минимум на ближайший час.
      if (until.isBefore(DateTime.now())) {
        until = DateTime.now().add(const Duration(hours: 1));
      }
      until = until.add(const Duration(minutes: 20));

      final prev = busyUntil[tableId];
      if (prev == null || until.isAfter(prev)) busyUntil[tableId] = until;
    }

    return tables.where((t) {
      if (t.seats < guestsCount) return false;
      if (busyByReservation.contains(t.id)) return false;

      // Гость за столом: стол свободен только если бронь начинается после
      // окончания его сеанса с запасом на уборку.
      final occupiedUntil = busyUntil[t.id];
      if (occupiedUntil != null && start.isBefore(occupiedUntil)) return false;

      return true;
    }).toList()
      ..sort((a, b) => a.seats.compareTo(b.seats)); // подбираем стол «впритык»
  }

  /// Сетка доступных времён на день с шагом [stepMinutes].
  /// Используется в клиентском приложении для выбора времени.
  Future<List<DateTime>> availableSlots({
    required DateTime day,
    int durationMinutes = 90,
    int guestsCount = 2,
    int openHour = 12,
    int closeHour = 24,
    int stepMinutes = 30,
  }) async {
    final result = <DateTime>[];
    final now = DateTime.now();
    var cursor = DateTime(day.year, day.month, day.day, openHour);
    final last = DateTime(day.year, day.month, day.day).add(Duration(hours: closeHour));

    while (cursor.isBefore(last)) {
      if (cursor.isAfter(now.add(const Duration(minutes: 15)))) {
        final free = await availableTables(
          start: cursor,
          durationMinutes: durationMinutes,
          guestsCount: guestsCount,
        );
        if (free.isNotEmpty) result.add(cursor);
      }
      cursor = cursor.add(Duration(minutes: stepMinutes));
    }
    return result;
  }

  // ---------- СОЗДАНИЕ / ИЗМЕНЕНИЕ ----------

  /// Создать бронь. Если [tableId] не задан — стол подбирается автоматически
  /// из свободных на это время (самый компактный подходящий).
  Future<String> create(ReservationModel r, {bool autoAssignTable = true}) async {
    var reservation = r;

    if (autoAssignTable && reservation.tableId.isEmpty) {
      final free = await availableTables(
        start: reservation.startTime,
        durationMinutes: reservation.durationMinutes,
        guestsCount: reservation.guestsCount,
      );
      if (free.isEmpty) {
        throw NoTablesAvailableException(reservation.startTime);
      }
      reservation = reservation.copyWith(tableId: free.first.id, tableName: free.first.name);
    }

    final ref = _col.doc();
    await ref.set(reservation.toMap());
    return ref.id;
  }

  Future<void> confirm(String id, String employeeName) => _col.doc(id).update({
        'status': ReservationStatus.confirmed.code,
        'confirmedAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': employeeName,
      });

  Future<void> cancel(String id, {String by = ''}) => _col.doc(id).update({
        'status': ReservationStatus.cancelled.code,
        'handledBy': by,
      });

  Future<void> markNoShow(String id, String employeeName) => _col.doc(id).update({
        'status': ReservationStatus.noShow.code,
        'handledBy': employeeName,
      });

  Future<void> assignTable(String id, TableModel table) => _col.doc(id).update({
        'tableId': table.id,
        'tableName': table.name,
      });

  Future<void> reschedule(String id, DateTime newStart, {int? durationMinutes}) =>
      _col.doc(id).update({
        'startTime': Timestamp.fromDate(newStart),
        if (durationMinutes != null) 'durationMinutes': durationMinutes,
      });

  Future<void> setAiNote(String id, String note) => _col.doc(id).update({'aiNote': note});

  Future<void> setPreOrder(String id, List<OrderItem> items) =>
      _col.doc(id).update({'preOrder': items.map((e) => e.toMap()).toList()});

  // ---------- ПОСАДКА ГОСТЯ ----------

  /// Посадить гостя по брони: открывает чек за столом брони, переносит
  /// предзаказ в чек и связывает бронь с сессией. Всё одной транзакцией,
  /// чтобы два администратора не открыли по брони два чека.
  ///
  /// Возвращает id созданного чека.
  Future<String> seat({
    required ReservationModel reservation,
    required String employeeName,
  }) async {
    if (reservation.tableId.isEmpty) {
      throw StateError('У брони не назначен стол — назначьте стол перед посадкой.');
    }

    final tableRef = _db.collection('tables').doc(reservation.tableId);
    final sessionRef = _db.collection('sessions').doc();
    final resRef = _col.doc(reservation.id);
    final now = DateTime.now();

    await _db.runTransaction((tx) async {
      final freshRes = await tx.get(resRef);
      final resData = freshRes.data() as Map<String, dynamic>? ?? {};
      if ((resData['sessionId'] as String? ?? '').isNotEmpty) {
        throw StateError('По этой брони уже открыт чек.');
      }

      final freshTable = await tx.get(tableRef);
      final data = freshTable.data() as Map<String, dynamic>?;
      if (data == null) throw StateError('Стол брони удалён из карты зала.');

      final ids = ((data['activeSessionIds'] ?? []) as List).map((e) => e.toString()).toList();
      final maxOpen = (data['maxOpenSessions'] as num?)?.toInt() ?? 2;
      if (ids.length >= maxOpen) {
        throw StateError('На столе уже максимум открытых чеков — выберите другой стол.');
      }

      final session = SessionModel(
        id: sessionRef.id,
        tableId: reservation.tableId,
        tableName: data['name'] ?? reservation.tableName,
        employeeName: employeeName,
        guestTag: reservation.guestName,
        startTime: now,
        plannedEnd: now.add(Duration(minutes: reservation.durationMinutes)),
        orderItems: reservation.preOrder,
      );
      tx.set(sessionRef, session.toMap());

      ids.add(sessionRef.id);
      tx.update(tableRef, {'activeSessionIds': ids, 'status': 'occupied'});

      tx.update(resRef, {
        'status': ReservationStatus.seated.code,
        'sessionId': sessionRef.id,
        'handledBy': employeeName,
      });
    });

    // Привязываем гостя к чеку, чтобы в его приложении сразу появился
    // живой счёт и таймер стола.
    if (reservation.clientUid.isNotEmpty) {
      await _db.collection('clients').doc(reservation.clientUid).set({
        'activeSessionId': sessionRef.id,
        'activeTableId': reservation.tableId,
        'lastVisitAt': Timestamp.fromDate(now),
      }, SetOptions(merge: true));
    }

    return sessionRef.id;
  }
}

class NoTablesAvailableException implements Exception {
  final DateTime time;
  NoTablesAvailableException(this.time);
  @override
  String toString() => 'Нет свободных столов на выбранное время';
}
