import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:uuid/uuid.dart';
import '../models/table_model.dart';
import '../models/session_model.dart';
import '../models/menu_models.dart';
import '../models/discount_card.dart';
import '../models/employee.dart';
import '../models/shift_model.dart';
import '../models/inventory_models.dart';
import '../models/egais_models.dart';
import '../utils/constants.dart';

/// Единая точка доступа к Firestore. Простая, без лишней абстракции.
class FirestoreService {
  final _db = FirebaseFirestore.instance;
  final _uuid = const Uuid();

  // ---------- СТОЛЫ ----------
  Stream<List<TableModel>> tablesStream() {
    return _db.collection('tables').snapshots().map(
        (snap) => snap.docs.map((d) => TableModel.fromDoc(d)).toList());
  }

  Future<void> addTable(TableModel table) {
    return _db.collection('tables').doc(table.id).set(table.toMap());
  }

  Future<void> updateTable(TableModel table) {
    return _db.collection('tables').doc(table.id).update(table.toMap());
  }

  Future<void> updateTablePosition(String tableId, double x, double y) {
    return _db.collection('tables').doc(tableId).update({'x': x, 'y': y});
  }

  Future<void> deleteTable(String tableId) {
    return _db.collection('tables').doc(tableId).delete();
  }

  /// Стрим ОДНОГО стола по id. В отличие от [tablesStream] не тянет всю
  /// коллекцию столов — используется на экране конкретного стола, чтобы
  /// открытие/изменение любого другого стола в зале не вызывало лишних
  /// перестроений и сетевого трафика на этом экране.
  Stream<TableModel?> tableStream(String tableId) {
    return _db
        .collection('tables')
        .doc(tableId)
        .snapshots()
        .map((doc) => doc.exists ? TableModel.fromDoc(doc) : null);
  }

  String newTableId() => _uuid.v4();

  /// Пересадка гостя за другой стол вместе с открытым чеком: чек и вся его
  /// история/заказ остаются теми же, меняется только его "прописка" —
  /// tableId у сессии и activeSessionIds у обоих столов. Обёрнуто в одну
  /// транзакцию, поэтому не бывает промежуточного состояния, когда чек
  /// "потерян" (исчез со старого стола, но ещё не появился на новом).
  ///
  /// Бросает [TableFullException], если на целевом столе уже открыто
  /// максимально допустимое число чеков — например, если два сотрудника
  /// одновременно пересаживают гостей на один и тот же свободный стол.
  Future<void> moveSessionToTable({
    required String sessionId,
    required String fromTableId,
    required String toTableId,
  }) async {
    if (fromTableId == toTableId) return;

    final sessionRef = _db.collection('sessions').doc(sessionId);
    final fromRef = _db.collection('tables').doc(fromTableId);
    final toRef = _db.collection('tables').doc(toTableId);

    await _db.runTransaction((tx) async {
      final toSnap = await tx.get(toRef);
      final toData = toSnap.data() as Map<String, dynamic>?;
      final toIds = ((toData?['activeSessionIds'] ?? []) as List)
          .map((e) => e.toString())
          .toList();
      final toMax = (toData?['maxOpenSessions'] as num?)?.toInt() ?? 2;
      if (toIds.length >= toMax) {
        throw TableFullException(toMax);
      }

      final fromSnap = await tx.get(fromRef);
      final fromData = fromSnap.data() as Map<String, dynamic>?;
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
  }

  // ---------- СЕССИИ (ЧЕКИ) ----------
  Stream<SessionModel?> sessionStream(String sessionId) {
    return _db.collection('sessions').doc(sessionId).snapshots().map(
        (doc) => doc.exists ? SessionModel.fromDoc(doc) : null);
  }

  /// Все сейчас открытые чеки конкретного стола, отсортированные по времени
  /// открытия. Запрос состоит из двух равенств (tableId, status) — Firestore
  /// умеет объединять такие простые условия без ручного составного
  /// индекса, поэтому сортировку делаем на клиенте, а не в самом запросе.
  Stream<List<SessionModel>> activeSessionsStream(String tableId) {
    return _db
        .collection('sessions')
        .where('tableId', isEqualTo: tableId)
        .where('status', isEqualTo: 'active')
        .snapshots()
        .map((snap) {
      final list = snap.docs.map((d) => SessionModel.fromDoc(d)).toList();
      list.sort((a, b) => a.startTime.compareTo(b.startTime));
      return list;
    });
  }

  /// Открыть новый чек за столом (Старт / доп. чек / Перезабивка после
  /// закрытия). Обёрнуто в транзакцию: читает актуальный список открытых
  /// чеков стола и лимит maxOpenSessions — если лимит уже достигнут (в т.ч.
  /// из-за одновременного нажатия "Начать" на двух устройствах), бросает
  /// TableFullException вместо дублирующего/лишнего счёта.
  Future<String> openSession({
    required TableModel table,
    required String employeeName,
    int durationMinutes = AppConstants.defaultSessionMinutes,
  }) async {
    final tableRef = _db.collection('tables').doc(table.id);
    final sessionRef = _db.collection('sessions').doc();
    final now = DateTime.now();

    await _db.runTransaction((tx) async {
      final freshTable = await tx.get(tableRef);
      final data = freshTable.data() as Map<String, dynamic>?;
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
        tableName: table.name,
        employeeName: employeeName,
        startTime: now,
        plannedEnd: now.add(Duration(minutes: durationMinutes)),
      );
      tx.set(sessionRef, session.toMap());

      ids.add(sessionRef.id);
      tx.update(tableRef, {'activeSessionIds': ids, 'status': 'occupied'});
    });

    return sessionRef.id;
  }

  /// Перезабивка — сброс таймера на новые 1.5ч (или заданную длительность)
  Future<void> refillSession(String sessionId,
      {int durationMinutes = AppConstants.defaultSessionMinutes}) async {
    final now = DateTime.now();
    await _db.collection('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(now.add(Duration(minutes: durationMinutes))),
      'refillCount': FieldValue.increment(1),
      'refillHistory': FieldValue.arrayUnion([
        {'time': Timestamp.fromDate(now)}
      ]),
    });
  }

