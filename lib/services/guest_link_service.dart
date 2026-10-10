import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'firestore_service.dart';
import '../models/delivery_status.dart';
import '../models/client_models.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../models/table_model.dart';
import '../utils/phone_utils.dart';
import 'pii_gateway_service.dart';
import 'push_service.dart';
import 'venue_service.dart';
import '../utils/shared_stream.dart';
import '../utils/constants.dart';
import '../utils/promo_policy.dart';
import '../utils/venue_terms.dart';
import 'people_directory.dart';

/// Мост между кассой и приложением гостя:
/// профиль гостя, привязка к живому чеку, вызовы персонала, заказы из-за
/// стола, бонусы и отзывы. Оба приложения работают с одними коллекциями,
/// поэтому любое изменение прилетает второй стороне мгновенно.
class GuestLinkService {
  final _db = FirebaseFirestore.instance;
  final PiiGatewayService _piiGateway;

  GuestLinkService({PiiGatewayService? piiGateway})
      : _piiGateway = piiGateway ?? PiiGatewayService();

  // Лояльность (профиль/бонусы гостя) — через loyaltyCol: у сети заведений
  // общая на все точки (chains/{chainId}/clients), у одиночного заведения
  // ничем не отличается от обычного AppScope.col (см. её docstring).
  CollectionReference<Map<String, dynamic>> get _clients => AppScope.loyaltyCol('clients');
  CollectionReference<Map<String, dynamic>> get _calls => AppScope.col('waiterCalls');
  CollectionReference<Map<String, dynamic>> get _orders => AppScope.col('guestOrders');
  CollectionReference<Map<String, dynamic>> get _reviews => AppScope.col('reviews');

  // ---------- ПРОФИЛЬ ГОСТЯ ----------

  /// Общие подписки гостя (см. SharedStreams): экраны берут эти стримы
  /// прямо в build, и без общей ссылки каждое нажатие (вызов, заказ,
  /// оценка) переподписывало экран на базу — лишние чтения и подёргивания.
  static final _profileS = SharedStreams<ClientProfile?>();
  static final _sessionS = SharedStreams<SessionModel?>();
  static final _myCallsS = SharedStreams<List<WaiterCall>>();
  static final _myOrdersS = SharedStreams<List<GuestOrder>>();
  static final _visitsS = SharedStreams<List<GuestVisit>>();
  static final _reviewsS = SharedStreams<List<GuestReview>>();
  static final _menuS = SharedStreams<List<MenuItem>>();
  static final _categoriesS = SharedStreams<List<MenuCategory>>();

  /// Ключ с учётом заведения и сети: у сети профиль гостя общий.
  static String _key([String id = '']) => '${AppScope.tenantId ?? '-'}|${AppScope.chainId ?? '-'}|$id';

  Stream<ClientProfile?> profileStream(String uid) => _profileS.get(
      _key(uid), () => _clients.doc(uid).snapshots().map((d) => d.exists ? ClientProfile.fromDoc(d) : null));

