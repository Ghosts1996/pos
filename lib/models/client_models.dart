import 'package:cloud_firestore/cloud_firestore.dart';
import 'session_model.dart';
import 'table_model.dart';

/// Профиль гостя приложения «Colibri Lounge».
/// Документ clients/{uid}, где uid — Firebase Auth UID клиентского приложения.
class ClientProfile {
  final String uid;
  final String name;
  final String phone;

  /// Бонусный баланс в рублях (1 бонус = 1 ₽ при списании).
  final double bonusBalance;

  /// Сумма всех закрытых чеков гостя — база для уровня лояльности.
  final double totalSpent;
  final int visits;

  /// Привязанная дисконтная карта из POS (discountCards/{id}).
  final String discountCardId;
  final double discountPercent;

  /// Чек, за которым гость сидит прямо сейчас. Пусто — гость не в зале.
  final String activeSessionId;
  final String activeTableId;

  final List<String> favoriteItemIds;

  /// Токен push-уведомлений (FCM) клиентского устройства.
  final String pushToken;

  /// Портрет гостя, который поддерживает ИИ-агент «Консьерж»:
  /// вкусовые предпочтения, крепость кальяна, аллергии, средний чек.
  final String aiProfile;

  final DateTime createdAt;
  final DateTime? lastVisitAt;

  ClientProfile({
    required this.uid,
    this.name = '',
    this.phone = '',
    this.bonusBalance = 0,
    this.totalSpent = 0,
    this.visits = 0,
    this.discountCardId = '',
    this.discountPercent = 0,
    this.activeSessionId = '',
    this.activeTableId = '',
    this.favoriteItemIds = const [],
    this.pushToken = '',
    this.aiProfile = '',
    required this.createdAt,
    this.lastVisitAt,
  });

  /// Пороги уровней лояльности по сумме всех закрытых чеков гостя.
  /// Одно место, из которого берут данные и сам уровень, и прогресс-бар в
  /// профиле, — чтобы пороги нельзя было развести по разным экранам.
  static const tiers = <({String name, double from, double cashback})>[
    (name: 'Бронза', from: 0, cashback: 3),
    (name: 'Серебро', from: 10000, cashback: 5),
    (name: 'Золото', from: 25000, cashback: 7),
    (name: 'Платина', from: 50000, cashback: 10),
    (name: 'Алмаз', from: 100000, cashback: 15),
  ];

  /// Уровень лояльности — считается от суммы закрытых чеков.
  String get tier => _currentTier.name;

  ({String name, double from, double cashback}) get _currentTier {
    var result = tiers.first;
    for (final t in tiers) {
      if (totalSpent >= t.from) result = t;
    }
    return result;
  }

  /// Следующий уровень, если он есть. null — гость уже на «Алмазе».
  ({String name, double from, double cashback})? get nextTier {
    for (final t in tiers) {
      if (totalSpent < t.from) return t;
    }
    return null;
  }

  /// Сколько ещё потратить до следующего уровня. 0 — уровень максимальный.
  double get toNextTier {
    final next = nextTier;
    return next == null ? 0 : next.from - totalSpent;
  }

  /// Доля пройденного пути до следующего уровня (0..1) — для прогресс-бара.
  double get tierProgress {
    final next = nextTier;
    if (next == null) return 1;
    final from = _currentTier.from;
    final span = next.from - from;
    if (span <= 0) return 1;
    return ((totalSpent - from) / span).clamp(0.0, 1.0);
  }

  /// Процент кешбэка бонусами по уровню.
  double get cashbackPercent => _currentTier.cashback;

  factory ClientProfile.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final created = data['createdAt'];
    final last = data['lastVisitAt'];
    return ClientProfile(
      uid: doc.id,
      name: data['name'] ?? '',
      phone: data['phone'] ?? '',
      bonusBalance: (data['bonusBalance'] ?? 0).toDouble(),
      totalSpent: (data['totalSpent'] ?? 0).toDouble(),
      visits: (data['visits'] as num?)?.toInt() ?? 0,
      discountCardId: data['discountCardId'] ?? '',
      discountPercent: (data['discountPercent'] ?? 0).toDouble(),
      activeSessionId: data['activeSessionId'] ?? '',
      activeTableId: data['activeTableId'] ?? '',
      favoriteItemIds:
          ((data['favoriteItemIds'] ?? []) as List).map((e) => e.toString()).toList(),
      pushToken: data['pushToken'] ?? '',
      aiProfile: data['aiProfile'] ?? '',
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      lastVisitAt: last is Timestamp ? last.toDate() : null,
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'phone': phone,
        'bonusBalance': bonusBalance,
        'totalSpent': totalSpent,
        'visits': visits,
        'discountCardId': discountCardId,
        'discountPercent': discountPercent,
        'activeSessionId': activeSessionId,
        'activeTableId': activeTableId,
        'favoriteItemIds': favoriteItemIds,
        'pushToken': pushToken,
        'aiProfile': aiProfile,
        'createdAt': Timestamp.fromDate(createdAt),
        'lastVisitAt': lastVisitAt != null ? Timestamp.fromDate(lastVisitAt!) : null,
      };
}

