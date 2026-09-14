import 'package:cloud_firestore/cloud_firestore.dart';

// ---------------------------------------------------------------- заведение

/// Профиль заведения: часы работы, адрес, правила, FAQ.
///
/// Это же — база знаний для ИИ-агентов: консьерж отвечает гостю «до скольки
/// вы работаете» и «можно ли с детьми» из этих полей, а не выдумывает.
/// Документ: meta/venueProfile.
class VenueProfile {
  final String name;
  final String address;
  final String phone;
  final String about;

  /// Часы работы по дням недели: 1 — понедельник … 7 — воскресенье.
  /// Значение вида '14:00-02:00'. Пусто — выходной.
  final Map<int, String> workingHours;

  /// Вопрос → ответ. Всё, что чаще всего спрашивают гости.
  final List<VenueFaq> faq;

  /// Правила заведения: депозит, возраст, можно ли со своим, дресс-код.
  final String rules;

  /// Минимальный депозит на компанию от N человек, 0 — без депозита.
  final double depositFrom;
  final int depositGuests;

  /// Координаты заведения — нужны только инструменту ИИ «погода сейчас»,
  /// который сомелье и консьерж используют, чтобы подобрать микс под
  /// погоду за окном. 0/0 — не заданы, инструмент тогда отвечает без погоды.
  final double lat;
  final double lon;

  /// Подключены ли Cloud Functions (тариф Firebase Blaze).
  ///
  /// По умолчанию ВЫКЛЮЧЕНО: на бесплатном тарифе Spark функции
  /// развернуть нельзя, и всё, что они делали, приложение делает само —
  /// POS ведёт фоновые задания (авто-неявка, дни рождения), а гостевое
  /// приложение показывает локальные уведомления вместо push.
  ///
  /// Включать только после `firebase deploy --only functions`: иначе
  /// очередь `pushQueue` будет копиться впустую, а гость получит по два
  /// уведомления на каждое событие — от функции и от приложения.
  final bool cloudFunctionsEnabled;

  const VenueProfile({
    this.name = 'Colibri Lounge',
    this.address = '',
    this.phone = '',
    this.about = '',
    this.workingHours = const {},
    this.faq = const [],
    this.rules = '',
    this.depositFrom = 0,
    this.depositGuests = 6,
    this.lat = 0,
    this.lon = 0,
    this.cloudFunctionsEnabled = false,
  });

