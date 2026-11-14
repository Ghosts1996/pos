// Выручка «до копейки»: Z-отчёт кассы на тех же чеках, что бот и кабинет
// (saas-gateway/test-fixtures/revenue-sessions.json, JS-сторона —
// saas-gateway/test.revenue-parity.js). Числа должны совпасть.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/shift_model.dart';
import 'package:hookah_pos/utils/promo_policy.dart';
import 'package:hookah_pos/utils/z_report.dart';

void main() {
  test('Z-отчёт = бот = кабинет на одних и тех же чеках', () {
    final fx = jsonDecode(File('saas-gateway/test-fixtures/revenue-sessions.json').readAsStringSync()) as Map<String, dynamic>;
    final period = fx['period'] as Map<String, dynamic>;
    final from = (period['from'] as num).toInt(), to = (period['to'] as num).toInt();
    bool inP(Object? v) => v is num && v >= from && v < to;
    DateTime? at(Object? v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
    PromoPolicy.excludeTobacco = fx['excludeTobacco'] as bool;
    final all = [
      for (final raw in (fx['sessions'] as List).cast<Map<String, dynamic>>())
        (
          raw,
          SessionModel(
            id: raw['id'] as String,
            tableId: 't',
            tableName: 'Стол',
            employeeName: 'Анна',
            startTime: DateTime.fromMillisecondsSinceEpoch(0),
            plannedEnd: DateTime.fromMillisecondsSinceEpoch(0),
            status: raw['status'] as String,
            closedAt: at(raw['closedAt']),
            discountPercent: (raw['discountPercent'] as num?)?.toDouble() ?? 0,
            paymentCash: (raw['paymentCash'] as num?)?.toDouble() ?? 0,
            paymentCard: (raw['paymentCard'] as num?)?.toDouble() ?? 0,
            paymentComp: (raw['paymentComp'] as num?)?.toDouble() ?? 0,
            closedWithoutPayment: raw['closedWithoutPayment'] == true,
            refunded: raw['refunded'] == true,
            refundedAt: at(raw['refundedAt']),
            orderItems: [
              for (final i in (raw['orderItems'] as List).cast<Map<String, dynamic>>())
                OrderItem(
                  menuItemId: i['name'] as String,
                  name: i['name'] as String,
                  price: (i['price'] as num).toDouble(),
                  qty: (i['qty'] as num).toInt(),
                  noPromo: i['noPromo'] == true,
                ),
            ],
          )
        ),
    ];
    // Как касса собирает Z-отчёт: чеки, закрытые за смену, и возвраты, оформленные за смену.
    final sold = [for (final (raw, s) in all) if (inP(raw['closedAt'])) s];
    final refunds = [for (final (raw, s) in all) if (inP(raw['refundedAt'])) s];
    final z = ZReport.build(
      number: 1,
      shift: ShiftModel(id: 'sh', openedAt: DateTime.fromMillisecondsSinceEpoch(from), openedBy: 'Анна'),
      closedAt: DateTime.fromMillisecondsSinceEpoch(to),
      closedBy: 'Анна',
      sold: sold,
      refunds: refunds,
      ops: const [],
    );
    final exp = fx['expected'] as Map<String, dynamic>;
    expect(z.salesTotal, (exp['sales'] as num).toDouble());
    expect(z.refundsTotal, (exp['refunds'] as num).toDouble());
    expect(z.revenue, (exp['revenue'] as num).toDouble());
    expect(z.salesCount, (exp['checks'] as num).toInt());
  });
}
