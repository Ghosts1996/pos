import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:http/http.dart' as http;

/// Реальный HTTP-клиент к True API системы маркировки «Честный ЗНАК» —
/// метод проверки кода `codes/check`, тот же самый, который используют
/// онлайн-кассы в «разрешительном режиме» перед продажей маркированного
/// товара. Это НЕ полная интеграция с ИС МП (заказ кодов, ввод/вывод из
/// оборота — те методы требуют подписи запроса УКЭП, отдельная и куда
/// более тяжёлая история), а именно проверка «этот код существует и не
/// продан ранее в самой системе» — то, что нужно на кассе перед продажей.
///
/// Два контура (задаются переключателем в Настройках → Интеграции):
///   • Пилот (тестовый/sandbox) — https://markirovka.sandbox.crptech.ru
///     Тестовые данные, ничего не портит в бою. С него стоит начинать —
///     ЦРПТ прямо рекомендует не пропускать этот этап.
///   • Боевой (прод) — https://markirovka.crpt.ru
///
/// Авторизация — простой статический ключ, а не полноценный OAuth: в
/// личном кабинете «Честный знак» (профиль → «Токен для контрольно-кассовой
/// техники») выдаётся строка, которая передаётся заголовком `X-API-KEY`.
/// Она отдельная для каждого контура — токен из личного кабинета песочницы
/// не подойдёт к боевому и наоборот.
///
/// ЧЕСТНО про риск: у ЦРПТ нет открытого Swagger, точные названия полей
/// ответа `codes/check` время от времени уточняются в методических
/// рекомендациях (docs.crpt.ru / личный кабинет / база знаний «Реестр
/// интеграторов»). Ниже разбор ответа сделан терпимо к вариациям (ищет
/// несколько разных возможных названий поля валидности), но перед боевым
/// использованием стоит один раз сверить реальный JSON-ответ вашего
/// контура с этим кодом — см. [ChestnyZnakCodeCheck.raw], где лежит
/// исходный необработанный ответ на конкретный код, если разбор что-то не
/// узнал.
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

    final list = (data['codes'] as List?) ?? const [];
    return list.map((raw) {
      final m = raw as Map<String, dynamic>;
      final code = (m['code'] ?? m['cis'] ?? '') as String;
      // Разные версии методички называли это поле по-разному
      // (valid / isValid / realCodeFoundInSystem) — берём первое найденное.
      final valid = (m['valid'] ?? m['isValid'] ?? m['realCodeFoundInSystem']) as bool? ?? false;
      final soldOrRetired = (m['isBlocked'] ?? m['utilised'] ?? m['sold']) as bool? ?? false;
      final errorMessage = m['errorMessage'] ?? m['errorCode'] ?? m['message'];
      return ChestnyZnakCodeCheck(
        code: code.isEmpty ? rawCodes.first : code,
        valid: valid,
        alreadyRetired: soldOrRetired,
        errorMessage: errorMessage?.toString(),
        raw: m,
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

  const ChestnyZnakCodeCheck({
    required this.code,
    required this.valid,
    required this.alreadyRetired,
    this.errorMessage,
    this.raw = const {},
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
    final doc = await FirebaseFirestore.instance.collection('settings').doc('integrations').get();
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