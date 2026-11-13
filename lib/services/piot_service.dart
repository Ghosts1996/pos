import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../build_info.dart';
import 'chestny_znak_api_service.dart';

/// Проверка кодов маркировки через ТС ПИоТ — техническое средство получения
/// информации о товаре «Честного знака». С 28.12.2025 касса обязана
/// проверять коды через него, проверка по токену X-API-KEY отключается с
/// 1.10.2026 (см. [ChestnyZnakApiService] — старый способ).
///
/// ТС ПИоТ ставится на компьютер у кассы (Windows) от оператора из реестра
/// «Честного знака» и слушает HTTPS, по умолчанию `https://localhost:51401`
/// (вторая касса на том же компьютере — 51402 и т. д.). Касса шлёт
/// `POST /api/v1/codes/check` с кодами и сведениями о кассовой программе
/// (`client_info`), ответ — как у `codes/check` True API, сгруппированный в
/// `codesResponse` с `reqId`/`reqTimestamp`: их касса пишет в чек отраслевым
/// реквизитом (UUID=…&Time=…, см. [MarkingPermit]). Касса на Android
/// обращается к ТС ПИоТ на компьютере в той же сети по его адресу.
///
/// Открытой спецификации нет (у разных версий ТС ПИоТ отличаются путь и
/// поля) — адрес и путь задаются в настройках, разбор ответа терпим к
/// вариантам ([parsePiotResponse]).
class PiotService {
  /// Адрес ТС ПИоТ: `https://localhost:51401` или полный путь проверки.
  final String url;

  /// Идентификатор кассовой программы в реестре ГИС МТ и ключ, если ТС ПИоТ
  /// их требует (`client_info.id` / `client_info.token`).
  final String softId;
  final String softToken;

  /// Логин и пароль, если в ТС ПИоТ включена авторизация (обычно пусто).
  final String login;
  final String password;

  PiotService({required this.url, this.softId = '', this.softToken = '', this.login = '', this.password = ''});

  static const defaultUrl = 'https://localhost:51401';

  bool get isAvailable => url.trim().isNotEmpty;

  /// Полный адрес запроса проверки: если в настройках только хост и порт —
  /// дописываем стандартный путь.
  Uri get checkUri {
    var u = url.trim();
    if (u.isEmpty) u = defaultUrl;
    if (!u.contains('://')) u = 'https://$u';
    final parsed = Uri.parse(u);
    if (parsed.path.isEmpty || parsed.path == '/') return parsed.replace(path: '/api/v1/codes/check');
    return parsed;
  }

  /// ТС ПИоТ стоит на компьютере у кассы и отвечает по HTTPS с собственным
  /// сертификатом. Такой сертификат принимаем только от своего компьютера и
  /// локальной сети (127.0.0.1, 10.x, 172.16–31.x, 192.168.x, *.local) —
  /// чужие адреса проверяются как обычно.
  static bool isLocalHost(String host) {
    final h = host.toLowerCase();
    if (h == 'localhost' || h.endsWith('.local') || h == '::1') return true;
    final ip = InternetAddress.tryParse(h);
    if (ip == null) return false;
    if (ip.isLoopback || ip.isLinkLocal) return true;
    if (ip.type == InternetAddressType.IPv4) {
      final b = ip.rawAddress;
      return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
    }
    return false;
  }

  http.Client _client() {
    final hc = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8)
      ..badCertificateCallback = (cert, host, port) => isLocalHost(host);
    return IOClient(hc);
  }

  /// Сведения о кассовой программе для ТС ПИоТ.
  Map<String, dynamic> get clientInfo {
    final build = int.tryParse(kBuildNumber) ?? 0;
    return {
      'name': 'ZalPOS',
      'version': build > 0 ? versionOf(build) : kBuildNumber,
      if (softId.trim().isNotEmpty) 'id': softId.trim(),
      if (softToken.trim().isNotEmpty) 'token': softToken.trim(),
    };
  }

  Future<List<ChestnyZnakCodeCheck>> checkCodes(List<String> rawCodes) async {
    if (rawCodes.isEmpty) return const [];
    if (rawCodes.length > 100) throw ChestnyZnakApiException('Максимум 100 кодов за одну проверку');
    final uri = checkUri;
    final headers = <String, String>{
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      if (login.trim().isNotEmpty) 'Authorization': 'Basic ${base64Encode(utf8.encode('${login.trim()}:$password'))}',
    };
    final client = _client();
    final http.Response resp;
    try {
      resp = await client
          .post(uri, headers: headers, body: jsonEncode({'codes': rawCodes, 'client_info': clientInfo}))
          .timeout(const Duration(seconds: 12));
    } catch (e) {
      throw ChestnyZnakApiException('ТС ПИоТ не отвечает по адресу ${uri.origin} — проверьте, что он запущен на '
          'компьютере кассы, адрес и порт (обычно 51401), и что антивирус не блокирует обмен. ($e)');
    } finally {
      client.close();
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw ChestnyZnakApiException('ТС ПИоТ отклонил запрос (${resp.statusCode}) — проверьте логин и пароль, '
          'идентификатор и ключ кассовой программы в настройках.');
    }
    if (resp.statusCode == 404) {
      throw ChestnyZnakApiException('ТС ПИоТ не знает адрес ${uri.path} — укажите путь проверки из инструкции к вашему '
          'ТС ПИоТ (например, https://localhost:51401/api/v2/codes/check).');
    }
    if (resp.statusCode != 200) {
      throw ChestnyZnakApiException('Ошибка ${resp.statusCode} от ТС ПИоТ: ${_short(utf8.decode(resp.bodyBytes, allowMalformed: true))}');
    }
    Object? data;
    try {
      data = jsonDecode(utf8.decode(resp.bodyBytes));
    } catch (_) {
      throw ChestnyZnakApiException('Не удалось разобрать ответ ТС ПИоТ: ${_short(resp.body)}');
    }
    return parsePiotResponse(data, rawCodes);
  }
}