/// Чем закончилась попытка «сесть за стол» по QR-коду.
///
/// Три исхода: за столом нет открытых чеков; привязались к единственному;
/// чеков несколько и гостю нужно выбрать свой.
class TableBindResult {
  final String? sessionId;
  final List<TableCheck> choices;
  final String tableName;

  const TableBindResult.empty()
      : sessionId = null,
        choices = const [],
        tableName = '';

  const TableBindResult.bound(String this.sessionId)
      : choices = const [],
        tableName = '';

  const TableBindResult.choose(this.choices, this.tableName) : sessionId = null;

  /// За столом нет ни одного открытого чека.
  bool get isEmpty => sessionId == null && choices.isEmpty;

  /// Нужно спросить гостя, какой чек его.
  bool get needsChoice => sessionId == null && choices.isNotEmpty;
}

/// Один визит гостя — документ clients/{uid}/visits/{sessionId}.
///
/// Отдельная «вечная» запись, а не ссылка на чек: коллекцию sessions гостю
/// читать нельзя (там чужие счета), а историю своих посещений он видеть
/// должен. Пишется кассой один раз при закрытии чека и больше не меняется.
class GuestVisit {
  final String id;
  final DateTime date;
  final String tableName;

  /// Сумма чека со скидкой — она же копится в totalSpent и двигает уровень.
  final double total;

  /// Сколько из неё получено живыми деньгами (с них считается кешбэк).
  final double paid;

  final double bonusEarned;
  final double bonusSpent;
  final List<GuestVisitItem> items;

  const GuestVisit({
    required this.id,
    required this.date,
    this.tableName = '',
    this.total = 0,
    this.paid = 0,
    this.bonusEarned = 0,
    this.bonusSpent = 0,
    this.items = const [],
  });

  factory GuestVisit.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final date = data['date'];
    return GuestVisit(
      id: doc.id,
      date: date is Timestamp ? date.toDate() : DateTime.now(),
      tableName: data['tableName'] ?? '',
      total: (data['total'] ?? 0).toDouble(),
      paid: (data['paid'] ?? 0).toDouble(),
      bonusEarned: (data['bonusEarned'] ?? 0).toDouble(),
      bonusSpent: (data['bonusSpent'] ?? 0).toDouble(),
      items: ((data['items'] ?? []) as List)
          .map((e) => GuestVisitItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
    );
  }
}

/// Строка заказа внутри визита — хранится копией, чтобы история не
/// «поехала», если позицию меню потом переименуют или удалят.
class GuestVisitItem {
  final String name;
  final int qty;
  final double price;

  const GuestVisitItem({required this.name, this.qty = 1, this.price = 0});

  factory GuestVisitItem.fromMap(Map<String, dynamic> m) => GuestVisitItem(
        name: m['name']?.toString() ?? '',
        qty: (m['qty'] as num?)?.toInt() ?? 1,
        price: (m['price'] ?? 0).toDouble(),
      );
}

/// Тип обращения гостя из-за стола.
enum GuestCallType { waiter, coal, bill, refill }

extension GuestCallTypeX on GuestCallType {
  String get code => name;

  String get label {
    switch (this) {
      case GuestCallType.waiter:
        return 'Позвать кальянщика';
      case GuestCallType.coal:
        return 'Поменять угли';
      case GuestCallType.bill:
        return 'Счёт, пожалуйста';
      case GuestCallType.refill:
        return 'Перезабивка';
    }
  }

  static GuestCallType fromCode(String? c) => GuestCallType.values.firstWhere(
        (e) => e.name == c,
        orElse: () => GuestCallType.waiter,
      );
}

/// Вызов персонала гостем — документ waiterCalls/{id}.
/// Появляется на POS мгновенно (стрим) и подсвечивает стол на карте зала.
class WaiterCall {
  final String id;
  final String tableId;
  final String tableName;
  final String sessionId;
  final String clientUid;
  final String guestName;
  final GuestCallType type;
  final String comment;

  /// 'new' | 'done'
  final String status;
  final DateTime createdAt;
  final DateTime? doneAt;
  final String doneBy;

  WaiterCall({
    required this.id,
    required this.tableId,
    this.tableName = '',
    this.sessionId = '',
    this.clientUid = '',
    this.guestName = '',
    this.type = GuestCallType.waiter,
    this.comment = '',
    this.status = 'new',
    required this.createdAt,
    this.doneAt,
    this.doneBy = '',
  });

  bool get isOpen => status == 'new';

  /// Сколько минут гость уже ждёт — для SLA-подсветки на POS.
  int get waitingMinutes => DateTime.now().difference(createdAt).inMinutes;

