import 'package:cloud_firestore/cloud_firestore.dart';
import '../utils/venue_terms.dart';
import '../utils/parse.dart';
import '../utils/ru_requisites.dart';
import '../build_info.dart';
import 'online_pay.dart';
import '../services/people_directory.dart';

export '../utils/venue_terms.dart';

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

  /// Тип заведения: 'hookah' | 'restaurant' | 'cafe' | 'bar' (VenueTerms).
  /// От него зависят слова в приложении гостя и кнопки вызова: угли и
  /// перезабивка — только у кальянной. Без поля считаем кальянной.
  final String venueType;

  /// Переключатель «Заведение с кальянами» (см. VenueTerms.isHookah).
  /// null — владелец его ещё не трогал: кальяны включены у кальянной.
  final bool? hookahEnabled;

  /// Гость может оставить чаевые из приложения.
  final bool tipsEnabled;

  /// Кроме конкретного сотрудника, гостю доступен вариант «Всей смене» —
  /// сумма делится поровну между теми, кто был на смене в этот момент.
  final bool tipsTeamEnabled;

  /// Гость оплачивает онлайн из приложения — счёт за столом и заказ
  /// доставки (через банк из «Интеграций»; реквизиты остаются на сервере).
  final bool guestSbpPay;

  /// Какой банк подключён для онлайн-оплаты гостей (OnlinePayProvider.id),
  /// пусто — не подключён. Ставит шлюз, когда банк подтвердил реквизиты
  /// («Сохранить и проверить подключение»); в toMap() не входит.
  final String onlinePay;

  /// Реквизиты продавца — их видит гость перед заказом и оплатой из
  /// приложения (ст. 9 и 26.1 закона «О защите прав потребителей»):
  /// ООО «…» или ИП Фамилия И. О., ИНН, ОГРН/ОГРНИП, адрес.
  final String sellerName;
  final String sellerInn;
  final String sellerOgrn;
  final String sellerAddress;

  /// Модуль «С собой и доставка»: кнопка в зале кассы. Выключение прячет её
  /// на всех кассах сразу, без перезапуска.
  final bool deliveryEnabled;

  /// Где имена и телефоны людей: 'rf' — только в справочнике в РФ (People),
  /// в документах Firestore их нет; иначе — ещё и в Firestore, пока все
  /// кассы не обновились. Ставит сервер при переносе; в toMap() не входит.
  final String piiMode;

  /// Реквизиты продавца заполнены верно: без них заказ и оплата из
  /// приложения недоступны. Те же правила — в saas-gateway (sellerReady).
  bool get sellerReady =>
      sellerName.trim().length >= 3 &&
      RegExp(r'^(\d{10}|\d{12})$').hasMatch(sellerInn) &&
      RegExp(r'^(\d{13}|\d{15})$').hasMatch(sellerOgrn) &&
      requisitesValid(sellerInn, sellerOgrn) &&
      sellerAddress.trim().length >= 5;

  /// Одной строкой — под оформлением заказа и оплатой.
  String get sellerLine => sellerReady
      ? 'Продавец: ${sellerName.trim()}, ИНН $sellerInn, ${sellerOgrn.length == 15 ? 'ОГРНИП' : 'ОГРН'} $sellerOgrn, '
          '${sellerAddress.trim()}'
      : '';

  /// Гость может заплатить онлайн: включено в профиле, банк подтвердил
  /// реквизиты и указан продавец.
  bool get onlinePayReady => guestSbpPay && OnlinePayProvider.byId(onlinePay) != null && sellerReady;

  const VenueProfile({
    // Пусто, пока владелец не заполнил профиль: подставлять чужое имя
    // нельзя — оно уходило в чек и в ИИ. См. VenueService.displayNameOf.
    this.name = '',
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
    this.venueType = VenueTerms.hookah,
    this.hookahEnabled,
    this.tipsEnabled = true,
    this.tipsTeamEnabled = true,
    this.guestSbpPay = false,
    this.onlinePay = '',
    this.deliveryEnabled = false,
    this.piiMode = '',
    this.sellerName = '',
    this.sellerInn = '',
    this.sellerOgrn = '',
    this.sellerAddress = '',
  });

  factory VenueProfile.fromMap(Map<String, dynamic>? data) {
    if (data == null) return const VenueProfile();
    return VenueProfile(
      name: asText(data['name']),
      address: asText(data['address']),
      phone: asText(data['phone']),
      about: asText(data['about']),
      workingHours: {
        for (final e in ((data['workingHours'] as Map?) ?? {}).entries)
          int.tryParse(e.key.toString()) ?? 1: e.value.toString(),
      },
      faq: asList(data['faq'])
          .whereType<Map>().map((e) => VenueFaq.fromMap(Map<String, dynamic>.from(e)))
          .toList(),
      rules: asText(data['rules']),
      depositFrom: (data['depositFrom'] ?? 0).toDouble(),
      depositGuests: asNum(data['depositGuests'])?.toInt() ?? 6,
      lat: (data['lat'] ?? 0).toDouble(),
      lon: (data['lon'] ?? 0).toDouble(),
      // На платформе функций нет: флаг, включённый по ошибке, глушил бы
      // фоновые задания кассы и уведомления гостя.
      cloudFunctionsEnabled: !kSaasMode && data['cloudFunctionsEnabled'] == true,
      venueType: VenueTerms.normalize(asTextOrNull(data['venueType'])),
      hookahEnabled: data['hookahEnabled'] is bool ? data['hookahEnabled'] as bool : null,
      tipsEnabled: data['tipsEnabled'] != false,
      tipsTeamEnabled: data['tipsTeamEnabled'] != false,
      guestSbpPay: data['guestSbpPay'] == true,
      onlinePay: asText(data['onlinePay']),
      piiMode: asText(data['piiMode']),
      deliveryEnabled: data['deliveryEnabled'] == true,
      sellerName: asText(data['sellerName']),
      sellerInn: asText(data['sellerInn']),
      sellerOgrn: asText(data['sellerOgrn']),
      sellerAddress: asText(data['sellerAddress']),
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
        'venueType': venueType,
        if (hookahEnabled != null) 'hookahEnabled': hookahEnabled,
        'tipsEnabled': tipsEnabled,
        'tipsTeamEnabled': tipsTeamEnabled,
        'guestSbpPay': guestSbpPay,
        'deliveryEnabled': deliveryEnabled,
        'sellerName': sellerName,
        'sellerInn': sellerInn,
        'sellerOgrn': sellerOgrn,
        'sellerAddress': sellerAddress,
      };

  VenueTerms get terms => VenueTerms(venueType, withHookah: hookahEnabled);

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
    String? venueType,
    bool? hookahEnabled,
    bool? tipsEnabled,
    bool? tipsTeamEnabled,
    bool? guestSbpPay,
    bool? deliveryEnabled,
    String? sellerName,
    String? sellerInn,
    String? sellerOgrn,
    String? sellerAddress,
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
        venueType: venueType ?? this.venueType,
        hookahEnabled: hookahEnabled ?? this.hookahEnabled,
        tipsEnabled: tipsEnabled ?? this.tipsEnabled,
        tipsTeamEnabled: tipsTeamEnabled ?? this.tipsTeamEnabled,
        guestSbpPay: guestSbpPay ?? this.guestSbpPay,
        onlinePay: onlinePay,
        piiMode: piiMode,
        deliveryEnabled: deliveryEnabled ?? this.deliveryEnabled,
        sellerName: sellerName ?? this.sellerName,
        sellerInn: sellerInn ?? this.sellerInn,
        sellerOgrn: sellerOgrn ?? this.sellerOgrn,
        sellerAddress: sellerAddress ?? this.sellerAddress,
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
      title: asText(d['title'], 'Счастливые часы'),
      weekdays: asList(d['weekdays']).map((e) => (e as num).toInt()).toList(),
      fromMinutes: asNum(d['fromMinutes'])?.toInt() ?? 0,
      toMinutes: asNum(d['toMinutes'])?.toInt() ?? 0,
      discountPercent: (d['discountPercent'] ?? 0).toDouble(),
      categoryIds: asList(d['categoryIds']).map((e) => e.toString()).toList(),
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
  final String _guestName;
  String get guestName => _waitName(id, _guestName);
  final String _phone;
  String get phone => Pd.phone('waitlist', id, _phone);
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
    required String guestName,
    String phone = '',
    this.clientUid = '',
    this.guestsCount = 2,
    this.comment = '',
    this.status = 'waiting',
    this.promisedMinutes = 0,
    required this.createdAt,
    this.invitedAt,
    this.source = 'pos',
  }) : _guestName = guestName, _phone = phone;

  int get waitingMinutes => DateTime.now().difference(createdAt).inMinutes;
  bool get isOpen => status == 'waiting' || status == 'invited';

  factory WaitlistEntry.fromDoc(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>? ?? {};
    final created = d['createdAt'];
    final invited = d['invitedAt'];
    return WaitlistEntry(
      id: doc.id,
      guestName: asText(d['guestName']),
      phone: asText(d['phone']),
      clientUid: asText(d['clientUid']),
      guestsCount: asNum(d['guestsCount'])?.toInt() ?? 2,
      comment: asText(d['comment']),
      status: asText(d['status'], 'waiting'),
      promisedMinutes: asNum(d['promisedMinutes'])?.toInt() ?? 0,
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      invitedAt: invited is Timestamp ? invited.toDate() : null,
      source: asText(d['source'], 'pos'),
    );
  }

  Map<String, dynamic> toMap() => {
        if (Pd.mirror) 'guestName': guestName,
        if (Pd.mirror) 'phone': phone,
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

/// Имя в очереди; не назвался — «Гость».
String _waitName(String id, String legacy) {
  final n = Pd.name('waitlist', id, legacy);
  return n.trim().isEmpty ? 'Гость' : n;
}

// ---------------------------------------------------------- сертификаты

/// Подарочный сертификат — код на бонусы. Заведение выпускает код на сумму
/// и число активаций; каждому успевшему начисляется вся сумма (1000 ₽ на 3
/// активации — тысяча троим). Дальше это обычные бонусы.
///
/// Коллекция giftCards, id документа — код.
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
  final String _issuedBy;
  String get issuedBy => Pd.whoName(_issuedBy);

  const GiftCard({
    required this.code,
    required this.bonusAmount,
    this.maxUses = 0,
    this.usedCount = 0,
    this.active = true,
    required this.createdAt,
    this.expiresAt,
    this.comment = '',
    String issuedBy = '',
  }) : _issuedBy = issuedBy;

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
      // faceValue — старое имя поля: читаем, чтобы прежние коды не стали
      // «сертификатом на 0 бонусов».
      bonusAmount: (d['bonusAmount'] ?? d['faceValue'] ?? 0).toDouble(),
      maxUses: asNum(d['maxUses'])?.toInt() ?? 0,
      usedCount: asNum(d['usedCount'])?.toInt() ?? 0,
      active: d['active'] ?? true,
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      expiresAt: expires is Timestamp ? expires.toDate() : null,
      comment: asText(d['comment']),
      issuedBy: asText(d['issuedBy']),
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
      code: asText(d['code']),
      clientUid: asText(d['clientUid']),
      status: asText(d['status'], 'new'),
      reason: asText(d['reason']),
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
