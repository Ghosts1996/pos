import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/fiscal_receipt.dart';
import '../models/marking_code.dart';
import 'chestny_znak_api_service.dart';

/// Маркировка «Честный знак».
///
/// Выбытие кода при продаже происходит не вызовом API из приложения, а
/// через онлайн-кассу: она кладёт код в чек (тег 1162), и ОФД передаёт его
/// в ИС МП. Для законной продажи маркированного товара нужна касса с ФН и
/// договором с ОФД и её драйвер, принимающий код в позиции чека.
///
/// Этот сервис делает то, что не требует кассы:
///   • разбирает скан DataMatrix в GTIN и серийник ([MarkingCode.tryParse]);
///   • отличает код маркировки от обычного штрихкода;
///   • не даёт продать один экземпляр дважды на этой кассе;
///   • копит очередь кодов к списанию для передачи в SDK кассы
///     ([ChestnyZnakQueueEntry]).
class ChestnyZnakService {

  /// Распознаёт скан как код маркировки; null — обычный штрихкод, по нему
  /// ищут позицию меню или склада.
  MarkingCode? parse(String rawScan) => MarkingCode.tryParse(rawScan);

  /// true, если этот конкретный экземпляр (raw-код целиком) уже был
  /// продан ранее — по локальному журналу списаний. Проверять нужно перед
  /// добавлением позиции в чек, чтобы не продать одну бутылку дважды по
  /// одному коду (частая причина штрафа при проверке).
  ///
  /// Это только локальная (на этом кассовом месте) защита. Если в
  /// Настройках → Интеграции указан токен «Честного знака»
  /// ([activeChestnyZnakApi] не null), дополнительно смотрим
  /// [checkOnlineStatus] — он же в силах поймать код, проданный на ДРУГОЙ
  /// кассе/точке или вовсе поддельный, чего локальный журнал не увидит.
  Future<bool> isAlreadySold(MarkingCode code) async {
    final doc = await AppScope.col('marking_codes_sold').doc(_docId(code)).get();
    return doc.exists;
  }

  /// Онлайн-проверка кода напрямую в ИС МП «Честный знак» (методом
  /// `codes/check` — см. `chestny_znak_api_service.dart`). Возвращает null,
  /// если в Настройках → Интеграции не задан токен — тогда сканирование
  /// продолжает работать только на локальной проверке [isAlreadySold], без
  /// онлайн-части.
  Future<ChestnyZnakCodeCheck?> checkOnlineStatus(MarkingCode code) async {
    final api = activeChestnyZnakApi;
    if (api == null) return null;
    final results = await api.checkCodes([code.raw]);
    return results.isEmpty ? null : results.first;
  }

  /// Помечает код как использованный в чеке [receiptId] и кладёт его в
  /// очередь на фактическое списание в ИС МП (см. класс-докстринг — само
  /// списание произойдёт при пробитии чека через онлайн-кассу, когда она
  /// будет подключена; до этого момента запись в очереди носит учётный
  /// характер и не является легальным выводом из оборота).
  ///
  /// [menuItemId]/[itemName] — позиция меню, при сканировании которой был
  /// считан этот код. Нужны, чтобы на экране оплаты сопоставить код именно
  /// с той строкой чека (а не воткнуть его в чек "куда попало") — см.
  /// [codesForReceiptDetailed] и `payment_screen.dart`.
  Future<void> attachToReceipt(
    MarkingCode code, {
    required String receiptId,
    String menuItemId = '',
    String itemName = '',
    MarkingPermit? permit,
  }) async {
    await AppScope.col('marking_codes_sold').doc(_docId(code)).set({
      // Результат проверки в «Честном знаке» (разрешительный режим) — уйдёт
      // в чек отраслевым реквизитом.
      if (permit != null) 'permitReqId': permit.reqId,
      if (permit != null) 'permitReqTimestamp': permit.reqTimestamp,
      'gtin': code.gtin,
      'serial': code.serial,
      'raw': code.raw,
      'receiptId': receiptId,
      'menuItemId': menuItemId,
      'itemName': itemName,
      'soldAt': FieldValue.serverTimestamp(),
      // 'retiredAtOfd' проставится true после того, как SDK кассы
      // подтвердит, что код ушёл в чек и передан в ОФД.
      'retiredAtOfd': false,
    });
  }

  String _docId(MarkingCode code) => code.uniqueKey.hashCode.toUnsigned(62).toString();

  /// Коды маркировки, привязанные к чеку [receiptId] (обычно — id сессии
  /// стола) — используются при сборке фискального чека, чтобы подставить
  /// их в позиции (тег ФФД 1162, см. `fiscal_receipt.dart`).
  Future<List<MarkingCode>> codesForReceipt(String receiptId) async {
    final detailed = await codesForReceiptDetailed(receiptId);
    return detailed.map((e) => e.code).toList();
  }

  /// То же самое, что [codesForReceipt], но вместе с позицией меню, к
  /// которой код был привязан при сканировании — по ней экран оплаты
  /// сопоставляет код с конкретной строкой чека (см. `payment_screen.dart`,
  /// `_sendToKassa`).
  Future<List<AttachedMarkingCode>> codesForReceiptDetailed(String receiptId) async {
    final snap =
        await AppScope.col('marking_codes_sold').where('receiptId', isEqualTo: receiptId).get();
    return snap.docs
        .map((d) => AttachedMarkingCode(
              code: MarkingCode(
                raw: d['raw'] as String,
                gtin: d['gtin'] as String,
                serial: d['serial'] as String,
              ),
              menuItemId: (d.data()['menuItemId'] as String?) ?? '',
              itemName: (d.data()['itemName'] as String?) ?? '',
              permit: (d.data()['permitReqId'] as String?)?.isNotEmpty == true
                  ? MarkingPermit(
                      reqId: d.data()['permitReqId'] as String,
                      reqTimestamp: (d.data()['permitReqTimestamp'] ?? '').toString(),
                    )
                  : null,
            ))
        .toList();
  }
}

/// Код маркировки вместе с позицией меню, к которой он был привязан при
/// сканировании (см. [ChestnyZnakService.attachToReceipt]).
class AttachedMarkingCode {
  final MarkingCode code;
  final String menuItemId;
  final String itemName;
  final MarkingPermit? permit;
  const AttachedMarkingCode({required this.code, required this.menuItemId, required this.itemName, this.permit});
}