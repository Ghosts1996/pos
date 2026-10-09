import 'package:cloud_firestore/cloud_firestore.dart';

import '../utils/promo_policy.dart';
import '../utils/parse.dart';
import '../utils/sale_kind.dart';

class OrderItem {
  // Id позиции меню, из которой добавлена эта строка заказа.
  // Нужен, чтобы при повторном добавлении той же позиции увеличивалось
  // количество, а не создавалась вторая отдельная строка.
  final String menuItemId;
  final String name;
  final double price;
  final int qty;

  /// Табачная/никотиновая позиция (кальян) — без скидок и бонусов, см.
  /// PromoPolicy. Ставится при добавлении по названию позиции и категории.
  final bool noPromo;

  /// Вид продажи (SaleKind: kitchen, bar, hookah) — ставится при
  /// добавлении по категории меню. Пусто у старых строк, см. [effectiveKind].
  final String kind;

  /// Кто сколько штук добавил: id сотрудника → количество. Одна строка
  /// копит количество от разных людей (два «Мохито» от двух барменов),
  /// поэтому учёт — внутри строки. Сумма может быть меньше [qty]: штуки
  /// без автора (заказ гостя до обновления, старые чеки) идут в общий
  /// котёл смены, см. PayrollSales.
  final Map<String, int> by;

  /// Пожелание к строке: «без льда», «покрепче», «один лёгкий, один
  /// крепкий». Одно на всю строку — строка в счёте одна на позицию меню.
  /// Видно в счёте, в очереди заказов и на бумажном чеке.
  final String note;

  /// Длина пожелания: хватает на «два без льда, один с лимоном».
  static const noteMaxLength = 120;

  /// Сколько штук уже готово — отметили на экране «Кухня и бар». Остальные
  /// ([pending]) ждут повара, бармена или кальянщика.
  final int ready;

  /// С какого момента ждут неготовые штуки: ставится, когда у строки
  /// появляется неготовое (новая строка или «+» к уже готовой). Время
  /// устройства, которое добавило, — для «ждут 12 мин» на экране кухни.
  final DateTime? since;

  /// Сколько штук уже ушло на кухню или бар бумажным бегунком — чтобы
  /// следующий бегунок печатал только новое.
  final int sent;

  /// Выбранные модификаторы («Кокосовое молоко», «Medium»). Цена строки уже
  /// включает доплаты. Строки одной позиции с разными модификаторами — разные
  /// строки, см. [lineId].
  final List<String> mods;

  OrderItem({
    this.menuItemId = '',
    required this.name,
    required this.price,
    required this.qty,
    this.noPromo = false,
    this.kind = '',
    this.by = const {},
    this.note = '',
    int ready = 0,
    this.since,
    int sent = 0,
    this.mods = const [],
  })  : ready = _clampQty(ready, qty),
        sent = _clampQty(sent, qty);

  static int _clampQty(int v, int qty) => v < 0 ? 0 : (v > qty ? (qty < 0 ? 0 : qty) : v);

  /// Штук ещё не готово.
  int get pending => qty - ready;

  /// Ключ строки в счёте: позиция меню + её модификаторы.
  String get lineId => lineIdOf(menuItemId, mods);
  static String lineIdOf(String menuItemId, List<String> mods) =>
      mods.isEmpty ? menuItemId : '$menuItemId|${mods.join('|')}';

  /// Название с модификаторами — для чеков, бегунков и предчека.
  String get displayName => mods.isEmpty ? name : '$name (${mods.join(', ')})';

  /// Штук для следующего бегунка: не отправленные и не отмеченные готовыми.
  /// Строки без «ждёт с» — из чеков до бегунков, их давно вынесли.
  int get unsent => since == null ? 0 : qty - (sent > ready ? sent : ready);

  static String cleanNote(Object? raw) {
    final s = (raw ?? '').toString().replaceAll(RegExp(r'\s+'), ' ').trim();
    return s.length > noteMaxLength ? s.substring(0, noteMaxLength) : s;
  }

  /// Строки заказа приходят и от гостя (guestOrders, предзаказ) — дробное
  /// количество или цена строкой роняли бы разбор всего списка заказов.
  factory OrderItem.fromMap(Map<String, dynamic> m) {
    final rawBy = m['by'];
    final by = <String, int>{};
    if (rawBy is Map) {
      rawBy.forEach((k, v) {
        if (k is String && k.isNotEmpty && v is num && v > 0) by[k] = v.toInt();
      });
    }
    return OrderItem(
      menuItemId: m['menuItemId']?.toString() ?? '',
      name: m['name']?.toString() ?? '',
      price: m['price'] is num ? (m['price'] as num).toDouble() : 0,
      qty: m['qty'] is num ? (m['qty'] as num).toInt() : 1,
      noPromo: m['noPromo'] == true,
      kind: SaleKind.normalize(m['kind'] as String?),
      by: by,
      note: cleanNote(m['note']),
      ready: m['ready'] is num ? (m['ready'] as num).toInt() : 0,
      since: m['since'] is num ? DateTime.fromMillisecondsSinceEpoch((m['since'] as num).toInt()) : null,
      sent: m['sent'] is num ? (m['sent'] as num).toInt() : 0,
      mods: m['mods'] is List
          ? [for (final v in m['mods'] as List) if (v != null && v.toString().trim().isNotEmpty) v.toString().trim()]
          : const [],
    );
  }

