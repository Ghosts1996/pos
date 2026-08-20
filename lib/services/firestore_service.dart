import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:uuid/uuid.dart';
import '../models/table_model.dart';
import '../models/session_model.dart';
import '../models/menu_models.dart';
import '../models/discount_card.dart';
import '../models/employee.dart';
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

  String newTableId() => _uuid.v4();

  // ---------- СЕССИИ (СЧЕТА) ----------
  Stream<SessionModel?> sessionStream(String sessionId) {
    return _db.collection('sessions').doc(sessionId).snapshots().map(
        (doc) => doc.exists ? SessionModel.fromDoc(doc) : null);
  }

  /// Открыть новый сеанс за столом (Старт / Перезабивка после закрытия).
  /// Обёрнуто в транзакцию: если два сотрудника одновременно нажмут "Начать"
  /// на разных телефонах, только один действительно создаст сеанс — второй
  /// получит ошибку TableAlreadyOccupiedException вместо дублирующего счёта.
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
      if (data != null && data['status'] == 'occupied' && data['currentSessionId'] != null) {
        throw TableAlreadyOccupiedException();
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
      tx.update(tableRef, {'status': 'occupied', 'currentSessionId': sessionRef.id});
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

  /// Закрыть стол (без кассы — просто фиксируем закрытие счёта). После
  /// закрытия сеанс становится доступен для отчётов и, согласно
  /// firestore.rules, больше не может быть изменён или удалён.
  Future<void> closeSession(String sessionId, String tableId) async {
    await _db.collection('sessions').doc(sessionId).update({
      'status': 'closed',
      'closedAt': Timestamp.fromDate(DateTime.now()),
    });
    await _db.collection('tables').doc(tableId).update({
      'status': 'free',
      'currentSessionId': null,
    });
  }

  /// Закрытые сеансы за период [start; end) — источник данных для отчётов.
  /// Специально фильтруется только по диапазону closedAt (у активных
  /// сеансов это поле всегда null и они никогда сюда не попадают), поэтому
  /// запросу достаточно автоматического одиночного индекса Firestore — не
  /// нужно вручную создавать составной индекс в консоли.
  Future<List<SessionModel>> closedSessionsInRange(DateTime start, DateTime end) async {
    final snap = await _db
        .collection('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(start))
        .where('closedAt', isLessThan: Timestamp.fromDate(end))
        .orderBy('closedAt', descending: true)
        .get();
    return snap.docs.map((d) => SessionModel.fromDoc(d)).toList();
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

  /// Новая категория всегда встаёт в конец списка — порядок вычисляется
  /// автоматически по текущему количеству категорий.
  Future<void> addCategory(String name) async {
    final snap = await _db.collection('menuCategories').get();
    await _db.collection('menuCategories').add({'name': name, 'order': snap.docs.length});
  }

  Future<void> renameCategory(String id, String name) {
    return _db.collection('menuCategories').doc(id).update({'name': name});
  }

  Future<void> deleteCategory(String id) => _db.collection('menuCategories').doc(id).delete();

  Future<void> addMenuItem(MenuItem item) {
    return _db.collection('menuItems').add(item.toMap());
  }

  Future<void> updateMenuItem(MenuItem item) {
    return _db.collection('menuItems').doc(item.id).update(item.toMap());
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

  /// Удаляет стол, только если он сейчас свободен — чтобы не потерять
  /// активный сеанс с заказом гостя.
  Future<void> deleteTableSafe(String tableId) async {
    final doc = await _db.collection('tables').doc(tableId).get();
    final data = doc.data();
    if (data != null && data['status'] == 'occupied') {
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
}

class TableAlreadyOccupiedException implements Exception {
  @override
  String toString() => 'Стол уже занят — сеанс уже открыт на другом устройстве';
}

class TableOccupiedDeleteException implements Exception {
  @override
  String toString() => 'Нельзя удалить стол с активным сеансом — сначала закройте счёт';
}
