import 'app_scope.dart';
import 'package:http/http.dart' as http;

/// ЕГАИС в заведении общепита.
///
/// ЕГАИС нужен ТОЛЬКО если заведение продаёт алкоголь (включая пиво) — у
/// кальянной без алкоголя его просто нет. Общепит, в отличие от розницы,
/// НЕ отправляет в ЕГАИС каждую продажу с кассы: он принимает накладные
/// поставщиков (ТТН), переводит продукцию в торговый зал и отмечает
/// вскрытие бутылок крепкого алкоголя. Эти документы подписываются
/// крипто-ключом организации в УТМ — программе ФСРАР на компьютере
/// заведения; касса обращается к ней по локальной сети.
///
/// Здесь — то, что работает одинаково во всех версиях УТМ: проверка связи
/// и список входящих документов (`/opt/out` отдаёт
/// `<A><url replyId="…">http://…/opt/out/ТИП/номер</url>…</A>`), чтобы
/// администратор видел, что пришла новая накладная и её нужно принять.
/// Раньше при закрытии стола касса слала в УТМ самодельный «чек продажи»,
/// которого нет в форматах ЕГАИС для общепита, — эта отправка убрана.
class EgaisUtmService {
  final String utmHost;
  final int utmPort;

  /// Идентификатор организации в ЕГАИС (ФСРАР ИД, 12 цифр) — из УТМ или
  /// личного кабинета ЕГАИС.
  final String fsrarId;

  EgaisUtmService({required this.utmHost, this.utmPort = 8080, this.fsrarId = ''});

  Uri get _outUri => Uri.parse('http://$utmHost:$utmPort/opt/out');

  Future<EgaisConnectionStatus> checkConnection() async {
    try {
      final resp = await http.get(_outUri).timeout(const Duration(seconds: 5));
      if (resp.statusCode != 200 || !resp.body.contains('<A')) {
        return EgaisConnectionStatus(ok: false, message: 'Адрес отвечает, но это не УТМ (код ${resp.statusCode})');
      }
      final docs = parseIncoming(resp.body);
      final waybills = docs.where((d) => d.isWaybill).length;
      return EgaisConnectionStatus(
        ok: true,
        message: 'УТМ на связи. Входящих документов: ${docs.length}'
            '${waybills > 0 ? ', из них накладных поставщиков: $waybills' : ''}.'
            '${fsrarId.isEmpty ? ' Укажите ФСРАР ИД организации.' : ''}',
      );
    } catch (e) {
      return EgaisConnectionStatus(
        ok: false,
        message: 'Нет связи с УТМ по адресу $utmHost:$utmPort — проверьте, что '
            'компьютер с УТМ включён, в той же сети, крипто-ключ вставлен, а порт '
            '$utmPort не закрыт файрволом. ($e)',
      );
    }
  }

  /// Входящие документы из УТМ (новые сверху).
  Future<List<EgaisIncomingDoc>> incomingDocuments() async {
    final resp = await http.get(_outUri).timeout(const Duration(seconds: 10));
    if (resp.statusCode != 200) {
      throw EgaisException('УТМ ответил кодом ${resp.statusCode}');
    }
    return parseIncoming(resp.body).reversed.toList();
  }

  static final _urlRe = RegExp(r'<url(?:\s+replyId="([^"]*)")?\s*>([^<]+)</url>');

  /// Разбор ответа `/opt/out` (вынесен для теста без УТМ).
  static List<EgaisIncomingDoc> parseIncoming(String xml) => _urlRe.allMatches(xml).map((m) {
        final url = m.group(2)!.trim();
        final parts = Uri.tryParse(url)?.pathSegments ?? const <String>[];
        final i = parts.indexOf('out');
        final type = (i >= 0 && i + 1 < parts.length) ? parts[i + 1] : '';
        return EgaisIncomingDoc(type: type, url: url, replyId: m.group(1) ?? '');
      }).toList();
}

class EgaisIncomingDoc {
  final String type;
  final String url;
  final String replyId;
  const EgaisIncomingDoc({required this.type, required this.url, this.replyId = ''});

  bool get isWaybill => type.startsWith('WayBill') || type.startsWith('WAYBILL');

  /// Понятное название типа документа.
  String get label {
    final t = type.toLowerCase();
    if (t.startsWith('waybillact')) return 'Акт к накладной';
    if (t.startsWith('waybill')) return 'Накладная поставщика — примите в УТМ/ЕГАИС';
    if (t.startsWith('form2reginfo') || t.startsWith('formbreginfo') || t.startsWith('form1reginfo')) {
      return 'Справка к накладной';
    }
    if (t.startsWith('ticket')) return 'Квитанция ЕГАИС о приёме документа';
    if (t.startsWith('replyrests')) return 'Остатки';
    if (t.startsWith('replypartner') || t.startsWith('replyclient')) return 'Справочник организаций';
    if (t.startsWith('actwriteoff')) return 'Акт списания';
    if (t.startsWith('transfertoshop') || t.startsWith('transferfromshop')) return 'Перемещение между регистрами';
    return type.isEmpty ? 'Документ' : type;
  }
}

class EgaisConnectionStatus {
  final bool ok;
  final String message;
  const EgaisConnectionStatus({required this.ok, required this.message});
}

class EgaisException implements Exception {
  final String message;
  EgaisException(this.message);
  @override
  String toString() => message;
}

/// Подключённый УТМ — null, пока в заведении не включён ЕГАИС (Настройки →
/// Интеграции → «В заведении продаётся алкоголь») или не указан адрес УТМ.
EgaisUtmService? activeEgaisService;

EgaisUtmService? buildEgaisService(Map<String, dynamic> data) {
  final host = (data['utmHost'] as String?)?.trim() ?? '';
  // Старые настройки без переключателя: адрес УТМ указан — значит включено.
  final enabled = data['egaisEnabled'] as bool? ?? host.isNotEmpty;
  if (!enabled || host.isEmpty) return null;
  return EgaisUtmService(utmHost: host, fsrarId: (data['egaisFsrarId'] as String?)?.trim() ?? '');
}

/// Подтягивает сохранённые настройки ЕГАИС (settings/integrations) — один
/// раз при старте, как и остальные интеграции.
Future<void> loadSavedEgaisSettings() async {
  try {
    final doc = await AppScope.col('settings').doc('integrations').get();
    activeEgaisService = buildEgaisService(doc.data() ?? const {});
  } catch (_) {
    // Нет сети/документа при первом запуске — ЕГАИС остаётся выключенным
    // до захода в Настройки → Интеграции.
  }
}
