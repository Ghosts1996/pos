import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/client_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../models/table_model.dart';
import '../utils/phone_utils.dart';

/// Мост между POS и клиентским приложением «Колибри Лаундж»:
/// профиль гостя, привязка к живому чеку, вызовы персонала, заказы из-за
/// стола, бонусы и отзывы. Оба приложения работают с одними коллекциями,
/// поэтому любое изменение прилетает второй стороне мгновенно.
class GuestLinkService {
  final _db = FirebaseFirestore.instance;

  CollectionReference<Map<String, dynamic>> get _clients => _db.collection('clients');
  CollectionReference<Map<String, dynamic>> get _calls => _db.collection('waiterCalls');
  CollectionReference<Map<String, dynamic>> get _orders => _db.collection('guestOrders');
  CollectionReference<Map<String, dynamic>> get _reviews => _db.collection('reviews');

  // ---------- ПРОФИЛЬ ГОСТЯ ----------

  Stream<ClientProfile?> profileStream(String uid) =>
      _clients.doc(uid).snapshots().map((d) => d.exists ? ClientProfile.fromDoc(d) : null);

  Future<ClientProfile> ensureProfile(String uid, {String name = '', String phone = ''}) async {
    final doc = await _clients.doc(uid).get();
    if (doc.exists) return ClientProfile.fromDoc(doc);
    final normPhone = phone.isNotEmpty ? normalizePhone(phone) : '';
    final profile = ClientProfile(uid: uid, name: name, phone: normPhone, createdAt: DateTime.now());
    await _clients.doc(uid).set(profile.toMap());
    return profile;
  }

  Future<void> updateProfile(String uid, Map<String, dynamic> patch) {
    // Нормализуем телефон если он есть в patch
    if (patch.containsKey('phone') && patch['phone'] is String) {
      final raw = patch['phone'] as String;
      if (raw.isNotEmpty) {
        patch = Map<String, dynamic>.from(patch);
        patch['phone'] = normalizePhone(raw);
      }
    }
    return _clients.doc(uid).set(patch, SetOptions(merge: true));
  }

  Future<void> toggleFavorite(String uid, String menuItemId, bool favorite) =>
      _clients.doc(uid).set({
        'favoriteItemIds':
            favorite ? FieldValue.arrayUnion([menuItemId]) : FieldValue.arrayRemove([menuItemId]),
      }, SetOptions(merge: true));

  /// Ищет профиль по номеру телефона в любом формате.
  /// Нормализует запрос, поэтому 79995061580, +79995061580 и 89995061580
  /// дают одинаковый результат.
  Future<ClientProfile?> findByPhone(String phone) async {
    final normalized = normalizePhone(phone);
    final snap = await _clients.where('phone', isEqualTo: normalized).limit(1).get();
    if (snap.docs.isEmpty) return null;
    return ClientProfile.fromDoc(snap.docs.first);
  }

  /// Найти профиль по короткому ID устройства (6 символов).
  Future<ClientProfile?> findByShortDeviceId(String shortId) async {
    final snap = await _clients
        .where('shortDeviceId', isEqualTo: shortId.toUpperCase())
        .limit(1)
        .get();
    if (snap.docs.isEmpty) return null;
    return ClientProfile.fromDoc(snap.docs.first);
  }

