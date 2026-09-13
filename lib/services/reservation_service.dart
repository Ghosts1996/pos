import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/reservation_model.dart';
import '../models/venue_models.dart';
import 'venue_service.dart';
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

  /// Снимок занятости зала: столы, живые брони и текущие сеансы.
  /// Загружается один раз и переиспользуется для всех слотов дня — иначе
  /// на каждый получас уходило по три запроса, и список времени собирался
  /// по десять секунд.
  Future<_HallSnapshot> _loadHall(DateTime around) async {
    final dayFrom = around.subtract(const Duration(hours: 14));
    final dayTo = around.add(const Duration(hours: 26));

    final results = await Future.wait([
      _db.collection('tables').get(),
      _col
          .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(dayFrom))
          .where('startTime', isLessThan: Timestamp.fromDate(dayTo))
          .get(),
      _db.collection('sessions').where('status', isEqualTo: 'active').get(),
    ]);

    final tables = results[0].docs.map(TableModel.fromDoc).toList();

    final reservations = results[1]
        .docs
        .map(ReservationModel.fromDoc)
        .where((r) => r.status.blocksTable)
        .toList();

    // До какого момента стол занят живым гостем: планируемый конец плюс
    // 20 минут на уборку. Просроченный сеанс держит стол ещё час.
    final busyUntil = <String, DateTime>{};
    for (final doc in results[2].docs) {
      final data = doc.data();
      final tableId = data['tableId']?.toString() ?? '';
      if (tableId.isEmpty) continue;

      final ts = data['plannedEnd'];
      var until = ts is Timestamp ? ts.toDate() : DateTime.now();
      if (until.isBefore(DateTime.now())) {
        until = DateTime.now().add(const Duration(hours: 1));
      }
      until = until.add(const Duration(minutes: 20));

      final prev = busyUntil[tableId];
      if (prev == null || until.isAfter(prev)) busyUntil[tableId] = until;
    }

    return _HallSnapshot(tables: tables, reservations: reservations, busyUntil: busyUntil);
  }

  /// Свободные столы на интервал по уже загруженному снимку — без сети.
  List<TableModel> _freeIn(
    _HallSnapshot hall, {
    required DateTime start,
    required int durationMinutes,
    required int guestsCount,
  }) {
    final end = start.add(Duration(minutes: durationMinutes));

    final busyByReservation = hall.reservations
        .where((r) => r.overlaps(start, end) && r.tableId.isNotEmpty)
        .map((r) => r.tableId)
        .toSet();

    return hall.tables.where((t) {
      if (t.seats < guestsCount) return false;
      if (busyByReservation.contains(t.id)) return false;

      final occupiedUntil = hall.busyUntil[t.id];
      if (occupiedUntil != null && start.isBefore(occupiedUntil)) return false;

      return true;
    }).toList()
      ..sort((a, b) => a.seats.compareTo(b.seats)); // подбираем стол «впритык»
  }

  /// Столы, свободные на интервал [start] + [durationMinutes].
  Future<List<TableModel>> availableTables({
    required DateTime start,
    int durationMinutes = 90,
    int guestsCount = 2,
  }) async {
    final hall = await _loadHall(start);
    return _freeIn(hall,
        start: start, durationMinutes: durationMinutes, guestsCount: guestsCount);
  }

  /// Сетка доступных времён на день с шагом [stepMinutes].
  ///
  /// Часы берутся из профиля заведения (Админ → Профиль заведения):
  /// строка вида «16:00-02:00» для нужного дня недели. Закрытие после
  /// полуночи поддерживается — слоты продолжаются до 02:00 следующих суток.
  /// Выходной день (пустая строка) даёт пустой список.
  ///
  /// Прошедшее время не предлагается никогда: последний слот — не раньше
  /// чем через 30 минут от текущего момента, чтобы гость успел доехать,
  /// а зал — подготовить стол.
  Future<List<DateTime>> availableSlots({
    required DateTime day,
    int durationMinutes = 90,
    int guestsCount = 2,
    int stepMinutes = 30,
  }) async {
    final profile = await VenueService.instance.load();
    final window = _workingWindow(profile, day);
    if (window == null) return const []; // выходной

    final hall = await _loadHall(window.open);

    final result = <DateTime>[];
    // Буфер на подготовку стола перед посадкой. Был 30 минут — из-за него
    // при открытии брони, скажем, в 16:11 при работе с 16:00 первый
    // доступный слот получался только в 17:00, хотя заведение уже открыто.
    // 15 минут — тот же запас, но ближе к реальному открытию.
    final earliest = DateTime.now().add(const Duration(minutes: 15));
    var cursor = window.open;

    // Бронь должна успеть закончиться до закрытия — иначе гостя выгонят
    // на середине сеанса.
    final lastStart = window.close.subtract(Duration(minutes: durationMinutes));

    while (!cursor.isAfter(lastStart)) {
      if (cursor.isAfter(earliest)) {
        final free = _freeIn(hall,
            start: cursor, durationMinutes: durationMinutes, guestsCount: guestsCount);
        if (free.isNotEmpty) result.add(cursor);
      }
      cursor = cursor.add(Duration(minutes: stepMinutes));
    }
    return result;
  }

  /// Окно работы на конкретный день: разбирает «16:00-02:00» в две даты.
  /// Время закрытия меньше времени открытия означает следующие сутки.
  ({DateTime open, DateTime close})? _workingWindow(VenueProfile profile, DateTime day) {
    final raw = profile.workingHours[day.weekday]?.trim() ?? '';
    if (raw.isEmpty) return null;

    final match = RegExp(r'(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})').firstMatch(raw);
    if (match == null) return null;

    final openH = int.parse(match.group(1)!);
    final openM = int.parse(match.group(2)!);
    final closeH = int.parse(match.group(3)!);
    final closeM = int.parse(match.group(4)!);

    final open = DateTime(day.year, day.month, day.day, openH, openM);
    var close = DateTime(day.year, day.month, day.day, closeH, closeM);
    if (!close.isAfter(open)) close = close.add(const Duration(days: 1));

    return (open: open, close: close);
  }

  /// Работает ли заведение в это время — проверка перед созданием брони.
  Future<bool> isOpenAt(DateTime moment) async {
    final profile = await VenueService.instance.load();
    // Ночное время относится к предыдущему дню: 01:30 — это ещё смена,
    // начавшаяся накануне.
    for (final day in [moment, moment.subtract(const Duration(days: 1))]) {
      final window = _workingWindow(profile, day);
      if (window == null) continue;
      if (!moment.isBefore(window.open) && moment.isBefore(window.close)) return true;
    }
    return false;
  }

  // ---------- СОЗДАНИЕ / ИЗМЕНЕНИЕ ----------

  /// Создать бронь. Если [tableId] не задан — стол подбирается автоматически
  /// из свободных на это время (самый компактный подходящий).
  Future<String> create(ReservationModel r, {bool autoAssignTable = true}) async {
    var reservation = r;

    // Защита от брони «в прошлое»: такие записи появлялись, если экран
    // держали открытым и время успевало пройти.
    if (reservation.startTime.isBefore(DateTime.now().add(const Duration(minutes: 5)))) {
      throw ReservationTimeException('Это время уже прошло — выберите другое.');
    }
    if (!await isOpenAt(reservation.startTime)) {
      throw ReservationTimeException('В это время заведение закрыто.');
    }

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
    } else if (reservation.tableId.isNotEmpty) {
      // Стол выбран вручную — на карте (гостем в приложении или сотрудником
      // на POS). Карта могла устареть, пока человек её листал, поэтому
      // перепроверяем прямо перед записью — иначе два гостя могут выбрать
      // один и тот же стол на одно время.
      final free = await availableTables(
        start: reservation.startTime,
        durationMinutes: reservation.durationMinutes,
        guestsCount: reservation.guestsCount,
      );
      if (!free.any((t) => t.id == reservation.tableId)) {
        throw NoTablesAvailableException(reservation.startTime);
      }
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

/// Разовый снимок занятости зала для расчёта слотов.
class _HallSnapshot {
  final List<TableModel> tables;
  final List<ReservationModel> reservations;
  final Map<String, DateTime> busyUntil;

  _HallSnapshot({
    required this.tables,
    required this.reservations,
    required this.busyUntil,
  });
}

/// Время брони невозможно: в прошлом или вне часов работы.
class ReservationTimeException implements Exception {
  final String message;
  ReservationTimeException(this.message);
  @override
  String toString() => message;
}

class NoTablesAvailableException implements Exception {
  final DateTime time;
  NoTablesAvailableException(this.time);
  @override
  String toString() => 'Нет свободных столов на выбранное время';
}
