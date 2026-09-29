import 'dart:convert';
import 'app_scope.dart';
import 'package:http/http.dart' as http;

/// Клиент True API «Честного знака»: только проверка кода `codes/check`,
/// как у онлайн-касс в разрешительном режиме. Заказ кодов и вывод из
/// оборота требуют подписи УКЭП — их здесь нет.
///
/// Контуры (Настройки → Интеграции): песочница
/// https://markirovka.sandbox.crptech.ru — с неё и начинать — и боевой
/// https://markirovka.crpt.ru. Авторизация — токен для ККТ из личного
/// кабинета в заголовке `X-API-KEY`, у каждого контура свой.
///
/// Открытой схемы ответа у ЦРПТ нет, поэтому разбор терпим к вариантам
/// названий полей. Перед боевым запуском сверьте ответ с
/// [ChestnyZnakCodeCheck.raw].
class ChestnyZnakApiService {
  final String token;
  final bool isPilot;

  ChestnyZnakApiService({required this.token, required this.isPilot});

  String get baseUrl =>
      isPilot ? 'https://markirovka.sandbox.crptech.ru' : 'https://markirovka.crpt.ru';

  bool get isAvailable => token.trim().isNotEmpty;

  /// Проверяет до 100 кодов маркировки за раз (ограничение самого метода
  /// ЦРПТ) на существование и статус выбытия. [rawCodes] — как их отдаёт
  /// сканер целиком (см. [MarkingCode.raw]).
  Future<List<ChestnyZnakCodeCheck>> checkCodes(List<String> rawCodes) async {
    if (!isAvailable) {
      throw ChestnyZnakApiException('Не задан токен «Честного знака» — Настройки → Интеграции');
    }
    if (rawCodes.isEmpty) return const [];
    if (rawCodes.length > 100) {
      throw ChestnyZnakApiException('Максимум 100 кодов за один запрос к codes/check');
    }

    final http.Response resp;
    try {
      resp = await http
          .post(
            Uri.parse('$baseUrl/api/v4/true-api/codes/check'),
            headers: {
              'X-API-KEY': token,
              'Accept-Charset': 'utf-8',
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: jsonEncode({'codes': rawCodes}),
          )
          .timeout(const Duration(seconds: 10));
    } catch (e) {
      throw ChestnyZnakApiException(
          'Нет связи с сервером «Честного знака» (${isPilot ? 'пилот' : 'прод'}): $e');
    }

    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw ChestnyZnakApiException(
          'Токен отклонён (${resp.statusCode}) — проверьте, что он выдан для ${isPilot ? 'тестового' : 'боевого'} контура и не истёк. Ответ: ${resp.body}');
    }
    if (resp.statusCode != 200) {
      throw ChestnyZnakApiException('Ошибка ${resp.statusCode} от «Честного знака»: ${resp.body}');
    }

    Map<String, dynamic> data;
    try {
      data = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (e) {
      throw ChestnyZnakApiException('Не удалось разобрать ответ «Честного знака»: ${resp.body}');
    }

    // Идентификатор и время проверки — для отраслевого реквизита чека
    // (разрешительный режим, теги 1260–1265).
    final reqId = (data['reqId'] ?? '').toString();
    final reqTimestamp = (data['reqTimestamp'] ?? '').toString();
    final list = (data['codes'] as List?) ?? const [];
    return list.map((raw) {
      final m = raw as Map<String, dynamic>;
      final code = (m['code'] ?? m['cis'] ?? '') as String;
      // Разные версии методички называли это поле по-разному
      // (valid / isValid / realCodeFoundInSystem) — берём первое найденное.
      final found = (m['valid'] ?? m['isValid'] ?? m['realCodeFoundInSystem']) as bool? ?? false;
      // utilised — «код нанесён на товар», у годного товара это true, а не
      // признак продажи. Продан — sold, заблокирован — isBlocked, срок
      // годности — expireDate.
      final sold = m['sold'] == true;
      final blocked = m['isBlocked'] == true;
      final expire = DateTime.tryParse((m['expireDate'] ?? '').toString());
      final expired = expire != null && expire.isBefore(DateTime.now());
      final errorCode = m['errorCode'];
      final errorMessage = m['errorMessage'] ??
          m['message'] ??
          (errorCode != null && errorCode != 0 && errorCode != '0' ? 'Код ошибки $errorCode' : null) ??
          (blocked ? 'Товар заблокирован для продажи' : null) ??
          (expired ? 'Истёк срок годности' : null);
      final valid = found && !blocked && !expired;
      final soldOrRetired = sold;
      return ChestnyZnakCodeCheck(
        code: code.isEmpty ? rawCodes.first : code,
        valid: valid,
        alreadyRetired: soldOrRetired,
        errorMessage: errorMessage?.toString(),
        raw: m,
        reqId: reqId,
        reqTimestamp: reqTimestamp,
      );
    }).toList();
  }
}

class ChestnyZnakCodeCheck {
  final String code;

  /// true — код реально существует в системе «Честный знак» (не подделка).
  final bool valid;

  /// true — код уже выведен из оборота (продан) ранее, по данным самой
  /// ИС МП, а не только по локальному журналу этого кассового места.
  final bool alreadyRetired;
  final String? errorMessage;

  /// Необработанный JSON-объект по этому коду — на случай, если разбор
  /// выше не нашёл нужное поле в конкретной версии ответа ЦРПТ.
  final Map<String, dynamic> raw;

  /// Идентификатор и время запроса проверки — нужны кассе для чека.
  final String reqId;
  final String reqTimestamp;

  const ChestnyZnakCodeCheck({
    required this.code,
    required this.valid,
    required this.alreadyRetired,
    this.errorMessage,
    this.raw = const {},
    this.reqId = '',
    this.reqTimestamp = '',
  });
}

class ChestnyZnakApiException implements Exception {
  final String message;
  ChestnyZnakApiException(this.message);
  @override
  String toString() => message;
}

/// Единая точка получения активного клиента «Честного знака» во всём
/// приложении — как [activeEgaisService]/[kassaService]. null, пока токен
/// не задан в Настройках → Интеграции: тогда онлайн-проверка кода просто
/// пропускается (остаётся только локальная защита от повторной продажи в
/// [ChestnyZnakService.isAlreadySold]), а не роняет сканирование.
ChestnyZnakApiService? activeChestnyZnakApi;

/// Подтягивает сохранённые токен и контур «Честного знака»
/// (settings/integrations) и заполняет [activeChestnyZnakApi] — вызывается
/// один раз при старте приложения, аналогично [loadSavedEgaisSettings].
Future<void> loadSavedChestnyZnakSettings() async {
  try {
    final doc = await AppScope.col('settings').doc('integrations').get();
    final data = doc.data();
    final token = data?['czToken'] as String?;
    final circuit = data?['czCircuit'] as String? ?? 'pilot';
    activeChestnyZnakApi =
        (token != null && token.isNotEmpty) ? ChestnyZnakApiService(token: token, isPilot: circuit != 'prod') : null;
  } catch (_) {
    // Нет сети/документа при первом запуске — activeChestnyZnakApi остаётся
    // null до захода в Настройки → Интеграции.
  }
}