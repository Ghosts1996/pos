/// Модели фискального чека по 54-ФЗ.
///
/// Это тот набор полей, который реально требует протокол ФФД (формат
/// фискальных документов) от любой онлайн-кассы — что физической (АТОЛ,
/// Штрих-М, Эвотор), что облачной (кассы "в аренду", когда физическое ККТ
/// стоит у провайдера, а вы обращаетесь к нему по HTTP). Модель написана
/// провайдер-независимой, чтобы конкретный HTTP-клиент (см.
/// `kassa_service.dart`) просто собирал из неё запрос под конкретного
/// провайдера.
library fiscal_receipt;

/// Ставка НДС позиции (тег ФФД 1199). По умолчанию `none` — большинство
/// небольших заведений на УСН/патенте НДС не платят; если у заведения
/// общая система налогообложения, ставку нужно проставлять по позициям.
enum FiscalVatRate { vat20, vat10, vat0, none }

extension FiscalVatRateX on FiscalVatRate {
  /// Код ставки НДС в терминах большинства провайдеров облачных касс
  /// (АТОЛ Онлайн и совместимые с ним по духу API).
  String get providerCode {
    switch (this) {
      case FiscalVatRate.vat20:
        return 'vat20';
      case FiscalVatRate.vat10:
        return 'vat10';
      case FiscalVatRate.vat0:
        return 'vat0';
      case FiscalVatRate.none:
        return 'none';
    }
  }
}

/// Признак предмета расчёта (тег ФФД 1212) — обычный товар/услуга или
/// маркированный товар. Влияет на то, обязателен ли [FiscalReceiptItem.markingCode].
enum FiscalPaymentObject { commodity, service, excise, markedGood }

/// Одна строка фискального чека.
class FiscalReceiptItem {
  final String name;
  final double price;
  final double quantity;
  final FiscalVatRate vat;
  final FiscalPaymentObject paymentObject;

  /// Код маркировки «Честный ЗНАК» (тег 1162) — обязателен, если
  /// [paymentObject] == markedGood. Именно передача этого поля в
  /// фискальный чек и есть тот момент, когда код по-настоящему легально
  /// выбывает из оборота (эту часть не может сделать ничего, кроме самой
  /// кассы — см. docstring в `chestny_znak_service.dart`).
  final String? markingCode;

  const FiscalReceiptItem({
    required this.name,
    required this.price,
    required this.quantity,
    this.vat = FiscalVatRate.none,
    this.paymentObject = FiscalPaymentObject.commodity,
    this.markingCode,
  });

  double get sum => price * quantity;
}

/// Способ расчёта одной части оплаты чека (тег 1031/1081/1215/1216).
class FiscalPayment {
  final String type; // cash | card | prepayment (аванс) | other
  final double amount;
  const FiscalPayment(this.type, this.amount);
}

/// Полный фискальный чек — то, что нужно передать в онлайн-кассу при
/// закрытии стола, если включена "Распечатать фискальный чек".
class FiscalReceipt {
  /// Внутренний номер чека (обычно — id сессии/стола) — используется как
  /// идемпотентный ключ у большинства провайдеров, чтобы повторная
  /// отправка того же id не пробила чек дважды при сетевом сбое.
  final String receiptId;
  final List<FiscalReceiptItem> items;
  final List<FiscalPayment> payments;

  /// Контакт покупателя (email/телефон) — обязателен по 54-ФЗ для чеков,
  /// отправляемых в электронном виде. Пусто — чек печатается только на
  /// бумаге (если касса с чекопечатающим устройством).
  final String buyerContact;

  const FiscalReceipt({
    required this.receiptId,
    required this.items,
    required this.payments,
    this.buyerContact = '',
  });

  double get total => items.fold(0, (sum, i) => sum + i.sum);
}

class FiscalReceiptResult {
  final bool success;
  final String? fiscalDocumentNumber; // ФД №
  final String? fiscalSign; // ФПД
  final String? fnNumber; // номер фискального накопителя
  final String? receiptUrl; // ссылка на электронный чек для гостя
  final String? errorMessage;

  const FiscalReceiptResult.success({
    this.fiscalDocumentNumber,
    this.fiscalSign,
    this.fnNumber,
    this.receiptUrl,
  })  : success = true,
        errorMessage = null;

  const FiscalReceiptResult.failure(this.errorMessage)
      : success = false,
        fiscalDocumentNumber = null,
        fiscalSign = null,
        fnNumber = null,
        receiptUrl = null;
}