import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:xml/xml.dart';
import 'package:uuid/uuid.dart';
import '../models/egais_models.dart';

/// Интеграция с ЕГАИС.
///
/// ВАЖНО, честно про то, что здесь реально автоматизировано, а что нет:
///
/// 1. ЕГАИС не принимает запросы напрямую из приложения — по закону обмен
///    идёт через УТМ (Универсальный Транспортный Модуль), программу от
///    ЦРПТ/Росалкогольрегулирования, которая:
///      • ставится на отдельный ПК/сервер в той же локальной сети, что и
///        касса/планшет;
///      • требует физический крипто-ключ (JaCarta/Рутокен PINPad) с
///        сертификатом организации, которым УТМ подписывает документы;
///      • сама поднимает локальный HTTP-сервер, обычно на
///        `http://<ip-компьютера-с-УТМ>:8080`.
///    Наше приложение — это клиент к УТМ, а не к ЕГАИС напрямую. Ссылку/IP
///    компьютера с УТМ нужно один раз указать в настройках интеграций.
///
/// 2. Реальный протокол УТМ — это обмен XML-документами по HTTP:
///      POST http://<utm host>:8080/opt/in/<ИмяМетода>   (multipart, файл xml_file)
///      GET  http://<utm host>:8080/opt/out               (входящие от ЕГАИС документы)
///    Ниже реализован именно этот протокол — реальные HTTP-вызовы, а не
///    заглушка. Но структура XML документа `ЧекАлкоРозница`/`ПродажаПива`
///    (набор тегов, версия схемы) регулярно уточняется Росалкогольрегулированием,
///    и её стоит сверить с актуальными методическими рекомендациями УТМ
///    перед боевым запуском — здесь заложен корректный на 2025-2026 год
///    минимальный набор полей, но это тот кусок, который в первую очередь
///    стоит показать интегратору ЕГАИС на объекте.
///
/// 3. Каждой позиции алкоголя в вашем справочнике нужен алкокод — он не
///    придумывается на кассе, а выдаётся ЕГАИС при заведении марки/партии
///    в личном кабинете организации. См. поле [AlcoholInfo.alcCode].
class EgaisUtmService {
  final Uuid _uuid = const Uuid();

  /// Адрес компьютера с установленным УТМ, например `192.168.1.50`.
  /// Задаётся в настройках интеграций и хранится в Firestore
  /// (settings/integrations), не хардкодится.
  String utmHost;
  int utmPort;

  EgaisUtmService({required this.utmHost, this.utmPort = 8080});

  Uri _uri(String method) => Uri.parse('http://$utmHost:$utmPort/opt/in/$method');

  /// Простая проверка, что УТМ вообще поднят и отвечает — дергаем
  /// стандартный метод получения версии УТМ. Используется на экране
  /// настроек кнопкой "Проверить соединение".
  Future<EgaisConnectionStatus> checkConnection() async {
    try {
      final resp = await http
          .get(Uri.parse('http://$utmHost:$utmPort/utm/version'))
          .timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        return EgaisConnectionStatus(ok: true, message: resp.body.trim());
      }
      return EgaisConnectionStatus(ok: false, message: 'УТМ ответил кодом ${resp.statusCode}');
    } catch (e) {
      return EgaisConnectionStatus(
        ok: false,
        message: 'Нет связи с УТМ по адресу $utmHost:$utmPort — проверьте, что '
            'компьютер с УТМ включён, находится в той же сети и порт 8080 не '
            'закрыт файрволом. ($e)',
      );
    }
  }

  /// Формирует и отправляет в УТМ документ розничной продажи для позиций
  /// чека, отмеченных как алкоголь. Крепкий алкоголь и пиво уходят разными
  /// документами, поэтому список линий разбивается автоматически.
  ///
  /// Возвращает id документа на стороне УТМ (нужен для последующей сверки
  /// статуса через [pollDocumentStatus]), либо бросает [EgaisException].
  Future<String> sendRetailSale({
    required List<EgaisSaleLine> lines,
    required String receiptNumber,
  }) async {
    if (lines.isEmpty) {
      throw EgaisException('Нет алкогольных позиций для отправки в ЕГАИС');
    }

    final strong = lines.where((l) => !l.isBeer).toList();
    final beer = lines.where((l) => l.isBeer).toList();

    String? lastDocId;
    if (strong.isNotEmpty) {
      lastDocId = await _sendDocument(
        method: 'CheckAlcoRetail',
        rootTag: 'ЧекАлкоРозница',
        lines: strong,
        receiptNumber: receiptNumber,
      );
    }
    if (beer.isNotEmpty) {
      lastDocId = await _sendDocument(
        method: 'BeerRetailSale',
        rootTag: 'ПродажаПива',
        lines: beer,
        receiptNumber: receiptNumber,
      );
    }
    return lastDocId!;
  }

  Future<String> _sendDocument({
    required String method,
    required String rootTag,
    required List<EgaisSaleLine> lines,
    required String receiptNumber,
  }) async {
    final docId = _uuid.v4();
    final builder = XmlBuilder();
    builder.processing('xml', 'version="1.0" encoding="UTF-8"');
    builder.element('Documents', nest: () {
      builder.element(rootTag, nest: () {
        builder.element('Identity', nest: () => builder.text(docId));
        builder.element('Number', nest: () => builder.text(receiptNumber));
        builder.element('Date', nest: () => builder.text(_egaisDate(DateTime.now())));
        builder.element('Content', nest: () {
          for (final line in lines) {
            builder.element('Position', nest: () {
              builder.element('AlcCode', nest: () => builder.text(line.alcCode));
              builder.element('Quantity', nest: () => builder.text(line.quantityLiters.toStringAsFixed(4)));
            });
          }
        });
      });
    });
    final xmlDoc = builder.buildDocument().toXmlString(pretty: false);

    final request = http.MultipartRequest('POST', _uri(method))
      ..files.add(http.MultipartFile.fromBytes(
        'xml_file',
        utf8.encode(xmlDoc),
        filename: '$docId.xml',
      ));

    try {
      final streamed = await request.send().timeout(const Duration(seconds: 15));
      final resp = await http.Response.fromStream(streamed);
      if (resp.statusCode != 200) {
        throw EgaisException('УТМ вернул ошибку ${resp.statusCode}: ${resp.body}');
      }
      return docId;
    } catch (e) {
      if (e is EgaisException) rethrow;
      throw EgaisException('Не удалось отправить документ в УТМ: $e');
    }
  }

  /// Забирает входящие документы (квитанции о принятии/отказе) из УТМ —
  /// реальный обмен асинхронный: сам факт HTTP 200 при отправке значит
  /// только "УТМ принял документ в очередь", а не "ЕГАИС подтвердила
  /// продажу". Итоговый статус приходит позже отдельным документом сюда.
  Future<List<String>> pollIncomingDocuments() async {
    try {
      final resp = await http
          .get(Uri.parse('http://$utmHost:$utmPort/opt/out'))
          .timeout(const Duration(seconds: 10));
      if (resp.statusCode != 200) return [];
      return [resp.body];
    } catch (_) {
      return [];
    }
  }

  String _egaisDate(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
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