  /// Объединение гостя, пришедшего с НОВОГО устройства, с его же старым
  /// профилем (найденным по номеру телефона).
  ///
  /// [newDeviceInput] — либо короткий ID устройства (6 символов, напр. UXVA4J),
  /// либо полный Firebase UID. Метод сам разбирается что это такое.
  Future<void> mergeGuestProfiles({
    required String phone,
    required String newDeviceInput,
  }) async {
    final normalized = normalizePhone(phone);
    final old = await findByPhone(normalized);
    if (old == null) {
      throw StateError('Гость с номером $normalized не найден');
    }

    // Определяем реальный uid нового устройства:
    // если ввод короткий (≤10 символов) — ищем по shortDeviceId,
    // иначе считаем что это Firebase UID напрямую.
    String newUid;
    if (newDeviceInput.length <= 10) {
      final byShort = await findByShortDeviceId(newDeviceInput);
      if (byShort == null) {
        throw StateError(
          'Устройство с ID $newDeviceInput не найдено — '
          'попросите гостя открыть приложение и профиль ещё раз',
        );
      }
      newUid = byShort.uid;
    } else {
      newUid = newDeviceInput;
    }

    if (old.uid == newUid) {
      throw StateError('Это уже тот же самый профиль');
    }
    final newRef = _clients.doc(newUid);
    final oldRef = _clients.doc(old.uid);

    await _db.runTransaction((tx) async {
      final newSnap = await tx.get(newRef);
      if (!newSnap.exists) {
        throw StateError('Устройство с ID $newUid не найдено — попросите гостя '
            'открыть приложение и профиль ещё раз');
      }
      final newData = newSnap.data() as Map<String, dynamic>;
      final newBonus = (newData['bonusBalance'] ?? 0).toDouble();
      final newSpent = (newData['totalSpent'] ?? 0).toDouble();
      final newVisits = (newData['visits'] as num?)?.toInt() ?? 0;
      final newName = (newData['name'] as String?) ?? '';

      tx.set(newRef, {
        'phone': normalized,
        'name': newName.isNotEmpty ? newName : old.name,
        'bonusBalance': old.bonusBalance + newBonus,
        'totalSpent': old.totalSpent + newSpent,
        'visits': old.visits + newVisits,
        if (old.discountCardId.isNotEmpty) 'discountCardId': old.discountCardId,
        if (old.discountPercent > 0) 'discountPercent': old.discountPercent,
      }, SetOptions(merge: true));
    });

    // Переносим историю бонусных операций на новый uid — гость увидит её
    // в «Истории бонусов» уже на текущем устройстве.
    final ops = await _db.collection('bonusOperations').where('clientUid', isEqualTo: old.uid).get();
    final batch = _db.batch();
    for (final d in ops.docs) {
      batch.update(d.reference, {'clientUid': newUid});
    }
    batch.delete(oldRef);
    await batch.commit();
  }

  /// Все гости для админского экрана «Гости»: имя, телефон, уровень
  /// лояльности, визиты, траты — сортировка по тратам. Фильтрация по
  /// имени/телефону — на клиенте: гостей обычно не тысячи, а Firestore не
  /// умеет полнотекстовый поиск без отдельного индекса-сервиса.
  Stream<List<ClientProfile>> allClientsStream() => _clients
      .orderBy('totalSpent', descending: true)
      .snapshots()
      .map((s) => s.docs.map(ClientProfile.fromDoc).toList());

  /// Найти гостя по открытому чеку — нужно кассиру при оплате
  /// (бонусы, сертификаты, чаевые).
  Future<ClientProfile?> findBySession(String sessionId) async {
    final snap = await _clients.where('activeSessionId', isEqualTo: sessionId).limit(1).get();
    return snap.docs.isEmpty ? null : ClientProfile.fromDoc(snap.docs.first);
  }

  // ---------- ПРИВЯЗКА ГОСТЯ К ЧЕКУ ----------

  /// Гость сканирует QR стола (в QR зашит tableId) и «садится» за свой счёт.
  /// Если за столом открыто несколько чеков — берём последний открытый.
  /// Возвращает id чека или null, если стол свободен.
  Future<String?> bindToTable(String uid, String tableId) async {
    final tableDoc = await _db.collection('tables').doc(tableId).get();
    if (!tableDoc.exists) return null;
    final table = TableModel.fromDoc(tableDoc);
    if (table.activeSessionIds.isEmpty) return null;

    final sessionId = table.activeSessionIds.last;
    await _clients.doc(uid).set({
      'activeSessionId': sessionId,
      'activeTableId': tableId,
      'lastVisitAt': Timestamp.fromDate(DateTime.now()),
    }, SetOptions(merge: true));

    // Подписываем чек именем гостя, если подпись пуста — кальянщик сразу
    // видит, кто за столом.
    final client = await _clients.doc(uid).get();
    final name = (client.data()?['name'] as String?) ?? '';
    if (name.isNotEmpty) {
      final sessionRef = _db.collection('sessions').doc(sessionId);
      final s = await sessionRef.get();
      if (((s.data()?['guestTag'] as String?) ?? '').isEmpty) {
        await sessionRef.update({'guestTag': name});
      }
    }
    return sessionId;
  }

  Future<void> unbind(String uid) => _clients.doc(uid).set({
        'activeSessionId': '',
        'activeTableId': '',
      }, SetOptions(merge: true));

  // ---------- ЛИМИТ ИИ-КОНСЬЕРЖА ----------

