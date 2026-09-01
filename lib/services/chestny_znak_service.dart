import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/marking_code.dart';
import 'chestny_znak_api_service.dart';

/// Интеграция с системой маркировки «Честный ЗНАК».
///
/// Честно про механику, чтобы не создавать иллюзию "подключил — и всё
/// само работает":
///
/// Официальное списание (выбытие) кода маркировки при розничной продаже
/// происходит НЕ прямым вызовом какого-то API «Честного знака» из
/// приложения кассира, а автоматически — через код маркировки, который
/// онлайн-касса (54-ФЗ) кладёт в сам фискальный чек (реквизит ОФД,
/// тег 1162 «код товара»), и дальше ОФД сам передаёт эти сведения в
/// ИС МП «Честный знак». Это встроено в прошивку кассы/драйвер ККТ, а не
/// в стороннее приложение управления столами.
///
/// Значит, чтобы промаркированный товар (алкоголь, определённые снеки,
/// вода, парфюмерия и т.д. — список постоянно расширяется) законно продавался
/// именно из этого приложения, on-premise нужна:
///   1. подключённая онлайн-касса (54-ФЗ) с ФН и заключённым договором с ОФД;
///   2. драйвер/SDK этой кассы, который принимает код маркировки как часть
///      позиции чека и сам кладёт его в тег 1162 при пробитии.
///
/// Пока это не подключено (в проекте нет онлайн-кассы — см. README), сервис
/// ниже отвечает за ту часть, которая не требует кассы и полностью
/// реализуема уже сейчас:
///   • разбор скана DataMatrix в GTIN/серийник ([MarkingCode.tryParse]);
///   • проверка, что это вообще код маркировки, а не случайный штрихкод;
///   • защита от повторной продажи ОДНОГО и того же экземпляра на этом
///     кассовом месте (полезно само по себе — эта проверка предотвращает
///     ошибку официанта, даже без интеграции с ИС МП);
///   • очередь кодов, готовых к списанию — как только будет подключена
///     касса, эта очередь передаётся в её SDK одним вызовом
///     (см. [ChestnyZnakQueueEntry] и TODO в [attachReceipt]).
class ChestnyZnakService {
  final _db = FirebaseFirestore.instance;

  /// Пытается распознать скан как код маркировки. Возвращает null, если
  /// это обычный штрихкод (тогда вызывающий экран ищет позицию меню/склада
  /// по этому значению как раньше).
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
    final doc = await _db.collection('marking_codes_sold').doc(_docId(code)).get();
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
  }) async {
    await _db.collection('marking_codes_sold').doc(_docId(code)).set({
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
        await _db.collection('marking_codes_sold').where('receiptId', isEqualTo: receiptId).get();
    return snap.docs
        .map((d) => AttachedMarkingCode(
              code: MarkingCode(
                raw: d['raw'] as String,
                gtin: d['gtin'] as String,
                serial: d['serial'] as String,
              ),
              menuItemId: (d.data()['menuItemId'] as String?) ?? '',
              itemName: (d.data()['itemName'] as String?) ?? '',
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
  const AttachedMarkingCode({required this.code, required this.menuItemId, required this.itemName});
}