  Map<String, dynamic> toMap() => {
        'menuItemId': menuItemId,
        'name': name,
        'price': price,
        'qty': qty,
        if (noPromo) 'noPromo': true,
        if (kind.isNotEmpty) 'kind': kind,
        if (by.isNotEmpty) 'by': by,
        if (note.isNotEmpty) 'note': note,
        if (ready > 0) 'ready': ready,
        if (since != null) 'since': since!.millisecondsSinceEpoch,
        if (sent > 0) 'sent': sent,
        if (mods.isNotEmpty) 'mods': mods,
      };

  /// Всё готово: [ready] = [qty].
  OrderItem markReady() => _with(ready: qty);

  /// Бегунок напечатан: на кухню ушло [count] штук (сколько было в строке
  /// на момент печати — добавленное за это время уйдёт следующим).
  OrderItem markSent(int count) => count > sent ? _with(sent: count) : this;

  /// Та же строка с другим пожеланием (пусто — убрать).
  OrderItem withNote(String value) => _with(note: cleanNote(value));

  OrderItem _with({String? note, int? ready, int? sent}) => OrderItem(
      menuItemId: menuItemId, name: name, price: price, qty: qty, noPromo: noPromo, kind: kind, by: by,
      note: note ?? this.note, ready: ready ?? this.ready, since: since, sent: sent ?? this.sent, mods: mods);

  /// Новое количество. Если штук стало меньше, учёт авторов урезается с
  /// самых крупных долей — сумма никогда не больше [qty].
  OrderItem copyWith({int? qty}) {
    final q = qty ?? this.qty;
    return OrderItem(
      menuItemId: menuItemId,
      name: name,
      price: price,
      qty: q,
      noPromo: noPromo,
      kind: kind,
      by: _fitBy(by, q),
      note: note,
      ready: ready,
      since: since,
      sent: sent,
      mods: mods,
    );
  }

  /// Ещё [n] штук от сотрудника [employeeId] (пусто — без автора).
  OrderItem plus(int n, {String employeeId = ''}) {
    final next = Map<String, int>.from(by);
    if (employeeId.isNotEmpty && n > 0) next[employeeId] = (next[employeeId] ?? 0) + n;
    return OrderItem(
      menuItemId: menuItemId,
      name: name,
      price: price,
      qty: qty + n,
      noPromo: noPromo,
      kind: kind,
      by: next,
      note: note,
      ready: ready,
      // Было всё готово — новые штуки ждут с этой минуты.
      since: n > 0 && pending <= 0 ? DateTime.now() : since,
      sent: sent,
      mods: mods,
    );
  }

  /// Минус [n] штук. Убираем сначала штуки того, кто убирает ([employeeId]),
  /// потом без автора, потом с самых крупных долей: свою позицию убрать
  /// можно, а «переписать» чужую на себя — нет.
  OrderItem minus(int n, {String employeeId = ''}) {
    final q = qty - n;
    if (q <= 0) return copyWith(qty: 0);
    final next = Map<String, int>.from(by);
    var left = n;
    final mine = next[employeeId] ?? 0;
    if (employeeId.isNotEmpty && mine > 0) {
      final take = mine < left ? mine : left;
      next[employeeId] = mine - take;
      left -= take;
    }
    final unattributed = qty - by.values.fold<int>(0, (a, b) => a + b);
    left -= unattributed < left ? (unattributed < 0 ? 0 : unattributed) : left;
    next.removeWhere((_, v) => v <= 0);
    return OrderItem(
      menuItemId: menuItemId,
      name: name,
      price: price,
      qty: q,
      noPromo: noPromo,
      kind: kind,
      by: _fitBy(next, q),
      note: note,
      ready: ready,
      since: since,
      sent: sent,
      mods: mods,
    );
  }

