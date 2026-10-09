import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../utils/pin_hash.dart';
import '../utils/shared_stream.dart';
import '../utils/shift_crew.dart';
import 'package:uuid/uuid.dart';
import '../models/delivery_status.dart';
import '../models/table_model.dart';
import '../models/hall_label.dart';
import '../models/hall_wall.dart';
import '../models/session_model.dart';
import '../models/menu_models.dart';
import '../models/payroll_adjustment.dart';
import '../models/discount_card.dart';
import '../models/employee.dart';
import '../models/pay_terms.dart';
import '../models/shift_model.dart';
import '../models/cash_op.dart';
import '../models/staff_shift_model.dart';
import '../models/inventory_models.dart';
import '../utils/constants.dart';
import 'venue_service.dart';
import 'tips_service.dart';
import 'table_key_service.dart';
import '../utils/shift_time.dart';
import '../utils/promo_policy.dart';
import '../utils/sale_kind.dart';
import 'audit_log_service.dart';
import 'net_status.dart';
import '../utils/guest_items.dart';
import '../utils/loyalty_refund.dart';
import '../utils/checkout_checks.dart';

/// Единая точка доступа к Firestore. Простая, без лишней абстракции.
class FirestoreService {
  final _db = FirebaseFirestore.instance;
  final _uuid = const Uuid();

  // Подписки, которые экраны берут прямо в build, — общие (см.
  // SharedStreams): одна и та же ссылка на поток, пока он кому-то нужен,
  // поэтому перерисовка экрана не переподписывается на базу.
  static final _tablesS = SharedStreams<List<TableModel>>();
  static final _tableS = SharedStreams<TableModel?>();
  static final _wallsS = SharedStreams<List<HallWall>>();
  static final _labelsS = SharedStreams<List<HallLabel>>();
  static final _sessionS = SharedStreams<SessionModel?>();
  static final _activeSessionsS = SharedStreams<List<SessionModel>>();
  static final _openChecksS = SharedStreams<List<SessionModel>>();
  static final _openShiftS = SharedStreams<ShiftModel?>();
  static final _openStaffShiftS = SharedStreams<StaffShiftModel?>();
  static final _openStaffShiftsS = SharedStreams<List<StaffShiftModel>>();
  static final _inventoryItemsS = SharedStreams<List<InventoryItem>>();
  static final _inventoryItemS = SharedStreams<InventoryItem?>();
  static final _openInventoryCountS = SharedStreams<InventoryCount?>();

  /// Ключ общей подписки — с заведением: у другого заведения другие данные.
  static String _k([String id = '']) => '${AppScope.tenantId ?? '-'}|$id';

  // ---------- СТОЛЫ ----------
  Stream<List<TableModel>> tablesStream() => _tablesS.get(
      _k(),
      () => AppScope.col('tables')
          .snapshots()
          .map((snap) => snap.docs
              .where((d) => d.id != TableModel.takeawayId)
              .map((d) => TableModel.fromDoc(d))
              .toList()));

  /// Служебный стол заказов с собой и доставки — создаётся при первом заказе.
  Future<TableModel> ensureTakeawayTable() async {
    final ref = AppScope.col('tables').doc(TableModel.takeawayId);
    DocumentSnapshot<Map<String, dynamic>>? snap;
    try {
      snap = await ref.get(NetStatus.online.value ? null : const GetOptions(source: Source.cache));
    } catch (_) {
      snap = null; // нет ни связи, ни копии в памяти — создадим заново
    }
    if (snap != null && snap.exists) return TableModel.fromDoc(snap);
    final table = TableModel(
      id: TableModel.takeawayId,
      name: 'С собой и доставка',
      x: 0,
      y: 0,
      seats: 0,
      maxOpenSessions: 200,
    );
    // merge и без списка чеков: если стол уже есть на сервере, а в памяти
    // устройства его нет, открытые заказы не затрутся.
    final write = ref.set({
      'name': table.name,
      'x': 0,
      'y': 0,
      'seats': 0,
      'maxOpenSessions': table.maxOpenSessions,
    }, SetOptions(merge: true));
    if (NetStatus.online.value) {
      await write;
    } else {
      unawaited(write.catchError((Object _) {}));
    }
    return table;
  }

  /// Следующий шаг заказа с собой/доставки (см. DeliveryFlow). Со связью —
  /// транзакцией: если тот же шаг уже нажали в Telegram или на другой
  /// кассе, второй раз он не пройдёт. Без связи — по копии на устройстве.
  Future<void> setDeliveryStatus(String sessionId, String to, {String courierName = ''}) async {
    final ref = AppScope.col('sessions').doc(sessionId);
    Map<String, dynamic> patch() => {
          'deliveryStatus': to,
          'deliveryStatusAt': Timestamp.fromDate(DateTime.now()),
          if (courierName.isNotEmpty) 'courierName': courierName,
        };
    void check(Map<String, dynamic>? data) {
      if (data == null) throw StateError('Заказ не найден');
      final type = (data['orderType'] ?? '').toString();
      if (!DeliveryFlow.canMove(type, data['deliveryStatus'] as String?, to)) {
        throw StateError('Статус уже изменили: сейчас «${DeliveryFlow.label(type, data['deliveryStatus'] as String?)}»');
      }
    }

    if (NetStatus.online.value) {
      try {
        await _db.runTransaction((tx) async {
          check((await tx.get(ref)).data());
          tx.update(ref, patch());
        });
        return;
      } on FirebaseException catch (e) {
        if (e.code != 'unavailable') rethrow;
        NetStatus.reportFailure();
      }
    }
    check((await ref.get(const GetOptions(source: Source.cache))).data());
    await _write(ref.update(patch()));
  }

  Stream<List<SessionModel>> takeawaySessionsStream() => AppScope.col('sessions')
      .where('tableId', isEqualTo: TableModel.takeawayId)
      .where('status', isEqualTo: 'active')
      .snapshots()
      .map((s) => s.docs.map(SessionModel.fromDoc).toList()..sort((a, b) => a.startTime.compareTo(b.startTime)));

  Future<void> addTable(TableModel table) async {
    await AppScope.col('tables').doc(table.id).set(table.toMap());
    // Секрет стола для QR-наклейки (см. TableKeyService).
    try {
      await TableKeyService.instance.ensureKey(table.id);
    } catch (_) {
      // Выпустится при следующем входе на кассу (ensureKeys).
    }
  }

  Future<void> updateTable(TableModel table) {
    return AppScope.col('tables').doc(table.id).update(table.toMap());
  }

  /// Настройки стола из редактора зала — только свои поля, чтобы не
  /// затереть чеки, открытые, пока был открыт редактор.
  Future<void> updateTableSettings(
    String tableId, {
    required String name,
    required int seats,
    required String shape,
    int rotation = 0,
    required int maxOpenSessions,
    required String zone,
  }) {
    return AppScope.col('tables').doc(tableId).update({
      'name': name,
      'seats': seats,
      'shape': shape,
      'rotation': rotation,
      'maxOpenSessions': maxOpenSessions,
      'zone': zone,
    });
  }

  /// Переносит столы в зону [zone] одной записью — так переименовывают зону
  /// («Без зоны» → «Основной зал») или сливают две в одну.
  Future<void> setTablesZone(List<String> tableIds, String zone) async {
    for (var i = 0; i < tableIds.length; i += 400) {
      final batch = _db.batch();
      for (final id in tableIds.skip(i).take(400)) {
        batch.update(AppScope.col('tables').doc(id), {'zone': zone});
      }
      await batch.commit();
    }
  }

  // ---------- СТЕНЫ ЗАЛА ----------

  /// Стены всех зон (см. HallWall). Нет доступа (правила ещё не обновлены)
  /// — схема просто без стен, а не ошибка на весь зал.
  Stream<List<HallWall>> hallWallsStream() => _wallsS.get(
      _k(),
      () => AppScope.col('hallWalls')
          .snapshots()
          .map((snap) => snap.docs.map(HallWall.fromDoc).where((w) => w.isValid).toList())
          .transform(StreamTransformer.fromHandlers(handleError: (e, st, sink) => sink.add(const <HallWall>[]))));

  /// Id новой стены — известен сразу, до ответа базы: «Отменить» может
  /// убрать стену, даже пока она сохраняется.
  String newHallWallId() => AppScope.col('hallWalls').doc().id;

  Future<void> saveHallWall(String id, HallWall wall) =>
      AppScope.col('hallWalls').doc(id).set({...wall.toMap(), 'createdAt': FieldValue.serverTimestamp()});

  Future<void> deleteHallWall(String id) => AppScope.col('hallWalls').doc(id).delete();

  /// Подписи на схеме (см. HallLabel). Нет доступа — схема без подписей.
  Stream<List<HallLabel>> hallLabelsStream() => _labelsS.get(
      _k(),
      () => AppScope.col('hallLabels')
          .snapshots()
          .map((snap) => snap.docs.map(HallLabel.fromDoc).where((l) => l.isValid).toList())
          .transform(StreamTransformer.fromHandlers(handleError: (e, st, sink) => sink.add(const <HallLabel>[]))));

  String newHallLabelId() => AppScope.col('hallLabels').doc().id;

  Future<void> saveHallLabel(HallLabel label) =>
      AppScope.col('hallLabels').doc(label.id).set({...label.toMap(), 'createdAt': FieldValue.serverTimestamp()});

  Future<void> deleteHallLabel(String id) => AppScope.col('hallLabels').doc(id).delete();

  /// Стены и подписи зоны [from] переезжают в зону [to] (переименование
  /// зоны); с [to] == null — удаляются вместе с зоной.
  Future<void> moveHallDrawing(String from, String? to) async {
    for (final name in const ['hallWalls', 'hallLabels']) {
      final snap = await AppScope.col(name).where('zone', isEqualTo: from).get();
      for (var i = 0; i < snap.docs.length; i += 400) {
        final batch = _db.batch();
        for (final d in snap.docs.skip(i).take(400)) {
          to == null ? batch.delete(d.reference) : batch.update(d.reference, {'zone': to});
        }
        await batch.commit();
      }
    }
  }

  Future<void> updateTablePosition(String tableId, double x, double y) {
    return AppScope.col('tables').doc(tableId).update({'x': x, 'y': y});
  }

  /// Поворот стола вместе с новым положением (центр остаётся на месте).
  Future<void> updateTableLayout(String tableId, {required int rotation, required double x, required double y}) {
    return AppScope.col('tables').doc(tableId).update({'rotation': rotation, 'x': x, 'y': y});
  }

  Future<void> deleteTable(String tableId) async {
    await AppScope.col('tables').doc(tableId).delete();
    await TableKeyService.instance.remove(tableId);
  }

  /// Стрим ОДНОГО стола по id. В отличие от [tablesStream] не тянет всю
  /// коллекцию столов — используется на экране конкретного стола, чтобы
  /// открытие/изменение любого другого стола в зале не вызывало лишних
  /// перестроений и сетевого трафика на этом экране.
  Stream<TableModel?> tableStream(String tableId) => _tableS.get(
      _k(tableId),
      () => AppScope.col('tables')
          .doc(tableId)
          .snapshots()
          .map((doc) => doc.exists ? TableModel.fromDoc(doc) : null));

  String newTableId() => _uuid.v4();

  /// Пересадка гостя с открытым чеком на другой стол. Чек тот же, меняются
  /// tableId и activeSessionIds обоих столов — одной транзакцией, чтобы чек
  /// не «потерялся» между столами.
  ///
  /// [TableFullException] — на целевом столе уже максимум чеков.
  Future<void> moveSessionToTable({
    required String sessionId,
    required String fromTableId,
    required String toTableId,
  }) async {
    if (fromTableId == toTableId) return;
    _requireOnline('Пересадить гостей');

    final sessionRef = AppScope.col('sessions').doc(sessionId);
    final fromRef = AppScope.col('tables').doc(fromTableId);
    final toRef = AppScope.col('tables').doc(toTableId);

    await _db.runTransaction((tx) async {
      // Пока кассир выбирал стол, чек могли закрыть или уже пересадить с
      // другого устройства — тогда переносить нечего.
      final session = (await tx.get(sessionRef)).data();
      if (session == null ||
          session['status'] != 'active' ||
          session['tableId'] != fromTableId) {
        throw StateError('Чек уже закрыт или пересажен');
      }

      final toSnap = await tx.get(toRef);
      final toData = toSnap.data();
      final toIds = ((toData?['activeSessionIds'] ?? []) as List)
          .map((e) => e.toString())
          .toList();
      final toMax = (toData?['maxOpenSessions'] as num?)?.toInt() ?? 2;
      if (toIds.length >= toMax) {
        throw TableFullException(toMax);
      }

      final fromSnap = await tx.get(fromRef);
      final fromData = fromSnap.data();
      final fromIds = ((fromData?['activeSessionIds'] ?? []) as List)
          .map((e) => e.toString())
          .toList();
      fromIds.remove(sessionId);

      final toName = (toData?['name'] as String?) ?? '';
      toIds.add(sessionId);

      tx.update(sessionRef, {'tableId': toTableId, 'tableName': toName});
      tx.update(fromRef, {
        'activeSessionIds': fromIds,
        'status': fromIds.isEmpty ? 'free' : 'occupied',
      });
      tx.update(toRef, {'activeSessionIds': toIds, 'status': 'occupied'});
    });

    // Занятость обоих столов пересчитываем после транзакции: внутри неё
    // нельзя прочитать чужие чеки запросом, а для busyUntil нужен максимум
    // plannedEnd по всем чекам стола.
    await syncTableBusyUntil(fromTableId);
    await syncTableBusyUntil(toTableId);

    // Гость, сидящий на этом чеке через приложение, пересаживается вместе
    // с ним: по activeTableId приложение зовёт персонал, и вызов уходил бы
    // к пустому столу, за которым гостя уже нет.
    try {
      final bound = await AppScope.loyaltyCol('clients')
          .where('activeSessionId', isEqualTo: sessionId)
          .get();
      for (final d in bound.docs) {
        await d.reference.update({'activeTableId': toTableId});
      }
    } catch (_) {
      // Не критично: приложение гостя берёт стол из самого чека, а
      // профиль поправится при следующей привязке.
    }
  }