  /// Каждый вызов ИИ-консьержа/сомелье стоит денег на шлюзе, поэтому доступ
  /// ограничен: гость должен указать телефон (иначе анонимный аккаунт можно
  /// плодить бесконечно) и физически сидеть за столом (отсканировал QR —
  /// activeSessionId не пуст), и не больше [dailyLimit] вопросов в день.
  /// Счётчик и дата лежат прямо в профиле гостя и атомарно проверяются и
  /// увеличиваются транзакцией — параллельные быстрые тапы не дадут пробить
  /// лимит гонкой запросов.
  Future<AiQuotaResult> consumeAiQuota(String uid, {int dailyLimit = 10}) {
    final ref = _clients.doc(uid);
    return _db.runTransaction<AiQuotaResult>((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) {
        return const AiQuotaResult(false, 'Сначала откройте профиль в приложении.');
      }
      final data = snap.data()!;
      final phone = ((data['phone'] as String?) ?? '').trim();
      if (phone.isEmpty) {
        return const AiQuotaResult(
            false, 'Укажите номер телефона в профиле — так доступен ИИ-консьерж.');
      }
      final activeSessionId = (data['activeSessionId'] as String?) ?? '';
      if (activeSessionId.isEmpty) {
        return const AiQuotaResult(
            false, 'ИИ-консьерж доступен только за столом — отсканируйте QR-код на столе.');
      }

      final today = _dayKey(DateTime.now());
      final storedDay = (data['aiQuotaDate'] as String?) ?? '';
      final used = storedDay == today ? ((data['aiQuotaCount'] as num?)?.toInt() ?? 0) : 0;

      if (used >= dailyLimit) {
        return AiQuotaResult(false,
            'На сегодня лимит в $dailyLimit вопросов консьержу исчерпан — обратитесь к кальянщику.');
      }

      tx.set(ref, {'aiQuotaDate': today, 'aiQuotaCount': used + 1}, SetOptions(merge: true));
      return const AiQuotaResult(true);
    });
  }

  String _dayKey(DateTime d) => '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  /// Живой счёт гостя: сумма, позиции, таймер стола — тот же документ,
  /// который правит кассир на POS.
  Stream<SessionModel?> sessionStream(String sessionId) => _db
      .collection('sessions')
      .doc(sessionId)
      .snapshots()
      .map((d) => d.exists ? SessionModel.fromDoc(d) : null);

  // ---------- ВЫЗОВ ПЕРСОНАЛА ----------

  Future<String> callStaff({
    required String tableId,
    required String tableName,
    required GuestCallType type,
    String sessionId = '',
    String clientUid = '',
    String guestName = '',
    String comment = '',
  }) async {
    final call = WaiterCall(
      id: '',
      tableId: tableId,
      tableName: tableName,
      sessionId: sessionId,
      clientUid: clientUid,
      guestName: guestName,
      type: type,
      comment: comment,
      createdAt: DateTime.now(),
    );
    final ref = await _calls.add(call.toMap());
    return ref.id;
  }

  /// Все открытые вызовы — баннер и подсветка столов на POS.
  Stream<List<WaiterCall>> openCallsStream() => _calls
      .where('status', isEqualTo: 'new')
      .snapshots()
      .map((s) => s.docs.map(WaiterCall.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt)));

  /// Вызовы конкретного гостя — для его же экрана «Мой стол».
  Stream<List<WaiterCall>> myCallsStream(String clientUid) => _calls
      .where('clientUid', isEqualTo: clientUid)
      .where('status', isEqualTo: 'new')
      .snapshots()
      .map((s) => s.docs.map(WaiterCall.fromDoc).toList());

  Future<void> closeCall(String callId, String employeeName) => _calls.doc(callId).update({
        'status': 'done',
        'doneAt': Timestamp.fromDate(DateTime.now()),
        'doneBy': employeeName,
      });

  // ---------- ЗАКАЗ ИЗ-ЗА СТОЛА ----------

  Future<String> placeGuestOrder({
    required String sessionId,
    required String tableId,
    required String tableName,
    required List<OrderItem> items,
    String clientUid = '',
    String guestName = '',
    String comment = '',
  }) async {
    final order = GuestOrder(
      id: '',
      sessionId: sessionId,
      tableId: tableId,
      tableName: tableName,
      clientUid: clientUid,
      guestName: guestName,
      items: items,
      comment: comment,
      createdAt: DateTime.now(),
    );
    final ref = await _orders.add(order.toMap());
    return ref.id;
  }

  /// Заказы, требующие внимания персонала: новые и те, что уже готовятся.
  Stream<List<GuestOrder>> openGuestOrdersStream() => _orders
      .where('status', whereIn: ['new', 'preparing'])
      .snapshots()
      .map((s) => s.docs.map(GuestOrder.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt)));

  Stream<List<GuestOrder>> clientOrdersStream(String clientUid) => _orders
      .where('clientUid', isEqualTo: clientUid)
      .orderBy('createdAt', descending: true)
      .limit(20)
      .snapshots()
      .map((s) => s.docs.map(GuestOrder.fromDoc).toList());

  Future<void> acceptGuestOrder(GuestOrder order, String employeeName) async {
    final sessionRef = _db.collection('sessions').doc(order.sessionId);
    final orderRef = _orders.doc(order.id);

    await _db.runTransaction((tx) async {
      final snap = await tx.get(sessionRef);
      if (!snap.exists) throw StateError('Чек уже закрыт — заказ нельзя добавить.');

      final data = snap.data() as Map<String, dynamic>;
      final current = ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();

      for (final incoming in order.items) {
        final idx = current.indexWhere((i) => i.menuItemId == incoming.menuItemId);
        if (idx >= 0) {
          current[idx] = current[idx].copyWith(qty: current[idx].qty + incoming.qty);
        } else {
          current.add(incoming);
        }
      }

      tx.update(sessionRef, {'orderItems': current.map((e) => e.toMap()).toList()});
      tx.update(orderRef, {
        'status': 'preparing',
        'handledAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': employeeName,
      });
    });
  }

  Future<void> markOrderReady(GuestOrder order, String employeeName) async {
    await _orders.doc(order.id).update({
      'status': 'ready',
      'readyAt': Timestamp.fromDate(DateTime.now()),
      'handledBy': employeeName,
    });

    if (order.clientUid.isEmpty) return;
    final client = await _clients.doc(order.clientUid).get();
    final token = client.data()?['pushToken'] as String?;
    if (token == null || token.isEmpty) return;

    await _db.collection('pushQueue').add({
      'token': token,
      'title': 'Заказ готов',
      'body': order.items.map((i) => i.name).join(', '),
      'status': 'new',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  Future<void> rejectGuestOrder(String orderId, String employeeName, String reason) =>
      _orders.doc(orderId).update({
        'status': 'rejected',
        'rejectReason': reason,
        'handledAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': employeeName,
      });

  // ---------- БОНУСЫ ----------

  Future<void> accrueBonuses({
    required String clientUid,
    required String sessionId,
    required double paidAmount,
  }) async {
    if (clientUid.isEmpty || paidAmount <= 0) return;
    final ref = _clients.doc(clientUid);
    var bonus = 0.0;

    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) return;

      final data = snap.data() as Map<String, dynamic>;
      if (data['bonusAccruedFor'] == sessionId) return;

      final profile = ClientProfile.fromDoc(snap);
      bonus = (paidAmount * profile.cashbackPercent / 100).roundToDouble();

      tx.update(ref, {
        'bonusBalance': profile.bonusBalance + bonus,
        'totalSpent': profile.totalSpent + paidAmount,
        'visits': profile.visits + 1,
        'bonusAccruedFor': sessionId,
        'activeSessionId': '',
        'activeTableId': '',
        'lastVisitAt': Timestamp.fromDate(DateTime.now()),
      });
    });

    if (bonus <= 0) return;
    await _db.collection('bonusOperations').add({
      'clientUid': clientUid,
      'sessionId': sessionId,
      'type': 'accrual',
      'amount': paidAmount,
      'bonus': bonus,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  Future<double> redeemBonuses({
    required String clientUid,
    required String sessionId,
    required double requested,
  }) async {
    final ref = _clients.doc(clientUid);
    double applied = 0;

    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) return;
      final balance = (snap.data()?['bonusBalance'] ?? 0).toDouble();
      applied = requested > balance ? balance : requested;
      if (applied <= 0) return;
      tx.update(ref, {'bonusBalance': balance - applied});
    });

    if (applied > 0) {
      await _db.collection('bonusOperations').add({
        'clientUid': clientUid,
        'sessionId': sessionId,
        'type': 'redeem',
        'amount': applied,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    }
    return applied;
  }

  // ---------- ОТЗЫВЫ ----------

  Future<void> addReview(GuestReview review) => _reviews.add(review.toMap());

  Stream<List<GuestReview>> recentReviewsStream({int limit = 50}) => _reviews
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots()
      .map((s) => s.docs.map(GuestReview.fromDoc).toList());

  // ---------- МЕНЮ ДЛЯ ГОСТЯ ----------

  Stream<List<MenuItem>> publicMenuStream() => _db
      .collection('menuItems')
      .snapshots()
      .map((s) => s.docs.map(MenuItem.fromDoc).where((i) => i.available).toList());

  Stream<List<MenuCategory>> publicCategoriesStream() => _db
      .collection('menuCategories')
      .orderBy('order')
      .snapshots()
      .map((s) => s.docs.map(MenuCategory.fromDoc).toList());
}

/// Результат проверки лимита ИИ-консьержа.
class AiQuotaResult {
  final bool allowed;
  final String? reason;
  const AiQuotaResult(this.allowed, [this.reason]);
}