  /// Часть строки на [n] штук — для «Разделить счёт». Авторы уходят вместе
  /// со штуками: сначала забираем штуки без автора, потом по порядку.
  /// Возвращает (уходит, остаётся).
  (OrderItem, OrderItem?) split(int n) {
    if (n >= qty) return (this, null);
    final attributed = by.values.fold<int>(0, (a, b) => a + b);
    var unattributed = qty - attributed;
    final taken = <String, int>{};
    final kept = Map<String, int>.from(by);
    var left = n - (unattributed < n ? unattributed : n);
    unattributed = 0;
    for (final id in by.keys) {
      if (left <= 0) break;
      final have = kept[id] ?? 0;
      final take = have < left ? have : left;
      if (take <= 0) continue;
      taken[id] = take;
      kept[id] = have - take;
      left -= take;
    }
    kept.removeWhere((_, v) => v <= 0);
    // Готовые штуки уходят первыми — их уже вынесли гостю. Так же и
    // отправленные бегунком: их уже готовят.
    final readyOut = ready < n ? ready : n;
    final sentOut = sent < n ? sent : n;
    OrderItem part(int q, Map<String, int> b, int r, int sn) => OrderItem(
        menuItemId: menuItemId, name: name, price: price, qty: q, noPromo: noPromo, kind: kind, by: b, note: note,
        ready: r, since: since, sent: sn, mods: mods);
    return (part(n, taken, readyOut, sentOut), part(qty - n, kept, ready - readyOut, sent - sentOut));
  }

  /// Вид продажи: записанный при добавлении, а у старых строк — по
  /// признаку табака (кальян) или «кухня».
  String get effectiveKind {
    if (kind.isNotEmpty) return kind;
    return noPromo || PromoPolicy.looksTobacco(name) ? SaleKind.hookah : SaleKind.kitchen;
  }

  double get total => price * qty;

  static Map<String, int> _fitBy(Map<String, int> by, int qty) {
    var sum = by.values.fold<int>(0, (a, b) => a + b);
    if (sum <= qty) return by;
    final next = Map<String, int>.from(by);
    final ids = next.keys.toList()..sort((a, b) => next[b]!.compareTo(next[a]!));
    for (final id in ids) {
      if (sum <= qty) break;
      final cut = sum - qty < next[id]! ? sum - qty : next[id]!;
      next[id] = next[id]! - cut;
      sum -= cut;
    }
    next.removeWhere((_, v) => v <= 0);
    return next;
  }
}

class RefillEvent {
  final DateTime time;
  RefillEvent(this.time);

  factory RefillEvent.fromMap(Map<String, dynamic> m) {
    final t = m['time'];
    return RefillEvent(t is Timestamp ? t.toDate() : DateTime.now());
  }

  Map<String, dynamic> toMap() => {'time': Timestamp.fromDate(time)};
}

/// Модель сеанса (открытого счёта) за столом
class SessionModel {
  final String id;
  final String tableId;
  final String tableName;
  final String employeeName;

  /// Id сотрудника, открывшего стол, — по нему, а не по имени, считается
  /// процент с продаж. Пусто у старых чеков — тогда сопоставляем по имени.
  final String employeeId;

  /// Подпись чека — кто сидит за столом / чей это счёт (например, имя
  /// гостя или номер компании: "Аня", "Компания у окна"). Задаётся и
  /// меняется сотрудником вручную на экране стола, не привязана к
  /// гостю/CRM — просто текстовая метка для наглядности на карте зала.
  final String guestTag;

  final DateTime startTime;
  final DateTime plannedEnd;
  final int refillCount;
  final List<RefillEvent> refillHistory;
  final String? discountCardId;
  final double discountPercent;
  final List<OrderItem> orderItems;
  final String status; // 'active' | 'closed'
  final DateTime? closedAt;

  // ---- Оплата (заполняется на экране оплаты при закрытии чека) ----
  final double paymentCash; // сколько оплачено наличными
  final double paymentCard; // сколько оплачено картой (ручной ввод/сайт, без физического терминала)
  final double paymentTerminal; // сколько оплачено через платёжный терминал (эквайринг)
  final double paymentComp; // сколько списано за счёт заведения
  final String guestContact; // телефон/email гостя, необязательно
  final bool closedWithoutPayment; // стол закрыт без фактической оплаты
  final bool receiptPrinted;
  final bool fiscalReceiptPrinted;

  // ---- Чаевые, принятые вместе с оплатой ----
  // Не выручка: в paymentCash/paymentCard их нет, в фискальный чек они не
  // идут. Хранятся отдельно, чтобы X-отчёт сходился с наличными в кассе.
  final double tipsCash;
  final double tipsCard; // картой и с терминала

  // ---- Возврат чека (раздел "История чеков и возврат" у сотрудника) ----
  final bool refunded;
  final DateTime? refundedAt;

  /// Деньги за возвращённый чек выданы из кассы наличными — записан
  /// расход «Возврат наличными» (см. CashOp). У старых возвратов признака
  /// нет: они не считаются ни в приход, ни в расход наличных.
  final bool refundCashOut;