  factory VenueProfile.fromMap(Map<String, dynamic>? data) {
    if (data == null) return const VenueProfile();
    return VenueProfile(
      name: data['name'] ?? 'Colibri Lounge',
      address: data['address'] ?? '',
      phone: data['phone'] ?? '',
      about: data['about'] ?? '',
      workingHours: {
        for (final e in ((data['workingHours'] as Map?) ?? {}).entries)
          int.tryParse(e.key.toString()) ?? 1: e.value.toString(),
      },
      faq: ((data['faq'] ?? []) as List)
          .map((e) => VenueFaq.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      rules: data['rules'] ?? '',
      depositFrom: (data['depositFrom'] ?? 0).toDouble(),
      depositGuests: (data['depositGuests'] as num?)?.toInt() ?? 6,
      lat: (data['lat'] ?? 0).toDouble(),
      lon: (data['lon'] ?? 0).toDouble(),
      cloudFunctionsEnabled: data['cloudFunctionsEnabled'] == true,
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'address': address,
        'phone': phone,
        'about': about,
        'workingHours': workingHours.map((k, v) => MapEntry(k.toString(), v)),
        'faq': faq.map((e) => e.toMap()).toList(),
        'rules': rules,
        'depositFrom': depositFrom,
        'depositGuests': depositGuests,
        'lat': lat,
        'lon': lon,
        'cloudFunctionsEnabled': cloudFunctionsEnabled,
      };

  /// Часы работы на сегодня — строкой, как их показывают гостю.
  String get todayHours => workingHours[DateTime.now().weekday] ?? 'выходной';

  VenueProfile copyWith({
    String? name,
    String? address,
    String? phone,
    String? about,
    Map<int, String>? workingHours,
    List<VenueFaq>? faq,
    String? rules,
    double? depositFrom,
    int? depositGuests,
    double? lat,
    double? lon,
    bool? cloudFunctionsEnabled,
  }) =>
      VenueProfile(
        name: name ?? this.name,
        address: address ?? this.address,
        phone: phone ?? this.phone,
        about: about ?? this.about,
        workingHours: workingHours ?? this.workingHours,
        faq: faq ?? this.faq,
        rules: rules ?? this.rules,
        depositFrom: depositFrom ?? this.depositFrom,
        depositGuests: depositGuests ?? this.depositGuests,
        lat: lat ?? this.lat,
        lon: lon ?? this.lon,
        cloudFunctionsEnabled: cloudFunctionsEnabled ?? this.cloudFunctionsEnabled,
      );
}

class VenueFaq {
  final String question;
  final String answer;
  const VenueFaq(this.question, this.answer);

  factory VenueFaq.fromMap(Map<String, dynamic> m) =>
      VenueFaq(m['q']?.toString() ?? '', m['a']?.toString() ?? '');

  Map<String, dynamic> toMap() => {'q': question, 'a': answer};
}

// -------------------------------------------------------------- happy hours

/// Акционное окно: скидка в «мёртвые» часы.
///
/// Применяется автоматически при открытии чека и видна гостю в приложении —
/// это честнее, чем «скидка по настроению кассира», и разгружает пик.
/// Коллекция: happyHours.
class HappyHour {
  final String id;
  final String title;

  /// Дни недели (1–7), в которые действует акция.
  final List<int> weekdays;

  /// Окно в минутах от полуночи: 14:00 → 840.
  final int fromMinutes;
  final int toMinutes;

  final double discountPercent;

  /// Ограничение по категориям меню (пусто — на весь чек).
  final List<String> categoryIds;

  final bool active;

  const HappyHour({
    required this.id,
    required this.title,
    this.weekdays = const [1, 2, 3, 4, 5, 6, 7],
    this.fromMinutes = 0,
    this.toMinutes = 0,
    this.discountPercent = 0,
    this.categoryIds = const [],
    this.active = true,
  });

  bool matches(DateTime moment) {
    if (!active || discountPercent <= 0) return false;
    if (!weekdays.contains(moment.weekday)) return false;
    final minutes = moment.hour * 60 + moment.minute;
    // Окно может переходить через полночь: 22:00–02:00.
    if (toMinutes >= fromMinutes) {
      return minutes >= fromMinutes && minutes < toMinutes;
    }
    return minutes >= fromMinutes || minutes < toMinutes;
  }

  String get window =>
      '${_fmt(fromMinutes)}–${_fmt(toMinutes)}';

  static String _fmt(int minutes) =>
      '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';

  factory HappyHour.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    return HappyHour(
      id: doc.id,
      title: d['title'] ?? 'Счастливые часы',
      weekdays: ((d['weekdays'] ?? []) as List).map((e) => (e as num).toInt()).toList(),
      fromMinutes: (d['fromMinutes'] as num?)?.toInt() ?? 0,
      toMinutes: (d['toMinutes'] as num?)?.toInt() ?? 0,
      discountPercent: (d['discountPercent'] ?? 0).toDouble(),
      categoryIds: ((d['categoryIds'] ?? []) as List).map((e) => e.toString()).toList(),
      active: d['active'] ?? true,
    );
  }

  Map<String, dynamic> toMap() => {
        'title': title,
        'weekdays': weekdays,
        'fromMinutes': fromMinutes,
        'toMinutes': toMinutes,
        'discountPercent': discountPercent,
        'categoryIds': categoryIds,
        'active': active,
      };
}

// ----------------------------------------------------------- лист ожидания

/// Гость, который пришёл или написал, когда всё занято.
/// Коллекция: waitlist.
class WaitlistEntry {
  final String id;
  final String guestName;
  final String phone;
  final String clientUid;
  final int guestsCount;
  final String comment;

  /// 'waiting' | 'invited' | 'seated' | 'left'
  final String status;

  /// Обещанное время ожидания в минутах — что сказали гостю.
  final int promisedMinutes;

  final DateTime createdAt;
  final DateTime? invitedAt;
  final String source; // 'kolibri' | 'pos'

  const WaitlistEntry({
    required this.id,
    required this.guestName,
    this.phone = '',
    this.clientUid = '',
    this.guestsCount = 2,
    this.comment = '',
    this.status = 'waiting',
    this.promisedMinutes = 0,
    required this.createdAt,
    this.invitedAt,
    this.source = 'pos',
  });

  int get waitingMinutes => DateTime.now().difference(createdAt).inMinutes;
  bool get isOpen => status == 'waiting' || status == 'invited';

  factory WaitlistEntry.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final created = d['createdAt'];
    final invited = d['invitedAt'];
    return WaitlistEntry(
      id: doc.id,
      guestName: d['guestName'] ?? 'Гость',
      phone: d['phone'] ?? '',
      clientUid: d['clientUid'] ?? '',
      guestsCount: (d['guestsCount'] as num?)?.toInt() ?? 2,
      comment: d['comment'] ?? '',
      status: d['status'] ?? 'waiting',
      promisedMinutes: (d['promisedMinutes'] as num?)?.toInt() ?? 0,
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      invitedAt: invited is Timestamp ? invited.toDate() : null,
      source: d['source'] ?? 'pos',
    );
  }

  Map<String, dynamic> toMap() => {
        'guestName': guestName,
        'phone': phone,
        'clientUid': clientUid,
        'guestsCount': guestsCount,
        'comment': comment,
        'status': status,
        'promisedMinutes': promisedMinutes,
        'createdAt': Timestamp.fromDate(createdAt),
        'invitedAt': invitedAt != null ? Timestamp.fromDate(invitedAt!) : null,
        'source': source,
      };
}

// ---------------------------------------------------------- сертификаты

