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
    };
  }

  double get orderTotal => orderItems.fold(0.0, (sum, item) => sum + item.total);

  double get totalWithDiscount => orderTotal * (1 - discountPercent / 100);

  Duration get remaining => plannedEnd.difference(DateTime.now());
}
