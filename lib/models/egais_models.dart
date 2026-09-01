/// Модели для интеграции с ЕГАИС (алкогольная продукция).
///
/// В самой ЕГАИС нет привязки к "номенклатуре кальянной" — есть справочник
/// алкокодов (AlcCode), который выдаётся на партию/марку алкоголя при её
/// заведении в системе через личный кабинет ЕГАИС. Наша задача на стороне
/// кассы — только хранить этот код рядом с позицией склада и подставлять
/// его в документ ПродажаПива/ЧекАлкоРозница при пробитии чека.
library egais_models;

/// Алкогольные реквизиты одной позиции склада/меню. Хранится как
/// вложенная структура в [InventoryItem] (поле `alcohol`), чтобы не менять
/// схему остальных позиций (кальянный табак, снеки и т.д.).
class AlcoholInfo {
  /// Признак того, что позиция вообще подакцизный алкоголь и должна идти
  /// через ЕГАИС при продаже (пиво тоже сюда — со своими особенностями).
  final bool isAlcohol;

  /// Алкокод — присваивается ЕГАИС при регистрации марки/партии в личном
  /// кабинете (несколько цифр, обычно 6-10 знаков). Обязателен для отправки
  /// документа продажи.
  final String alcCode;

  /// Крепость, % об.
  final double abv;

  /// Объём тары в литрах (0.5, 0.33, 1 и т.д.) — нужен для расчёта
  /// суммарного объёма реализации в документе.
  final double volumeLiters;

  /// Признак "пиво и пивные напитки" — по 171-ФЗ для пива не нужна ЕГАИС
  /// маркировка марками (акцизными/федеральными спецмарками), но
  /// розничная продажа всё равно фиксируется через УТМ отдельным типом
  /// документа (ПродажаПива), в отличие от крепкого алкоголя (ЧекАлкоРозница).
  final bool isBeer;

  const AlcoholInfo({
    this.isAlcohol = false,
    this.alcCode = '',
    this.abv = 0,
    this.volumeLiters = 0,
    this.isBeer = false,
  });

  factory AlcoholInfo.fromMap(Map<String, dynamic>? data) {
    if (data == null) return const AlcoholInfo();
    return AlcoholInfo(
      isAlcohol: data['isAlcohol'] ?? false,
      alcCode: data['alcCode'] ?? '',
      abv: (data['abv'] as num?)?.toDouble() ?? 0,
      volumeLiters: (data['volumeLiters'] as num?)?.toDouble() ?? 0,
      isBeer: data['isBeer'] ?? false,
    );
  }

  Map<String, dynamic> toMap() => {
        'isAlcohol': isAlcohol,
        'alcCode': alcCode,
        'abv': abv,
        'volumeLiters': volumeLiters,
        'isBeer': isBeer,
      };

  AlcoholInfo copyWith({
    bool? isAlcohol,
    String? alcCode,
    double? abv,
    double? volumeLiters,
    bool? isBeer,
  }) =>
      AlcoholInfo(
        isAlcohol: isAlcohol ?? this.isAlcohol,
        alcCode: alcCode ?? this.alcCode,
        abv: abv ?? this.abv,
        volumeLiters: volumeLiters ?? this.volumeLiters,
        isBeer: isBeer ?? this.isBeer,
      );
}

/// Одна строка алкогольной продажи, которую нужно передать в УТМ при
/// закрытии чека со спиртным — собирается из позиций чека на экране оплаты.
class EgaisSaleLine {
  final String alcCode;
  final double quantityLiters; // объём тары × количество
  final bool isBeer;

  const EgaisSaleLine({
    required this.alcCode,
    required this.quantityLiters,
    required this.isBeer,
  });
}

/// Статус отправки документа продажи в УТМ — отображается в истории чека,
/// чтобы официант/админ видел, прошла ли отметка в ЕГАИС, а не просто
/// "чек напечатан".
enum EgaisSendStatus { notRequired, pending, sent, failed }