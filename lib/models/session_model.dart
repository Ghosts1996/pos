import 'package:cloud_firestore/cloud_firestore.dart';

class OrderItem {
  // Id позиции меню, из которой добавлена эта строка заказа.
  // Нужен, чтобы при повторном добавлении той же позиции увеличивалось
  // количество, а не создавалась вторая отдельная строка.
  final String menuItemId;
  final String name;
  final double price;
  final int qty;

  OrderItem({
    this.menuItemId = '',
    required this.name,
    required this.price,
    required this.qty,
  });

  factory OrderItem.fromMap(Map<String, dynamic> m) => OrderItem(
        menuItemId: m['menuItemId'] ?? '',
        name: m['name'] ?? '',
        price: (m['price'] ?? 0).toDouble(),
        qty: m['qty'] ?? 1,
      );

  Map<String, dynamic> toMap() =>
      {'menuItemId': menuItemId, 'name': name, 'price': price, 'qty': qty};

  OrderItem copyWith({int? qty}) => OrderItem(
        menuItemId: menuItemId,
        name: name,
        price: price,
        qty: qty ?? this.qty,
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

  // ---- Возврат чека (раздел "История чеков и возврат" у сотрудника) ----
  final bool refunded;
  final DateTime? refundedAt;

  SessionModel({
    required this.id,
    required this.tableId,
    required this.tableName,
    required this.employeeName,
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
    this.refunded = false,
    this.refundedAt,
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
      refunded: data['refunded'] ?? false,
      refundedAt: data['refundedAt'] != null ? (data['refundedAt'] as Timestamp).toDate() : null,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'tableId': tableId,
      'tableName': tableName,
      'employeeName': employeeName,
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
      'refunded': refunded,
      'refundedAt': refundedAt != null ? Timestamp.fromDate(refundedAt!) : null,
    };
  }

  double get orderTotal => orderItems.fold(0.0, (sum, item) => sum + item.total);

  double get totalWithDiscount => orderTotal * (1 - discountPercent / 100);

  /// Сумма, фактически принятая при оплате (нал + карта + терминал + за счёт заведения)
  double get paymentTotal => paymentCash + paymentCard + paymentTerminal + paymentComp;

  Duration get remaining => plannedEnd.difference(DateTime.now());
}