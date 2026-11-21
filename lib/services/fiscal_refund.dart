import 'dart:async';

import '../models/fiscal_receipt.dart';
import '../models/session_model.dart';
import '../utils/human_error.dart';
import 'firestore_service.dart';
import 'fiscal_queue.dart';
import 'kassa_service.dart';

/// Чек «возврат прихода» по чеку, сохранённому при оплате: при возврате и
/// при переоткрытии чека. Возвращает текст ошибки, если возврат придётся
/// пробить на ККТ вручную; null — чек отправлен (или встал в очередь).
Future<String?> sendFiscalRefund(SessionModel s, {FirestoreService? fs}) async {
  final db = fs ?? FirestoreService();
  String? error;
  try {
    // Два юрлица — возврат по каждому чеку на его кассу.
    final saved = await db.fiscalReceiptsOf(s.id);
    if (saved.isEmpty) {
      error = 'чек продажи пробит до обновления кассы, и его состава нет в базе';
    } else {
      for (final raw in saved) {
        final sale = FiscalReceipt.fromJson(raw);
        if (!kassaFor(sale).isAvailable) {
          error ??= 'касса не настроена (Настройки → Интеграции)';
          continue;
        }
        final result = await FiscalQueue.send(sale.asRefund());
        if (!result.success && !result.queued) {
          error ??= 'касса отклонила чек возврата: ${result.errorMessage ?? 'без описания'}';
        }
      }
    }
  } catch (e) {
    error = 'не удалось отправить чек возврата: ${humanError(e, lower: true)}';
  }
  unawaited(db.markFiscalRefund(s.id, error: error).catchError((Object _) {}));
  return error;
}
