import 'package:cloud_firestore/cloud_firestore.dart';

import '../data/app_db.dart';
import '../models/cash_op.dart';
import '../models/reservation_model.dart';
import '../services/people_directory.dart';
import 'app_scope.dart';
import 'booking_fiscal_service.dart';
import 'fiscal_queue.dart';
import 'kassa_service.dart';

/// Итоги банкета для карточки и экрана: меню, на гостя, предоплата, остаток.
class BanquetSummary {
  final double menuTotal;
  final double perGuest;
  final double prepayRequired;
  final double prepaid;

  const BanquetSummary({
    required this.menuTotal,
    required this.perGuest,
    required this.prepayRequired,
    required this.prepaid,
  });

  /// Сколько предоплаты ещё не внесли.
  double get prepayLeft => _r2(prepayRequired - prepaid) > 0 ? _r2(prepayRequired - prepaid) : 0;

  /// Сколько гость доплатит в день банкета по меню (без того, что дозакажут).
  double get balance => _r2(menuTotal - prepaid) > 0 ? _r2(menuTotal - prepaid) : 0;

  static double _r2(double v) => (v * 100).roundToDouble() / 100;
}

BanquetSummary banquetSummary(ReservationModel r) {
  final menu = r.preOrderTotal;
  final guests = r.guestsCount < 1 ? 1 : r.guestsCount;
  return BanquetSummary(
    menuTotal: menu,
    perGuest: (menu / guests * 100).roundToDouble() / 100,
    prepayRequired: r.banquetPrepay,
    prepaid: r.prepaidTotal,
  );
}

/// Доля меню как сумма предоплаты (30% → округление до 100 ₽ вверх).
double prepayShare(double menuTotal, int percent) {
  if (menuTotal <= 0 || percent <= 0) return 0;
  final v = menuTotal * percent / 100;
  if (percent >= 100) return (v * 100).roundToDouble() / 100;
  return (v / 100).ceilToDouble() * 100;
}

/// Предоплата банкета на кассе (SaaS): чек «аванс» (54-ФЗ — в момент
/// получения денег), наличные — «Внесение» в кассу смены, сумма — в
/// `prepaidTotal` брони; при посадке она уходит в счёт, как онлайн-предоплата.
class BanquetService {
  BanquetService._();
  static final BanquetService instance = BanquetService._();

  /// Возвращает текст для кассира. Ошибка — исключение с понятным текстом.
  Future<String> acceptDeposit({
    required ReservationModel reservation,
    required double amount,
    required String method, // cash | card
    required String employeeName,
    String employeeId = '',
  }) async {
    final sum = (amount * 100).roundToDouble() / 100;
    if (sum <= 0) throw StateError('Укажите сумму');
    if (sum > 5000000) throw StateError('Слишком большая сумма');
    final ref = AppScope.col('reservations').doc(reservation.id);
    final stateRef = AppScope.col('meta').doc('shiftState');
    String? shiftId;
    if (method == 'cash') {
      shiftId = ((await stateRef.get()).data()?['openShiftId'] ?? '').toString();
      if (shiftId.isEmpty) throw StateError('Смена не открыта — откройте смену, чтобы принять наличные');
    }
    // Сначала чек: деньги получены — чек нужен сейчас. Касса не приняла —
    // предоплату не записываем, кассир видит причину.
    var fiscalized = false;
    String note = 'чек «аванс» не пробивался — онлайн-касса не подключена';
    if (kassaService.isAvailable) {
      final receipt = bookingAdvanceReceipt(
        reservationId: reservation.id,
        amount: sum,
        alreadyFiscalized: reservation.advanceFiscalized,
        banquet: true,
        contact: reservation.phone,
        pay: method,
      );
      final res = await FiscalQueue.send(receipt);
      if (!res.success && !res.queued) {
        throw StateError('Касса не пробила чек «аванс»: ${res.errorMessage ?? 'ошибка кассы'}. Предоплата не записана.');
      }
      fiscalized = true;
      note = res.queued ? 'чек «аванс» в очереди — уйдёт, когда появится связь с кассой' : 'чек «аванс» пробит';
    }
    final now = DateTime.now();
    await AppDb.instance.runTransaction((tx) async {
      final cur = await tx.get(ref);
      if (!cur.exists) throw StateError('Бронь удалена');
      tx.update(ref, {
        'prepaidTotal': FieldValue.increment(sum),
        'depositKassa': FieldValue.increment(sum),
        'prepaidAt': Timestamp.fromDate(now),
        if (fiscalized) 'fiscalAuto.advance.amount': FieldValue.increment(sum),
        if (fiscalized) 'fiscalAuto.advance.ok': true,
        if (fiscalized) 'fiscalAuto.advance.at': Timestamp.fromDate(now),
        'deposits': FieldValue.arrayUnion([
          {'amount': sum, 'method': method, 'at': Timestamp.fromDate(now), 'by': Pd.who(employeeName)},
        ]),
      });
      if (method == 'cash') {
        final opRef = AppScope.col('cashOps').doc();
        tx.set(
            opRef,
            CashOp(
              id: opRef.id,
              shiftId: shiftId!,
              type: CashOpType.deposit,
              amount: sum,
              comment: 'Предоплата банкета ${_dm(reservation.startTime)}',
              employeeName: employeeName,
              employeeId: employeeId,
              createdAt: now,
            ).toMap());
      }
    });
    return note;
  }

  static String _dm(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';
}