/// Подарочный сертификат — код на бонусы.
///
/// Заведение выпускает код на определённую сумму и на определённое число
/// активаций, постит его в Telegram-канале, а гость вводит код у себя в
/// приложении. Каждому успевшему на бонусный счёт падает вся указанная
/// сумма: сертификат «1000 ₽, 3 активации» — это тысяча троим, а не
/// тысяча на всех.
///
/// Бонусами гость платит на кассе как обычно, поэтому отдельного способа
/// оплаты «сертификатом» не нужно: сертификат превращается в бонусы один
/// раз, при активации.
///
/// Коллекция: giftCards, id документа = код.
class GiftCard {
  final String code;

  /// Сколько бонусов получает КАЖДЫЙ успевший гость.
  final double bonusAmount;

  /// Сколько гостей всего может активировать код. 0 — без ограничения.
  final int maxUses;

  /// Сколько уже активировали.
  final int usedCount;

  final bool active;
  final DateTime createdAt;
  final DateTime? expiresAt;

  /// Заметка для администратора: «пост в ТГ 14 сентября».
  final String comment;
  final String issuedBy;

  const GiftCard({
    required this.code,
    required this.bonusAmount,
    this.maxUses = 0,
    this.usedCount = 0,
    this.active = true,
    required this.createdAt,
    this.expiresAt,
    this.comment = '',
    this.issuedBy = '',
  });

  bool get hasUsesLeft => maxUses <= 0 || usedCount < maxUses;

  /// Сколько активаций осталось; null — без ограничения.
  int? get usesLeft => maxUses <= 0 ? null : (maxUses - usedCount).clamp(0, maxUses);

  bool get isExpired => expiresAt != null && !expiresAt!.isAfter(DateTime.now());

  bool get isUsable => active && hasUsesLeft && !isExpired && bonusAmount > 0;

  /// Почему код не сработает — текст для гостя. null, если всё в порядке.
  String? get problem {
    if (!active) return 'Этот сертификат больше не действует.';
    if (isExpired) return 'Срок действия сертификата истёк.';
    if (!hasUsesLeft) return 'Сертификат разобрали — активации закончились.';
    if (bonusAmount <= 0) return 'Этот сертификат ничего не начисляет.';
    return null;
  }

  factory GiftCard.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final created = d['createdAt'];
    final expires = d['expiresAt'];
    return GiftCard(
      code: doc.id,
      // faceValue — имя поля из прежней версии, где сертификат был
      // кошельком. Читаем и его, чтобы выпущенные раньше коды не
      // превратились в «сертификат на 0 бонусов».
      bonusAmount: (d['bonusAmount'] ?? d['faceValue'] ?? 0).toDouble(),
      maxUses: (d['maxUses'] as num?)?.toInt() ?? 0,
      usedCount: (d['usedCount'] as num?)?.toInt() ?? 0,
      active: d['active'] ?? true,
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      expiresAt: expires is Timestamp ? expires.toDate() : null,
      comment: d['comment'] ?? '',
      issuedBy: d['issuedBy'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {
        'bonusAmount': bonusAmount,
        'maxUses': maxUses,
        'usedCount': usedCount,
        'active': active,
        'createdAt': Timestamp.fromDate(createdAt),
        'expiresAt': expiresAt != null ? Timestamp.fromDate(expiresAt!) : null,
        'comment': comment,
        'issuedBy': issuedBy,
      };
}

/// Заявка гостя на активацию сертификата.
///
/// Гость не может начислить себе бонусы сам — правила базы это запрещают,
/// и правильно делают: иначе любой желающий выписывал бы себе сколько
/// угодно. Поэтому гость оставляет заявку, а начисляет её касса, у которой
/// права есть. Пока заведение работает, это занимает секунды.
///
/// Здесь же решается, кто «успел»: заявки обрабатываются по времени
/// создания, и когда активации кончаются, остальным приходит отказ.
///
/// Коллекция: giftCardClaims.
class GiftCardClaim {
  final String id;
  final String code;
  final String clientUid;

  /// 'new' — ждёт начисления, 'granted' — начислено, 'rejected' — отказ.
  final String status;

  /// Причина отказа — её видит гость.
  final String reason;

  /// Сколько начислено (для 'granted').
  final double amount;

  final DateTime createdAt;
  final DateTime? processedAt;

  const GiftCardClaim({
    required this.id,
    required this.code,
    required this.clientUid,
    this.status = 'new',
    this.reason = '',
    this.amount = 0,
    required this.createdAt,
    this.processedAt,
  });

  bool get isPending => status == 'new';
  bool get isGranted => status == 'granted';

  factory GiftCardClaim.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final created = d['createdAt'];
    final processed = d['processedAt'];
    return GiftCardClaim(
      id: doc.id,
      code: d['code'] ?? '',
      clientUid: d['clientUid'] ?? '',
      status: d['status'] ?? 'new',
      reason: d['reason'] ?? '',
      amount: (d['amount'] ?? 0).toDouble(),
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      processedAt: processed is Timestamp ? processed.toDate() : null,
    );
  }

  Map<String, dynamic> toMap() => {
        'code': code,
        'clientUid': clientUid,
        'status': status,
        'reason': reason,
        'amount': amount,
        'createdAt': Timestamp.fromDate(createdAt),
        'processedAt': processedAt != null ? Timestamp.fromDate(processedAt!) : null,
      };
}
