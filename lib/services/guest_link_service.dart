import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/client_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../models/table_model.dart';
import '../utils/phone_utils.dart';
import 'push_service.dart';

/// Мост между POS и клиентским приложением «Colibri Lounge»:
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

  Future<void> updateProfile(String uid, Map<String, dynamic> patch) async {
    // Нормализуем телефон если он есть в patch
    if (patch.containsKey('phone') && patch['phone'] is String) {
      final raw = patch['phone'] as String;
      if (raw.isNotEmpty) {
        patch = Map<String, dynamic>.from(patch);
        final normalized = normalizePhone(raw);
        patch['phone'] = normalized;
        await _syncPhoneIndex(uid, normalized);
      }
    }
    await _clients.doc(uid).set(patch, SetOptions(merge: true));
  }

  /// Обезличенный указатель «номер → uid», по которому можно узнать, занят
  /// ли телефон, не читая чужой профиль.
  ///
  /// Зачем он нужен. Гость по firestore.rules может прочитать ТОЛЬКО свой
  /// документ в clients — запрос по всей коллекции (`where('phone', ...)`)
  /// правила отклоняют, потому что не могут доказать, что все результаты
  /// разрешены. Из-за этого проверка «номер уже занят» в профиле падала с
  /// permission-denied, и сохранение телефона зависало навсегда. Здесь
  /// лежит только пара «номер → uid»: ни имени, ни бонусов, ни трат.
  CollectionReference<Map<String, dynamic>> get _phoneIndex =>
      _db.collection('phoneIndex');

  /// Занят ли номер ДРУГИМ профилем. Это чтение одного документа по id, а
  /// не запрос по коллекции, поэтому работает и у гостя.
  Future<bool> isPhoneTakenByOther(String phone, String uid) async {
    final normalized = normalizePhone(phone);
    if (normalized.isEmpty) return false;
    final doc = await _phoneIndex.doc(normalized).get();
    if (!doc.exists) return false;
    final owner = (doc.data()?['uid'] as String?) ?? '';
    return owner.isNotEmpty && owner != uid;
  }

  /// Закрепляет номер за гостем и освобождает его прежний номер.
  /// Ошибки не пробрасывает: указатель вторичен, сам профиль важнее.
  Future<void> _syncPhoneIndex(String uid, String normalized) async {
    try {
      final prev = (await _clients.doc(uid).get()).data()?['phone'] as String?;
      if (prev != null && prev.isNotEmpty && prev != normalized) {
        // Освободить прежний номер может только касса — у гостя номер и так
        // меняется лишь через администратора.
        await _phoneIndex.doc(prev).delete();
      }
    } catch (_) {
      // Нет прав на удаление — не страшно, лишняя запись никому не мешает.
    }
    try {
      await _phoneIndex.doc(normalized).set({'uid': uid});
    } catch (_) {}
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
      final newData = newSnap.data()!;
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
    //
    // Пишем ЧАНКАМИ: в один батч Firestore принимает максимум 500 операций,
    // а у постоянного гостя за пару лет операций бывает и больше — такой
    // батч отклонялся целиком, и объединение профилей падало с ошибкой,
    // уже успев слить балансы транзакцией выше.
    final ops = await _db.collection('bonusOperations').where('clientUid', isEqualTo: old.uid).get();
    const chunkSize = 400;
    for (var i = 0; i < ops.docs.length; i += chunkSize) {
      final batch = _db.batch();
      for (final d in ops.docs.skip(i).take(chunkSize)) {
        batch.update(d.reference, {'clientUid': newUid});
      }
      await batch.commit();
    }

    // Переносим и историю визитов. Она лежит подколлекцией внутри профиля,
    // а Firestore при удалении документа подколлекции НЕ удаляет — без
    // этого переноса визиты остались бы висеть под уже удалённым профилем,
    // и гость, объединивший устройства, увидел бы пустую историю при
    // сохранившейся сумме трат.
    final visits = await oldRef.collection('visits').get();
    for (var i = 0; i < visits.docs.length; i += chunkSize) {
      final batch = _db.batch();
      for (final d in visits.docs.skip(i).take(chunkSize)) {
        batch.set(newRef.collection('visits').doc(d.id), d.data());
        batch.delete(d.reference);
      }
      await batch.commit();
    }

    // Указатель «номер → uid» переводим на выживший профиль, иначе номер
    // остался бы закреплён за удалённым.
    if (normalized.isNotEmpty) {
      try {
        await _phoneIndex.doc(normalized).set({'uid': newUid});
      } catch (_) {}
    }

    await oldRef.delete();
  }

  /// Разовая достройка указателей phoneIndex и referralCodes для гостей,
  /// заведённых до их появления. Без неё номер старого гостя не считался
  /// занятым, и второе устройство могло увести его себе.
  ///
  /// Запускается с кассы при входе сотрудника: читать всех гостей может
  /// только персонал. Отметка о выполнении лежит в jobRuns, поэтому проход
  /// по базе делается один раз, а не на каждый вход.
  Future<void> backfillGuestIndexes() async {
    final marker = _db.collection('jobRuns').doc('guestIndexBackfill');
    try {
      if ((await marker.get()).exists) return;

      final clients = await _clients.get();
      for (final doc in clients.docs) {
        final data = doc.data();
        final phone = (data['phone'] as String?) ?? '';
        final code = (data['referralCode'] as String?) ?? '';
        if (phone.isNotEmpty) {
          await _phoneIndex.doc(normalizePhone(phone)).set({'uid': doc.id});
        }
        if (code.isNotEmpty) {
          await _db.collection('referralCodes').doc(code).set({'uid': doc.id});
        }
      }
      await marker.set({'lastRunAt': Timestamp.fromDate(DateTime.now())});
    } catch (_) {
      // Нет прав или сети — попробуем при следующем входе.
    }
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
  ///
  /// Если за столом открыт ОДИН чек — привязываемся сразу. Если несколько
  /// (стол поддерживает раздельные счета, см. TableModel.maxOpenSessions) —
  /// возвращаем список чеков, чтобы гость выбрал свой: раньше молча брался
  /// последний открытый, и двое гостей за одним столом видели один и тот же
  /// чужой счёт вместо каждый своего.
  Future<TableBindResult> bindToTable(String uid, String tableId) async {
    final tableDoc = await _db.collection('tables').doc(tableId).get();
    if (!tableDoc.exists) return const TableBindResult.empty();
    final table = TableModel.fromDoc(tableDoc);
    if (table.activeSessionIds.isEmpty) return const TableBindResult.empty();

    // Витрина чеков живёт на карточке стола: читать sessions гостю нельзя.
    final checks = table.openChecks.where((c) => c.id.isNotEmpty).toList();
    if (checks.length > 1) {
      return TableBindResult.choose(await _markTakenChecks(checks, uid), table.name);
    }

    // Витрина могла ещё не построиться (старые данные) — тогда работаем по
    // activeSessionIds, как раньше.
    final sessionId =
        checks.length == 1 ? checks.first.id : table.activeSessionIds.last;
    if (table.activeSessionIds.length > 1 && checks.isEmpty) {
      return TableBindResult.choose(
        table.activeSessionIds
            .map((id) => TableCheck(id: id, label: ''))
            .toList(),
        table.name,
      );
    }
    await bindToSession(uid, tableId, sessionId);
    return TableBindResult.bound(sessionId);
  }

  /// Кто занял чек: sessionClaims/{sessionId} → {uid}.
  ///
  /// Нужен, чтобы один и тот же счёт не открылся сразу на двух телефонах.
  /// Проверить это через коллекцию clients нельзя — запрос по ней гостю
  /// запрещён правилами, поэтому занятость лежит отдельным документом,
  /// который гость может прочитать по id.
  CollectionReference<Map<String, dynamic>> get _sessionClaims =>
      _db.collection('sessionClaims');

  /// Занят ли чек другим гостем.
  Future<bool> isSessionTakenByOther(String sessionId, String uid) async {
    try {
      final doc = await _sessionClaims.doc(sessionId).get();
      if (!doc.exists) return false;
      final owner = (doc.data()?['uid'] as String?) ?? '';
      return owner.isNotEmpty && owner != uid;
    } catch (_) {
      // Не смогли проверить — не мешаем гостю сесть за стол.
      return false;
    }
  }

  /// Проставляет каждому чеку признак «уже занят другим гостем», чтобы в
  /// списке выбора такие счета были видны, но недоступны.
  Future<List<TableCheck>> _markTakenChecks(
      List<TableCheck> checks, String uid) async {
    final result = <TableCheck>[];
    for (final c in checks) {
      result.add(c.copyWith(taken: await isSessionTakenByOther(c.id, uid)));
    }
    return result;
  }

  /// Привязать гостя к конкретному чеку стола — используется после выбора
  /// из нескольких открытых счетов.
  ///
  /// Чек закрепляется за гостем: повторно открыть его на другом телефоне
  /// или под другим профилем уже нельзя. Раньше этого не было — двое
  /// гостей, отсканировав один QR, садились на один и тот же счёт и оба
  /// им распоряжались.
  ///
  /// Бросает [SessionTakenException], если чек занят кем-то другим.
  Future<void> bindToSession(String uid, String tableId, String sessionId) async {
    if (await isSessionTakenByOther(sessionId, uid)) {
      throw SessionTakenException();
    }
    try {
      // Документ создаётся только если его ещё нет, поэтому при одновременном
      // сканировании с двух телефонов выигрывает ровно один: второму правила
      // откажут в записи.
      await _sessionClaims.doc(sessionId).set({'uid': uid});
    } on FirebaseException catch (e) {
      if (e.code == 'permission-denied') throw SessionTakenException();
      rethrow;
    }

    await _clients.doc(uid).set({
      'activeSessionId': sessionId,
      'activeTableId': tableId,
      'lastVisitAt': Timestamp.fromDate(DateTime.now()),
    }, SetOptions(merge: true));

    // Подписываем чек именем гостя, если подпись пуста — кальянщик сразу
    // видит, кто за столом.
    //
    // ВАЖНО: этот шаг — «по возможности». Писать в sessions по правилам
    // может только POS, а метод вызывается и из гостевого приложения (гость
    // сканирует QR стола). Раньше permission-denied отсюда улетал наружу, и
    // гость видел «Не удалось открыть стол», хотя привязка выше уже
    // прошла успешно и счёт был доступен. Подпись чека — украшение, ронять
    // из-за неё посадку за стол нельзя.
    try {
      final client = await _clients.doc(uid).get();
      final name = (client.data()?['name'] as String?) ?? '';
      if (name.isNotEmpty) {
        final sessionRef = _db.collection('sessions').doc(sessionId);
        final s = await sessionRef.get();
        if (((s.data()?['guestTag'] as String?) ?? '').isEmpty) {
          await sessionRef.update({'guestTag': name});
        }
      }
    } catch (_) {
      // Нет прав/сети — гость всё равно уже за столом.
    }
  }

  /// Гость уходит от стола («Это не мой стол») — освобождаем чек, чтобы им
  /// мог воспользоваться тот, чей он на самом деле.
  Future<void> unbind(String uid) async {
    try {
      final current =
          (await _clients.doc(uid).get()).data()?['activeSessionId'] as String?;
      if (current != null && current.isNotEmpty) {
        await _sessionClaims.doc(current).delete();
      }
    } catch (_) {
      // Не удалось освободить — чек всё равно закроется вместе с визитом.
    }
    await _clients.doc(uid).set({
      'activeSessionId': '',
      'activeTableId': '',
    }, SetOptions(merge: true));
  }

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

    // Очередь разбирает Cloud Function, которой нет на бесплатном тарифе —
    // PushService сам решает, писать туда или нет. Без функций гость всё
    // равно узнает о готовности: его приложение слушает свои заказы и
    // показывает локальное уведомление (KolibriNotifications).
    await PushService.instance.enqueue(
      token: token,
      clientUid: order.clientUid,
      title: 'Заказ готов',
      body: order.items.map((i) => i.name).join(', '),
    );
  }

  Future<void> rejectGuestOrder(String orderId, String employeeName, String reason) =>
      _orders.doc(orderId).update({
        'status': 'rejected',
        'rejectReason': reason,
        'handledAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': employeeName,
      });

  // ---------- БОНУСЫ ----------

  /// Засчитывает визит гостю: кешбэк, счётчик визитов, сумма трат и запись
  /// в вечную историю визитов.
  ///
  /// Два разных числа — и их нельзя путать:
  ///  • [paidAmount] — сколько получено ЖИВЫМИ деньгами (наличные, карта,
  ///    терминал). С них и только с них считается кешбэк: если начислять
  ///    бонусы ещё и на сумму, оплаченную бонусами, программа лояльности
  ///    начинает подпитывать сама себя.
  ///  • [billTotal] — полная сумма чека со скидкой. Именно она копится в
  ///    totalSpent и двигает уровень: гость «наел» на эти деньги, чем бы он
  ///    их ни закрыл. Раньше в totalSpent падала оплата живыми деньгами, и
  ///    гость, расплатившийся бонусами, продвигался к Золоту медленнее, чем
  ///    тот, кто бонусами не пользуется, — программа наказывала за то, ради
  ///    чего сама и существует.
  ///
  /// Идемпотентно: повторный вызов с тем же чеком ничего не начислит
  /// (отметка bonusAccruedFor) и не задвоит запись визита (id визита —
  /// это id чека).
  Future<void> accrueBonuses({
    required String clientUid,
    required String sessionId,
    required double paidAmount,
    double billTotal = 0,
    String tableName = '',
    double bonusSpent = 0,
    List<OrderItem> items = const [],
  }) async {
    if (clientUid.isEmpty) return;
    final spent = billTotal > 0 ? billTotal : paidAmount;
    if (spent <= 0 && paidAmount <= 0) return;

    final ref = _clients.doc(clientUid);
    var bonus = 0.0;
    var counted = false;

    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) return;

      final data = snap.data()!;
      if (data['bonusAccruedFor'] == sessionId) return;

      final profile = ClientProfile.fromDoc(snap);
      bonus = (paidAmount * profile.cashbackPercent / 100).roundToDouble();
      counted = true;

      tx.update(ref, {
        'bonusBalance': profile.bonusBalance + bonus,
        'totalSpent': profile.totalSpent + spent,
        'visits': profile.visits + 1,
        'bonusAccruedFor': sessionId,
        'activeSessionId': '',
        'activeTableId': '',
        'lastVisitAt': Timestamp.fromDate(DateTime.now()),
      });
    });

    if (!counted) return; // этот чек уже засчитан раньше

    // Вечная история визитов гостя. Живёт отдельным документом, потому что
    // сами чеки (коллекция sessions) гостю читать нельзя — там чужие счета.
    // Id документа — id чека, поэтому повторная запись просто перезапишет
    // ту же строку, а не создаст дубль.
    await _clients.doc(clientUid).collection('visits').doc(sessionId).set({
      'date': Timestamp.fromDate(DateTime.now()),
      'tableName': tableName,
      'total': spent,
      'paid': paidAmount,
      'bonusEarned': bonus,
      'bonusSpent': bonusSpent,
      'items': items
          .map((i) => {'name': i.name, 'qty': i.qty, 'price': i.price})
          .toList(),
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

  /// Вечная история визитов гостя, от самого свежего. Источник — та самая
  /// подколлекция, что пишется при закрытии чека.
  Stream<List<GuestVisit>> visitsStream(String uid, {int limit = 100}) => _clients
      .doc(uid)
      .collection('visits')
      .orderBy('date', descending: true)
      .limit(limit)
      .snapshots()
      .map((s) => s.docs.map(GuestVisit.fromDoc).toList());

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

  /// Вернуть гостю бонусы, списанные на экране оплаты, если оплата так и
  /// не была проведена (кассир вышел с экрана, оплату отменили).
  ///
  /// Без этого возврата получалась прямая потеря денег гостя: нажатие
  /// «Списать» уменьшало баланс сразу, а выход с экрана оплаты оставлял
  /// чек открытым — при следующем открытии экрана сумма к оплате была уже
  /// полной, и бонусы просто исчезали.
  Future<void> refundBonuses({
    required String clientUid,
    required String sessionId,
    required double amount,
  }) async {
    if (clientUid.isEmpty || amount <= 0) return;
    await _clients.doc(clientUid).set(
      {'bonusBalance': FieldValue.increment(amount)},
      SetOptions(merge: true),
    );
    await _db.collection('bonusOperations').add({
      'clientUid': clientUid,
      'sessionId': sessionId,
      'type': 'redeem_cancelled',
      'amount': amount,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
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

/// Чек уже открыт у другого гостя.
class SessionTakenException implements Exception {
  @override
  String toString() =>
      'Этот счёт уже открыт у другого гостя. Если счёт ваш — попросите '
      'кальянщика открыть его на вас.';
}

/// Результат проверки лимита ИИ-консьержа.
class AiQuotaResult {
  final bool allowed;
  final String? reason;
  const AiQuotaResult(this.allowed, [this.reason]);
}
