import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../build_info.dart';
import '../data/app_db.dart';
import '../models/fiscal_receipt.dart';
import '../models/reservation_model.dart';
import 'app_scope.dart';
import 'fiscal_queue.dart';
import 'kassa_service.dart';
import 'net_status.dart';

/// Чек «аванс» за предоплату брони или банкета (SaaS, 54-ФЗ): деньги
/// пришли онлайн — чек нужен в момент оплаты, а не при посадке. Шлюз
/// (guest-pay.js) ставит брони `fiscalNeed: true`; любая касса с онлайн-
/// кассой забирает бронь в транзакции (`fiscalAuto.advance.claimBy`) и
/// пробивает «Аванс» (способ расчёта 3, предмет «платёж») на сумму, по
/// которой чека ещё нет. При посадке эта сумма идёт в счёт зачётом аванса
/// (payment_screen.dart, `advancePaid`).
class BookingFiscalService {
  BookingFiscalService._();
  static final BookingFiscalService instance = BookingFiscalService._();

  final String _device = const Uuid().v4();
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _sub;
  Timer? _timer;
  final Set<String> _busy = {};
  Set<String> _waiting = {};

  void start() {
    if (!kSaasMode || _sub != null) return;
    _sub = AppScope.col('reservations').where('fiscalNeed', isEqualTo: true).snapshots().listen((q) {
      _waiting = {for (final d in q.docs) d.id};
      for (final id in _waiting) {
        unawaited(_handle(id));
      }
    }, onError: (_) {});
    _timer = Timer.periodic(const Duration(minutes: 2), (_) {
      for (final id in _waiting) {
        unawaited(_handle(id));
      }
    });
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _handle(String id) async {
    if (!kassaService.isAvailable || _busy.contains(id) || !NetStatus.online.value) return;
    _busy.add(id);
    try {
      final ref = AppScope.col('reservations').doc(id);
      final snap = await ref.get();
      final raw = snap.data();
      if (raw == null) return;
      final r = ReservationModel.fromDoc(snap);
      final amount = advanceToFiscalize(r.prepaidTotal, r.advanceFiscalized);
      if (amount <= 0) {
        await ref.update({'fiscalNeed': false});
        return;
      }
      final claimed = await AppDb.instance.runTransaction<bool>((tx) async {
        final cur = (await tx.get(ref)).data();
        final slot = ((cur?['fiscalAuto'] as Map?)?['advance'] as Map?) ?? const {};
        final at = slot['claimAt'];
        final fresh = at is Timestamp && DateTime.now().difference(at.toDate()).inMinutes < 5;
        if (fresh && slot['claimBy'] != _device) return false;
        tx.update(ref, {
          'fiscalAuto.advance.claimBy': _device,
          'fiscalAuto.advance.claimAt': Timestamp.fromDate(DateTime.now()),
        });
        return true;
      }).catchError((Object _) => false);
      if (!claimed) return;
      final receipt = bookingAdvanceReceipt(
        reservationId: id,
        amount: amount,
        alreadyFiscalized: r.advanceFiscalized,
        banquet: r.kind == 'banquet',
        contact: r.phone,
      );
      final result = await FiscalQueue.send(receipt);
      final at = Timestamp.fromDate(DateTime.now());
      if (result.success || result.queued) {
        await ref.update({
          'fiscalAuto.advance.amount': FieldValue.increment(amount),
          'fiscalAuto.advance.ok': true,
          'fiscalAuto.advance.at': at,
          if (result.fiscalDocumentNumber != null) 'fiscalAuto.advance.fd': result.fiscalDocumentNumber,
          'fiscalAuto.advance.claimAt': FieldValue.delete(),
          'fiscalNeed': false,
        });
      } else {
        await ref.update({
          'fiscalAuto.advance.error': result.errorMessage ?? 'касса отклонила чек',
          'fiscalAuto.advance.at': at,
          'fiscalNeed': false,
        });
        await AppScope.col('waiterCalls').add({
          'tableId': r.tableId,
          'tableName': r.tableName,
          'sessionId': '',
          'clientUid': '',
          'guestName': '',
          'type': 'paid',
          'comment': 'Чек «аванс» по предоплате брони не пробит: ${result.errorMessage ?? 'касса отклонила чек'} — пробейте вручную',
          'status': 'new',
          'createdAt': at,
        });
      }
    } catch (e) {
      debugPrint('Чек аванса брони $id: $e');
    } finally {
      _busy.remove(id);
    }
  }
}

/// Сколько предоплаты ещё без чека.
@visibleForTesting
double advanceToFiscalize(double prepaid, double fiscalized) {
  final v = ((prepaid - fiscalized) * 100).roundToDouble() / 100;
  return v > 0.004 ? v : 0;
}

/// Чек «аванс»: одна строка «Предоплата за бронь стола» (предмет — платёж),
/// оплата безналичная (гость платил онлайн) или наличными (на кассе).
/// Номер постоянный для суммы — касса отсечёт повтор.
FiscalReceipt bookingAdvanceReceipt({
  required String reservationId,
  required double amount,
  double alreadyFiscalized = 0,
  bool banquet = false,
  String contact = '',
  String pay = 'card',
}) =>
    FiscalReceipt(
      receiptId: 'res-$reservationId-adv${(alreadyFiscalized * 100).round()}',
      items: [
        FiscalReceiptItem(
          name: banquet ? 'Предоплата банкета' : 'Предоплата за бронь стола',
          price: amount,
          quantity: 1,
          vat: kassaDefaultVat,
          paymentObject: FiscalPaymentObject.payment,
        ),
      ],
      payments: [FiscalPayment(pay == 'cash' ? 'cash' : 'card', amount)],
      buyerContact: contact,
      advance: true,
    );
