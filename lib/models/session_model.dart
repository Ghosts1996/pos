import 'package:cloud_firestore/cloud_firestore.dart';

import '../utils/promo_policy.dart';

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

  OrderItem({
    this.menuItemId = '',
    required this.name,
    required this.price,
    required this.qty,
    this.noPromo = false,
  });

  factory OrderItem.fromMap(Map<String, dynamic> m) => OrderItem(
        menuItemId: m['menuItemId'] ?? '',
        name: m['name'] ?? '',
        price: (m['price'] ?? 0).toDouble(),
        qty: m['qty'] ?? 1,
        noPromo: m['noPromo'] == true,
      );

  Map<String, dynamic> toMap() => {
        'menuItemId': menuItemId,
        'name': name,
        'price': price,
        'qty': qty,
        if (noPromo) 'noPromo': true,
      };

  OrderItem copyWith({int? qty}) => OrderItem(
        menuItemId: menuItemId,
        name: name,
        price: price,
        qty: qty ?? this.qty,
        noPromo: noPromo,
      );

  double get total => price * qty;
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
  /// госту/CRM — просто текстовая метка для наглядности на карте зала.
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
      tableId: data['tableId'] ?? '',
      tableName: data['tableName'] ?? '',
      employeeName: data['employeeName'] ?? '',
      employeeId: data['employeeId'] ?? '',
      guestTag: data['guestTag'] ?? '',
      startTime: start is Timestamp ? start.toDate() : now,
      plannedEnd: end is Timestamp ? end.toDate() : now,
      refillCount: data['refillCount'] ?? 0,
      refillHistory: ((data['refillHistory'] ?? []) as List)
          .map((e) => RefillEvent.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      discountCardId: data['discountCardId'],
      discountPercent: (data['discountPercent'] ?? 0).toDouble(),
      orderItems: ((data['orderItems'] ?? []) as List)
          .map((e) => OrderItem.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      status: data['status'] ?? 'active',
      closedAt: data['closedAt'] != null ? (data['closedAt'] as Timestamp).toDate() : null,
      paymentCash: (data['paymentCash'] ?? 0).toDouble(),
      paymentCard: (data['paymentCard'] ?? 0).toDouble(),
      paymentTerminal: (data['paymentTerminal'] ?? 0).toDouble(),
      paymentComp: (data['paymentComp'] ?? 0).toDouble(),
      guestContact: data['guestContact'] ?? '',
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