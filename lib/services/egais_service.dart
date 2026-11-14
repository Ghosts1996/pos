import 'dart:convert';

import 'app_scope.dart';
import 'package:http/http.dart' as http;

/// ЕГАИС в заведении общепита — только если продаётся алкоголь.
///
/// Общепит не передаёт в ЕГАИС каждую продажу: он принимает накладные
/// (ТТН), переводит продукцию в торговый зал и отмечает вскрытие бутылок
/// крепкого. Документы подписываются ключом организации в УТМ — программе
/// ФСРАР на компьютере заведения, касса обращается к ней по сети.
///
/// Здесь: проверка связи, список входящих документов (`/opt/out`),
/// накладная поставщика с номером в ЕГАИС (из справки FORM2REGINFO) и ответ
/// на неё — акт приёмки `WayBillAct_v4` (принять, отказать или принять с
/// расхождениями по количеству). Подписывает и отправляет в ЕГАИС сам УТМ.
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

  /// Документ из УТМ по его адресу из списка.
  Future<String> fetch(String url) async {
    final resp = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 15));
    if (resp.statusCode != 200) throw EgaisException('УТМ не отдал документ (код ${resp.statusCode})');
    return utf8.decode(resp.bodyBytes);
  }

  /// Накладные поставщиков с номером в ЕГАИС: накладная (WayBill) и её
  /// справка (FORM2REGINFO) сопоставляются по идентификатору документа,
  /// иначе — по номеру накладной.
  Future<List<EgaisWaybill>> waybills([List<EgaisIncomingDoc>? docs]) async {
    final list = docs ?? await incomingDocuments();
    final regs = <EgaisRegInfo>[];
    for (final d in list.where((d) => d.type.toLowerCase().startsWith('form2reginfo'))) {
      final r = EgaisRegInfo.parse(await fetch(d.url));
      if (r != null) regs.add(r);
    }
    final out = <EgaisWaybill>[];
    for (final d in list.where((d) => d.isWaybill && !d.type.toLowerCase().startsWith('waybillact'))) {
      final w = EgaisWaybill.parse(await fetch(d.url), url: d.url);
      if (w == null) continue;
      final reg = regs.where((r) => r.identity.isNotEmpty && r.identity == w.identity).firstOrNull ??
          regs.where((r) => r.number.isNotEmpty && r.number == w.number).firstOrNull;
      out.add(reg == null ? w : w.withReg(reg));
    }
    return out;
  }

  /// Ответ на накладную: принять целиком ([accept] true, без [real]),
  /// отказать ([accept] false) или принять с расхождениями — [real]:
  /// номер позиции в накладной → сколько пришло на самом деле. Возвращает
  /// номер запроса в УТМ (по нему придёт квитанция Ticket).
  Future<String> sendAct(EgaisWaybill wb, {required bool accept, Map<String, num> real = const {}, String note = '', DateTime? date}) async {
    if (fsrarId.isEmpty) throw EgaisException('Укажите ФСРАР ИД организации в настройках ЕГАИС');
    if (wb.regId.isEmpty) throw EgaisException('Нет справки к накладной (номера в ЕГАИС) — дождитесь её в УТМ и обновите список');
    final xml = buildActXml(fsrarId: fsrarId, wb: wb, accept: accept, real: real, note: note, date: date ?? DateTime.now());
    final req = http.MultipartRequest('POST', Uri.parse('http://$utmHost:$utmPort/opt/in/WayBillAct_v4'))
      ..files.add(http.MultipartFile.fromBytes('xml_file', utf8.encode(xml), filename: 'act.xml'));
    final resp = await http.Response.fromStream(await req.send().timeout(const Duration(seconds: 30)));
    final body = utf8.decode(resp.bodyBytes);
    final err = RegExp(r'<error>([\s\S]*?)</error>').firstMatch(body)?.group(1)?.trim();
    if (resp.statusCode != 200 || err != null) {
      throw EgaisException('УТМ не принял акт: ${err ?? 'код ${resp.statusCode}'}');
    }
    return RegExp(r'<url>([^<]+)</url>').firstMatch(body)?.group(1)?.trim() ?? '';
  }

  static String _esc(String v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  /// XML акта приёмки WayBillAct_v4 (вынесен для теста).
  static String buildActXml({
    required String fsrarId,
    required EgaisWaybill wb,
    required bool accept,
    Map<String, num> real = const {},
    String note = '',
    required DateTime date,
  }) {
    final diffs = accept ? real.entries.where((e) => wb.positions.any((p) => p.identity == e.key && p.quantity != e.value)).toList() : const <MapEntry<String, num>>[];
    final mode = !accept ? 'Rejected' : diffs.isEmpty ? 'Accepted' : 'Differences';
    final d = '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
    final actNo = 'A${date.millisecondsSinceEpoch % 100000000}';
    final content = StringBuffer();
    for (final e in diffs) {
      final p = wb.positions.firstWhere((p) => p.identity == e.key);
      content.write('<wa:Position><wa:Identity>${_esc(p.identity)}</wa:Identity>'
          '<wa:InformF2RegId>${_esc(p.informF2RegId)}</wa:InformF2RegId>'
          '<wa:RealQuantity>${e.value}</wa:RealQuantity></wa:Position>');
    }
    return '<?xml version="1.0" encoding="UTF-8"?>'
        '<ns:Documents Version="1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:ns="http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01"'
        ' xmlns:wa="http://fsrar.ru/WEGAIS/ActTTNSingle_v4"'
        ' xmlns:ce="http://fsrar.ru/WEGAIS/CommonV3">'
        '<ns:Owner><ns:FSRAR_ID>${_esc(fsrarId)}</ns:FSRAR_ID></ns:Owner>'
        '<ns:Document><ns:WayBillAct_v4><wa:Header>'
        '<wa:IsAccept>$mode</wa:IsAccept>'
        '<wa:ACTNUMBER>$actNo</wa:ACTNUMBER>'
        '<wa:ActDate>$d</wa:ActDate>'
        '<wa:WBRegId>${_esc(wb.regId)}</wa:WBRegId>'
        '<wa:Note>${_esc(note.isEmpty ? (accept ? 'Принято' : 'Отказ от накладной') : note)}</wa:Note>'
        '</wa:Header><wa:Content>$content</wa:Content></ns:WayBillAct_v4></ns:Document></ns:Documents>';
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

/// Значение тега без учёта префикса пространства имён (<wb:NUMBER>, <NUMBER>).
String _tag(String xml, String name) =>
    RegExp('<(?:[\\w-]+:)?$name(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?$name>').firstMatch(xml)?.group(1)?.trim() ?? '';

Iterable<String> _blocks(String xml, String name) =>
    RegExp('<(?:[\\w-]+:)?$name(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?$name>').allMatches(xml).map((m) => m.group(1)!);

/// Позиция накладной.
class EgaisPosition {
  final String identity;
  final String name;
  final num quantity;
  final String informF2RegId;
  const EgaisPosition({required this.identity, required this.name, required this.quantity, this.informF2RegId = ''});
}

/// Справка к накладной (FORM2REGINFO): номер накладной в ЕГАИС и справки Б
/// по позициям.
class EgaisRegInfo {
  final String identity;
  final String number;
  final String regId;
  final Map<String, String> informF2ByPosition;
  const EgaisRegInfo({required this.identity, required this.number, required this.regId, required this.informF2ByPosition});

  static EgaisRegInfo? parse(String xml) {
    final regId = _tag(xml, 'WBRegId');
    if (regId.isEmpty) return null;
    final header = _blocks(xml, 'Header').firstOrNull ?? xml;
    return EgaisRegInfo(
      identity: _tag(header, 'Identity'),
      number: _tag(header, 'WBNUMBER'),
      regId: regId,
      informF2ByPosition: {
        for (final p in _blocks(xml, 'Position'))
          if (_tag(p, 'Identity').isNotEmpty) _tag(p, 'Identity'): _tag(p, 'InformF2RegId'),
      },
    );
  }
}

/// Накладная поставщика (WayBill_v4).
class EgaisWaybill {
  final String url;
  final String identity;
  final String number;
  final String date;
  final String shipper;
  final List<EgaisPosition> positions;

  /// Номер накладной в ЕГАИС (из справки) — нужен для акта приёмки.
  final String regId;

  const EgaisWaybill({
    required this.url,
    required this.identity,
    required this.number,
    required this.date,
    required this.shipper,
    required this.positions,
    this.regId = '',
  });

  static EgaisWaybill? parse(String xml, {String url = ''}) {
    final header = _blocks(xml, 'Header').firstOrNull;
    if (header == null) return null;
    final shipperBlock = _blocks(header, 'Shipper').firstOrNull ?? '';
    return EgaisWaybill(
      url: url,
      identity: _tag(xml, 'Identity'),
      number: _tag(header, 'NUMBER'),
      date: _tag(header, 'Date'),
      shipper: _tag(shipperBlock, 'ShortName').isNotEmpty ? _tag(shipperBlock, 'ShortName') : _tag(shipperBlock, 'FullName'),
      positions: [
        for (final p in _blocks(xml, 'Position'))
          EgaisPosition(
            identity: _tag(p, 'Identity'),
            name: _tag(p, 'FullName').isNotEmpty ? _tag(p, 'FullName') : _tag(p, 'ShortName'),
            quantity: num.tryParse(_tag(p, 'Quantity').replaceAll(',', '.')) ?? 0,
          ),
      ],
    );
  }

  EgaisWaybill withReg(EgaisRegInfo reg) => EgaisWaybill(
        url: url,
        identity: identity,
        number: number,
        date: date,
        shipper: shipper,
        regId: reg.regId,
        positions: [
          for (final p in positions)
            EgaisPosition(identity: p.identity, name: p.name, quantity: p.quantity, informF2RegId: reg.informF2ByPosition[p.identity] ?? ''),
        ],
      );
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