  SessionModel({
    required this.id,
    required this.tableId,
    required this.tableName,
    required this.employeeName,
    this.employeeId = '',
    this.guestTag = '',
    required this.startTime,
    required this.plannedEnd,
    this.refillCount = 0,
    this.refillHistory = const [],
    this.discountCardId,
    this.discountPercent = 0,
    this.orderItems = const [],
    this.status = 'active',
    this.closedAt,
    this.paymentCash = 0,
    this.paymentCard = 0,
    this.paymentTerminal = 0,
    this.paymentComp = 0,
    this.guestContact = '',
    this.closedWithoutPayment = false,
    this.receiptPrinted = false,
    this.fiscalReceiptPrinted = false,
    this.tipsCash = 0,
    this.tipsCard = 0,
    this.refunded = false,
    this.refundedAt,
    this.refundCashOut = false,
  });

  factory SessionModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final start = data['startTime'];
    final end = data['plannedEnd'];
    final now = DateTime.now();
    return SessionModel(
      id: doc.id,
      tableId: asText(data['tableId']),
      tableName: asText(data['tableName']),
      employeeName: asText(data['employeeName']),
      employeeId: asText(data['employeeId']),
      guestTag: asText(data['guestTag']),
      startTime: start is Timestamp ? start.toDate() : now,
      plannedEnd: end is Timestamp ? end.toDate() : now,
      refillCount: data['refillCount'] ?? 0,
      refillHistory: asList(data['refillHistory'])
          .whereType<Map>().map((e) => RefillEvent.fromMap(Map<String, dynamic>.from(e)))
          .toList(),
      discountCardId: data['discountCardId'],
      discountPercent: (data['discountPercent'] ?? 0).toDouble(),
      orderItems: asList(data['orderItems'])
          .whereType<Map>().map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e)))
          .toList(),
      status: asText(data['status'], 'active'),
      closedAt: data['closedAt'] != null ? (data['closedAt'] as Timestamp).toDate() : null,
      paymentCash: (data['paymentCash'] ?? 0).toDouble(),
      paymentCard: (data['paymentCard'] ?? 0).toDouble(),
      paymentTerminal: (data['paymentTerminal'] ?? 0).toDouble(),
      paymentComp: (data['paymentComp'] ?? 0).toDouble(),
      guestContact: asText(data['guestContact']),
      closedWithoutPayment: data['closedWithoutPayment'] ?? false,
      receiptPrinted: data['receiptPrinted'] ?? false,
      fiscalReceiptPrinted: data['fiscalReceiptPrinted'] ?? false,
      tipsCash: (data['tipsCash'] ?? 0).toDouble(),
      tipsCard: (data['tipsCard'] ?? 0).toDouble(),
      refunded: data['refunded'] ?? false,
      refundedAt: data['refundedAt'] != null ? (data['refundedAt'] as Timestamp).toDate() : null,
      refundCashOut: data['refundCashOut'] == true,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'tableId': tableId,
      'tableName': tableName,
      'employeeName': employeeName,
      'employeeId': employeeId,
      'guestTag': guestTag,
      'startTime': Timestamp.fromDate(startTime),
      'plannedEnd': Timestamp.fromDate(plannedEnd),
      'refillCount': refillCount,
      'refillHistory': refillHistory.map((e) => e.toMap()).toList(),
      'discountCardId': discountCardId,
      'discountPercent': discountPercent,
      'orderItems': orderItems.map((e) => e.toMap()).toList(),
      'status': status,
      'closedAt': closedAt != null ? Timestamp.fromDate(closedAt!) : null,
      'paymentCash': paymentCash,
      'paymentCard': paymentCard,
      'paymentTerminal': paymentTerminal,
      'paymentComp': paymentComp,
      'guestContact': guestContact,
      'closedWithoutPayment': closedWithoutPayment,
      'receiptPrinted': receiptPrinted,
      'fiscalReceiptPrinted': fiscalReceiptPrinted,
      'tipsCash': tipsCash,
      'tipsCard': tipsCard,
      'refunded': refunded,
      'refundedAt': refundedAt != null ? Timestamp.fromDate(refundedAt!) : null,
      'refundCashOut': refundCashOut,
    };
  }

  double get orderTotal => orderItems.fold(0.0, (acc, item) => acc + item.total);

  /// Скидка — только на позиции, которые можно удешевлять (кальяны по
  /// умолчанию нет, см. PromoPolicy).
  double get promoBase => PromoPolicy.promoBase(orderItems);
  double get totalWithDiscount => orderTotal - promoBase * discountPercent / 100;

  /// Сумма, фактически принятая при оплате (нал + карта + терминал + за счёт заведения)
  double get paymentTotal => paymentCash + paymentCard + paymentTerminal + paymentComp;

  Duration get remaining => plannedEnd.difference(DateTime.now());
}