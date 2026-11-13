import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../build_info.dart';
import '../data/app_db.dart';
import '../models/delivery_status.dart';
import '../models/fiscal_receipt.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../utils/promo_policy.dart';
import 'app_scope.dart';
import 'firestore_service.dart';
import 'fiscal_queue.dart';
import 'kassa_service.dart';
import 'net_status.dart';

/// Чеки доставки без кассира (SaaS, 54-ФЗ). Гость заплатил онлайн заранее —
/// касса сама пробивает «Предоплату 100%»; курьер нажал «Вручил» — «Полный
/// расчёт»: с зачётом предоплаты или наличными/картой, которые он принял у
/// двери. Заказ отменили после предоплаты — «Возврат прихода» предоплаты.
///
/// Как узнаёт: шлюз ставит заказу `fiscalNeed: true`, когда пришла оплата
/// онлайн или курьер вручил заказ (касса — когда сотрудник отметил
/// «Доставлен»/«Отменён»). Работает на каждой кассе с подключённой
/// онлайн-кассой, но чек пробивает одна: она занимает заказ в транзакции
/// (`fiscalAuto.<вид>.claimBy`), номер чека постоянный (`<заказ>-dprepay`,
/// `-dfull`, `-dprepay-refund`) — касса отсекает повтор.
///
/// Итог — в `fiscalAuto` заказа: `prepay`/`full`/`refund` = {ok, queued,
/// fd, fp, url, amount, at} или {error, at}. Экран оплаты видит готовый
/// чек и второй не пробивает. Не получилось — сигнал на кассу «пробейте
/// чек вручную», заказ остаётся кассиру.
class DeliveryFiscalService {
  DeliveryFiscalService._();
  static final DeliveryFiscalService instance = DeliveryFiscalService._();

  final String _device = const Uuid().v4();
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _sub;
  Timer? _timer;
  final Set<String> _busy = {};
  Set<String> _waiting = {};

  void start() {
    if (!kSaasMode || _sub != null) return;
    _sub = AppScope.col('sessions').where('fiscalNeed', isEqualTo: true).snapshots().listen((q) {
      _waiting = {for (final d in q.docs) d.id};
      for (final id in _waiting) {
        unawaited(_handle(id));
      }
    }, onError: (_) {});
    // Повтор: касса была без связи, другая касса заняла заказ и пропала,
    // чек ждал в очереди.
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
    if (!deliveryAutoFiscal || !kassaService.isAvailable || _busy.contains(id)) return;
    // Облачной кассе нужен интернет; регистратор в зале — нет, но занять
    // заказ без связи с сервером нельзя (две кассы пробили бы один чек).
    if (!NetStatus.online.value) return;
    _busy.add(id);
    try {
      final ref = AppScope.col('sessions').doc(id);
      final snap = await ref.get();
      final raw = snap.data();
      if (raw == null) return;
      final session = SessionModel.fromDoc(snap);
      final items = await deliveryFiscalItems(session);
      final total = fiscalItemsTotal(items);
      final step = planDeliveryFiscal(raw: raw, total: total, guestPaid: session.guestPaidTotal);
      if (step == null) {
        await ref.update({'fiscalNeed': false});
        return;
      }
      if (!await _claim(ref, step.kind)) return;
      final contact = session.customerPhone.isNotEmpty ? session.customerPhone : (raw['guestContact'] ?? '').toString();
      final receipt = step.kind == DeliveryFiscalKind.refund
          ? FiscalReceipt.fromJson({
              ...Map<String, dynamic>.from(((raw['fiscalAuto'] as Map?)?['prepay'] as Map?)?['receipt'] as Map? ?? {}),
              'buyerContact': contact,
            }).asRefund()
          : FiscalReceipt(
              receiptId: '$id-${step.kind == DeliveryFiscalKind.prepay ? 'dprepay' : 'dfull'}',
              items: items,
              payments: balancePayments(step.payments, total),
              buyerContact: contact,
              fullPrepayment: step.kind == DeliveryFiscalKind.prepay,
            );
      final result = await FiscalQueue.send(receipt);
      final key = step.kind.name;
      final at = Timestamp.fromDate(DateTime.now());
      if (result.success || result.queued) {
        await ref.update({
          'fiscalAuto.$key': {
            'ok': true,
            if (result.queued) 'queued': true,
            if (result.fiscalDocumentNumber != null) 'fd': result.fiscalDocumentNumber,
            if (result.fiscalSign != null) 'fp': result.fiscalSign,
            if (result.receiptUrl != null) 'url': result.receiptUrl,
            'amount': receipt.total,
            'payments': [for (final p in receipt.payments) {'type': p.type, 'amount': p.amount}],
            if (step.kind == DeliveryFiscalKind.prepay) 'receipt': {...receipt.toJson()}..remove('buyerContact'),
            'at': at,
          },
        });
      } else {
        await ref.update({
          'fiscalAuto.$key': {'error': result.errorMessage ?? 'касса отклонила чек', 'at': at},
          'fiscalNeed': false,
        });
        await _alert(raw, id, 'Чек доставки не пробит: ${result.errorMessage ?? 'касса отклонила чек'} — пробейте вручную');
      }
    } catch (e) {
      debugPrint('Чек доставки $id: $e');
    } finally {
      _busy.remove(id);
    }
  }