  factory WaiterCall.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final created = data['createdAt'];
    final done = data['doneAt'];
    return WaiterCall(
      id: doc.id,
      tableId: data['tableId'] ?? '',
      tableName: data['tableName'] ?? '',
      sessionId: data['sessionId'] ?? '',
      clientUid: data['clientUid'] ?? '',
      guestName: data['guestName'] ?? '',
      type: GuestCallTypeX.fromCode(data['type'] as String?),
      comment: data['comment'] ?? '',
      status: data['status'] ?? 'new',
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      doneAt: done is Timestamp ? done.toDate() : null,
      doneBy: data['doneBy'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {
        'tableId': tableId,
        'tableName': tableName,
        'sessionId': sessionId,
        'clientUid': clientUid,
        'guestName': guestName,
        'type': type.code,
        'comment': comment,
        'status': status,
        'createdAt': Timestamp.fromDate(createdAt),
        'doneAt': doneAt != null ? Timestamp.fromDate(doneAt!) : null,
        'doneBy': doneBy,
      };
}

/// Заказ, собранный гостем в приложении за своим столом — guestOrders/{id}.
/// Не попадает в чек автоматически: сотрудник подтверждает его на POS,
/// после чего позиции добавляются в сессию (списывается склад как обычно).
class GuestOrder {
  final String id;
  final String sessionId;
  final String tableId;
  final String tableName;
  final String clientUid;
  final String guestName;
  final List<OrderItem> items;
  final String comment;

  /// 'new' | 'preparing' | 'ready' | 'rejected'
  final String status;
  final String rejectReason;
  final DateTime createdAt;
  final DateTime? handledAt;
  final String handledBy;

  GuestOrder({
    required this.id,
    required this.sessionId,
    required this.tableId,
    this.tableName = '',
    this.clientUid = '',
    this.guestName = '',
    this.items = const [],
    this.comment = '',
    this.status = 'new',
    this.rejectReason = '',
    required this.createdAt,
    this.handledAt,
    this.handledBy = '',
  });

  /// Заказ ещё в работе у персонала.
  bool get isOpen => status == 'new' || status == 'preparing';

  /// Подпись стадии для гостя.
  String get statusLabel {
    switch (status) {
      case 'preparing':
        return 'Готовим';
      case 'ready':
        return 'Готово, несём';
      case 'rejected':
        return 'Отклонён';
      default:
        return 'Ждёт подтверждения';
    }
  }

  double get total => items.fold(0.0, (s, i) => s + i.total);

  factory GuestOrder.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final created = data['createdAt'];
    final handled = data['handledAt'];
    return GuestOrder(
      id: doc.id,
      sessionId: data['sessionId'] ?? '',
      tableId: data['tableId'] ?? '',
      tableName: data['tableName'] ?? '',
      clientUid: data['clientUid'] ?? '',
      guestName: data['guestName'] ?? '',
      items: ((data['items'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      comment: data['comment'] ?? '',
      status: data['status'] ?? 'new',
      rejectReason: data['rejectReason'] ?? '',
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      handledAt: handled is Timestamp ? handled.toDate() : null,
      handledBy: data['handledBy'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {
        'sessionId': sessionId,
        'tableId': tableId,
        'tableName': tableName,
        'clientUid': clientUid,
        'guestName': guestName,
        'items': items.map((e) => e.toMap()).toList(),
        'comment': comment,
        'status': status,
        'rejectReason': rejectReason,
        'createdAt': Timestamp.fromDate(createdAt),
        'handledAt': handledAt != null ? Timestamp.fromDate(handledAt!) : null,
        'handledBy': handledBy,
      };
}

/// Отзыв гостя о визите — reviews/{id}. Собирается после закрытия чека,
/// анализируется ИИ-агентом «Качество сервиса».
class GuestReview {
  final String id;
  final String sessionId;
  final String clientUid;
  final String guestName;
  final int rating; // 1..5
  final String text;

  /// Разбор отзыва ИИ: тема, тональность, что починить.
  final String aiSummary;
  final DateTime createdAt;

  GuestReview({
    required this.id,
    required this.sessionId,
    this.clientUid = '',
    this.guestName = '',
    required this.rating,
    this.text = '',
    this.aiSummary = '',
    required this.createdAt,
  });

  factory GuestReview.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final created = data['createdAt'];
    return GuestReview(
      id: doc.id,
      sessionId: data['sessionId'] ?? '',
      clientUid: data['clientUid'] ?? '',
      guestName: data['guestName'] ?? '',
      rating: (data['rating'] as num?)?.toInt() ?? 5,
      text: data['text'] ?? '',
      aiSummary: data['aiSummary'] ?? '',
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
    );
  }

  Map<String, dynamic> toMap() => {
        'sessionId': sessionId,
        'clientUid': clientUid,
        'guestName': guestName,
        'rating': rating,
        'text': text,
        'aiSummary': aiSummary,
        'createdAt': Timestamp.fromDate(createdAt),
      };
}