  /// Пересчитывает [TableModel.busyUntil] — до какого момента стол занят.
  ///
  /// Приложению гостя sessions читать нельзя (чужие счета), а карточку
  /// стола — можно, поэтому занятость для брони и очереди живёт на столе и
  /// её ведёт касса. Ошибки проглатываем: поле вспомогательное.
  /// Действия, которым нужен сервер (переносят позиции между чеками
  /// атомарно): без связи сразу понятная ошибка вместо долгого ожидания.
  static void _requireOnline(String what) {
    if (!NetStatus.online.value) {
      throw StateError('$what можно, когда вернётся интернет. Заказы и оплата работают и без него.');
    }
  }

  /// Запись без связи не ждём: подтверждение сервера придёт, только когда
  /// интернет вернётся, а память устройства и экран обновляются сразу.
  static Future<void> _write(Future<void> w) {
    if (NetStatus.online.value) return w;
    unawaited(w.catchError((Object _) {}));
    return Future.value();
  }

  Future<void> syncTableBusyUntil(String tableId) async {
    if (tableId.isEmpty) return;
    try {
      final snap = await AppScope.col('sessions')
          .where('tableId', isEqualTo: tableId)
          .where('status', isEqualTo: 'active')
          .get(NetStatus.online.value ? null : const GetOptions(source: Source.cache));

      DateTime? maxEnd;
      final checks = <Map<String, dynamic>>[];
      for (final doc in snap.docs) {
        final data = doc.data();
        final ts = data['plannedEnd'];
        if (ts is Timestamp) {
          final end = ts.toDate();
          if (maxEnd == null || end.isAfter(maxEnd)) maxEnd = end;
        }
        // Витрина открытых чеков стола для гостевого приложения: по ней
        // гость выбирает СВОЙ чек, когда за столом их несколько. Читать
        // коллекцию sessions ему нельзя, а карточку стола — можно, поэтому
        // краткая сводка живёт здесь. Ни позиций, ни сумм: только чем один
        // чек отличается от другого — подпись кассира и время открытия.
        final started = data['startTime'];
        checks.add({
          'id': doc.id,
          'label': (data['guestTag'] as String?) ?? '',
          'openedAt': started is Timestamp ? started : null,
        });
      }
      checks.sort((a, b) {
        final x = a['openedAt'], y = b['openedAt'];
        if (x is! Timestamp || y is! Timestamp) return 0;
        return x.compareTo(y);
      });

      await _write(AppScope.col('tables').doc(tableId).update({
        'busyUntil': maxEnd == null ? null : Timestamp.fromDate(maxEnd),
        'openChecks': checks,
      }));
    } catch (_) {
      // Денормализация — не критичный путь.
    }
  }

  // ---------- СЕССИИ (ЧЕКИ) ----------
  Stream<SessionModel?> sessionStream(String sessionId) => _sessionS.get(
      _k(sessionId),
      () => AppScope.col('sessions')
          .doc(sessionId)
          .snapshots()
          .map((doc) => doc.exists ? SessionModel.fromDoc(doc) : null));

  /// Все сейчас открытые чеки конкретного стола, отсортированные по времени
  /// открытия. Запрос состоит из двух равенств (tableId, status) — Firestore
  /// умеет объединять такие простые условия без ручного составного
  /// индекса, поэтому сортировку делаем на клиенте, а не в самом запросе.
  Stream<List<SessionModel>> activeSessionsStream(String tableId) => _activeSessionsS.get(
      _k(tableId),
      () => AppScope.col('sessions')
              .where('tableId', isEqualTo: tableId)
              .where('status', isEqualTo: 'active')
              .snapshots()
              .map((snap) {
            final list = snap.docs.map((d) => SessionModel.fromDoc(d)).toList();
            list.sort((a, b) => a.startTime.compareTo(b.startTime));
            return list;
          }));

  /// Открыть новый чек за столом (Старт / доп. чек / Перезабивка после
  /// закрытия). Обёрнуто в транзакцию: читает актуальный список открытых
  /// чеков стола и лимит maxOpenSessions — если лимит уже достигнут (в т.ч.
  /// из-за одновременного нажатия "Начать" на двух устройствах), бросает
  /// TableFullException вместо дублирующего/лишнего счёта.
  Future<String> openSession({
    required TableModel table,
    required String employeeName,
    String employeeId = '',
    int durationMinutes = AppConstants.defaultSessionMinutes,
    String guestTag = '',
    String? tableName,
    String orderType = '',
    String customerPhone = '',
    String deliveryAddress = '',
    String? sessionId,
  }) async {
    final tableRef = AppScope.col('tables').doc(table.id);
    final sessionRef = AppScope.col('sessions').doc(sessionId);
    final now = DateTime.now();

    // Новый чек и стол: [write] получает свежие данные стола и пишет через
    // [set]/[update] — транзакцией со связью или пакетом в память без неё.
    void build(Map<String, dynamic>? data, void Function(DocumentReference<Map<String, dynamic>>, Map<String, dynamic>) set,
        void Function(DocumentReference<Map<String, dynamic>>, Map<String, dynamic>) update) {
      final ids = ((data?['activeSessionIds'] ?? []) as List)
          .map((e) => e.toString())
          .toList();
      final maxOpen = (data?['maxOpenSessions'] as num?)?.toInt() ?? table.maxOpenSessions;

      if (ids.length >= maxOpen) {
        throw TableFullException(maxOpen);
      }

      final session = SessionModel(
        id: sessionRef.id,
        tableId: table.id,
        tableName: tableName ?? table.name,
        employeeName: employeeName,
        employeeId: employeeId,
        startTime: now,
        plannedEnd: now.add(Duration(minutes: durationMinutes)),
        guestTag: guestTag,
        orderType: orderType,
        customerPhone: customerPhone,
        deliveryAddress: deliveryAddress,
      );
      set(sessionRef, session.toMap());

      ids.add(sessionRef.id);
      // busyUntil держим не меньше конца самого позднего чека стола:
      // на столе может быть открыто несколько счетов.
      final prevBusy = data?['busyUntil'];
      final prevEnd = prevBusy is Timestamp ? prevBusy.toDate() : null;
      final newEnd = session.plannedEnd;
      update(tableRef, {
        'activeSessionIds': ids,
        'status': 'occupied',
        'busyUntil': Timestamp.fromDate(
            prevEnd != null && prevEnd.isAfter(newEnd) ? prevEnd : newEnd),
      });
    }

    var offline = !NetStatus.online.value;
    if (!offline) {
      try {
        await _db.runTransaction((tx) async {
          build((await tx.get(tableRef)).data(), tx.set, tx.update);
        });
      } on FirebaseException catch (e) {
        if (e.code != 'unavailable') rethrow;
        NetStatus.reportFailure();
        offline = true;
      }
    }
    if (offline) {
      // Без связи: стол из памяти устройства, запись уйдёт на сервер сама.
      final cached = await tableRef.get(const GetOptions(source: Source.cache));
      final batch = _db.batch();
      build(cached.data(), batch.set, batch.update);
      unawaited(batch.commit().catchError((Object _) {}));
      unawaited(syncTableBusyUntil(table.id).catchError((Object _) {}));
      return sessionRef.id;
    }

    // Витрину открытых чеков собираем после транзакции: внутри неё нельзя
    // прочитать запросом остальные чеки стола.
    await syncTableBusyUntil(table.id);
    return sessionRef.id;
  }

  /// Разделить счёт: выбранные позиции уходят в новый отдельный чек за тем
  /// же столом — гости платят каждый за своё.
  ///
  /// [moveQty] — сколько штук каждой строки перенести; ключ строки —
  /// [splitKey] (позиция, название и цена: одна и та же позиция меню могла
  /// попасть в чек по разной цене). Всё в одной транзакции: позиции не
  /// могут ни потеряться, ни задвоиться, а лимит чеков на стол
  /// (maxOpenSessions) проверяется по свежим данным. Время и скидка у
  /// нового чека — как у исходного: компания та же.
  Future<String> splitOffItems({
    required String sessionId,
    required String tableId,
    required Map<String, int> moveQty,
    required String employeeName,
    String employeeId = '',
    String guestTag = '',
  }) async {
    _requireOnline('Разделить счёт');
    final fromRef = AppScope.col('sessions').doc(sessionId);
    final tableRef = AppScope.col('tables').doc(tableId);
    final newRef = AppScope.col('sessions').doc();

    await _db.runTransaction((tx) async {
      final fromSnap = await tx.get(fromRef);
      final tableSnap = await tx.get(tableRef);
      if (!fromSnap.exists) throw StateError('Чек не найден');
      final from = SessionModel.fromDoc(fromSnap);
      if (from.status != 'active') throw StateError('Этот чек уже закрыт');

      final tdata = tableSnap.data() ?? const <String, dynamic>{};
      final ids = ((tdata['activeSessionIds'] ?? []) as List).map((e) => e.toString()).toList();
      final maxOpen = (tdata['maxOpenSessions'] as num?)?.toInt() ?? 2;
      if (ids.length >= maxOpen) throw TableFullException(maxOpen);

      final left = Map<String, int>.from(moveQty);
      final keep = <OrderItem>[];
      final moved = <OrderItem>[];
      for (final item in from.orderItems) {
        final key = splitKey(item);
        final want = left[key] ?? 0;
        final take = want <= 0 ? 0 : (want >= item.qty ? item.qty : want);
        if (take > 0) {
          final (out, rest) = item.split(take);
          moved.add(out);
          left[key] = want - take;
          if (rest != null) keep.add(rest);
        } else {
          keep.add(item);
        }
      }
      if (moved.isEmpty) throw StateError('Нечего переносить — заказ уже изменился');

      final split = SessionModel(
        id: newRef.id,
        tableId: from.tableId,
        tableName: from.tableName,
        employeeName: employeeName,
        employeeId: employeeId,
        guestTag: guestTag,
        startTime: from.startTime,
        plannedEnd: from.plannedEnd,
        discountCardId: from.discountCardId,
        discountPercent: from.discountPercent,
        orderItems: moved,
      );
      tx.set(newRef, split.toMap());
      tx.update(fromRef, {'orderItems': keep.map((e) => e.toMap()).toList()});
      ids.add(newRef.id);
      tx.update(tableRef, {'activeSessionIds': ids, 'status': 'occupied'});
    });

    await syncTableBusyUntil(tableId);
    return newRef.id;
  }

  /// Ключ строки заказа для [splitOffItems].
  static String splitKey(OrderItem i) => '${i.lineId}|${i.name}|${i.price}';

