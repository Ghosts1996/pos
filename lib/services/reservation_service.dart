import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/reservation_model.dart';
import '../models/venue_models.dart';
import 'venue_service.dart';
import 'firestore_service.dart';
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
  ///
  /// ВАЖНО про источники данных. Этот расчёт выполняется и на POS, и в
  /// гостевом приложении «Колибри Лаундж», а у гостя по firestore.rules
  /// НЕТ доступа ни к коллекции `sessions` (там чужие счета), ни к
  /// коллекции `reservations` целиком (там чужие имена и телефоны).
  /// Раньше метод ходил именно туда — и у гостя оба запроса падали с
  /// permission-denied: экран брони молча показывал «слотов нет», а выбор
  /// стола вообще не открывался. Поэтому занятость берётся из двух
  /// обезличенных источников, читать которые гостю можно:
  ///   • `tables.busyUntil` — до какого момента стол занят живым гостем
  ///     (поддерживает POS, см. FirestoreService.syncTableBusyUntil);
  ///   • `reservationSlots` — зеркало броней БЕЗ персональных данных
  ///     (только стол, интервал и признак «занимает»), см. [_writeSlot].
  Future<_HallSnapshot> _loadHall(DateTime around) async {
    final dayFrom = around.subtract(const Duration(hours: 14));
    final dayTo = around.add(const Duration(hours: 26));

    final results = await Future.wait([
      _db.collection('tables').get(),
      _slots
          .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(dayFrom))
          .where('startTime', isLessThan: Timestamp.fromDate(dayTo))
          .get(),
    ]);

    final tables = results[0].docs.map(TableModel.fromDoc).toList();

    final reservations = results[1]
        .docs
        .map(_ReservedSlot.fromDoc)
        .where((r) => r.active && r.tableId.isNotEmpty)
        .toList();

    // До какого момента стол занят живым гостем: планируемый конец плюс
    // 20 минут на уборку. Просроченный сеанс держит стол ещё час.
    final now = DateTime.now();
    final busyUntil = <String, DateTime>{};
    for (final t in tables) {
      final end = t.busyUntil;
      if (end == null) continue;
      var until = end.isBefore(now) ? now.add(const Duration(hours: 1)) : end;
      until = until.add(const Duration(minutes: 20));
      busyUntil[t.id] = until;
    }

    return _HallSnapshot(tables: tables, reservations: reservations, busyUntil: busyUntil);
  }

  /// Зеркало броней без персональных данных — единственный источник
  /// занятости столов бронями, доступный гостевому приложению.
  CollectionReference<Map<String, dynamic>> get _slots =>
      _db.collection('reservationSlots');

  /// Создаёт/обновляет запись в зеркале. Вызывается при каждом изменении
  /// брони, которое влияет на занятость стола: создание, подтверждение,
  /// отмена, неявка, перенос времени, смена стола.
  ///
  /// В документ кладутся ТОЛЬКО обезличенные поля: стол, интервал, признак
  /// «занимает стол» и uid владельца (нужен правилам, чтобы гость не мог
  /// переписать чужую бронь). Ни имени, ни телефона, ни комментария.
  Future<void> _writeSlot({
    required String reservationId,
    required String tableId,
    required DateTime startTime,
    required int durationMinutes,
    required bool active,
    required String clientUid,
  }) async {
    try {
      await _slots.doc(reservationId).set({
        'tableId': tableId,
        'clientUid': clientUid,
        'startTime': Timestamp.fromDate(startTime),
        'endTime':
            Timestamp.fromDate(startTime.add(Duration(minutes: durationMinutes))),
        'active': active,
      }, SetOptions(merge: true));
    } catch (_) {
      // Зеркало вторично: если запись не прошла, сама бронь всё равно
      // создана и видна персоналу на POS.
    }
  }

  /// Снять блокировку стола в зеркале (отмена/неявка).
  Future<void> _releaseSlot(String reservationId) async {
    try {
      await _slots.doc(reservationId).set({'active': false}, SetOptions(merge: true));
    } catch (_) {}
  }

  /// Занятые интервалы столов на конкретный день — обезличенно, из
  /// зеркала [reservationSlots]. Используется гостевым приложением, где
  /// читать сами брони (с именами и телефонами) нельзя.
  Future<List<({String tableId, DateTime start, DateTime end})>> dayBusySlots(
      DateTime day) async {
    final from = DateTime(day.year, day.month, day.day);
    final to = from.add(const Duration(days: 1));
    final snap = await _slots
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('startTime', isLessThan: Timestamp.fromDate(to))
        .get();
    return snap.docs
        .map(_ReservedSlot.fromDoc)
        .where((s) => s.active && s.tableId.isNotEmpty)
        .map((s) => (tableId: s.tableId, start: s.startTime, end: s.endTime))
        .toList();
  }

  /// Достроить зеркало, если его ещё нет: разовая миграция для заведений,
  /// которые обновились с версии без `reservationSlots`. Без неё уже
  /// созданные будущие брони не держали бы стол в гостевом приложении.
  ///
  /// Дёшево и самовосстанавливаемо: читаем ближайшую будущую бронь и
  /// проверяем, есть ли для неё запись в зеркале. Есть — ничего не делаем.
  /// Вызывается с POS при входе сотрудника (у гостя нет прав читать чужие
  /// брони, поэтому там метод молча ничего не сделает).
  Future<void> ensureSlotMirror() async {
    try {
      final snap = await _col
          .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(DateTime.now()))
          .orderBy('startTime')
          .limit(1)
          .get();
      if (snap.docs.isEmpty) return; // будущих броней нет — нечего зеркалить
      final mirrored = await _slots.doc(snap.docs.first.id).get();
      if (mirrored.exists) return; // зеркало уже построено
      await rebuildSlotMirror();
    } catch (_) {
      // Нет прав (не POS) или нет сети — попробуем при следующем входе.
    }
  }

  /// Перестроить зеркало по существующим броням — разовая миграция для
  /// заведений, которые обновились с версии без `reservationSlots`.
  /// Запускается с POS (у гостя нет прав читать чужие брони).
  Future<int> rebuildSlotMirror() async {
    final from = DateTime.now().subtract(const Duration(days: 1));
    final snap = await _col
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .get();
    var count = 0;
    for (final doc in snap.docs) {
      final r = ReservationModel.fromDoc(doc);
      await _writeSlot(
        reservationId: r.id,
        tableId: r.tableId,
        startTime: r.startTime,
        durationMinutes: r.durationMinutes,
        active: r.status.blocksTable,
        clientUid: r.clientUid,
      );
      count++;
    }
    return count;
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
    await _writeSlot(
      reservationId: ref.id,
      tableId: reservation.tableId,
      startTime: reservation.startTime,
      durationMinutes: reservation.durationMinutes,
      active: reservation.status.blocksTable,
      clientUid: reservation.clientUid,
    );
    return ref.id;
  }

  Future<void> confirm(String id, String employeeName) => _col.doc(id).update({
        'status': ReservationStatus.confirmed.code,
        'confirmedAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': employeeName,
      });

  Future<void> cancel(String id, {String by = ''}) async {
    await _col.doc(id).update({
      'status': ReservationStatus.cancelled.code,
      'handledBy': by,
    });
    // Стол освобождается сразу — иначе отменённая бронь продолжала бы
    // держать слот в сетке доступности до конца своего интервала.
    await _releaseSlot(id);
  }

  Future<void> markNoShow(String id, String employeeName) async {
    await _col.doc(id).update({
      'status': ReservationStatus.noShow.code,
      'handledBy': employeeName,
    });
    await _releaseSlot(id);
  }

  Future<void> assignTable(String id, TableModel table) async {
    await _col.doc(id).update({
      'tableId': table.id,
      'tableName': table.name,
    });
    await _slots.doc(id).set({'tableId': table.id}, SetOptions(merge: true));
  }

  Future<void> reschedule(String id, DateTime newStart, {int? durationMinutes}) async {
    await _col.doc(id).update({
      'startTime': Timestamp.fromDate(newStart),
      if (durationMinutes != null) 'durationMinutes': durationMinutes,
    });
    final fresh = await _col.doc(id).get();
    if (!fresh.exists) return;
    final r = ReservationModel.fromDoc(fresh);
    await _writeSlot(
      reservationId: id,
      tableId: r.tableId,
      startTime: r.startTime,
      durationMinutes: r.durationMinutes,
      active: r.status.blocksTable,
      clientUid: r.clientUid,
    );
  }

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
      final resData = freshRes.data() ?? <String, dynamic>{};
      if ((resData['sessionId'] as String? ?? '').isNotEmpty) {
        throw StateError('По этой брони уже открыт чек.');
      }

      final freshTable = await tx.get(tableRef);
      final data = freshTable.data();
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

    // Гость сел — бронь больше не держит слот, теперь стол занят живым
    // чеком (его конец уезжает в tables.busyUntil).
    await _releaseSlot(reservation.id);
    await FirestoreService().syncTableBusyUntil(reservation.tableId);

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

/// Обезличенная запись занятости стола бронью — документ
/// `reservationSlots/{reservationId}`. Ровно те поля, которых хватает для
/// расчёта свободных слотов, и ни одного персонального.
class _ReservedSlot {
  final String tableId;
  final DateTime startTime;
  final DateTime endTime;
  final bool active;

  const _ReservedSlot({
    required this.tableId,
    required this.startTime,
    required this.endTime,
    required this.active,
  });

  factory _ReservedSlot.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? const <String, dynamic>{};
    final start = data['startTime'];
    final end = data['endTime'];
    final startAt = start is Timestamp ? start.toDate() : DateTime.now();
    return _ReservedSlot(
      tableId: (data['tableId'] as String?) ?? '',
      startTime: startAt,
      endTime: end is Timestamp
          ? end.toDate()
          : startAt.add(const Duration(minutes: 90)),
      active: data['active'] != false,
    );
  }

  bool overlaps(DateTime from, DateTime to) =>
      startTime.isBefore(to) && endTime.isAfter(from);
}

/// Разовый снимок занятости зала для расчёта слотов.
class _HallSnapshot {
  final List<TableModel> tables;
  final List<_ReservedSlot> reservations;
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