/// Активный ТС ПИоТ кассы (Настройки → Интеграции → «Честный ЗНАК»,
/// способ «ТС ПИоТ»; только SaaS). Если задан — проверка кода идёт через
/// него, а не по токену ([activeChestnyZnakApi]).
PiotService? activePiot;

/// ТС ПИоТ из документа settings/integrations: czMode == 'piot'.
PiotService? piotFromSettings(Map<String, dynamic> d) {
  if (d['czMode'] != 'piot') return null;
  return PiotService(
    url: '${d['czPiotUrl'] ?? ''}'.trim().isEmpty ? PiotService.defaultUrl : '${d['czPiotUrl']}',
    softId: '${d['czPiotId'] ?? ''}',
    softToken: '${d['czPiotToken'] ?? ''}',
    login: '${d['czPiotLogin'] ?? ''}',
    password: '${d['czPiotPassword'] ?? ''}',
  );
}

String _short(String s) => s.length > 300 ? '${s.substring(0, 300)}…' : s;

/// Понятное объяснение кода ошибки группы ответа ТС ПИоТ.
String piotErrorText(int code, String description) {
  final d = description.trim();
  switch (code) {
    case 514:
      return 'ТС ПИоТ не получил ответ от «Честного знака» и от локального модуля (514): проверьте интернет на '
          'компьютере кассы, что локальный модуль ЧЗ запущен, и что антивирус не блокирует обмен.';
    default:
      return 'ТС ПИоТ вернул ошибку $code${d.isNotEmpty ? ': $d' : ''}';
  }
}

bool? _bool(Object? v) => v is bool ? v : (v is String ? (v == 'true' ? true : v == 'false' ? false : null) : null);

/// Разбор ответа ТС ПИоТ. Понимает оба известных вида:
///  • `{codesResponse: [{code, description, codes: [...], reqId, reqTimestamp, isCheckedOffline}]}`
///    (бывает и вложенный `{codesResponse: {codesResponse: [...]}}`);
///  • как у True API: `{code, codes: [...], reqId, reqTimestamp}`.
/// Можно продавать, если код найден, подлинный, введён в оборот, не
/// заблокирован, не продан и не просрочен.
List<ChestnyZnakCodeCheck> parsePiotResponse(Object? data, List<String> rawCodes) {
  if (data is! Map) throw ChestnyZnakApiException('Неожиданный ответ ТС ПИоТ');
  Object? groups = data['codesResponse'];
  if (groups is Map) groups = groups['codesResponse'] ?? [groups];
  final list = groups is List ? groups : [data];
  final out = <ChestnyZnakCodeCheck>[];
  for (final g in list) {
    if (g is! Map) continue;
    final gCode = int.tryParse('${g['code'] ?? 0}') ?? 0;
    if (gCode != 0) throw ChestnyZnakApiException(piotErrorText(gCode, '${g['description'] ?? ''}'));
    final reqId = '${g['reqId'] ?? data['reqId'] ?? ''}';
    final reqTs = '${g['reqTimestamp'] ?? data['reqTimestamp'] ?? ''}';
    final offline = _bool(g['isCheckedOffline']) ?? false;
    for (final raw in (g['codes'] as List? ?? const [])) {
      if (raw is! Map) continue;
      final m = Map<String, dynamic>.from(raw);
      final code = '${m['cis'] ?? m['code'] ?? ''}';
      final found = _bool(m['found']) ?? _bool(m['valid']) ?? _bool(m['realCodeFoundInSystem']) ?? false;
      final verified = _bool(m['verified']);
      final realizable = _bool(m['realizable']);
      final blocked = _bool(m['isBlocked']) == true;
      final sold = _bool(m['sold']) == true;
      final expire = DateTime.tryParse('${m['expireDate'] ?? ''}');
      final expired = expire != null && expire.isBefore(DateTime.now());
      final err = m['errorCode'];
      final hasErr = err != null && err != 0 && err != '0';
      String? message;
      if (!found) {
        message = 'Код не найден в «Честном знаке» — возможна подделка';
      } else if (verified == false) {
        message = 'Код не прошёл проверку подлинности';
      } else if (realizable == false) {
        message = 'Товар не введён в оборот — продавать нельзя';
      } else if (blocked) {
        message = 'Товар заблокирован для продажи';
      } else if (expired) {
        message = 'Истёк срок годности';
      } else if (hasErr) {
        message = '${m['errorMessage'] ?? m['message'] ?? 'Код ошибки $err'}';
      }
      out.add(ChestnyZnakCodeCheck(
        code: code.isEmpty && rawCodes.isNotEmpty ? rawCodes.first : code,
        valid: found && verified != false && realizable != false && !blocked && !expired && !hasErr,
        alreadyRetired: sold,
        errorMessage: message ?? (sold ? 'Код уже продан ранее' : null),
        raw: m,
        reqId: reqId,
        reqTimestamp: reqTs,
        offline: offline,
      ));
    }
  }
  return out;
}