  /// Перезабивка — сброс таймера на новые 1.5ч (или заданную длительность).
  /// [tableId] нужен, чтобы обновить денормализованную занятость стола —
  /// см. [syncTableBusyUntil].
  Future<void> refillSession(String sessionId,
      {int durationMinutes = AppConstants.defaultSessionMinutes,
      String tableId = ''}) async {
    final now = DateTime.now();
    await _write(AppScope.col('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(now.add(Duration(minutes: durationMinutes))),
      'refillCount': FieldValue.increment(1),
      'refillHistory': FieldValue.arrayUnion([
        {'time': Timestamp.fromDate(now)}
      ]),
    }));
    await syncTableBusyUntil(tableId);
  }

  /// Установить/сменить подпись чека — кто сидит за столом (гость, номер
  /// компании и т.п.). Пустая строка убирает подпись.
  Future<void> setGuestTag(String sessionId, String tag, {String tableId = ''}) async {
    await _write(AppScope.col('sessions').doc(sessionId).update({'guestTag': tag}));
    // Подпись — то, по чему гость узнаёт свой чек в списке за столом,
    // поэтому витрину открытых чеков надо обновить сразу.
    await syncTableBusyUntil(tableId);
  }

  /// Обновить/продлить таймер на N минут (может быть отрицательным)
  Future<void> extendSession(String sessionId, DateTime currentPlannedEnd, int minutes,
      {String tableId = ''}) async {
    final newEnd = currentPlannedEnd.add(Duration(minutes: minutes));
    await _write(AppScope.col('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(newEnd),
    }));
    await syncTableBusyUntil(tableId);
  }

  /// Установить таймер на конкретное время вручную
  Future<void> setSessionEnd(String sessionId, DateTime newEnd, {String tableId = ''}) async {
    await _write(AppScope.col('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(newEnd),
    }));
    await syncTableBusyUntil(tableId);
  }

  /// Добавить позицию в заказ. Если такая позиция меню (по menuItemId) уже
  /// есть в счёте — увеличивает её количество, а не создаёт вторую строку.
  /// Обёрнуто в транзакцию, чтобы два одновременных нажатия "Добавить" не
  /// перезаписали друг друга.
  ///
  /// [employeeId] — кто добавляет (сотрудник, вошедший по PIN): по нему
  /// кальянщику и бармену идёт процент с их позиций (PayrollSales).
  ///
  /// [mods] — выбранные модификаторы: строка с другими модификаторами —
  /// отдельная строка, цена — с доплатами (MenuItem.priceWith).
  Future<void> addOrderItem(String sessionId, MenuItem menuItem,
      {int qty = 1, String employeeId = '', List<String> mods = const []}) async {
    final chosen = [for (final o in menuItem.optionsNamed(mods)) o.name];
    final lineId = OrderItem.lineIdOf(menuItem.id, chosen);
    // Кальян/табак — по флагу позиции, её названию или категории («Кальяны»):
    // на такие позиции не действуют скидки и бонусы (PromoPolicy).
    var noPromo = PromoPolicy.menuTobacco(menuItem);
    var catName = '';
    var catKind = '';
    if (menuItem.categoryId.isNotEmpty) {
      try {
        final cat = await AppScope.col('menuCategories').doc(menuItem.categoryId).get();
        catName = (cat.data()?['name'] ?? '').toString();
        catKind = SaleKind.normalize(cat.data()?['kind'] as String?);
        if (!noPromo) noPromo = PromoPolicy.looksTobacco(catName);
      } catch (_) {}
    }
    final kind = noPromo
        ? SaleKind.hookah
        : SaleKind.forMenuItem(
            tobacco: menuItem.tobacco, itemName: menuItem.name, categoryKind: catKind, categoryName: catName);
    await _editCheckItems(sessionId, (items) {
      final idx = items.indexWhere((i) => i.lineId == lineId);
      if (idx >= 0) {
        items[idx] = items[idx].plus(qty, employeeId: employeeId);
      } else {
        items.add(OrderItem(
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.priceWith(chosen),
          mods: chosen,
          qty: qty,
          noPromo: noPromo,
          kind: kind,
          by: employeeId.isEmpty ? const {} : {employeeId: qty},
          since: DateTime.now(),
        ));
      }
      return true;
    });
  }

  /// Позиции от гостя по текущему меню — см. [priceGuestItems].
  Future<List<OrderItem>> menuPricedItems(List<OrderItem> items) async {
    final ids = items.map((i) => i.menuItemId).where((id) => id.isNotEmpty).toSet();
    if (ids.isEmpty) return const [];
    final docs = await Future.wait(ids.map((id) => AppScope.col('menuItems').doc(id).get()));
    final menu = {for (final d in docs) if (d.exists) d.id: MenuItem.fromDoc(d)};
    final catIds = menu.values.map((m) => m.categoryId).where((id) => id.isNotEmpty).toSet();
    final cats = await Future.wait(catIds.map((id) => AppScope.col('menuCategories').doc(id).get()));
    final categoryNames = {for (final c in cats) c.id: (c.data()?['name'] ?? '').toString()};
    final categoryKinds = {for (final c in cats) c.id: SaleKind.normalize(c.data()?['kind'] as String?)};
    return priceGuestItems(items, menu, categoryNames: categoryNames, categoryKinds: categoryKinds);
  }

  /// Изменить количество позиции в заказе на delta (может быть отрицательным).
  /// Если количество опускается до 0 или ниже — позиция удаляется из счёта.
  /// [lineId] — ключ строки (OrderItem.lineId).
  Future<void> changeOrderItemQty(String sessionId, String lineId, int delta, {String employeeId = ''}) =>
      _editCheckItems(sessionId, (items) {
        final idx = items.indexWhere((i) => i.lineId == lineId);
        if (idx < 0) return false;
        final newQty = items[idx].qty + delta;
        if (newQty <= 0) {
          items.removeAt(idx);
        } else {
          items[idx] = delta > 0
              ? items[idx].plus(delta, employeeId: employeeId)
              : items[idx].minus(-delta, employeeId: employeeId);
        }
        return true;
      });

  /// Экран «Кухня и бар»: отметить строки чека готовыми целиком.
  Future<void> markItemsReady(String sessionId, Set<String> lineIds) => _editCheckItems(sessionId, (items) {
        var changed = false;
        for (var k = 0; k < items.length; k++) {
          if (lineIds.contains(items[k].lineId) && items[k].pending > 0) {
            items[k] = items[k].markReady();
            changed = true;
          }
        }
        return changed;
      });

  /// Бегунок напечатан: [sentQty] — сколько штук каждой строки (lineId →
  /// количество) было в строке на момент печати. Добавленное за это время
  /// останется неотправленным и уйдёт следующим бегунком.
  Future<void> markItemsSent(String sessionId, Map<String, int> sentQty) async {
    if (sentQty.isEmpty) return;
    await _editCheckItems(sessionId, (items) {
      var changed = false;
      for (var k = 0; k < items.length; k++) {
        final count = sentQty[items[k].lineId];
        if (count == null || count <= items[k].sent) continue;
        items[k] = items[k].markSent(count);
        changed = true;
      }
      return changed;
    });
  }

  /// Все открытые чеки заведения — для экрана «Кухня и бар».
  Stream<List<SessionModel>> openChecksStream() => _openChecksS.get(
      'all',
      () => AppScope.col('sessions')
          .where('status', isEqualTo: 'active')
          .snapshots()
          .map((snap) => snap.docs.map((d) => SessionModel.fromDoc(d)).toList()));

  /// Пожелание к строке заказа («без льда», «покрепче»). Пусто — убрать.
  Future<void> setOrderItemNote(String sessionId, String lineId, String note) =>
      _editLine(sessionId, lineId, (i) => i.withNote(note));

  /// «Подать позже» для строки ([hold] = true) или вернуть её в работу.
  Future<void> setOrderItemHold(String sessionId, String lineId, bool hold) =>
      _editLine(sessionId, lineId, (i) => i.withHold(hold));

  /// «Подать»: все отложенные строки счёта уходят на кухню и бар.
  Future<void> fireHeldItems(String sessionId) => _editCheckItems(sessionId, (items) {
        if (!items.any((i) => i.hold)) return false;
        for (var k = 0; k < items.length; k++) {
          items[k] = items[k].withHold(false);
        }
        return true;
      });

  /// Полностью убрать позицию из заказа независимо от количества.
  Future<void> removeOrderItem(String sessionId, String lineId) => _editCheckItems(sessionId, (items) {
        final before = items.length;
        items.removeWhere((i) => i.lineId == lineId);
        return items.length != before;
      });

  Future<void> _editLine(String sessionId, String lineId, OrderItem Function(OrderItem) change) =>
      _editCheckItems(sessionId, (items) {
        final idx = items.indexWhere((i) => i.lineId == lineId);
        if (idx < 0) return false;
        items[idx] = change(items[idx]);
        return true;
      });

  /// Правка строк открытого чека. Есть связь — транзакцией (два планшета
  /// не перезапишут друг друга). Нет связи — по копии чека в памяти
  /// устройства: экран обновляется сразу, а запись уйдёт на сервер сама,
  /// когда интернет вернётся. Сервис не останавливается.
  /// [edit] меняет список и возвращает true, если есть что сохранить.
  Future<void> _editCheckItems(String sessionId, bool Function(List<OrderItem> items) edit) async {
    final ref = AppScope.col('sessions').doc(sessionId);
    if (NetStatus.online.value) {
      try {
        await _db.runTransaction((tx) async {
          final data = (await tx.get(ref)).data();
          if (data == null) return;
          final items = _openCheckItems(data);
          if (edit(items)) tx.update(ref, {'orderItems': items.map((e) => e.toMap()).toList()});
        });
        return;
      } on FirebaseException catch (e) {
        if (e.code != 'unavailable') rethrow;
        NetStatus.reportFailure();
      }
    }
    final snap = await ref.get(const GetOptions(source: Source.cache));
    final data = snap.data();
    if (data == null) throw StateError('Чека нет в памяти устройства — дождитесь связи');
    final items = _openCheckItems(data);
    if (!edit(items)) return;
    // Без await: без сети подтверждение сервера придёт только после её
    // возвращения, а локальная копия обновляется сразу.
    unawaited(ref.update({'orderItems': items.map((e) => e.toMap()).toList()}).catchError((Object _) {}));
  }

  /// Позиции чека, который ещё можно править. Закрытый чек уже оплачен и
  /// попал в отчёты, а правила Firestore персоналу его правку не запрещают —
  /// с другого устройства кассир мог закрыть его секунду назад.
  static List<OrderItem> _openCheckItems(Map<String, dynamic> data) {
    if ((data['status'] ?? 'active') != 'active') {
      throw StateError('Этот чек уже закрыт');
    }
    return ((data['orderItems'] ?? []) as List)
        .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<void> applyDiscountCard(String sessionId, DiscountCard? card) {
    return _write(AppScope.col('sessions').doc(sessionId).update({
      'discountCardId': card?.id,
      'discountPercent': card?.discountPercent ?? 0,
    }));
  }

  /// Экран оплаты гостя: закрывает чек с разбивкой суммы по способам оплаты,
  /// убирает его из списка открытых чеков стола, и автоматически списывает
  /// со склада позиции, привязанные к проданным пунктам меню.
  ///
  /// [expectedTotal] — сумма счёта, которую видел кассир. Пока был открыт
  /// экран оплаты, с другого планшета могли добавить позиции или принять
  /// заказ гостя: тогда чек не закрываем, иначе в нём остались бы
  /// неоплаченные позиции.
  ///
  /// [loyaltyClientUid] — гость из приложения, сидевший на этом чеке: по
  /// нему возврат отменит начисленный кешбэк (см. [refundSession]), а
  /// удаление данных гостя найдёт чеки с его именем в подписи.
  Future<void> closeSessionWithPayment(
    String sessionId,
    String tableId, {
    required double cash,
    required double card,
    double terminal = 0,
    required double comp,
    String guestContact = '',
    bool closedWithoutPayment = false,
    bool receiptPrinted = false,
    bool fiscalReceiptPrinted = false,
    List<OrderItem> orderItems = const [],
    String employeeName = '',
    Map<String, String> tipsPaidVia = const {},
    double tipsCash = 0,
    double tipsCard = 0,
    List<String> tipsCancelled = const [],
    double? expectedTotal,
    double? seenDiscountPercent,
    String loyaltyClientUid = '',
  }) async {
    // 1. Закрываем чек. Транзакция с проверкой статуса делает закрытие
    //    идемпотентным: повторное «Оплатить» после сбоя сети не спишет
    //    склад второй раз.
    final sessionRef = AppScope.col('sessions').doc(sessionId);
    // Без связи чек закрывается по копии в памяти устройства, а оплата
    // уходит на сервер сама, когда интернет вернётся (см. _editCheckItems).
    var offline = !NetStatus.online.value;
    // Транзакция читает чек с сервера, а экран показывал его вместе с ещё
    // не отправленными правками этого планшета (слабая сеть): без ожидания
    // только что добавленная позиция выглядела бы как «счёт изменился».
    if (!offline) {
      try {
        await _db.waitForPendingWrites().timeout(const Duration(seconds: 8));
      } on TimeoutException {
        NetStatus.reportFailure();
        offline = true;
      } catch (_) {
        // Платформа без ожидания записей — проверит сама транзакция.
      }
    }
    final closeData = <String, dynamic>{
      'status': 'closed',
      'closedAt': Timestamp.fromDate(DateTime.now()),
      'paymentCash': cash,
      'paymentCard': card,
      'paymentTerminal': terminal,
      'paymentComp': comp,
      'guestContact': guestContact,
      'closedWithoutPayment': closedWithoutPayment,
      'receiptPrinted': receiptPrinted,
      'fiscalReceiptPrinted': fiscalReceiptPrinted,
      'tipsCash': tipsCash,
      'tipsCard': tipsCard,
      if (loyaltyClientUid.isNotEmpty) 'loyaltyClientUid': loyaltyClientUid,
    };
    final tipNow = Timestamp.fromDate(DateTime.now());
    final tipUpdates = <DocumentReference<Map<String, dynamic>>, Map<String, dynamic>>{
      for (final e in tipsPaidVia.entries)
        AppScope.col('tips').doc(e.key): {'status': 'paid', 'paidAt': tipNow, 'paidVia': e.value},
      for (final id in tipsCancelled) AppScope.col('tips').doc(id): {'status': 'cancelled', 'cancelledAt': tipNow},
    };
    SessionModel? changed;
    _CloseOutcome check(DocumentSnapshot<Map<String, dynamic>> snap) {
      if ((snap.data()?['status'] as String?) == 'closed') return _CloseOutcome.alreadyClosed;
      if (expectedTotal != null && snap.exists) {
        final actual = SessionModel.fromDoc(snap);
        if ((actual.totalWithDiscount - expectedTotal).abs() > 0.009) {
          changed = actual;
          return _CloseOutcome.billChanged;
        }
      }
      return _CloseOutcome.closed;
    }

    var outcome = _CloseOutcome.closed;
    if (!offline) {
      try {
        outcome = await _db.runTransaction<_CloseOutcome>((tx) async {
          final verdict = check(await tx.get(sessionRef));
          if (verdict != _CloseOutcome.closed) return verdict;
          tx.update(sessionRef, closeData);
          // Чаевые, взятые вместе со счётом, отмечаются оплаченными в той же
          // транзакции: чек не может закрыться, а чаевые — повиснуть «к счёту»
          // (и наоборот, повторное нажатие не отметит их второй раз).
          tipUpdates.forEach(tx.update);
          return _CloseOutcome.closed;
        });
      } on FirebaseException catch (e) {
        if (e.code != 'unavailable') rethrow;
        NetStatus.reportFailure();
        offline = true;
      }
    }
    if (offline) {
      outcome = check(await sessionRef.get(const GetOptions(source: Source.cache)));
      if (outcome == _CloseOutcome.closed) {
        final batch = _db.batch()..update(sessionRef, closeData);
        tipUpdates.forEach(batch.update);
        unawaited(batch.commit().catchError((Object _) {}));
      }
    }
    // Бросаем после транзакции: в вебе исключение изнутри неё теряет текст.
    if (outcome == _CloseOutcome.billChanged) {
      final actual = changed;
      throw StateError(actual == null
          ? 'Чек изменился, пока была открыта оплата — откройте оплату заново'
          : describeBillChange(
              seen: orderItems,
              seenTotal: expectedTotal ?? 0,
              actual: actual.orderItems,
              actualTotal: actual.totalWithDiscount,
              seenDiscount: seenDiscountPercent ?? actual.discountPercent,
              actualDiscount: actual.discountPercent,
            ));
    }
    final alreadyClosed = outcome == _CloseOutcome.alreadyClosed;

    // 2. Убираем сессию из стола
    final tableRef = AppScope.col('tables').doc(tableId);
    Map<String, dynamic> freed(Map<String, dynamic>? data) {
      final ids = ((data?['activeSessionIds'] ?? []) as List).map((e) => e.toString()).toList()..remove(sessionId);
      return {'activeSessionIds': ids, 'status': ids.isEmpty ? 'free' : 'occupied'};
    }

    if (offline) {
      final doc = await tableRef.get(const GetOptions(source: Source.cache)).catchError((Object _) => tableRef.get());
      unawaited(tableRef.update(freed(doc.data())).catchError((Object _) {}));
      // Остальное — после возвращения связи, не задерживая кассира.
      unawaited(_afterClose(sessionId, tableId, alreadyClosed, orderItems, employeeName).catchError((Object _) {}));
      return;
    }
    await _db.runTransaction((tx) async {
      final doc = await tx.get(tableRef);
      tx.update(tableRef, freed(doc.data()));
    });
    await _afterClose(sessionId, tableId, alreadyClosed, orderItems, employeeName);
  }

  Future<void> _afterClose(
      String sessionId, String tableId, bool alreadyClosed, List<OrderItem> orderItems, String employeeName) async {
    // 3. Пересчитываем занятость стола для гостевого приложения и снимаем
    //    закрепление чека за гостем: счёт закрыт, держать его незачем.
    await syncTableBusyUntil(tableId);
    try {
      await AppScope.col('sessionClaims').doc(sessionId).delete();
    } catch (_) {
      // Не критично: id чека больше не повторится, запись просто устареет.
    }
    // Гость больше не за этим столом. Обычно это делает начисление кешбэка
    // (accrueBonuses), но при «закрыть без оплаты» его нет — и профиль
    // навсегда числил бы гостя за закрытым чеком: он не мог ни сесть за
    // другой стол по-человечески, ни удалить свои данные.
    try {
      final bound = await AppScope.loyaltyCol('clients')
          .where('activeSessionId', isEqualTo: sessionId)
          .get();
      for (final d in bound.docs) {
        await d.reference.update({
          'activeSessionId': '',
          'activeTableId': '',
          if (AppScope.chainId != null) 'activeTenantId': '',
        });
      }
    } catch (_) {
      // Не критично: приложение гостя видит, что чек закрыт.
    }

    // 4. Списываем склад по позициям заказа (игнорируем ошибки, чтобы не
    //    блокировать оплату при временных сбоях сети или ненастроенных связях)
    if (!alreadyClosed && orderItems.isNotEmpty) {
      await _deductInventoryForSale(orderItems, employeeName);
    }
  }

  /// Чего не хватит на складе, если закрыть чек с [orderItems]: кассир
  /// узнаёт об этом до оплаты, а не по уходу остатка в минус.
  Future<List<StockShortage>> stockShortagesFor(List<OrderItem> orderItems) async {
    final menu = await menuItemsByIds(
        orderItems.map((o) => o.menuItemId).where((id) => id.isNotEmpty).toSet());
    final invIds = <String>{
      for (final m in menu.values) ...[
        if (m.inventoryItemId.isNotEmpty) m.inventoryItemId,
        for (final c in m.components)
          if (c.inventoryItemId.isNotEmpty) c.inventoryItemId,
      ],
    };
    if (invIds.isEmpty) return const [];
    final docs = await Future.wait(invIds.map((id) => AppScope.col('inventoryItems').doc(id).get()));
    final stock = {for (final d in docs) if (d.exists) d.id: InventoryItem.fromDoc(d)};
    return stockShortages(orderItems, menu, stock);
  }

  /// Списывает позиции склада по проданным пунктам меню.
  /// Поддерживает два режима:
  /// 1. Простая позиция — одна привязка inventoryItemId + weight.
  /// 2. Составная позиция (микс) — список components, каждый со своим
  ///    inventoryItemId и weight. Например "Тарелка Снэков": орешки + чипсы
  ///    + сухарики списываются независимо с указанными граммовками.
  /// Ошибки по отдельным позициям не прерывают списание остальных.
  Future<void> _deductInventoryForSale(
      List<OrderItem> orderItems, String employeeName) async {
    // Собираем уникальные menuItemId из заказа
    final menuItemIds =
        orderItems.map((o) => o.menuItemId).where((id) => id.isNotEmpty).toSet();
    if (menuItemIds.isEmpty) return;

    // Загружаем данные позиций меню одним батчем
    final menuDocs = await Future.wait(menuItemIds
        .map((id) => AppScope.col('menuItems').doc(id).get()));

    // Строим карту menuItemId → MenuItem
    final menuMap = <String, MenuItem>{};
    for (final doc in menuDocs) {
      if (doc.exists) menuMap[doc.id] = MenuItem.fromDoc(doc);
    }

    // Для каждой строки заказа — списываем склад если настроена привязка
    for (final orderItem in orderItems) {
      final menuItem = menuMap[orderItem.menuItemId];
      if (menuItem == null) continue;

      // Модификаторы со складом: сироп 20 мл, доп. сыр 30 г.
      for (final option in menuItem.optionsNamed(orderItem.mods)) {
        if (!option.hasInventoryLink) continue;
        try {
          final invDoc = await AppScope.col('inventoryItems').doc(option.inventoryItemId).get();
          if (!invDoc.exists) continue;
          final invItem = InventoryItem.fromDoc(invDoc);
          await adjustInventoryQuantity(
            itemId: option.inventoryItemId,
            itemName: invItem.name,
            unit: invItem.unit,
            delta: -(option.weightUnit.convertTo(option.weight, invItem.unit) * orderItem.qty),
            type: 'writeoff',
            employeeName: employeeName,
            reason: 'Продажа: ${orderItem.name} ×${orderItem.qty} (${option.name})',
          );
        } catch (_) {
          // Не блокируем оплату из-за ошибок списания модификатора
        }
      }

      // Комбо: вариант — блюдо меню, списываем его техкарту.
      for (final option in menuItem.optionsNamed(orderItem.mods)) {
        if (option.menuItemId.isEmpty) continue;
        try {
          var dish = menuMap[option.menuItemId];
          if (dish == null) {
            final d = await AppScope.col('menuItems').doc(option.menuItemId).get();
            if (!d.exists) continue;
            dish = menuMap[d.id] = MenuItem.fromDoc(d);
          }
          await _deductMenuItem(dish, orderItem.qty, '${orderItem.name}: ${dish.name}', employeeName);
        } catch (_) {
          // Не блокируем оплату из-за ошибок списания
        }
      }

      await _deductMenuItem(menuItem, orderItem.qty, orderItem.name, employeeName);
    }
  }

  /// Списание техкарты одной позиции меню: простая привязка или состав.
  Future<void> _deductMenuItem(MenuItem menuItem, int qty, String label, String employeeName) async {
    if (!menuItem.hasAnyInventoryLink) return;

    if (menuItem.isComposite) {
      // Составная позиция: списываем каждый компонент отдельно
      for (final component in menuItem.components) {
        if (component.inventoryItemId.isEmpty || component.weight <= 0) continue;
        try {
          final invDoc = await AppScope.col('inventoryItems')
              .doc(component.inventoryItemId)
              .get();
          if (!invDoc.exists) continue;
          final invItem = InventoryItem.fromDoc(invDoc);
          // Граммовка компонента задана в component.weightUnit, а остаток
          // склада ведётся в invItem.unit — единицы могут не совпадать
          // (например, компонент задан в мл, а сама позиция склада — в
          // литрах), поэтому переводим количество в единицу склада перед
          // тем, как вычесть его из остатка.
          final qtyInStockUnit =
              component.weightUnit.convertTo(component.weight, invItem.unit);
          final delta = -(qtyInStockUnit * qty);
          await adjustInventoryQuantity(
            itemId: component.inventoryItemId,
            itemName: invItem.name,
            unit: invItem.unit,
            delta: delta,
            type: 'writeoff',
            employeeName: employeeName,
            reason: 'Продажа: $label ×$qty (компонент)',
          );
        } catch (_) {
          // Не блокируем оплату из-за ошибок списания компонента
        }
      }
    } else {
      // Простая позиция: одна привязка к складу
      try {
        final invDoc = await AppScope.col('inventoryItems')
            .doc(menuItem.inventoryItemId)
            .get();
        if (!invDoc.exists) return;
        final invItem = InventoryItem.fromDoc(invDoc);
        // Аналогично компоненту выше: граммовка позиции меню задана в
        // menuItem.weightUnit, который админ выбирает независимо от
        // единицы привязанной позиции склада — переводим перед списанием.
        final qtyInStockUnit = menuItem.weightUnit.convertTo(menuItem.weight, invItem.unit);
        final delta = -(qtyInStockUnit * qty);
        await adjustInventoryQuantity(
          itemId: menuItem.inventoryItemId,
          itemName: invItem.name,
          unit: invItem.unit,
          delta: delta,
          type: 'writeoff',
          employeeName: employeeName,
          reason: 'Продажа: $label ×$qty',
        );
      } catch (_) {
        // Не блокируем оплату из-за ошибок списания
      }
    }
  }

  /// Возврат закрытого чека: чек остаётся в истории с пометкой и не
  /// учитывается в выручке отчётов.
  ///
  /// Если платили наличными, в той же транзакции записывается расход
  /// «Возврат наличными» в текущую смену. Если за чек гостю начисляли
  /// кешбэк, возврат его отменяет (см. [applyLoyaltyRefund]) — иначе
  /// бонусы за возвращённый чек оставались бы у гостя.
  Future<void> refundSession(String sessionId, {String employeeName = '', String employeeId = ''}) async {
    final ref = AppScope.col('sessions').doc(sessionId);
    final stateRef = AppScope.col('meta').doc('shiftState');
    // Гостя ищем до транзакции: внутри неё запросы по коллекциям нельзя.
    final uid = await _loyaltyClientOf(sessionId);
    final clientRef = uid.isEmpty ? null : AppScope.loyaltyCol('clients').doc(uid);
    final visitRef = clientRef?.collection('visits').doc(sessionId);

    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final state = await tx.get(stateRef);
      final client = clientRef == null ? null : (await tx.get(clientRef)).data();
      final visit = visitRef == null ? null : (await tx.get(visitRef)).data();
      final data = doc.data();
      // Вернуть можно только оплаченный чек и только один раз.
      if (data == null || data['refunded'] == true || data['status'] != 'closed') return;
      final now = Timestamp.fromDate(DateTime.now());
      final cash = ((data['paymentCash'] ?? 0) as num).toDouble();
      final update = <String, dynamic>{
        'refunded': true,
        'refundedAt': now,
        'refundCashOut': cash > 0,
      };
      if (cash > 0) {
        final opRef = AppScope.col('cashOps').doc();
        tx.set(
            opRef,
            CashOp(
              id: opRef.id,
              shiftId: (state.data()?['openShiftId'] ?? '').toString(),
              type: CashOpType.refund,
              amount: cash,
              comment: 'Возврат чека · ${(data['tableName'] ?? '').toString()}',
              employeeName: employeeName,
              employeeId: employeeId,
              createdAt: DateTime.now(),
              sessionId: sessionId,
            ).toMap());
        update['refundCashOpId'] = opRef.id;
      }

      // Визит гостя по этому чеку — в нём ровно то, что было начислено.
      if (client != null && visit != null && visit['refunded'] != true) {
        final r = applyLoyaltyRefund(
          balance: _num(client['bonusBalance']),
          totalSpent: _num(client['totalSpent']),
          visits: _num(client['visits']).toInt(),
          earned: _num(visit['bonusEarned']),
          bonusSpent: _num(visit['bonusSpent']),
          visitTotal: _num(visit['total']),
        );
        tx.update(clientRef!, {'bonusBalance': r.balance, 'totalSpent': r.totalSpent, 'visits': r.visits});
        tx.update(visitRef!, {'refunded': true});
        _bonusOp(tx, uid, sessionId, 'refund_reversal', 'refund', r.refund.taken, now);
        _bonusOp(tx, uid, sessionId, 'redeem_cancelled', 'refund', r.refund.returned, now);
        update['refundLoyalty'] = r.refund.toMap(uid);
      }
      tx.update(ref, update);
    });
  }

  /// Отменить возврат чека (если оформили по ошибке) — снова учитывается
  /// в отчётах как обычный оплаченный чек, расход наличных по возврату
  /// помечается отменённым, а гостю возвращается то, что снял возврат.
  Future<void> undoRefundSession(String sessionId, {String employeeName = ''}) async {
    final ref = AppScope.col('sessions').doc(sessionId);
    await _db.runTransaction((tx) async {
      final data = (await tx.get(ref)).data();
      // Повторная отмена второй раз начислила бы гостю бонусы.
      if (data == null || data['refunded'] != true) return;
      final loyalty = data['refundLoyalty'];
      final uid = loyalty is Map ? (loyalty['uid'] as String? ?? '') : '';
      final clientRef = uid.isEmpty ? null : AppScope.loyaltyCol('clients').doc(uid);
      final visitRef = clientRef?.collection('visits').doc(sessionId);
      final client = clientRef == null ? null : (await tx.get(clientRef)).data();
      // Гость мог удалить свои данные вместе с историей визитов.
      final visitExists = visitRef != null && (await tx.get(visitRef)).exists;

      final opId = (data['refundCashOpId'] ?? '').toString();
      tx.update(ref, {
        'refunded': false,
        'refundedAt': null,
        'refundCashOut': false,
        'refundCashOpId': null,
        'refundLoyalty': FieldValue.delete(),
      });
      if (opId.isNotEmpty) {
        tx.update(AppScope.col('cashOps').doc(opId), {
          'cancelled': true,
          'cancelledBy': employeeName,
          'cancelledAt': Timestamp.fromDate(DateTime.now()),
        });
      }

      if (client != null && loyalty is Map) {
        final refund = LoyaltyRefund.fromMap(loyalty);
        final r = undoLoyaltyRefund(
          balance: _num(client['bonusBalance']),
          totalSpent: _num(client['totalSpent']),
          visits: _num(client['visits']).toInt(),
          refund: refund,
        );
        final now = Timestamp.fromDate(DateTime.now());
        tx.update(clientRef!, {'bonusBalance': r.balance, 'totalSpent': r.totalSpent, 'visits': r.visits});
        if (visitExists) tx.update(visitRef, {'refunded': false});
        _bonusOp(tx, uid, sessionId, 'accrual', 'refund_undone', refund.taken, now);
        _bonusOp(tx, uid, sessionId, 'redeem', 'refund_undone', r.reclaimed, now);
      }
    });
  }

  /// Гость, которому за чек начислялся кешбэк. У новых чеков он записан
  /// при оплате; у старых ищем по истории бонусов, а если кешбэка не было
  /// (одни кальяны) — по отметке bonusAccruedFor в профиле.
  Future<String> _loyaltyClientOf(String sessionId) async {
    try {
      final data = (await AppScope.col('sessions').doc(sessionId).get()).data();
      final uid = (data?['loyaltyClientUid'] as String?) ?? '';
      if (uid.isNotEmpty) return uid;
      final ops = await AppScope.loyaltyCol('bonusOperations')
          .where('sessionId', isEqualTo: sessionId)
          .where('type', isEqualTo: 'accrual')
          .limit(1)
          .get();
      if (ops.docs.isNotEmpty) return (ops.docs.first.data()['clientUid'] as String?) ?? '';
      final clients = await AppScope.loyaltyCol('clients')
          .where('bonusAccruedFor', isEqualTo: sessionId)
          .limit(1)
          .get();
      if (clients.docs.isNotEmpty) return clients.docs.first.id;
    } catch (_) {
      // Не нашли — вернём деньги без правки бонусов, чек важнее.
    }
    return '';
  }

  /// Строка в истории бонусов гостя — то, что он видит в профиле.
  static void _bonusOp(Transaction tx, String uid, String sessionId, String type, String reason,
      double amount, Timestamp at) {
    if (amount <= 0) return;
    tx.set(AppScope.loyaltyCol('bonusOperations').doc(), {
      'clientUid': uid,
      'sessionId': sessionId,
      'type': type,
      'reason': reason,
      'amount': amount,
      'createdAt': at,
    });
  }

  static double _num(Object? v) => v is num ? v.toDouble() : 0;

  /// Закрытые чеки за период [start; end) — источник данных для отчётов и
  /// X-отчёта. Специально фильтруется только по диапазону closedAt (у
  /// активных чеков это поле всегда null и они никогда сюда не попадают),
  /// поэтому запросу достаточно автоматического одиночного индекса
  /// Firestore — не нужно вручную создавать составной индекс в консоли.
  Future<List<SessionModel>> closedSessionsInRange(DateTime start, DateTime end) async {
    final snap = await AppScope.col('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(start))
        .where('closedAt', isLessThan: Timestamp.fromDate(end))
        .orderBy('closedAt', descending: true)
        .get();
    return snap.docs.map((d) => SessionModel.fromDoc(d)).toList();
  }

  // ---------- СМЕНЫ (КАССА) ----------
  // Кассовая смена одна на заведение: открывается при входе сотрудника,
  // закрывается в X-отчёте. Все чеки, закрытые за время смены, относятся к
  // ней, даже через полночь.

  /// Текущая открытая смена, если она есть. null, если ни одна смена сейчас
  /// не открыта (например, самый первый вход в приложение или после
  /// закрытия предыдущей смены).
  Future<ShiftModel?> currentOpenShift() async {
    // Только where по status: orderBy по другому полю требует составного
    // индекса. Открытая смена всегда одна (транзакция через meta/shiftState).
    final snap = await AppScope.col('shifts')
        .where('status', isEqualTo: 'open')
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return ShiftModel.fromDoc(snap.docs.first);
  }

  /// Стрим текущей открытой смены — используется, чтобы X-отчёт и другие
  /// экраны сразу видели открытие/закрытие смены без перезагрузки.
  Stream<ShiftModel?> openShiftStream() {
    // См. комментарий в currentOpenShift() — без orderBy, чтобы не требовать
    // составной индекс, из-за отсутствия которого стрим падал в ошибку
    // сразу после открытия смены и переставал обновляться.
    return _openShiftS.get(
        _k(),
        () => AppScope.col('shifts')
                .where('status', isEqualTo: 'open')
                .limit(1)
                .snapshots()
                .map((snap) => snap.docs.isEmpty ? null : ShiftModel.fromDoc(snap.docs.first))
                // Ошибку глушим: экраны остаются на последнем известном
                // состоянии смены. Firestore после ошибки закрывает
                // подписку, SharedStreams выбрасывает ключ, и следующая
                // перерисовка подпишется заново.
                .handleError((_) {}));
  }

  /// Открывает смену, если открытой нет, и возвращает её id. Указатель —
  /// в meta/shiftState: транзакции SDK читают только документы, не
  /// запросы, и так два одновременных входа не откроют две смены.
  Future<String> openShiftIfNeeded(String employeeName, {String employeeId = ''}) async {
    final stateRef = AppScope.col('meta').doc('shiftState');
    final shiftRef = AppScope.col('shifts').doc();
    final now = DateTime.now();

    final resultId = await _db.runTransaction<String>((tx) async {
      final stateDoc = await tx.get(stateRef);
      final data = stateDoc.data();
      final currentOpenId = data?['openShiftId'] as String?;

      // Указатель может остаться на закрытой смене, если закрытие прервалось
      // на середине. Проверяем саму смену: закрыта или пропала — открываем
      // новую, иначе «Открыть смену» молча ничего бы не делала.
      if (currentOpenId != null && currentOpenId.isNotEmpty) {
        final referencedShiftDoc = await tx.get(AppScope.col('shifts').doc(currentOpenId));
        final referencedData = referencedShiftDoc.data();
        final referencedStatus = referencedData?['status'] as String?;
        if (referencedShiftDoc.exists && referencedStatus == 'open') {
          return currentOpenId;
        }
        // Указатель "протух" (протухший id закрытой/удалённой смены) —
        // падаем через создание новой смены ниже.
      }

      final shift = ShiftModel(
        id: shiftRef.id,
        openedAt: now,
        openedBy: employeeName,
        openedById: employeeId,
        status: 'open',
        // Размен — то, что оставили в кассе, закрывая прошлую смену.
        openingCash: ((data?['cashLeft'] ?? 0) as num).toDouble(),
      );
      tx.set(shiftRef, shift.toMap());
      tx.set(stateRef, {'openShiftId': shiftRef.id});
      return shiftRef.id;
    });

    return resultId;
  }

  /// Закрывает смену (X-отчёт) и сбрасывает указатель в meta/shiftState —
  /// одной транзакцией, чтобы указатель не остался на закрытой смене.
  ///
  /// [cash] — пересчёт кассы: сколько должно быть, сколько насчитали,
  /// сколько инкассировать и сколько оставить на размен. Инкассация
  /// записывается в эту же смену той же транзакцией.
  Future<void> closeShift(String shiftId, String employeeName,
      {String employeeId = '', ShiftCashClose? cash}) async {
    final now = DateTime.now();
    final shiftRef = AppScope.col('shifts').doc(shiftId);
    final stateRef = AppScope.col('meta').doc('shiftState');
    final closed = await _db.runTransaction<bool>((tx) async {
      final shiftDoc = await tx.get(shiftRef);
      final stateDoc = await tx.get(stateRef);
      // Смену уже закрыли с другого устройства (или повторное нажатие) —
      // второй раз не закрываем: иначе инкассация записалась бы дважды,
      // а размен следующей смены затёрся бы. Ошибку бросаем уже после
      // транзакции: в вебе исключение изнутри неё теряет свой текст.
      if (!shiftDoc.exists || (shiftDoc.data()?['status'] ?? 'open') != 'open') {
        return false;
      }
      tx.update(shiftRef, {
        'status': 'closed',
        'closedAt': Timestamp.fromDate(now),
        'closedBy': employeeName,
        if (cash != null) ...{
          'closingExpectedCash': cash.expected,
          'closingCountedCash': cash.counted,
          'closingCollected': cash.collect,
          'closingLeftCash': cash.leave,
        },
      });
      if (cash != null && cash.collect > 0) {
        final opRef = AppScope.col('cashOps').doc();
        tx.set(
            opRef,
            CashOp(
              id: opRef.id,
              shiftId: shiftId,
              type: CashOpType.collection,
              amount: cash.collect,
              comment: 'При закрытии смены',
              employeeName: employeeName,
              employeeId: employeeId,
              createdAt: now,
            ).toMap());
      }
      final data = stateDoc.data();
      tx.set(
          stateRef,
          {
            if (data?['openShiftId'] == shiftId) 'openShiftId': null,
            // Что оставили в кассе — размен следующей смены.
            if (cash != null) 'cashLeft': cash.leave,
          },
          SetOptions(merge: true));
      return true;
    });
    if (!closed) throw StateError('Смена уже закрыта на другом устройстве');
  }

  // ---------- ЗАРПЛАТА: ПРЕМИИ, ШТРАФЫ, ВЫПЛАТЫ ----------

  Future<List<PayrollAdjustment>> payrollAdjustmentsInRange(DateTime from, DateTime to) async {
    final snap = await AppScope.col('payrollAdjustments')
        .where('at', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('at', isLessThan: Timestamp.fromDate(to))
        .get();
    return snap.docs.map(PayrollAdjustment.fromDoc).where((a) => !a.cancelled).toList()
      ..sort((a, b) => a.at.compareTo(b.at));
  }

  Future<void> addPayrollAdjustment(PayrollAdjustment a) =>
      AppScope.col('payrollAdjustments').add(a.toMap());

  Future<void> cancelPayrollAdjustment(String id, String by) => AppScope.col('payrollAdjustments')
      .doc(id)
      .update({'cancelled': true, 'cancelledBy': by, 'cancelledAt': Timestamp.fromDate(DateTime.now())});

  // ---------- НАЛИЧНЫЕ В КАССЕ ----------

  static final _cashOpsS = SharedStreams<List<CashOp>>();

  /// Операции с наличными смены (инкассации, внесения, выплаты, возвраты)
  /// — живые, по времени. Одно равенство — индекс не нужен.
  Stream<List<CashOp>> cashOpsStream(String shiftId) => _cashOpsS.get(
      _k(shiftId),
      () => AppScope.col('cashOps').where('shiftId', isEqualTo: shiftId).snapshots().map(
          (snap) => snap.docs.map(CashOp.fromDoc).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt))));

  Future<List<CashOp>> cashOpsForShift(String shiftId) async {
    final snap = await AppScope.col('cashOps').where('shiftId', isEqualTo: shiftId).get();
    return snap.docs.map(CashOp.fromDoc).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }

  /// Операции за период — для отчёта «по дате и времени».
  Future<List<CashOp>> cashOpsInRange(DateTime start, DateTime end) async {
    final snap = await AppScope.col('cashOps')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(start))
        .where('createdAt', isLessThan: Timestamp.fromDate(end))
        .get();
    return snap.docs.map(CashOp.fromDoc).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }

  Future<void> addCashOp(CashOp op) async {
    final ref = AppScope.col('cashOps').doc();
    await ref.set(op.toMap());
  }

  /// Ошибочную операцию не удаляем, а отменяем — она остаётся в истории.
  Future<void> cancelCashOp(String opId, String employeeName) async {
    await AppScope.col('cashOps').doc(opId).update({
      'cancelled': true,
      'cancelledBy': employeeName,
      'cancelledAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Поправить размен на начало смены (если пересчитали и там не столько).
  Future<void> setOpeningCash(String shiftId, double amount) async {
    await AppScope.col('shifts').doc(shiftId).update({'openingCash': amount});
  }

  /// Последние N смен (для просмотра прошлых смен в X-отчёте), отсортированы
  /// от самой свежей к самой старой.
  Future<List<ShiftModel>> recentShifts({int limit = 30}) async {
    final snap = await AppScope.col('shifts')
        .orderBy('openedAt', descending: true)
        .limit(limit)
        .get();
    return snap.docs.map((d) => ShiftModel.fromDoc(d)).toList();
  }

  /// Закрытые (оплаченные) чеки, относящиеся к конкретной смене: всё, что
  /// было закрыто в промежутке [shift.openedAt; shift.closedAt ?? сейчас).
  /// Именно на этом строится X-отчёт — вместо календарных суток, из-за
  /// которых отчёт "пропадал" ровно в полночь, если смена ещё не закрыта.
  Future<List<SessionModel>> closedSessionsForShift(ShiftModel shift) {
    final end = shift.closedAt ?? DateTime.now().add(const Duration(minutes: 1));
    return closedSessionsInRange(shift.openedAt, end);
  }

  // ---------- ЛИЧНЫЕ СМЕНЫ СОТРУДНИКОВ (ДЛЯ ЗАРПЛАТЫ) ----------
  // Не кассовая смена: у каждого сотрудника своя, открытых может быть
  // несколько — по ним считаются отработанные часы. Указатели открытых
  // смен — map employeeId → id в meta/staffShiftState, по той же причине,
  // что и meta/shiftState.

  /// Личная смена не начинается раньше открытия заведения: пришёл заранее —
  /// часы для зарплаты считаются от открытия. Часы работы не заданы или не
  /// разобрались — время не трогаем.
  DateTime _clampToVenueOpening(DateTime now) =>
      clampShiftStartToOpening(now, VenueService.instance.cached.workingHours);

  /// Начинает личную смену сотрудника, если у него сейчас нет открытой.
  /// Если она уже открыта — просто возвращает её id, не создавая вторую.
  Future<String> clockIn(Employee employee) async {
    final stateRef = AppScope.col('meta').doc('staffShiftState');
    final shiftRef = AppScope.col('staffShifts').doc();
    // Начало ставит сервер — перевод часов планшета назад смену не
    // удлинит. До открытия заведения время в зарплату не идёт: момент
    // открытия пишем в countFrom.
    final now = DateTime.now();
    final startedAt = _clampToVenueOpening(now);

    final id = await _db.runTransaction<String>((tx) async {
      final stateDoc = await tx.get(stateRef);
      final openByEmployee =
          Map<String, dynamic>.from(stateDoc.data()?['openByEmployee'] ?? {});
      final currentOpenId = openByEmployee[employee.id] as String?;

      // Как и в openShiftIfNeeded: доверяем указателю, только если смена,
      // на которую он ссылается, на самом деле ещё открыта — иначе (сеть
      // оборвалась между закрытием смены и сбросом указателя) кнопка
      // "Начать смену" молча ничего не делала бы вечно.
      if (currentOpenId != null && currentOpenId.isNotEmpty) {
        final referencedDoc = await tx.get(AppScope.col('staffShifts').doc(currentOpenId));
        final started = (referencedDoc.data()?['startedAt'] as Timestamp?)?.toDate();
        // Забытую со вчера смену не продолжаем — иначе в зарплату попадут
        // сутки. Она остаётся открытой, пока сотрудник или админ не укажет
        // время ухода (меню сотрудника и табель это подсказывают).
        if (referencedDoc.exists &&
            referencedDoc.data()?['status'] == 'open' &&
            (started == null || !isStaleShift(started))) {
          return currentOpenId;
        }
      }

      tx.set(shiftRef, {
        'employeeId': employee.id,
        'employeeName': employee.name,
        'startedAt': FieldValue.serverTimestamp(),
        'endedAt': null,
        'status': 'open',
        'manual': false,
        if (startedAt.isAfter(now)) 'countFrom': Timestamp.fromDate(startedAt),
      });
      openByEmployee[employee.id] = shiftRef.id;
      tx.set(stateRef, {'openByEmployee': openByEmployee}, SetOptions(merge: true));
      return shiftRef.id;
    });
    // Смена уже шла (открыли до обновления) — сотрудника в списке могло не
    // быть; дописать его повторно безопасно.
    await _putTipsMember(employee, startedAt);
    return id;
  }

  /// Сотрудник появляется в списке «кому оставить чаевые» у гостя, когда
  /// начинает смену. Отдельной записью, а не в транзакции смены: если
  /// правила базы для meta/tipsTeam ещё не выложены, учёт рабочего времени
  /// не должен ломаться из-за чаевых. Расхождения чинит [syncTipsTeam].
  Future<void> _putTipsMember(Employee employee, DateTime since) async {
    try {
      await TipsService.teamRef.set({
        'members': {employee.id: TipsService.memberOf(employee, since).toMap()},
        'updatedAt': Timestamp.fromDate(DateTime.now()),
      }, SetOptions(merge: true));
    } catch (_) {}
  }

  /// Пересобирает список «кто на смене» для чаевых по открытым личным
  /// сменам. Вызывается при старте кассы: чинит смены, открытые до
  /// обновления, и убирает тех, чью смену закрыли вручную в табеле.
  Future<void> syncTipsTeam() async {
    final open = await AppScope.col('staffShifts').where('status', isEqualTo: 'open').get();
    final employees = {for (final e in await employeesOnce()) e.id: e};
    final members = <String, dynamic>{};
    for (final d in open.docs) {
      final shift = StaffShiftModel.fromDoc(d);
      final e = employees[shift.employeeId];
      if (e == null) continue;
      members[e.id] = TipsService.memberOf(e, shift.startedAt).toMap();
    }
    // set без merge: состав заменяется целиком, лишние записи уходят.
    await TipsService.teamRef.set({
      'members': members,
      'updatedAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Заканчивает личную смену. При обычном нажатии «Закончить смену»
  /// конец ставит сервер. [endedAt] — ручное время ухода (забыл закончить
  /// вчера, админ дозакрывает в табеле): запись помечается ручной и
  /// подписывается тем, кто правил ([editor]), — это видно в зарплате.
  Future<void> clockOut(String shiftId, String employeeId, {DateTime? endedAt, Employee? editor}) async {
    final shiftRef = AppScope.col('staffShifts').doc(shiftId);
    final stateRef = AppScope.col('meta').doc('staffShiftState');
    final manual = endedAt != null;
    final wasCurrent = await _db.runTransaction<bool>((tx) async {
      final stateDoc = await tx.get(stateRef);
      tx.update(shiftRef, {
        'status': 'closed',
        'endedAt': manual ? Timestamp.fromDate(endedAt) : FieldValue.serverTimestamp(),
        if (manual) ...{
          'manual': true,
          'editedBy': editor?.name ?? '',
          'editedById': editor?.id ?? '',
          'editedAt': FieldValue.serverTimestamp(),
        },
      });
      final openByEmployee =
          Map<String, dynamic>.from(stateDoc.data()?['openByEmployee'] ?? {});
      if (openByEmployee[employeeId] == shiftId) {
        openByEmployee[employeeId] = null;
        tx.set(stateRef, {'openByEmployee': openByEmployee}, SetOptions(merge: true));
        return true;
      }
      return false;
    });
    // Ушёл со смены — гость больше не видит его в выборе, кому чаевые.
    // Только если закрыли ТЕКУЩУЮ смену: админ, дозакрывающий в табеле
    // вчерашнюю забытую смену, не должен убрать того, кто работает сейчас.
    if (wasCurrent) _removeTipsMember(employeeId).ignore();
    if (manual) {
      AuditLogService.instance.log(
        action: 'staff_shift_closed_manually',
        employeeName: editor?.name ?? '',
        details: {'shiftId': shiftId, 'employeeId': employeeId, 'endedAt': endedAt.toIso8601String()},
      ).ignore();
    }
  }

  Future<void> _removeTipsMember(String employeeId) async {
    try {
      await TipsService.teamRef.set({
        'members': {employeeId: FieldValue.delete()},
        'updatedAt': Timestamp.fromDate(DateTime.now()),
      }, SetOptions(merge: true));
    } catch (_) {}
  }

  /// Стрим текущей открытой личной смены ОДНОГО сотрудника — для
  /// переключателя "Моя смена" в меню сотрудника. Два равенства (employeeId +
  /// status), без orderBy по другому полю — составной индекс не требуется.
  Stream<StaffShiftModel?> openStaffShiftStream(String employeeId) => _openStaffShiftS.get(
      _k(employeeId),
      () => AppScope.col('staffShifts')
          .where('employeeId', isEqualTo: employeeId)
          .where('status', isEqualTo: 'open')
          .limit(1)
          .snapshots()
          .map((snap) => snap.docs.isEmpty ? null : StaffShiftModel.fromDoc(snap.docs.first))
          .handleError((_) => null));

  /// Все сейчас открытые личные смены (по всем сотрудникам) — для
  /// предупреждения в "Смены сотрудников"/"Зарплата": пока смена не закрыта,
  /// в расчёт зарплаты её часы не попадают.
  Stream<List<StaffShiftModel>> openStaffShiftsStream() => _openStaffShiftsS.get(
      _k(),
      () => AppScope.col('staffShifts')
          .where('status', isEqualTo: 'open')
          .snapshots()
          .map((snap) => snap.docs.map(StaffShiftModel.fromDoc).toList()));

  /// Открытые личные смены разово — кто сейчас на смене, перед тем как
  /// закончить свою смену или закрыть смену заведения.
  Future<List<StaffShiftModel>> openStaffShiftsOnce() async {
    final snap = await AppScope.col('staffShifts').where('status', isEqualTo: 'open').get();
    return snap.docs.map(StaffShiftModel.fromDoc).toList();
  }

  /// Закрытые личные смены за [start; end) по времени закрытия — одно
  /// поле, без составного индекса. Открытые не попадают: пока смена идёт,
  /// платить не за что. Отменённые записи остаются в табеле зачёркнутыми,
  /// [includeCancelled] — для него.
  Future<List<StaffShiftModel>> closedStaffShiftsInRange(DateTime start, DateTime end,
      {bool includeCancelled = false}) async {
    final snap = await AppScope.col('staffShifts')
        .where('endedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(start))
        .where('endedAt', isLessThan: Timestamp.fromDate(end))
        .orderBy('endedAt', descending: true)
        .get();
    return snap.docs
        .map((d) => StaffShiftModel.fromDoc(d))
        .where((s) => includeCancelled || !s.cancelled)
        .toList();
  }

  /// Все личные смены сотрудника — для проверки пересечения при ручном
  /// вводе. Их сотни за всё время, сравнить на клиенте дешевле индекса.
  Future<List<StaffShiftModel>> allStaffShiftsForEmployee(String employeeId) async {
    final snap =
        await AppScope.col('staffShifts').where('employeeId', isEqualTo: employeeId).get();
    return snap.docs.map((d) => StaffShiftModel.fromDoc(d)).toList();
  }

  /// Ручное добавление смены (админ восстанавливает забытую запись).
  /// Запись помечается ручной и подписывается [editor]; правка — в журнал.
  Future<void> addStaffShift(StaffShiftModel shift, {required Employee editor}) async {
    await AppScope.col('staffShifts').add({
      ...shift.toMap(),
      'manual': true,
      'editedBy': editor.name,
      'editedById': editor.id,
      'editedAt': FieldValue.serverTimestamp(),
    });
    AuditLogService.instance.log(
      action: 'staff_shift_added',
      employeeName: editor.name,
      details: {
        'employee': shift.employeeName,
        'startedAt': shift.startedAt.toIso8601String(),
        'endedAt': shift.endedAt?.toIso8601String() ?? '',
      },
    ).ignore();
  }

  /// Правка времени смены админом. Сотрудника у записи не сменить —
  /// иначе можно было бы переписать чужие часы на себя.
  Future<void> updateStaffShift(StaffShiftModel before, StaffShiftModel after, {required Employee editor}) async {
    await AppScope.col('staffShifts').doc(before.id).update({
      'startedAt': Timestamp.fromDate(after.startedAt),
      'endedAt': after.endedAt != null ? Timestamp.fromDate(after.endedAt!) : null,
      'status': after.endedAt != null ? 'closed' : 'open',
      'manual': true,
      'editedBy': editor.name,
      'editedById': editor.id,
      'editedAt': FieldValue.serverTimestamp(),
    });
    AuditLogService.instance.log(
      action: 'staff_shift_edited',
      employeeName: editor.name,
      details: {
        'employee': before.employeeName,
        'before': '${before.startedAt.toIso8601String()} – ${before.endedAt?.toIso8601String() ?? ''}',
        'after': '${after.startedAt.toIso8601String()} – ${after.endedAt?.toIso8601String() ?? ''}',
      },
    ).ignore();
  }

  /// Смены не удаляются: ошибочную отменяют, запись остаётся в табеле с
  /// именем того, кто отменил.
  Future<void> cancelStaffShift(StaffShiftModel shift, {required Employee editor}) async {
    await AppScope.col('staffShifts').doc(shift.id).update({
      'cancelled': true,
      'cancelledBy': editor.name,
      'cancelledAt': FieldValue.serverTimestamp(),
    });
    AuditLogService.instance.log(
      action: 'staff_shift_cancelled',
      employeeName: editor.name,
      details: {
        'employee': shift.employeeName,
        'startedAt': shift.startedAt.toIso8601String(),
        'endedAt': shift.endedAt?.toIso8601String() ?? '',
      },
    ).ignore();
  }

  // ---------- МЕНЮ ----------
  Stream<List<MenuCategory>> categoriesStream() {
    return AppScope.col('menuCategories').orderBy('order').snapshots().map(
        (snap) => snap.docs.map((d) => MenuCategory.fromDoc(d)).toList());
  }

  /// Позиции меню по id (для фискального чека: ставка НДС, предмет
  /// расчёта). Удалённые позиции просто отсутствуют в ответе.
  Future<Map<String, MenuItem>> menuItemsByIds(Set<String> ids) async {
    final docs = await Future.wait(ids.map((id) => AppScope.col('menuItems').doc(id).get()));
    return {for (final d in docs) if (d.exists) d.id: MenuItem.fromDoc(d)};
  }

  Stream<List<MenuItem>> menuItemsStream() {
    return AppScope.col('menuItems').snapshots().map(
        (snap) => snap.docs.map((d) => MenuItem.fromDoc(d)).toList());
  }

  /// Новая категория встаёт в конец. Две одновременные «Новая категория»
  /// могут получить одинаковый order — это безвредно.
  Future<String> addCategory(String name, {String imageUrl = ''}) async {
    final snap = await AppScope.col('menuCategories').get();
    var maxOrder = -1;
    for (final d in snap.docs) {
      final order = (d.data()['order'] as num?)?.toInt() ?? 0;
      if (order > maxOrder) maxOrder = order;
    }
    final docRef = AppScope.col('menuCategories').doc();
    await docRef.set({'name': name, 'order': maxOrder + 1, 'imageUrl': imageUrl});
    return docRef.id;
  }

  Future<void> renameCategory(String id, String name) {
    return AppScope.col('menuCategories').doc(id).update({'name': name});
  }

  /// Что в категории (SaleKind): от этого зависят проценты кальянщику и
  /// бармену и раздельная печать чеков. Пусто — по названию категории.
  Future<void> setCategoryKind(String id, String kind) {
    return AppScope.col('menuCategories').doc(id).update({'kind': SaleKind.normalize(kind)});
  }

  /// Сохраняет ссылку на фото-плитку категории (после загрузки через
  /// StorageService) — используется в редакторе меню и на плитках
  /// категорий у сотрудника.
  Future<void> updateCategoryImage(String id, String imageUrl) {
    return AppScope.col('menuCategories').doc(id).update({'imageUrl': imageUrl});
  }

  Future<void> reorderCategories(List<MenuCategory> orderedCategories) async {
    final batch = _db.batch();
    for (var i = 0; i < orderedCategories.length; i++) {
      batch.update(AppScope.col('menuCategories').doc(orderedCategories[i].id), {'order': i});
    }
    await batch.commit();
  }

  Future<void> deleteCategory(String id) => AppScope.col('menuCategories').doc(id).delete();

  Future<void> addMenuItem(MenuItem item) {
    return AppScope.col('menuItems').add(item.toMap());
  }

  Future<void> updateMenuItem(MenuItem item) {
    // Ручная правка снимает отметку автостоп-листа: решение за админом.
    return AppScope.col('menuItems').doc(item.id).update({...item.toMap(), 'autoStoppedBy': FieldValue.delete()});
  }

  /// Сохраняет фото конкретного блюда/позиции меню.
  Future<void> updateMenuItemImage(String id, String imageUrl) {
    return AppScope.col('menuItems').doc(id).update({'imageUrl': imageUrl});
  }

  Future<void> deleteMenuItem(String id) => AppScope.col('menuItems').doc(id).delete();

  // ---------- СКИДОЧНЫЕ КАРТЫ ----------
  Stream<List<DiscountCard>> discountCardsStream() {
    return AppScope.col('discountCards').snapshots().map(
        (snap) => snap.docs.map((d) => DiscountCard.fromDoc(d)).toList());
  }

  Future<void> addDiscountCard(DiscountCard card) {
    return AppScope.col('discountCards').add(card.toMap());
  }

  Future<void> updateDiscountCard(DiscountCard card) {
    return AppScope.col('discountCards').doc(card.id).update(card.toMap());
  }

  Future<void> setDiscountCardActive(String id, bool active) {
    return AppScope.col('discountCards').doc(id).update({'active': active});
  }

  Future<void> deleteDiscountCard(String id) => AppScope.col('discountCards').doc(id).delete();

  /// Ищет только среди активных карт — деактивированную карту сотрудник
  /// применить не сможет, даже зная номер.
  Future<DiscountCard?> findCardByNumber(String number) async {
    final snap = await AppScope.col('discountCards')
        .where('cardNumber', isEqualTo: number)
        .where('active', isEqualTo: true)
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return DiscountCard.fromDoc(snap.docs.first);
  }

  // ---------- СОТРУДНИКИ ----------
  static final _employeesS = SharedStreams<List<Employee>>();

  /// Общая подписка: меню сотрудника, X-отчёт и «кто на смене» читают
  /// одну и ту же, а не открывают каждый свою.
  Stream<List<Employee>> employeesStream() => _employeesS.get(
      _k(),
      () => AppScope.col('employees')
          .snapshots()
          .map((snap) => snap.docs.map((d) => Employee.fromDoc(d)).toList()));

  /// Список сотрудников разово — для отчётов. Не `employeesStream().first`:
  /// первый снимок подписки отдаётся из локального кэша, и сотрудник,
  /// заведённый на другом планшете, в «Зарплату» не попадал.
  Future<List<Employee>> employeesOnce() async {
    final snap = await AppScope.col('employees').get();
    return snap.docs.map((d) => Employee.fromDoc(d)).toList();
  }

  /// Кто может стоять на смене — все, кроме администраторов.
  ///
  /// Администратор заводит меню, правит цены и смотрит отчёты; в зале он не
  /// работает. Слать ему вызовы гостей и напоминания об углях незачем,
  /// поэтому в списке «кто на смене» его нет.
  Future<List<Employee>> shiftCandidates() async {
    final snap = await AppScope.col('employees').get();
    return snap.docs
        .map(Employee.fromDoc)
        .where((e) => e.role != AppConstants.roleAdmin)
        .toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  /// Новый сотрудник. Его первые условия оплаты сразу пишутся в историю —
  /// с этого момента они и действуют.
  Future<void> addEmployee(Employee e, {Employee? editor}) => AppScope.col('employees').add({
        ...e.toMap(),
        if (e.payTerms.configured)
          'payHistory': [
            PayChange(at: DateTime.now(), terms: e.payTerms, byId: editor?.id ?? '', byName: editor?.name ?? '').toMap(),
          ],
      });

  /// Сохранить карточку. Если поменялась оплата — дописываем запись в
  /// историю: новые ставки действуют с этого момента, прошлые смены
  /// считаются по старым. Правка — в журнал действий.
  Future<void> updateEmployee(Employee e, {Employee? editor}) async {
    final ref = AppScope.col('employees').doc(e.id);
    String? changed;
    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      final before = snap.exists ? Employee.fromDoc(snap) : e;
      // PIN открытым текстом в базе больше не держим.
      final update = <String, dynamic>{...e.toMap(), 'pinCode': FieldValue.delete()};
      if (before.payTerms != e.payTerms) {
        final history = [...before.payHistory];
        // Первая правка: записываем, как было до неё, — «с самого начала».
        // Кроме случая, когда зарплата вовсе не была настроена: тогда
        // первые условия действуют и для уже отработанных смен.
        if (history.isEmpty && before.payTerms.configured) {
          history.add(PayChange(at: PayChange.since, terms: before.payTerms));
        }
        history.add(PayChange(
          at: history.isEmpty ? PayChange.since : DateTime.now(),
          terms: e.payTerms,
          byId: editor?.id ?? '',
          byName: editor?.name ?? '',
        ));
        update['payHistory'] = history.map((c) => c.toMap()).toList();
        changed = '${before.payTerms.summary()} → ${e.payTerms.summary()}';
      }
      tx.update(ref, update);
    });
    if (changed != null) {
      AuditLogService.instance.log(
        action: 'pay_terms_changed',
        employeeName: editor?.name ?? '',
        details: {'employee': e.name, 'change': changed},
      ).ignore();
    }
  }

  /// Удаляет сотрудника. Его открытую личную смену закрываем сейчас же и
  /// убираем его из списка «кому чаевые»: иначе удалённый числился бы на
  /// смене у коллег («вы уходите не последним») и в выборе у гостя.
  Future<void> deleteEmployee(String id) async {
    final open = await AppScope.col('staffShifts')
        .where('employeeId', isEqualTo: id)
        .where('status', isEqualTo: 'open')
        .get();
    for (final d in open.docs) {
      await clockOut(d.id, id);
    }
    await AppScope.col('employees').doc(id).delete();
    await _removeTipsMember(id);
  }

  /// Сотрудник по id — по нему восстанавливается вход на планшете, где
  /// PIN уже вводили. Сам PIN на устройстве не хранится.
  Future<Employee?> employeeById(String id) async {
    if (id.isEmpty) return null;
    final doc = await AppScope.col('employees').doc(id).get();
    return doc.exists ? Employee.fromDoc(doc) : null;
  }

  /// Вход по PIN: ищем по хэшу. Старую запись с PIN открытым текстом
  /// находим по нему и сразу переводим на хэш.
  Future<Employee?> findByPin(String pin) async {
    final hash = await PinHash.of(pin);
    final snap = await AppScope.col('employees').where('pinHash', isEqualTo: hash).limit(1).get();
    if (snap.docs.isNotEmpty) return Employee.fromDoc(snap.docs.first);
    final legacy = await AppScope.col('employees').where('pinCode', isEqualTo: pin).limit(1).get();
    if (legacy.docs.isEmpty) return null;
    final doc = legacy.docs.first;
    unawaited(_write(doc.reference.update({'pinHash': hash, 'pinCode': FieldValue.delete()})).catchError((Object _) {}));
    return Employee.fromDoc(doc).copyWith(pinHash: hash, pinCode: '');
  }

  /// Перевод всех PIN заведения, ещё хранящихся открытым текстом, на хэши.
  /// Вызывается при старте кассы; если таких нет — один пустой запрос.
  Future<void> migratePlainPins() async {
    try {
      final snap = await AppScope.col('employees').where('pinCode', isGreaterThan: '').get();
      for (final d in snap.docs) {
        final pin = (d.data()['pinCode'] ?? '').toString();
        if (pin.isEmpty) continue;
        await _write(d.reference.update({'pinHash': await PinHash.of(pin), 'pinCode': FieldValue.delete()}));
      }
    } catch (_) {
      // Не критично: переведём при следующем входе сотрудника.
    }
  }

  /// Проверка, что PIN ещё не занят другим сотрудником (excludeId — при
  /// редактировании существующего сотрудника, чтобы не конфликтовать с самим собой)
  Future<bool> isPinTaken(String pin, {String? excludeId}) async {
    final hash = await PinHash.of(pin);
    final snaps = await Future.wait([
      AppScope.col('employees').where('pinHash', isEqualTo: hash).get(),
      AppScope.col('employees').where('pinCode', isEqualTo: pin).get(),
    ]);
    return snaps.any((s) => s.docs.any((d) => d.id != excludeId));
  }

  /// Удаляет стол, только если на нём сейчас нет открытых чеков — чтобы не
  /// потерять активный сеанс с заказом гостя.
  Future<void> deleteTableSafe(String tableId) async {
    final doc = await AppScope.col('tables').doc(tableId).get();
    final data = doc.data();
    final ids = ((data?['activeSessionIds'] ?? []) as List);
    if (data != null && (data['status'] == 'occupied' || ids.isNotEmpty)) {
      throw TableOccupiedDeleteException();
    }
    await AppScope.col('tables').doc(tableId).delete();
    await TableKeyService.instance.remove(tableId);
  }

  /// Удаляет категорию меню вместе со всеми её позициями (каскадно),
  /// чтобы не оставлять "осиротевшие" позиции без категории.
  Future<void> deleteCategoryCascade(String categoryId) async {
    final items = await AppScope.col('menuItems')
        .where('categoryId', isEqualTo: categoryId)
        .get();
    final batch = _db.batch();
    for (final doc in items.docs) {
      batch.delete(doc.reference);
    }
    batch.delete(AppScope.col('menuCategories').doc(categoryId));
    await batch.commit();
  }

  // ---------- СКЛАД (ОСТАТКИ) ----------
  // Склад — отдельный от меню справочник: позиции меню — это то, что
  // продаётся гостю, а позиции склада — это то, что физически лежит в
  // подсобке (граммы табака, литры сиропа, банки пива, угли и т.п.).
  // Список позиций полностью произвольный и настраивается админом.

  Stream<List<InventoryItem>> inventoryItemsStream() => _inventoryItemsS.get(
      _k(),
      () => AppScope.col('inventoryItems')
          .snapshots()
          .map((snap) => snap.docs.map((d) => InventoryItem.fromDoc(d)).toList()));

  Stream<InventoryItem?> inventoryItemStream(String id) => _inventoryItemS.get(
      _k(id),
      () => AppScope.col('inventoryItems')
          .doc(id)
          .snapshots()
          .map((doc) => doc.exists ? InventoryItem.fromDoc(doc) : null));

  Future<String> addInventoryItem(InventoryItem item) async {
    final ref = await AppScope.col('inventoryItems').add(item.toMap());
    return ref.id;
  }

  /// Обновляет карточку позиции склада. Остаток здесь не переписывается —
  /// для этого [adjustInventoryQuantity]. Исключение — смена единицы
  /// измерения: остаток пересчитывается, иначе «500 г» стали бы «500 кг».
  /// Порог «мало на складе» приходит уже пересчитанным из формы.
  Future<void> updateInventoryItem(InventoryItem item) async {
    final ref = AppScope.col('inventoryItems').doc(item.id);
    final map = item.toMap()..remove('quantity');
    final current = await ref.get();
    final currentUnitName = current.data()?['unit'] as String?;
    if (currentUnitName != null) {
      final currentUnit = InventoryUnitX.fromName(currentUnitName);
      if (currentUnit != item.unit) {
        final currentQty = (current.data()?['quantity'] as num?)?.toDouble() ?? 0;
        map['quantity'] = currentUnit.convertTo(currentQty, item.unit);
      }
    }
    await ref.update(map);
  }

  /// Включить/выключить отслеживание позиции — на усмотрение админа.
  /// Выключенная позиция остаётся в справочнике с историей и остатком, но
  /// пропадает из активного списка и из будущих инвентаризаций, пока её не
  /// включат обратно.
  Future<void> setInventoryItemActive(String id, bool active) {
    return AppScope.col('inventoryItems').doc(id).update({'active': active});
  }

  Future<void> deleteInventoryItem(String id) =>
      AppScope.col('inventoryItems').doc(id).delete();

  /// Ищет позицию склада по GTIN (штрихкод/код маркировки) — используется
  /// при сканировании на экране меню, чтобы найти, какую позицию добавить
  /// в чек. GTIN хранится в поле [InventoryItem.gtin], которое заполняется
  /// один раз при заведении позиции.
  Future<InventoryItem?> findInventoryItemByGtin(String gtin) async {
    final snap = await AppScope.col('inventoryItems')
        .where('gtin', isEqualTo: gtin)
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return InventoryItem.fromDoc(snap.docs.first);
  }

  /// Ищет позицию меню, привязанную к данной позиции склада — чтобы после
  /// сканирования штрихкода/кода маркировки добавить в чек не саму
  /// складскую позицию, а соответствующую ей позицию меню (с ценой).
  Future<MenuItem?> findMenuItemByInventoryItemId(String inventoryItemId) async {
    final snap = await AppScope.col('menuItems')
        .where('inventoryItemId', isEqualTo: inventoryItemId)
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return MenuItem.fromDoc(snap.docs.first);
  }

  /// Меняет остаток и пишет строку в историю движений. Транзакция: два
  /// одновременных изменения с разных устройств складываются.
  Future<void> adjustInventoryQuantity({
    required String itemId,
    required String itemName,
    required InventoryUnit unit,
    required double delta,
    required String type, // receipt | writeoff | correction
    required String employeeName,
    String reason = '',
  }) async {
    final itemRef = AppScope.col('inventoryItems').doc(itemId);
    final moveRef = AppScope.col('inventoryMovements').doc();
    var after = 0.0;
    if (!NetStatus.online.value) {
      // Без связи: атомарное приращение (сервер сложит сам), остаток для
      // журнала — по памяти устройства.
      final cached = await itemRef.get(const GetOptions(source: Source.cache)).catchError((Object _) => itemRef.get());
      after = ((cached.data()?['quantity'] as num?)?.toDouble() ?? 0) + delta;
      final batch = _db.batch()
        ..update(itemRef, {'quantity': FieldValue.increment(delta), 'updatedAt': Timestamp.fromDate(DateTime.now())})
        ..set(
            moveRef,
            InventoryMovement(
              id: moveRef.id,
              itemId: itemId,
              itemName: itemName,
              unit: unit,
              type: type,
              delta: delta,
              resultingQty: after,
              reason: reason,
              employeeName: employeeName,
              createdAt: DateTime.now(),
            ).toMap());
      unawaited(batch.commit().catchError((Object _) {}));
      return;
    }
    await _db.runTransaction((tx) async {
      final snap = await tx.get(itemRef);
      final current = (snap.data()?['quantity'] as num?)?.toDouble() ?? 0;
      final result = current + delta;
      after = result;
      tx.update(itemRef, {
        'quantity': result,
        'updatedAt': Timestamp.fromDate(DateTime.now()),
      });
      tx.set(
        moveRef,
        InventoryMovement(
          id: moveRef.id,
          itemId: itemId,
          itemName: itemName,
          unit: unit,
          type: type,
          delta: delta,
          resultingQty: result,
          reason: reason,
          employeeName: employeeName,
          createdAt: DateTime.now(),
        ).toMap(),
      );
    });
    try {
      await syncStopList(itemId, after, unit);
    } catch (_) {
      // Стоп-лист — удобство; движение склада уже записано.
    }
  }

  /// Автостоп-лист: продукта на складе меньше, чем на одну порцию, —
  /// блюдо пропадает из меню кассы и гостя (available = false, помечено
  /// autoStoppedBy). Пришёл приход — снятые так блюда возвращаются. Блюда,
  /// выключенные вручную, не трогаем.
  Future<void> syncStopList(String inventoryItemId, double stock, InventoryUnit unit) async {
    final menu = await AppScope.col('menuItems').get();
    final batch = _db.batch();
    var changed = false;
    for (final doc in menu.docs) {
      final item = MenuItem.fromDoc(doc);
      double? need;
      if (item.isComposite) {
        for (final c in item.components) {
          if (c.inventoryItemId == inventoryItemId && c.weight > 0) need = c.weightUnit.convertTo(c.weight, unit);
        }
      } else if (item.inventoryItemId == inventoryItemId && item.weight > 0) {
        need = item.weightUnit.convertTo(item.weight, unit);
      }
      if (need == null) continue;
      final stoppedBy = (doc.data()['autoStoppedBy'] ?? '').toString();
      if (stock < need && item.available) {
        batch.update(doc.reference, {'available': false, 'autoStoppedBy': inventoryItemId});
        changed = true;
      } else if (stock >= need && !item.available && stoppedBy == inventoryItemId) {
        batch.update(doc.reference, {'available': true, 'autoStoppedBy': FieldValue.delete()});
        changed = true;
      }
    }
    if (changed) await batch.commit();
  }

  /// Разовая достройка [TableModel.busyUntil] для столов, занятых до
  /// появления поля, — иначе приложение гостя считало бы их свободными.
  /// Вызывается с кассы при входе, правит только столы с открытым чеком и
  /// пустым полем.
  Future<void> backfillTablesBusyUntil() async {
    try {
      final snap = await AppScope.col('tables').get();
      for (final doc in snap.docs) {
        final data = doc.data();
        final ids = (data['activeSessionIds'] ?? []) as List;
        if (ids.isEmpty) continue;
        if (data['busyUntil'] is Timestamp) continue; // уже заполнено
        await syncTableBusyUntil(doc.id);
      }
    } catch (_) {
      // Нет прав/сети — попробуем при следующем входе.
    }
  }

  /// История движений конкретной позиции, от самого свежего к старому.
  Stream<List<InventoryMovement>> inventoryMovementsStream(String itemId, {int limit = 100}) {
    // orderBy обязателен: без него limit(100) брал первые документы по id,
    // и свежие движения не попадали в список. Индекс (itemId, createdAt DESC)
    // есть в firestore.indexes.json.
    return AppScope.col('inventoryMovements')
        .where('itemId', isEqualTo: itemId)
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .snapshots()
        .map((snap) => snap.docs.map((d) => InventoryMovement.fromDoc(d)).toList());
  }

  // ---------- СКЛАД (ИНВЕНТАРИЗАЦИЯ) ----------
  // Инвентаризация — отдельный процесс сверки: фиксируем системный остаток
  // каждой активной позиции на момент старта, затем сотрудник вводит
  // фактически посчитанное количество, а по завершении расхождения разом
  // применяются к остаткам и попадают в историю движений с типом 'count'.

  /// Стрим текущей незавершённой инвентаризации, если она есть — чтобы при
  /// заходе на экран сразу продолжить, а не потерять уже введённые цифры.
  Stream<InventoryCount?> openInventoryCountStream() => _openInventoryCountS.get(
      _k(),
      () => AppScope.col('inventoryCounts')
          .where('status', isEqualTo: 'in_progress')
          .limit(1)
          .snapshots()
          .map((snap) => snap.docs.isEmpty ? null : InventoryCount.fromDoc(snap.docs.first)));

  Future<InventoryCount?> currentOpenInventoryCount() async {
    final snap = await AppScope.col('inventoryCounts')
        .where('status', isEqualTo: 'in_progress')
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return InventoryCount.fromDoc(snap.docs.first);
  }

  /// Начинает новую инвентаризацию — снимает текущие остатки всех АКТИВНЫХ
  /// позиций склада как ожидаемые значения. Позиции, выключенные из
  /// отслеживания, в пересчёт не попадают.
  Future<String> startInventoryCount(String employeeName) async {
    final itemsSnap =
        await AppScope.col('inventoryItems').where('active', isEqualTo: true).get();
    final entries = itemsSnap.docs.map((d) {
      final item = InventoryItem.fromDoc(d);
      return InventoryCountEntry(
        itemId: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        expectedQty: item.quantity,
      );
    }).toList();
    // Группировка по категории и алфавиту делает лист пересчёта удобным
    // для похода по подсобке — сотрудник идёт полкой за полкой, а не
    // прыгает по случайному порядку добавления позиций в базу.
    entries.sort((a, b) {
      final catCmp = a.category.compareTo(b.category);
      return catCmp != 0 ? catCmp : a.name.compareTo(b.name);
    });

    final ref = AppScope.col('inventoryCounts').doc();
    await ref.set(InventoryCount(
      id: ref.id,
      status: 'in_progress',
      startedAt: DateTime.now(),
      startedBy: employeeName,
      entries: entries,
    ).toMap());
    return ref.id;
  }

  Stream<InventoryCount?> inventoryCountStream(String id) {
    return AppScope.col('inventoryCounts')
        .doc(id)
        .snapshots()
        .map((doc) => doc.exists ? InventoryCount.fromDoc(doc) : null);
  }

  /// Записывает фактически посчитанное количество для одной позиции внутри
  /// текущей инвентаризации. countedQty == null стирает уже введённое
  /// значение (если сотрудник хочет пересчитать позицию заново).
  Future<void> setInventoryCountValue(String countId, String itemId, double? countedQty) async {
    final ref = AppScope.col('inventoryCounts').doc(countId);
    final itemRef = AppScope.col('inventoryItems').doc(itemId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final data = doc.data();
      if (data == null) return;
      final entries = ((data['entries'] ?? []) as List)
          .map((e) => InventoryCountEntry.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();
      final idx = entries.indexWhere((e) => e.itemId == itemId);
      if (idx < 0) return;
      // Запоминаем системный остаток в момент подсчёта — продажи после
      // этого учтутся при завершении.
      final item = countedQty == null ? null : await tx.get(itemRef);
      final systemNow = (item?.data()?['quantity'] as num?)?.toDouble();
      entries[idx] = entries[idx]
          .copyWith(countedQty: countedQty, systemAtCount: systemNow, clear: countedQty == null);
      tx.update(ref, {'entries': entries.map((e) => e.toMap()).toList()});
    });
  }

  /// Завершает инвентаризацию: по каждой посчитанной позиции остаток в
  /// справочнике склада приравнивается к фактически введённому количеству,
  /// а расхождение (если оно есть) фиксируется отдельным движением типа
  /// 'count' в истории — так же прозрачно, как приход или списание.
  /// Позиции, которые никто не успел посчитать, остаются без изменений.
  ///
  /// Расхождение считаем от остатка на момент завершения, а не от снимка
  /// при старте: пока шёл пересчёт, продажи уже списывали склад, и движение
  /// должно показывать, на сколько остаток изменился именно сейчас.
  Future<void> completeInventoryCount(String countId, String employeeName) async {
    final ref = AppScope.col('inventoryCounts').doc(countId);
    final data = (await ref.get()).data();
    // Уже завершили или отменили с другого устройства — второй раз не
    // применяем, иначе движения в истории задвоятся.
    if (data == null || data['status'] != 'in_progress') return;
    final entries = ((data['entries'] ?? []) as List)
        .map((e) => InventoryCountEntry.fromMap(Map<String, dynamic>.from(e as Map)))
        .where((e) => e.countedQty != null)
        .toList();
    final current = await Future.wait(
        entries.map((e) => AppScope.col('inventoryItems').doc(e.itemId).get()));

    final now = DateTime.now();
    // Лимит батча — 500 операций, на позицию их до двух.
    var batch = _db.batch();
    var ops = 0;
    for (var i = 0; i < entries.length; i++) {
      final entry = entries[i];
      final snap = current[i];
      if (!snap.exists) continue; // позицию удалили, пока считали
      final before = (snap.data()?['quantity'] as num?)?.toDouble() ?? 0;
      final counted = inventoryCountFinalQty(
          counted: entry.countedQty!, systemAtCount: entry.systemAtCount, currentQty: before);
      final diff = counted - before;
      // Приращением, а не записью числа: продажа, прошедшая в эту же
      // секунду, не потеряется.
      batch.update(snap.reference, {
        'quantity': FieldValue.increment(diff),
        'updatedAt': Timestamp.fromDate(now),
      });
      ops++;
      if (diff.abs() > 0.0001) {
        final moveRef = AppScope.col('inventoryMovements').doc();
        batch.set(
          moveRef,
          InventoryMovement(
            id: moveRef.id,
            itemId: entry.itemId,
            itemName: entry.name,
            unit: entry.unit,
            type: 'count',
            delta: diff,
            resultingQty: counted,
            reason: 'Инвентаризация',
            employeeName: employeeName,
            createdAt: now,
          ).toMap(),
        );
        ops++;
      }
      if (ops >= 400) {
        await batch.commit();
        batch = _db.batch();
        ops = 0;
      }
    }
    batch.update(ref, {
      'status': 'completed',
      'closedAt': Timestamp.fromDate(now),
      'closedBy': employeeName,
    });
    await batch.commit();
  }

  /// Отменяет инвентаризацию без применения введённых цифр к остаткам —
  /// на случай, если пересчёт начали по ошибке или его пришлось прервать.
  Future<void> cancelInventoryCount(String countId, String employeeName) {
    return AppScope.col('inventoryCounts').doc(countId).update({
      'status': 'cancelled',
      'closedAt': Timestamp.fromDate(DateTime.now()),
      'closedBy': employeeName,
    });
  }

  /// Последние завершённые/отменённые инвентаризации — для истории.
  Future<List<InventoryCount>> recentInventoryCounts({int limit = 20}) async {
    final snap = await AppScope.col('inventoryCounts')
        .orderBy('startedAt', descending: true)
        .limit(limit)
        .get();
    return snap.docs.map((d) => InventoryCount.fromDoc(d)).toList();
  }
}

enum _CloseOutcome { closed, alreadyClosed, billChanged }

/// Бросается при попытке открыть чек на столе, где уже открыто
/// максимально допустимое (maxOpenSessions) число чеков.
class TableFullException implements Exception {
  final int maxOpenSessions;
  TableFullException(this.maxOpenSessions);

  @override
  String toString() => maxOpenSessions <= 1
      ? 'Стол уже занят — сеанс уже открыт на другом устройстве'
      : 'На столе уже открыто максимум чеков ($maxOpenSessions) — закройте один из них';
}

class TableOccupiedDeleteException implements Exception {
  @override
  String toString() => 'Нельзя удалить стол с активным чеком — сначала закройте счёт';
}

/// Пересчёт кассы при закрытии смены (см. FirestoreService.closeShift).
class ShiftCashClose {
  /// Сколько должно было быть по учёту.
  final double expected;

  /// Сколько насчитали на самом деле.
  final double counted;

  /// Сколько забрали (инкассация при закрытии).
  final double collect;

  /// Сколько оставили на размен следующей смене.
  final double leave;

  const ShiftCashClose({required this.expected, required this.counted, required this.collect, required this.leave});
}