  /// Установить/сменить подпись чека — кто сидит за столом (гость, номер
  /// компании и т.п.). Пустая строка убирает подпись.
  Future<void> setGuestTag(String sessionId, String tag) {
    return _db.collection('sessions').doc(sessionId).update({'guestTag': tag});
  }

  /// Обновить/продлить таймер на N минут (может быть отрицательным)
  Future<void> extendSession(String sessionId, DateTime currentPlannedEnd, int minutes) {
    final newEnd = currentPlannedEnd.add(Duration(minutes: minutes));
    return _db.collection('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(newEnd),
    });
  }

  /// Установить таймер на конкретное время вручную
  Future<void> setSessionEnd(String sessionId, DateTime newEnd) {
    return _db.collection('sessions').doc(sessionId).update({
      'plannedEnd': Timestamp.fromDate(newEnd),
    });
  }

  /// Добавить позицию в заказ. Если такая позиция меню (по menuItemId) уже
  /// есть в счёте — увеличивает её количество, а не создаёт вторую строку.
  /// Обёрнуто в транзакцию, чтобы два одновременных нажатия "Добавить" не
  /// перезаписали друг друга.
  Future<void> addOrderItem(String sessionId, MenuItem menuItem, {int qty = 1}) async {
    final ref = _db.collection('sessions').doc(sessionId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final data = doc.data();
      if (data == null) return;
      final items = ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();
      final idx = items.indexWhere((i) => i.menuItemId == menuItem.id);
      if (idx >= 0) {
        items[idx] = items[idx].copyWith(qty: items[idx].qty + qty);
      } else {
        items.add(OrderItem(
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          qty: qty,
        ));
      }
      tx.update(ref, {'orderItems': items.map((e) => e.toMap()).toList()});
    });
  }

  /// Изменить количество позиции в заказе на delta (может быть отрицательным).
  /// Если количество опускается до 0 или ниже — позиция удаляется из счёта.
  Future<void> changeOrderItemQty(String sessionId, String menuItemId, int delta) async {
    final ref = _db.collection('sessions').doc(sessionId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final data = doc.data();
      if (data == null) return;
      final items = ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();
      final idx = items.indexWhere((i) => i.menuItemId == menuItemId);
      if (idx < 0) return;
      final newQty = items[idx].qty + delta;
      if (newQty <= 0) {
        items.removeAt(idx);
      } else {
        items[idx] = items[idx].copyWith(qty: newQty);
      }
      tx.update(ref, {'orderItems': items.map((e) => e.toMap()).toList()});
    });
  }

  /// Полностью убрать позицию из заказа независимо от количества.
  Future<void> removeOrderItem(String sessionId, String menuItemId) async {
    final ref = _db.collection('sessions').doc(sessionId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final data = doc.data();
      if (data == null) return;
      final items = ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .where((i) => i.menuItemId != menuItemId)
          .toList();
      tx.update(ref, {'orderItems': items.map((e) => e.toMap()).toList()});
    });
  }

  Future<void> applyDiscountCard(String sessionId, DiscountCard? card) {
    return _db.collection('sessions').doc(sessionId).update({
      'discountCardId': card?.id,
      'discountPercent': card?.discountPercent ?? 0,
    });
  }

  /// Экран оплаты гостя: закрывает чек с разбивкой суммы по способам оплаты,
  /// убирает его из списка открытых чеков стола, и автоматически списывает
  /// со склада позиции, привязанные к проданным пунктам меню.
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
  }) async {
    // 1. Закрываем чек
    await _db.collection('sessions').doc(sessionId).update({
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
    });

    // 2. Убираем сессию из стола
    final tableRef = _db.collection('tables').doc(tableId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(tableRef);
      final data = doc.data() as Map<String, dynamic>?;
      final ids = ((data?['activeSessionIds'] ?? []) as List)
          .map((e) => e.toString())
          .toList();
      ids.remove(sessionId);
      tx.update(tableRef, {
        'activeSessionIds': ids,
        'status': ids.isEmpty ? 'free' : 'occupied',
      });
    });

    // 3. Списываем склад по позициям заказа (игнорируем ошибки, чтобы не
    //    блокировать оплату при временных сбоях сети или ненастроенных связях)
    if (orderItems.isNotEmpty) {
      await _deductInventoryForSale(orderItems, employeeName);
    }
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
        .map((id) => _db.collection('menuItems').doc(id).get()));

    // Строим карту menuItemId → MenuItem
    final menuMap = <String, MenuItem>{};
    for (final doc in menuDocs) {
      if (doc.exists) menuMap[doc.id] = MenuItem.fromDoc(doc);
    }

    // Для каждой строки заказа — списываем склад если настроена привязка
    for (final orderItem in orderItems) {
      final menuItem = menuMap[orderItem.menuItemId];
      if (menuItem == null || !menuItem.hasAnyInventoryLink) continue;

      if (menuItem.isComposite) {
        // Составная позиция: списываем каждый компонент отдельно
        for (final component in menuItem.components) {
          if (component.inventoryItemId.isEmpty || component.weight <= 0) continue;
          final delta = -(component.weight * orderItem.qty);
          try {
            final invDoc = await _db
                .collection('inventoryItems')
                .doc(component.inventoryItemId)
                .get();
            if (!invDoc.exists) continue;
            final invItem = InventoryItem.fromDoc(invDoc);
            await adjustInventoryQuantity(
              itemId: component.inventoryItemId,
              itemName: invItem.name,
              unit: invItem.unit,
              delta: delta,
              type: 'writeoff',
              employeeName: employeeName,
              reason: 'Продажа: ${orderItem.name} ×${orderItem.qty} (компонент)',
            );
          } catch (_) {
            // Не блокируем оплату из-за ошибок списания компонента
          }
        }
      } else {
        // Простая позиция: одна привязка к складу
        final delta = -(menuItem.weight * orderItem.qty);
        try {
          final invDoc = await _db
              .collection('inventoryItems')
              .doc(menuItem.inventoryItemId)
              .get();
          if (!invDoc.exists) continue;
          final invItem = InventoryItem.fromDoc(invDoc);
          await adjustInventoryQuantity(
            itemId: menuItem.inventoryItemId,
            itemName: invItem.name,
            unit: invItem.unit,
            delta: delta,
            type: 'writeoff',
            employeeName: employeeName,
            reason: 'Продажа: ${orderItem.name} ×${orderItem.qty}',
          );
        } catch (_) {
          // Не блокируем оплату из-за ошибок списания
        }
      }
    }
  }

  /// Собирает строки для документа продажи ЕГАИС по позициям заказа —
  /// вызывается на экране оплаты перед отправкой в кассу (см.
  /// `payment_screen.dart`, `_sendToEgaisIfNeeded`). Работает по тому же
  /// принципу, что и [_deductInventoryForSale]: находим позицию склада, на
  /// которую ссылается позиция меню, и если у неё `alcohol.isAlcohol` —
  /// включаем в результат.
  ///
  /// Для простой позиции (одна привязка `inventoryItemId` + `weight`)
  /// считаем, что продан [OrderItem.qty] целых "тар" — объём берём из
  /// `alcohol.volumeLiters` (эта величина как раз и означает объём тары,
  /// см. докстринг `AlcoholInfo`). Для составных миксов (коктейль с
  /// алкогольным компонентом в мл/г) точного стандарта нет — берём объём
  /// компонента в литрах напрямую из его граммовки/объёма в составе,
  /// приблизительно; при разлив-продаже коктейлей стоит свериться с тем,
  /// как именно у вас заведён алкокод партии в ЕГАИС.
  Future<List<EgaisSaleLine>> resolveAlcoholSaleLines(List<OrderItem> orderItems) async {
    final menuItemIds =
        orderItems.map((o) => o.menuItemId).where((id) => id.isNotEmpty).toSet();
    if (menuItemIds.isEmpty) return [];

    final menuDocs =
        await Future.wait(menuItemIds.map((id) => _db.collection('menuItems').doc(id).get()));
    final menuMap = <String, MenuItem>{};
    for (final doc in menuDocs) {
      if (doc.exists) menuMap[doc.id] = MenuItem.fromDoc(doc);
    }

    final invIds = <String>{};
    for (final m in menuMap.values) {
      if (m.hasInventoryLink) invIds.add(m.inventoryItemId);
      for (final c in m.components) {
        if (c.inventoryItemId.isNotEmpty) invIds.add(c.inventoryItemId);
      }
    }
    if (invIds.isEmpty) return [];

    final invDocs = await Future.wait(invIds.map((id) => _db.collection('inventoryItems').doc(id).get()));
    final invMap = <String, InventoryItem>{};
    for (final doc in invDocs) {
      if (doc.exists) invMap[doc.id] = InventoryItem.fromDoc(doc);
    }

    final lines = <EgaisSaleLine>[];
    for (final orderItem in orderItems) {
      final menuItem = menuMap[orderItem.menuItemId];
      if (menuItem == null) continue;

      if (menuItem.isComposite) {
        for (final component in menuItem.components) {
          final invItem = invMap[component.inventoryItemId];
          if (invItem == null || !invItem.alcohol.isAlcohol) continue;
          final liters = (component.weight * orderItem.qty) / 1000;
          if (liters <= 0) continue;
          lines.add(EgaisSaleLine(
            alcCode: invItem.alcohol.alcCode,
            quantityLiters: liters,
            isBeer: invItem.alcohol.isBeer,
          ));
        }
      } else if (menuItem.hasInventoryLink) {
        final invItem = invMap[menuItem.inventoryItemId];
        if (invItem == null || !invItem.alcohol.isAlcohol) continue;
        final liters = invItem.alcohol.volumeLiters * orderItem.qty;
        if (liters <= 0) continue;
        lines.add(EgaisSaleLine(
          alcCode: invItem.alcohol.alcCode,
          quantityLiters: liters,
          isBeer: invItem.alcohol.isBeer,
        ));
      }
    }
    return lines;
  }

  /// Возврат уже закрытого (оплаченного) чека — раздел "История чеков и
  /// возврат" у сотрудника, аналог возврата чеков в Restik POS. Чек
  /// остаётся в истории, но помечается как возвращённый и больше не
  /// учитывается в выручке X- и обычных отчётов.
  Future<void> refundSession(String sessionId) {
    return _db.collection('sessions').doc(sessionId).update({
      'refunded': true,
      'refundedAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Отменить возврат чека (если оформили по ошибке) — снова учитывается
  /// в отчётах как обычный оплаченный чек.
  Future<void> undoRefundSession(String sessionId) {
    return _db.collection('sessions').doc(sessionId).update({
      'refunded': false,
      'refundedAt': null,
    });
  }

  /// Закрытые чеки за период [start; end) — источник данных для отчётов и
  /// X-отчёта. Специально фильтруется только по диапазону closedAt (у
  /// активных чеков это поле всегда null и они никогда сюда не попадают),
  /// поэтому запросу достаточно автоматического одиночного индекса
  /// Firestore — не нужно вручную создавать составной индекс в консоли.
  Future<List<SessionModel>> closedSessionsInRange(DateTime start, DateTime end) async {
    final snap = await _db
        .collection('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(start))
        .where('closedAt', isLessThan: Timestamp.fromDate(end))
        .orderBy('closedAt', descending: true)
        .get();
    return snap.docs.map((d) => SessionModel.fromDoc(d)).toList();
  }

  // ---------- СМЕНЫ (КАССА) ----------
  // Смена — период работы кассы: открывается при входе сотрудника (если ещё
  // не открыта) и закрывается вручную кнопкой в X-отчёте. В один момент
  // времени может быть открыта только одна смена — она общая для всех
  // сотрудников заведения (как реальная кассовая смена), поэтому все чеки,
  // закрытые пока смена открыта, относятся к ней, даже если смена шла через
  // полночь.

  /// Текущая открытая смена, если она есть. null, если ни одна смена сейчас
  /// не открыта (например, самый первый вход в приложение или после
  /// закрытия предыдущей смены).
  Future<ShiftModel?> currentOpenShift() async {
    // Важно: фильтруем ТОЛЬКО по status, без orderBy по другому полю —
    // сочетание where+orderBy по разным полям требует составного индекса
    // в Firestore, которого в проекте нет, и запрос падал с
    // FAILED_PRECONDITION. Открытая смена в системе всегда одна
    // (гарантируется транзакцией в openShiftIfNeeded/closeShift через
    // meta/shiftState), поэтому сортировка тут не нужна.
    final snap = await _db
        .collection('shifts')
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
    return _db
        .collection('shifts')
        .where('status', isEqualTo: 'open')
        .limit(1)
        .snapshots()
        .map((snap) => snap.docs.isEmpty ? null : ShiftModel.fromDoc(snap.docs.first))
        .handleError((_) {
          // Не даём одиночной ошибке (например, временная проблема сети)
          // намертво "заморозить" последнее состояние — считаем смену
          // неизвестной/закрытой, и следующее изменение в базе снова
          // разбудит стрим.
          return null;
        });
  }

  /// Открывает новую смену, если сейчас нет открытой. Вызывается при входе
  /// сотрудника в приложение. Указатель на текущую открытую смену хранится
  /// в отдельном документе meta/shiftState — транзакции клиентского SDK
  /// умеют читать только конкретный документ (не запрос), поэтому именно
  /// через этот документ безопасно проверяем и фиксируем, что смена уже
  /// открыта, даже если два сотрудника входят почти одновременно.
  /// Возвращает id открытой смены (новой или уже существующей).
  Future<String> openShiftIfNeeded(String employeeName) async {
    final stateRef = _db.collection('meta').doc('shiftState');
    final shiftRef = _db.collection('shifts').doc();
    final now = DateTime.now();

    final resultId = await _db.runTransaction<String>((tx) async {
      final stateDoc = await tx.get(stateRef);
      final data = stateDoc.data();
      final currentOpenId = data?['openShiftId'] as String?;
      if (currentOpenId != null && currentOpenId.isNotEmpty) {
        return currentOpenId;
      }

      final shift = ShiftModel(
        id: shiftRef.id,
        openedAt: now,
        openedBy: employeeName,
        status: 'open',
      );
      tx.set(shiftRef, shift.toMap());
      tx.set(stateRef, {'openShiftId': shiftRef.id});
      return shiftRef.id;
    });

    return resultId;
  }

  /// Закрывает смену (кнопка "Закрыть смену" в X-отчёте) и сбрасывает
  /// указатель текущей открытой смены, чтобы следующий вход в приложение
  /// открыл новую смену.
  Future<void> closeShift(String shiftId, String employeeName) async {
    final now = DateTime.now();
    await _db.collection('shifts').doc(shiftId).update({
      'status': 'closed',
      'closedAt': Timestamp.fromDate(now),
      'closedBy': employeeName,
    });
    final stateRef = _db.collection('meta').doc('shiftState');
    await _db.runTransaction((tx) async {
      final stateDoc = await tx.get(stateRef);
      final data = stateDoc.data();
      if (data?['openShiftId'] == shiftId) {
        tx.set(stateRef, {'openShiftId': null});
      }
    });
  }

  /// Последние N смен (для просмотра прошлых смен в X-отчёте), отсортированы
  /// от самой свежей к самой старой.
  Future<List<ShiftModel>> recentShifts({int limit = 30}) async {
    final snap = await _db
        .collection('shifts')
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

  // ---------- МЕНЮ ----------
  Stream<List<MenuCategory>> categoriesStream() {
    return _db.collection('menuCategories').orderBy('order').snapshots().map(
        (snap) => snap.docs.map((d) => MenuCategory.fromDoc(d)).toList());
  }

  Stream<List<MenuItem>> menuItemsStream() {
    return _db.collection('menuItems').snapshots().map(
        (snap) => snap.docs.map((d) => MenuItem.fromDoc(d)).toList());
  }

  /// Новая категория всегда встаёт в конец списка. Firestore-транзакции в
  /// клиентском SDK умеют делать tx.get() только по DocumentReference, а не
  /// по запросу/коллекции — поэтому максимальный order читаем обычным
  /// запросом до транзакции, а саму запись документа делаем в транзакции
  /// ради атомарности создания. Полностью исключить гонку двух
  /// одновременных "Новая категория" без Cloud Function нельзя, но это
  /// на порядок надёжнее прежнего варианта по snap.docs.length.
  Future<String> addCategory(String name, {String imageUrl = ''}) async {
    final snap = await _db.collection('menuCategories').get();
    var maxOrder = -1;
    for (final d in snap.docs) {
      final order = (d.data()['order'] as num?)?.toInt() ?? 0;
      if (order > maxOrder) maxOrder = order;
    }
    final docRef = _db.collection('menuCategories').doc();
    await _db.runTransaction((tx) async {
      tx.set(docRef, {'name': name, 'order': maxOrder + 1, 'imageUrl': imageUrl});
    });
    return docRef.id;
  }

  Future<void> renameCategory(String id, String name) {
    return _db.collection('menuCategories').doc(id).update({'name': name});
  }

  /// Сохраняет ссылку на фото-плитку категории (после загрузки в Storage
  /// через StorageService) — используется в редакторе меню и на плитках
  /// категорий у сотрудника.
  Future<void> updateCategoryImage(String id, String imageUrl) {
    return _db.collection('menuCategories').doc(id).update({'imageUrl': imageUrl});
  }

  Future<void> reorderCategories(List<MenuCategory> orderedCategories) async {
    final batch = _db.batch();
    for (var i = 0; i < orderedCategories.length; i++) {
      batch.update(_db.collection('menuCategories').doc(orderedCategories[i].id), {'order': i});
    }
    await batch.commit();
  }

  Future<void> deleteCategory(String id) => _db.collection('menuCategories').doc(id).delete();

  Future<void> addMenuItem(MenuItem item) {
    return _db.collection('menuItems').add(item.toMap());
  }

  Future<void> updateMenuItem(MenuItem item) {
    return _db.collection('menuItems').doc(item.id).update(item.toMap());
  }

  /// Сохраняет фото конкретного блюда/позиции меню.
  Future<void> updateMenuItemImage(String id, String imageUrl) {
    return _db.collection('menuItems').doc(id).update({'imageUrl': imageUrl});
  }

  Future<void> deleteMenuItem(String id) => _db.collection('menuItems').doc(id).delete();

  // ---------- СКИДОЧНЫЕ КАРТЫ ----------
  Stream<List<DiscountCard>> discountCardsStream() {
    return _db.collection('discountCards').snapshots().map(
        (snap) => snap.docs.map((d) => DiscountCard.fromDoc(d)).toList());
  }

  Future<void> addDiscountCard(DiscountCard card) {
    return _db.collection('discountCards').add(card.toMap());
  }

  Future<void> updateDiscountCard(DiscountCard card) {
    return _db.collection('discountCards').doc(card.id).update(card.toMap());
  }

  Future<void> setDiscountCardActive(String id, bool active) {
    return _db.collection('discountCards').doc(id).update({'active': active});
  }

  Future<void> deleteDiscountCard(String id) => _db.collection('discountCards').doc(id).delete();

  /// Ищет только среди активных карт — деактивированную карту сотрудник
  /// применить не сможет, даже зная номер.
  Future<DiscountCard?> findCardByNumber(String number) async {
    final snap = await _db
        .collection('discountCards')
        .where('cardNumber', isEqualTo: number)
        .where('active', isEqualTo: true)
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return DiscountCard.fromDoc(snap.docs.first);
  }

  // ---------- СОТРУДНИКИ ----------
  Stream<List<Employee>> employeesStream() {
    return _db.collection('employees').snapshots().map(
        (snap) => snap.docs.map((d) => Employee.fromDoc(d)).toList());
  }

  Future<void> addEmployee(Employee e) => _db.collection('employees').add(e.toMap());

  Future<void> updateEmployee(Employee e) =>
      _db.collection('employees').doc(e.id).update(e.toMap());

  Future<void> deleteEmployee(String id) => _db.collection('employees').doc(id).delete();

  Future<Employee?> findByPin(String pin) async {
    final snap =
        await _db.collection('employees').where('pinCode', isEqualTo: pin).limit(1).get();
    if (snap.docs.isEmpty) return null;
    return Employee.fromDoc(snap.docs.first);
  }

  /// Проверка, что PIN ещё не занят другим сотрудником (excludeId — при
  /// редактировании существующего сотрудника, чтобы не конфликтовать с самим собой)
  Future<bool> isPinTaken(String pin, {String? excludeId}) async {
    final snap =
        await _db.collection('employees').where('pinCode', isEqualTo: pin).get();
    return snap.docs.any((d) => d.id != excludeId);
  }

  /// Удаляет стол, только если на нём сейчас нет открытых чеков — чтобы не
  /// потерять активный сеанс с заказом гостя.
  Future<void> deleteTableSafe(String tableId) async {
    final doc = await _db.collection('tables').doc(tableId).get();
    final data = doc.data();
    final ids = ((data?['activeSessionIds'] ?? []) as List);
    if (data != null && (data['status'] == 'occupied' || ids.isNotEmpty)) {
      throw TableOccupiedDeleteException();
    }
    await _db.collection('tables').doc(tableId).delete();
  }

  /// Удаляет категорию меню вместе со всеми её позициями (каскадно),
  /// чтобы не оставлять "осиротевшие" позиции без категории.
  Future<void> deleteCategoryCascade(String categoryId) async {
    final items = await _db
        .collection('menuItems')
        .where('categoryId', isEqualTo: categoryId)
        .get();
    final batch = _db.batch();
    for (final doc in items.docs) {
      batch.delete(doc.reference);
    }
    batch.delete(_db.collection('menuCategories').doc(categoryId));
    await batch.commit();
  }

  // ---------- СКЛАД (ОСТАТКИ) ----------
  // Склад — отдельный от меню справочник: позиции меню — это то, что
  // продаётся гостю, а позиции склада — это то, что физически лежит в
  // подсобке (граммы табака, литры сиропа, банки пива, угли и т.п.).
  // Список позиций полностью произвольный и настраивается админом.

  Stream<List<InventoryItem>> inventoryItemsStream() {
    return _db.collection('inventoryItems').snapshots().map(
        (snap) => snap.docs.map((d) => InventoryItem.fromDoc(d)).toList());
  }

  Stream<InventoryItem?> inventoryItemStream(String id) {
    return _db
        .collection('inventoryItems')
        .doc(id)
        .snapshots()
        .map((doc) => doc.exists ? InventoryItem.fromDoc(doc) : null);
  }

  Future<String> addInventoryItem(InventoryItem item) async {
    final ref = await _db.collection('inventoryItems').add(item.toMap());
    return ref.id;
  }

  /// Обновляет только карточку позиции (название, категория, единица,
  /// порог, заметка) — остаток через этот метод намеренно не меняется,
  /// чтобы правка описания никогда случайно не затёрла текущее количество.
  /// Для изменения остатка используйте [adjustInventoryQuantity].
  Future<void> updateInventoryItem(InventoryItem item) {
    final map = item.toMap()..remove('quantity');
    return _db.collection('inventoryItems').doc(item.id).update(map);
  }

  /// Включить/выключить отслеживание позиции — на усмотрение админа.
  /// Выключенная позиция остаётся в справочнике с историей и остатком, но
  /// пропадает из активного списка и из будущих инвентаризаций, пока её не
  /// включат обратно.
  Future<void> setInventoryItemActive(String id, bool active) {
    return _db.collection('inventoryItems').doc(id).update({'active': active});
  }

  Future<void> deleteInventoryItem(String id) =>
      _db.collection('inventoryItems').doc(id).delete();

  /// Ищет позицию склада по GTIN (штрихкод/код маркировки) — используется
  /// при сканировании на экране меню, чтобы найти, какую позицию добавить
  /// в чек. GTIN хранится в поле [InventoryItem.gtin], которое заполняется
  /// один раз при заведении позиции.
  Future<InventoryItem?> findInventoryItemByGtin(String gtin) async {
    final snap = await _db
        .collection('inventoryItems')
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
    final snap = await _db
        .collection('menuItems')
        .where('inventoryItemId', isEqualTo: inventoryItemId)
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return MenuItem.fromDoc(snap.docs.first);
  }

  /// Изменяет остаток позиции склада (приход/списание/ручная корректировка)
  /// и одновременно пишет строку в историю движений — остаток никогда не
  /// правится "молча". Обёрнуто в транзакцию: читает актуальный остаток
  /// прямо перед изменением, поэтому два одновременных изменения одной
  /// позиции (например, с двух устройств) складываются, а не затирают друг
  /// друга.
  Future<void> adjustInventoryQuantity({
    required String itemId,
    required String itemName,
    required InventoryUnit unit,
    required double delta,
    required String type, // receipt | writeoff | correction
    required String employeeName,
    String reason = '',
  }) async {
    final itemRef = _db.collection('inventoryItems').doc(itemId);
    final moveRef = _db.collection('inventoryMovements').doc();
    await _db.runTransaction((tx) async {
      final snap = await tx.get(itemRef);
      final current = (snap.data()?['quantity'] as num?)?.toDouble() ?? 0;
      final result = current + delta;
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
  }

  /// История движений конкретной позиции, от самого свежего к старому.
  Stream<List<InventoryMovement>> inventoryMovementsStream(String itemId, {int limit = 100}) {
    return _db
        .collection('inventoryMovements')
        .where('itemId', isEqualTo: itemId)
        .limit(limit)
        .snapshots()
        .map((snap) {
      final list = snap.docs.map((d) => InventoryMovement.fromDoc(d)).toList();
      list.sort((a, b) => b.createdAt.compareTo(a.createdAt));
      return list;
    });
  }

  // ---------- СКЛАД (ИНВЕНТАРИЗАЦИЯ) ----------
  // Инвентаризация — отдельный процесс сверки: фиксируем системный остаток
  // каждой активной позиции на момент старта, затем сотрудник вводит
  // фактически посчитанное количество, а по завершении расхождения разом
  // применяются к остаткам и попадают в историю движений с типом 'count'.

  /// Стрим текущей незавершённой инвентаризации, если она есть — чтобы при
  /// заходе на экран сразу продолжить, а не потерять уже введённые цифры.
  Stream<InventoryCount?> openInventoryCountStream() {
    return _db
        .collection('inventoryCounts')
        .where('status', isEqualTo: 'in_progress')
        .limit(1)
        .snapshots()
        .map((snap) => snap.docs.isEmpty ? null : InventoryCount.fromDoc(snap.docs.first));
  }

  Future<InventoryCount?> currentOpenInventoryCount() async {
    final snap = await _db
        .collection('inventoryCounts')
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
        await _db.collection('inventoryItems').where('active', isEqualTo: true).get();
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

    final ref = _db.collection('inventoryCounts').doc();
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
    return _db
        .collection('inventoryCounts')
        .doc(id)
        .snapshots()
        .map((doc) => doc.exists ? InventoryCount.fromDoc(doc) : null);
  }

  /// Записывает фактически посчитанное количество для одной позиции внутри
  /// текущей инвентаризации. countedQty == null стирает уже введённое
  /// значение (если сотрудник хочет пересчитать позицию заново).
  Future<void> setInventoryCountValue(String countId, String itemId, double? countedQty) async {
    final ref = _db.collection('inventoryCounts').doc(countId);
    await _db.runTransaction((tx) async {
      final doc = await tx.get(ref);
      final data = doc.data();
      if (data == null) return;
      final entries = ((data['entries'] ?? []) as List)
          .map((e) => InventoryCountEntry.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();
      final idx = entries.indexWhere((e) => e.itemId == itemId);
      if (idx < 0) return;
      entries[idx] = entries[idx].copyWith(countedQty: countedQty, clear: countedQty == null);
      tx.update(ref, {'entries': entries.map((e) => e.toMap()).toList()});
    });
  }

  /// Завершает инвентаризацию: по каждой посчитанной позиции остаток в
  /// справочнике склада приравнивается к фактически введённому количеству,
  /// а расхождение (если оно есть) фиксируется отдельным движением типа
  /// 'count' в истории — так же прозрачно, как приход или списание.
  /// Позиции, которые никто не успел посчитать, остаются без изменений.
  Future<void> completeInventoryCount(String countId, String employeeName) async {
    final ref = _db.collection('inventoryCounts').doc(countId);
    final doc = await ref.get();
    final data = doc.data();
    if (data == null) return;
    final entries = ((data['entries'] ?? []) as List)
        .map((e) => InventoryCountEntry.fromMap(Map<String, dynamic>.from(e as Map)))
        .toList();

    final now = DateTime.now();
    final batch = _db.batch();
    for (final entry in entries) {
      if (entry.countedQty == null) continue;
      final diff = entry.countedQty! - entry.expectedQty;
      final itemRef = _db.collection('inventoryItems').doc(entry.itemId);
      batch.update(itemRef, {
        'quantity': entry.countedQty,
        'updatedAt': Timestamp.fromDate(now),
      });
      if (diff.abs() <= 0.0001) continue;
      final moveRef = _db.collection('inventoryMovements').doc();
      batch.set(
        moveRef,
        InventoryMovement(
          id: moveRef.id,
          itemId: entry.itemId,
          itemName: entry.name,
          unit: entry.unit,
          type: 'count',
          delta: diff,
          resultingQty: entry.countedQty!,
          reason: 'Инвентаризация',
          employeeName: employeeName,
          createdAt: now,
        ).toMap(),
      );
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
    return _db.collection('inventoryCounts').doc(countId).update({
      'status': 'cancelled',
      'closedAt': Timestamp.fromDate(DateTime.now()),
      'closedBy': employeeName,
    });
  }

  /// Последние завершённые/отменённые инвентаризации — для истории.
  Future<List<InventoryCount>> recentInventoryCounts({int limit = 20}) async {
    final snap = await _db
        .collection('inventoryCounts')
        .orderBy('startedAt', descending: true)
        .limit(limit)
        .get();
    return snap.docs.map((d) => InventoryCount.fromDoc(d)).toList();
  }
}

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