  Future<ClientProfile> ensureProfile(String uid, {String name = '', String phone = ''}) async {
    final doc = await _clients.doc(uid).get();
    if (doc.exists) return ClientProfile.fromDoc(doc);
    final normPhone = phone.isNotEmpty ? normalizePhone(phone) : '';
    if (name.isNotEmpty || normPhone.isNotEmpty) {
      await People.instance
          .put('guest', uid, name: name.isEmpty ? null : name, phone: normPhone.isEmpty ? null : normPhone);
    }
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
        if (Pd.mirror) await _syncPhoneIndex(uid, normalized);
      }
    }
    // Имя и телефон — в справочник (на сервер в РФ — из очереди, касса
    // работает и без сети). В режиме rf в Firestore их не пишем.
    final name = patch['name'] is String ? patch['name'] as String : null;
    final phone = patch['phone'] is String ? patch['phone'] as String : null;
    if (name != null || phone != null) {
      await People.instance.put('guest', uid, name: name, phone: phone);
      if (!Pd.mirror) {
        patch = Map<String, dynamic>.from(patch)
          ..remove('name')
          ..remove('phone');
        if (patch.isEmpty) return;
      }
    }
    await _clients.doc(uid).set(patch, SetOptions(merge: true));
  }

  /// Имя и телефон, которые гость сообщил или поправил сам (профиль, бронь),
  /// — сначала в базу в РФ (152-ФЗ, [PiiGatewayService]), сервер сам копирует
  /// их в Firestore. Там, где связи может не быть (касса во время смены),
  /// используйте [updateProfile] — Firestore поставит запись в очередь.
  ///
  /// Возвращает профиль, перечитанный после ответа сервера.
  /// `null` — не трогать поле, `''` — очистить.
  Future<ClientProfile> registerGuestProfile(
    String uid, {
    String? name,
    String? phone,
  }) async {
    final normalizedPhone = phone != null && phone.isNotEmpty ? normalizePhone(phone) : phone;

    // Прежний номер нужно захватить ДО вызова шлюза: он сам обновит
    // Firestore, и повторное чтение после уже увидело бы новый номер
    // вместо старого — см. docstring _syncPhoneIndex(prevOverride:).
    String? prevPhone;
    if (normalizedPhone != null && normalizedPhone.isNotEmpty) {
      prevPhone = (await _clients.doc(uid).get()).data()?['phone'] as String?;
    }

    await _piiGateway.registerGuestProfile(uid: uid, name: name, phone: normalizedPhone);
    // Записанное на сервере — сразу и в копию на устройстве: в режиме rf
    // профиль Firestore имени и номера уже не покажет.
    People.instance.remember('guest', uid, name: name, phone: normalizedPhone);

    // Режим rf: номер в Firestore не кладём даже ключом указателя — занят
    // ли он, отвечает справочник в РФ (isPhoneTakenByOther).
    if (normalizedPhone != null && normalizedPhone.isNotEmpty && Pd.mirror) {
      await _syncPhoneIndex(uid, normalizedPhone, prevOverride: prevPhone ?? '');
    }

    final doc = await _clients.doc(uid).get();
    if (!doc.exists) {
      throw StateError('Шлюз подтвердил сохранение, но профиль не найден — сообщите в поддержку.');
    }
    return ClientProfile.fromDoc(doc);
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
      AppScope.loyaltyCol('phoneIndex');

  /// Занят ли номер ДРУГИМ профилем. Это чтение одного документа по id, а
  /// не запрос по коллекции, поэтому работает и у гостя.
  Future<bool> isPhoneTakenByOther(String phone, String uid) async {
    final normalized = normalizePhone(phone);
    if (normalized.isEmpty) return false;
    // Режим rf: телефонов в Firestore нет — спрашиваем справочник в РФ.
    if (!Pd.mirror) {
      final people = People.instance;
      if (!people.isStaff) return people.phoneTakenByOther(normalized);
      final owner = await people.guestUidByPhone(normalized);
      return owner.isNotEmpty && owner != uid;
    }
    final doc = await _phoneIndex.doc(normalized).get();
    if (!doc.exists) return false;
    final owner = (doc.data()?['uid'] as String?) ?? '';
    return owner.isNotEmpty && owner != uid;
  }

  /// Закрепляет номер за гостем и освобождает его прежний номер.
  /// Ошибки не пробрасывает: указатель вторичен, сам профиль важнее.
  ///
  /// [prevOverride] — использовать этот номер как «прежний» вместо чтения
  /// текущего значения из Firestore. Нужен вызывающим, которые сами уже
  /// записали НОВЫЙ номер в профиль до вызова этого метода (см.
  /// [registerGuestProfile]) — обычное чтение в этом случае увидело бы уже
  /// новый номер и решило бы, что менять нечего, а прежний указатель так и
  /// остался бы висеть на этом госте.
  Future<void> _syncPhoneIndex(String uid, String normalized, {String? prevOverride}) async {
    try {
      final prev = prevOverride ?? (await _clients.doc(uid).get()).data()?['phone'] as String?;
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
  /// Нормализует запрос, поэтому 79001234567, +79001234567 и 89001234567
  /// дают одинаковый результат.
  Future<ClientProfile?> findByPhone(String phone) async {
    final normalized = normalizePhone(phone);
    if (!Pd.mirror) {
      // Режим rf: номер знает только справочник в РФ.
      final uid = await People.instance.guestUidByPhone(normalized);
      if (uid.isEmpty) return null;
      final doc = await _clients.doc(uid).get();
      return doc.exists ? ClientProfile.fromDoc(doc) : null;
    }
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
    var mergedName = '';

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
      final newName = Pd.guestName(newUid, (newData['name'] as String?) ?? '');
      mergedName = newName.isNotEmpty ? newName : old.name;

      tx.set(newRef, {
        if (Pd.mirror) 'phone': normalized,
        if (Pd.mirror) 'name': mergedName,
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
    final ops = await AppScope.loyaltyCol('bonusOperations').where('clientUid', isEqualTo: old.uid).get();
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

    // Имя и телефон — выжившему профилю в справочнике, у удалённого стираем.
    await People.instance.put('guest', newUid,
        name: mergedName.isEmpty ? null : mergedName, phone: normalized.isEmpty ? null : normalized);
    await People.instance.erase('guest', old.uid);

    // Указатель «номер → uid» переводим на выживший профиль, иначе номер
    // остался бы закреплён за удалённым.
    if (normalized.isNotEmpty && Pd.mirror) {
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
    final marker = AppScope.col('jobRuns').doc('guestIndexBackfill');
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
          await AppScope.loyaltyCol('referralCodes').doc(code).set({'uid': doc.id});
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

  /// Удаляет гостя из справочника (дубль, пробный вход на чужой номер):
  /// профиль, указатели «номер → uid» и «код → uid» и историю визитов.
  ///
  /// Чеки, брони, чаевые, отзывы, бонусные операции и заявки на сертификаты
  /// не трогаем — это финансовая история заведения.
  Future<void> deleteClient(String uid) async {
    final doc = await _clients.doc(uid).get();
    if (!doc.exists) return;
    final data = doc.data() ?? {};
    final phone = (data['phone'] as String?) ?? '';
    final referralCode = (data['referralCode'] as String?) ?? '';

    // Указатели снимаем, только если они ещё ведут на этого гостя: если
    // номер успели переоформить на другой профиль, чужую запись трогать
    // нельзя.
    if (phone.isNotEmpty) {
      final idx = await _phoneIndex.doc(phone).get();
      if (idx.exists && (idx.data()?['uid'] as String?) == uid) {
        await _phoneIndex.doc(phone).delete();
      }
    }
    if (referralCode.isNotEmpty) {
      final codes = AppScope.loyaltyCol('referralCodes');
      final idx = await codes.doc(referralCode).get();
      if (idx.exists && (idx.data()?['uid'] as String?) == uid) {
        await codes.doc(referralCode).delete();
      }
    }

    // Подколлекция visits может быть длинной за годы — удаляем пачками,
    // чтобы не упереться в лимит 500 операций на один batch.
    final visits = _clients.doc(uid).collection('visits');
    while (true) {
      final page = await visits.limit(300).get();
      if (page.docs.isEmpty) break;
      final batch = _db.batch();
      for (final d in page.docs) {
        batch.delete(d.reference);
      }
      await batch.commit();
      if (page.docs.length < 300) break;
    }

    await _clients.doc(uid).delete();
    // Имя и телефон гостя — и из справочника в РФ.
    await People.instance.erase('guest', uid);
  }

  /// Найти гостя по открытому чеку — нужно кассиру при оплате
  /// (бонусы, сертификаты, чаевые).
  Future<ClientProfile?> findBySession(String sessionId) async {
    final snap = await _clients.where('activeSessionId', isEqualTo: sessionId).limit(1).get();
    return snap.docs.isEmpty ? null : ClientProfile.fromDoc(snap.docs.first);
  }

  // ---------- ПРИВЯЗКА ГОСТЯ К ЧЕКУ ----------

  /// Гость сканирует QR стола и садится за свой счёт. Один чек — привязываем
  /// сразу, несколько (TableModel.maxOpenSessions) — возвращаем список, чтобы
  /// гость выбрал свой.
  /// Без номера в профиле за стол не пускаем: по нему кассир находит гостя.
  /// Проверяем до обращения к столу.
  ///
  /// [tableKey] — секрет стола из QR (параметр `k`, см. TableKeyService):
  /// без него правила базы не дают занять чек.
  Future<TableBindResult> bindToTable(String uid, String tableId, {String tableKey = ''}) async {
    final profile = await _clients.doc(uid).get();
    final phone = (profile.data()?['phone'] as String?) ?? '';
    if (phone.isEmpty) return const TableBindResult.needsPhone();

    final tableDoc = await AppScope.col('tables').doc(tableId).get();
    if (!tableDoc.exists) return const TableBindResult.empty();
    final table = TableModel.fromDoc(tableDoc);
    if (table.activeSessionIds.isEmpty) return const TableBindResult.empty();

    // Витрина чеков живёт на карточке стола: читать sessions гостю нельзя.
    final checks = table.openChecks.where((c) => c.id.isNotEmpty).toList();
    if (checks.length > 1) {
      return TableBindResult.choose(await _markTakenChecks(checks, uid), table.name);
    }

    // Витрины чеков ещё нет (старые данные) — берём activeSessionIds.
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
    await bindToSession(uid, tableId, sessionId, tableKey: tableKey);
    return TableBindResult.bound(sessionId);
  }

  /// Кто занял чек: sessionClaims/{sessionId} → {uid}.
  ///
  /// Нужен, чтобы один и тот же счёт не открылся сразу на двух телефонах.
  /// Проверить это через коллекцию clients нельзя — запрос по ней гостю
  /// запрещён правилами, поэтому занятость лежит отдельным документом,
  /// который гость может прочитать по id.
  CollectionReference<Map<String, dynamic>> get _sessionClaims =>
      AppScope.col('sessionClaims');

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

  /// Привязывает гостя к выбранному чеку стола и закрепляет чек за ним:
  /// с другого телефона или профиля его уже не открыть.
  ///
  /// [SessionTakenException] — чек занят кем-то другим,
  /// [TableCodeException] — код со стола устарел или не от этого стола.
  Future<void> bindToSession(String uid, String tableId, String sessionId, {String tableKey = ''}) async {
    if (await isSessionTakenByOther(sessionId, uid)) {
      throw SessionTakenException();
    }
    try {
      // Документ создаётся только если его ещё нет, поэтому при одновременном
      // сканировании с двух телефонов выигрывает ровно один: второму правила
      // откажут в записи. В SaaS правила сверяют стол и его секрет из QR.
      await _sessionClaims.doc(sessionId).set({
        'uid': uid,
        if (AppScope.isSaasMode) 'tableId': tableId,
        if (AppScope.isSaasMode && tableKey.isNotEmpty) 'key': tableKey,
      });
    } on FirebaseException catch (e) {
      if (e.code != 'permission-denied') rethrow;
      // Отказ правил: либо чек успел занять другой, либо код со стола
      // старый (наклейку не заменили после выпуска секретов).
      if (await isSessionTakenByOther(sessionId, uid)) throw SessionTakenException();
      throw TableCodeException();
    }

    await _clients.doc(uid).set({
      'activeSessionId': sessionId,
      'activeTableId': tableId,
      // Профиль гостя сети общий на все точки, а чек физически принадлежит
      // ОДНОЙ конкретной точке (её кассе) — без этого поля правила сети
      // (chains/{chainId}/clients, chainSessionClaimOk) не смогли бы
      // проверить, что sessionId правда из sessionClaims именно этой
      // точки, а не подставлен гостем произвольно (см. saas/firestore.rules).
      // Для одиночного заведения (chainId == null) поле не пишем вовсе —
      // там в нём нет смысла и правила его не читают.
      if (AppScope.chainId != null) 'activeTenantId': AppScope.tenantId,
      'lastVisitAt': Timestamp.fromDate(DateTime.now()),
    }, SetOptions(merge: true));

    // Подписываем чек именем гостя, если подписи нет, — кальянщик видит, кто
    // за столом. По возможности: писать в sessions может только касса, а
    // метод вызывает и приложение гостя, и отказ не должен срывать посадку.
    try {
      final client = await _clients.doc(uid).get();
      final name = (client.data()?['name'] as String?) ?? '';
      if (name.isNotEmpty) {
        final sessionRef = AppScope.col('sessions').doc(sessionId);
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
      if (AppScope.chainId != null) 'activeTenantId': '',
    }, SetOptions(merge: true));
  }

  // ---------- ЛИМИТ ИИ-КОНСЬЕРЖА ----------

  /// Каждый вопрос ИИ-помощнику стоит денег на шлюзе, поэтому доступ
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
            false, 'Укажите номер телефона в профиле — так доступен ИИ-помощник.');
      }
      final activeSessionId = (data['activeSessionId'] as String?) ?? '';
      if (activeSessionId.isEmpty) {
        return const AiQuotaResult(
            false, 'ИИ-помощник доступен только за столом — отсканируйте QR-код на столе.');
      }

      final today = _dayKey(DateTime.now());
      final storedDay = (data['aiQuotaDate'] as String?) ?? '';
      final used = storedDay == today ? ((data['aiQuotaCount'] as num?)?.toInt() ?? 0) : 0;

      if (used >= dailyLimit) {
        return AiQuotaResult(false,
            'На сегодня лимит в $dailyLimit вопросов помощнику исчерпан — '
            'обратитесь к ${VenueService.instance.terms.staffDat}.');
      }

      tx.set(ref, {'aiQuotaDate': today, 'aiQuotaCount': used + 1}, SetOptions(merge: true));
      return const AiQuotaResult(true);
    });
  }

  String _dayKey(DateTime d) => '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  /// Живой счёт гостя: сумма, позиции, таймер стола — тот же документ,
  /// который правит кассир на POS.
  Stream<SessionModel?> sessionStream(String sessionId) => _sessionS.get(
      _key(sessionId),
      () => AppScope.col('sessions')
          .doc(sessionId)
          .snapshots()
          .map((d) => d.exists ? SessionModel.fromDoc(d) : null));

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
    // НЕ ждём подтверждения сервера. Firestore применяет запись локально
    // сразу и досылает её сам, как только появится связь, поэтому ждать
    // тут нечего — а ждали: на слабой связи кнопка «Позвать» висела
    // секундами, гость успевал нажать её ещё несколько раз, и кальянщик
    // получал пачку одинаковых вызовов.
    final ref = _calls.doc();
    unawaited(ref.set(call.toMap()));
    return ref.id;
  }


  /// Все открытые вызовы — баннер и подсветка столов на POS.
  /// Общие подписки (см. SharedStreams): баннер вызовов, плитки зала и
  /// очередь заказов берут их в build — ссылка одна, переподписок нет.
  static final _openCallsS = SharedStreams<List<WaiterCall>>();
  static final _openOrdersS = SharedStreams<List<GuestOrder>>();

  Stream<List<WaiterCall>> openCallsStream() => _openCallsS.get(
      AppScope.tenantId ?? '-',
      () => _calls
          .where('status', isEqualTo: 'new')
          .snapshots()
          .map((s) => s.docs.map(WaiterCall.fromDoc).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt))));

  /// Вызовы конкретного гостя — для его же экрана «Мой стол».
  /// Вызовы гостя, ожидающие кальянщика.
  ///
  /// Отсекаются старые: если вызов забыли закрыть на кассе, он висел у
  /// гостя вечно и копился вместе со следующими — экран превращался в
  /// столбик «крутилок», по которому невозможно понять, что происходит
  /// сейчас.
  Stream<List<WaiterCall>> myCallsStream(String clientUid) => _myCallsS.get(
      _key(clientUid),
      () => _calls.where('clientUid', isEqualTo: clientUid).where('status', isEqualTo: 'new').snapshots().map((s) {
            final fresh = DateTime.now().subtract(const Duration(minutes: 30));
            final list = s.docs.map(WaiterCall.fromDoc).where((c) => c.createdAt.isAfter(fresh)).toList()
              ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
            return list.take(4).toList();
          }));

  Future<void> closeCall(String callId, String employeeName) => _calls.doc(callId).update({
        'status': 'done',
        'doneAt': Timestamp.fromDate(DateTime.now()),
        'doneBy': Pd.who(employeeName),
      });

  // ---------- ЗАКАЗ ИЗ-ЗА СТОЛА ----------

  /// Заказ гостя, разложенный по адресатам: кальян — кальянщику, блюда и
  /// напитки — официанту (в баре — бармену). Каждый получает свою часть и
  /// подтверждает её сам. Возвращает адресатов в порядке позиций — для
  /// подписи «Заказ передан официанту».
  Future<List<String>> placeRoutedGuestOrder({
    required String sessionId,
    required String tableId,
    required List<OrderItem> items,
    String clientUid = '',
    String guestName = '',
  }) async {
    final terms = VenueService.instance.terms;
    final groups = <String, List<OrderItem>>{};
    for (final item in items) {
      final target = AppConstants.guestOrderTarget(
        hookahItem: item.noPromo || PromoPolicy.looksTobacco(item.name),
        hookahVenue: terms.isHookah,
        bar: terms.type == VenueTerms.bar,
      );
      (groups[target] ??= []).add(item);
    }
    for (final group in groups.entries) {
      await placeGuestOrder(
        sessionId: sessionId,
        tableId: tableId,
        tableName: '',
        items: group.value,
        clientUid: clientUid,
        guestName: guestName,
        targetPosition: group.key,
      );
    }
    return groups.keys.toList();
  }

  Future<String> placeGuestOrder({
    required String sessionId,
    required String tableId,
    required String tableName,
    required List<OrderItem> items,
    String clientUid = '',
    String guestName = '',
    String comment = '',
    String targetPosition = '',
  }) async {
    // Стол берём из самого чека (его гостю читать можно): гостя могли
    // пересадить, а стол в профиле ещё прежний. Имя стола обязательно —
    // без него у персонала заказ приходил как «Стол · …», и было
    // непонятно, куда нести.
    var resolvedTableId = tableId;
    var resolvedTable = tableName;
    if (sessionId.isNotEmpty) {
      try {
        final data = (await AppScope.col('sessions').doc(sessionId).get()).data();
        final id = (data?['tableId'] as String?) ?? '';
        final name = (data?['tableName'] as String?) ?? '';
        if (id.isNotEmpty) resolvedTableId = id;
        if (name.isNotEmpty) resolvedTable = name;
      } catch (_) {}
    }
    final order = GuestOrder(
      id: '',
      sessionId: sessionId,
      tableId: resolvedTableId,
      tableName: resolvedTable,
      clientUid: clientUid,
      guestName: guestName,
      items: items,
      comment: comment,
      targetPosition: targetPosition,
      createdAt: DateTime.now(),
    );
    final ref = await _orders.add(order.toMap());
    return ref.id;
  }

  /// Заказы, требующие внимания персонала: новые и те, что уже готовятся.
  Stream<List<GuestOrder>> openGuestOrdersStream() => _openOrdersS.get(
      AppScope.tenantId ?? '-',
      () => _orders
          .where('status', whereIn: ['new', 'preparing'])
          .snapshots()
          .map((s) => s.docs.map(GuestOrder.fromDoc).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt))));

  Stream<List<GuestOrder>> clientOrdersStream(String clientUid) => _myOrdersS.get(
      _key(clientUid),
      () => _orders
          .where('clientUid', isEqualTo: clientUid)
          .orderBy('createdAt', descending: true)
          .limit(20)
          .snapshots()
          .map((s) => s.docs.map(GuestOrder.fromDoc).toList()));

  /// [employeeId] — кто принял заказ: позиции записываются на него (по
  /// нему кальянщику и бармену идёт процент, см. PayrollSales).
  Future<void> acceptGuestOrder(GuestOrder order, String employeeName, {String employeeId = ''}) async {
    final sessionRef = AppScope.col('sessions').doc(order.sessionId);
    final orderRef = _orders.doc(order.id);
    // Цены, названия и признак табака — из меню, а не из заказа: его пишет
    // приложение гостя, и цену в нём можно подменить.
    final priced = await FirestoreService().menuPricedItems(order.items);

    // Ошибки бросаем после транзакции: в вебе исключение изнутри неё
    // теряет свой текст.
    final problem = await _db.runTransaction<String?>((tx) async {
      final snap = await tx.get(sessionRef);
      final orderSnap = await tx.get(orderRef);
      // Второй планшет уже принял этот заказ — позиции второй раз не льём.
      if (orderSnap.data()?['status'] != 'new') return 'Заказ уже принят или отклонён.';
      final data = snap.data();
      // Закрытый чек в базе остаётся — проверять надо статус, а не наличие.
      // Заказ отклоняем сразу: иначе он висел бы в очереди, а гость ждал.
      if (data == null || (data['status'] ?? 'active') != 'active') {
        tx.update(orderRef, {
          'status': 'rejected',
          'rejectReason': 'Счёт уже закрыт',
          'handledAt': Timestamp.fromDate(DateTime.now()),
          'handledBy': Pd.who(employeeName),
        });
        return 'Чек уже закрыт — заказ отклонён.';
      }

      if (priced.isEmpty) {
        tx.update(orderRef, {
          'status': 'rejected',
          'rejectReason': 'Этих позиций уже нет в меню',
          'handledAt': Timestamp.fromDate(DateTime.now()),
          'handledBy': Pd.who(employeeName),
        });
        return 'Позиций заказа нет в меню — заказ отклонён.';
      }

      final current = ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList();

      for (final incoming in priced) {
        final idx = current.indexWhere((i) => i.lineId == incoming.lineId);
        if (idx >= 0) {
          current[idx] = current[idx].plus(incoming.qty, employeeId: employeeId);
        } else {
          current.add(OrderItem(
            menuItemId: incoming.menuItemId,
            name: incoming.name,
            price: incoming.price,
            qty: incoming.qty,
            mods: incoming.mods,
            noPromo: incoming.noPromo,
            kind: incoming.kind,
            by: employeeId.isEmpty ? const {} : {employeeId: incoming.qty},
            since: DateTime.now(),
          ));
        }
      }

      tx.update(sessionRef, {
        'orderItems': current.map((e) => e.toMap()).toList(),
        // Заказ с собой/доставки из приложения: принят персоналом.
        if (data['tableId'] == TableModel.takeawayId &&
            DeliveryFlow.normalize((data['orderType'] ?? '').toString(), data['deliveryStatus'] as String?) == 'new') ...{
          'deliveryStatus': 'accepted',
          'deliveryStatusAt': Timestamp.fromDate(DateTime.now()),
        },
      });
      tx.update(orderRef, {
        'status': 'preparing',
        'handledAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': Pd.who(employeeName),
      });
      return null;
    });
    if (problem != null) throw StateError(problem);
  }

  Future<void> markOrderReady(GuestOrder order, String employeeName) async {
    await _orders.doc(order.id).update({
      'status': 'ready',
      'readyAt': Timestamp.fromDate(DateTime.now()),
      'handledBy': Pd.who(employeeName),
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
      body: order.items.map((i) => i.displayName).join(', '),
    );
  }

  Future<void> rejectGuestOrder(String orderId, String employeeName, String reason) =>
      _orders.doc(orderId).update({
        'status': 'rejected',
        'rejectReason': reason,
        'handledAt': Timestamp.fromDate(DateTime.now()),
        'handledBy': Pd.who(employeeName),
      });

  // ---------- БОНУСЫ ----------

  /// Засчитывает визит: кешбэк, счётчик визитов, сумма трат и запись в
  /// историю визитов.
  ///
  ///  • [paidAmount] — оплачено живыми деньгами. Кешбэк — только с них,
  ///    иначе бонусы начислялись бы на бонусы.
  ///  • [billTotal] — сумма чека со скидкой. Она идёт в totalSpent и
  ///    двигает уровень, чем бы гость ни платил.
  ///
  /// Идемпотентно: повторный вызов по тому же чеку ничего не начислит
  /// (bonusAccruedFor) и не задвоит визит (id визита — id чека).
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
      // Кешбэк — только с той доли чека, что не приходится на кальяны
      // (табак нельзя стимулировать бонусами, см. PromoPolicy).
      final all = items.fold(0.0, (a, i) => a + i.total);
      final share = all > 0 ? PromoPolicy.promoBase(items) / all : 1.0;
      bonus = (paidAmount * share * profile.cashbackPercent / 100).roundToDouble();
      counted = true;

      tx.update(ref, {
        'bonusBalance': profile.bonusBalance + bonus,
        'totalSpent': profile.totalSpent + spent,
        'visits': profile.visits + 1,
        'bonusAccruedFor': sessionId,
        'activeSessionId': '',
        'activeTableId': '',
        if (AppScope.chainId != null) 'activeTenantId': '',
        // Чек закрыт — предложение оценить визит держится на этом поле,
        // activeSessionId здесь же обнуляется.
        'lastVisitId': sessionId,
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
    await AppScope.loyaltyCol('bonusOperations').add({
      'clientUid': clientUid,
      'sessionId': sessionId,
      'type': 'accrual',
      'amount': paidAmount,
      'bonus': bonus,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Один визит по id — по нему строится экран «Спасибо за визит».
  ///
  /// Читается именно визит, а не чек: после закрытия чек гостю уже
  /// недоступен по правилам (там счета других столов), а в визите есть
  /// всё нужное — стол, сумма и начисленные бонусы.
  /// Именно стрим, а не разовое чтение: касса ставит отметку о закрытом
  /// чеке в профиле и только потом дописывает сам визит отдельной
  /// операцией. Разовое чтение попадает в этот промежуток, не находит
  /// визита — и экран «Спасибо» не появляется уже никогда, потому что
  /// перечитывать нечему.
  Stream<GuestVisit?> visitById(String uid, String visitId) {
    if (uid.isEmpty || visitId.isEmpty) return Stream.value(null);
    return _clients
        .doc(uid)
        .collection('visits')
        .doc(visitId)
        .snapshots()
        .map((d) => d.exists ? GuestVisit.fromDoc(d) : null)
        .handleError((_) {});
  }

  /// Гость поставил оценку (или закрыл предложение) — больше не показываем.
  Future<void> markVisitRated(String uid, String visitId) async {
    if (uid.isEmpty || visitId.isEmpty) return;
    try {
      await _clients.doc(uid).set({'ratedVisitId': visitId}, SetOptions(merge: true));
    } catch (_) {}
  }

  /// Вечная история визитов гостя, от самого свежего. Источник — та самая
  /// подколлекция, что пишется при закрытии чека.
  Stream<List<GuestVisit>> visitsStream(String uid, {int limit = 100}) => _visitsS.get(
      _key('$uid|$limit'),
      () => _clients
          .doc(uid)
          .collection('visits')
          .orderBy('date', descending: true)
          .limit(limit)
          .snapshots()
          .map((s) => s.docs.map(GuestVisit.fromDoc).toList()));

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
      await AppScope.loyaltyCol('bonusOperations').add({
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
    await AppScope.loyaltyCol('bonusOperations').add({
      'clientUid': clientUid,
      'sessionId': sessionId,
      'type': 'redeem_cancelled',
      'amount': amount,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  // ---------- ОТЗЫВЫ ----------

  Future<void> addReview(GuestReview review) => _reviews.add(review.toMap());

  /// Профиль гостя по uid — нужен на экране отзывов, чтобы рядом с оценкой
  /// было видно, кто её поставил, и как с ним связаться.
  Future<ClientProfile?> profileOnce(String uid) async {
    if (uid.isEmpty) return null;
    try {
      final doc = await _clients.doc(uid).get();
      return doc.exists ? ClientProfile.fromDoc(doc) : null;
    } catch (_) {
      return null;
    }
  }

  Stream<List<GuestReview>> recentReviewsStream({int limit = 50}) => _reviewsS.get(
      _key('$limit'),
      () => _reviews
          .orderBy('createdAt', descending: true)
          .limit(limit)
          .snapshots()
          .map((s) => s.docs.map(GuestReview.fromDoc).toList()));

  // ---------- МЕНЮ ДЛЯ ГОСТЯ ----------

  Stream<List<MenuItem>> publicMenuStream() => _menuS.get(
      _key(),
      () => AppScope.col('menuItems')
          .snapshots()
          .map((s) => s.docs.map(MenuItem.fromDoc).where((i) => i.available).toList()));

  Stream<List<MenuCategory>> publicCategoriesStream() => _categoriesS.get(
      _key(),
      () => AppScope.col('menuCategories')
          .orderBy('order')
          .snapshots()
          .map((s) => s.docs.map(MenuCategory.fromDoc).toList()));
}

/// Чек уже открыт у другого гостя.
/// Код со стола не подошёл: наклейка старая (до секретов столов или после
/// «Новый код» на кассе) либо сфотографирована с другого стола.
class TableCodeException implements Exception {
  @override
  String toString() =>
      'Код на этом столе устарел — отсканируйте QR прямо на столе ещё раз. '
      'Если не выходит, попросите ${VenueService.instance.terms.staffAcc} открыть вам счёт.';
}

class SessionTakenException implements Exception {
  @override
  String toString() =>
      'Этот счёт уже открыт у другого гостя. Если счёт ваш — попросите '
      '${VenueService.instance.terms.staffAcc} открыть его на вас.';
}

/// Результат проверки лимита ИИ-помощника.
class AiQuotaResult {
  final bool allowed;
  final String? reason;
  const AiQuotaResult(this.allowed, [this.reason]);
}