  /// Занять заказ для чека: другая касса, взявшая его меньше 5 минут назад
  /// и ещё без итога, — пропускаем.
  Future<bool> _claim(DocumentReference<Map<String, dynamic>> ref, DeliveryFiscalKind kind) {
    return AppDb.instance.runTransaction<bool>((tx) async {
      final cur = (await tx.get(ref)).data();
      final slot = ((cur?['fiscalAuto'] as Map?)?[kind.name] as Map?) ?? const {};
      if (slot['ok'] == true || slot['error'] != null) return false;
      final at = slot['claimAt'];
      final fresh = at is Timestamp && DateTime.now().difference(at.toDate()).inMinutes < 5;
      if (fresh && slot['claimBy'] != _device) return false;
      tx.update(ref, {
        'fiscalAuto.${kind.name}': {'claimBy': _device, 'claimAt': Timestamp.fromDate(DateTime.now())},
      });
      return true;
    }).catchError((Object _) => false);
  }

  Future<void> _alert(Map<String, dynamic> raw, String sessionId, String text) async {
    try {
      final no = raw['orderNo'];
      await AppScope.col('waiterCalls').add({
        'tableId': (raw['tableId'] ?? '').toString(),
        'tableName': (raw['tableName'] ?? '').toString(),
        'sessionId': sessionId,
        'clientUid': '',
        'guestName': '',
        'type': 'paid',
        'comment': no != null && '$no' != '0' ? 'Заказ №$no. $text' : text,
        'status': 'new',
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } catch (_) {}
  }
}

enum DeliveryFiscalKind { prepay, full, refund }

class DeliveryFiscalStep {
  final DeliveryFiscalKind kind;
  final List<FiscalPayment> payments;
  const DeliveryFiscalStep(this.kind, [this.payments = const []]);
}

bool _done(Object? slot) => slot is Map && slot['ok'] == true;

/// Чек этого вида уже пробит или касса его отклонила (тогда — кассиру).
bool _settled(Object? slot) => slot is Map && (slot['ok'] == true || slot['error'] != null);

/// Какой чек доставки пробить сейчас (или никакой). Чистая функция — по
/// данным заказа: [total] — сумма позиций чека, [guestPaid] — оплачено
/// онлайн (в приложении или по QR у курьера).
@visibleForTesting
DeliveryFiscalStep? planDeliveryFiscal({
  required Map<String, dynamic> raw,
  required double total,
  required double guestPaid,
}) {
  double r(double v) => (v * 100).roundToDouble() / 100;
  final type = (raw['orderType'] ?? '').toString();
  if (type != 'delivery' && type != 'takeaway') return null;
  // Кассир уже пробил чек на экране оплаты — заказ его.
  if (raw['fiscalReceipt'] is Map) return null;
  final auto = raw['fiscalAuto'] is Map ? Map<String, dynamic>.from(raw['fiscalAuto'] as Map) : const <String, dynamic>{};
  if (total <= 0) return null;
  final status = DeliveryFlow.normalize(type, raw['deliveryStatus'] as String?);
  final prepaid = _done(auto['prepay']);
  final paidOnline = r(guestPaid < total ? guestPaid : total);

  if (status == 'cancelled') {
    if (prepaid && !_done(auto['full']) && !_settled(auto['refund'])) return const DeliveryFiscalStep(DeliveryFiscalKind.refund);
    return null;
  }
  if (status == 'done') {
    if (_settled(auto['full'])) return null;
    final payments = <FiscalPayment>[];
    if (prepaid) {
      payments.add(FiscalPayment('prepayment', r(((auto['prepay'] as Map)['amount'] as num?)?.toDouble() ?? 0)));
    } else if (paidOnline > 0) {
      payments.add(FiscalPayment('card', paidOnline));
    }
    final cp = raw['courierPayment'];
    if (cp is Map) {
      final amount = r((cp['amount'] as num?)?.toDouble() ?? 0);
      if (amount > 0 && cp['method'] == 'cash') payments.add(FiscalPayment('cash', amount));
      if (amount > 0 && cp['method'] == 'card') payments.add(FiscalPayment('card', amount));
    }
    final sum = payments.fold<double>(0, (s, p) => s + p.amount);
    // Оплату не видно (вручил сотрудник, деньги — на кассе) — чек пробьёт кассир.
    if (sum + 1 < total) return null;
    return DeliveryFiscalStep(DeliveryFiscalKind.full, payments);
  }
  // Ещё не вручили: оплатили онлайн всю сумму — чек предоплаты.
  if (!_settled(auto['prepay']) && paidOnline + 0.01 >= total) {
    return DeliveryFiscalStep(DeliveryFiscalKind.prepay, [FiscalPayment('card', total)]);
  }
  return null;
}

double fiscalItemsTotal(List<FiscalReceiptItem> items) =>
    (items.fold<double>(0, (s, i) => s + i.sum) * 100).roundToDouble() / 100;

/// Позиции чека доставки — как на экране оплаты: цена со скидкой (кроме
/// позиций без скидок), НДС и предмет расчёта из карточки меню, строка
/// «Доставка» — услуга.
Future<List<FiscalReceiptItem>> deliveryFiscalItems(SessionModel s) async {
  Map<String, MenuItem> menu = const {};
  try {
    menu = await FirestoreService().menuItemsByIds(s.orderItems.map((l) => l.menuItemId).where((id) => id.isNotEmpty).toSet());
  } catch (_) {}
  return buildDeliveryFiscalItems(s, (id) => menu[id]);
}

@visibleForTesting
List<FiscalReceiptItem> buildDeliveryFiscalItems(SessionModel s, MenuItem? Function(String id) menuOf) {
  final discountK = 1 - s.discountPercent / 100;
  final items = <FiscalReceiptItem>[];
  for (final line in s.orderItems) {
    if (line.qty <= 0) continue;
    final m = menuOf(line.menuItemId);
    final own = m?.vat ?? '';
    final vat = own.isEmpty ? kassaDefaultVat : FiscalVatRateX.fromId(own, fallback: kassaDefaultVat);
    final subject = line.menuItemId == kDeliveryFeeItemId
        ? FiscalPaymentObject.service
        : FiscalPaymentObjectX.fromId(m?.fiscalSubject);
    final price = PromoPolicy.restricted(line) || line.menuItemId == kDeliveryFeeItemId
        ? line.price
        : double.parse((line.price * discountK).toStringAsFixed(2));
    final name = line.displayName.length > 128 ? line.displayName.substring(0, 128) : line.displayName;
    items.add(FiscalReceiptItem(name: name, price: price, quantity: line.qty.toDouble(), vat: vat, paymentObject: subject));
  }
  return items;
}

/// Чек доставки уже пробит автоматически — экран оплаты свой не пробивает.
/// 'full' — полный расчёт готов; 'prepay' — пробита предоплата (полный
/// расчёт касса пробьёт сама при вручении); '' — нет.
String deliveryFiscalState(Map<String, dynamic>? raw) {
  final auto = raw?['fiscalAuto'];
  if (auto is! Map) return '';
  if (_done(auto['full'])) return 'full';
  if (_done(auto['prepay']) && !_done(auto['refund'])) return 'prepay';
  return '';
}
