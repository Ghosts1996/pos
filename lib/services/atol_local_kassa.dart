import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:http/http.dart' as http;

import '../models/fiscal_receipt.dart';
import 'kassa_service.dart';

/// Фискальный регистратор АТОЛ, который стоит в заведении, — через
/// «Веб-сервер ККТ» из драйвера АТОЛ 10 (JSON-задания, `/api/v2/requests`,
/// порт 16732). Веб-сервер ставится на компьютер или на саму смарт-кассу,
/// к которому подключён регистратор, касса ZalPOS отправляет ему задания по
/// локальной сети.
///
/// Интернет для этого не нужен: чек печатается и записывается в
/// фискальный накопитель сразу, а в ОФД ФН отправит его сам, когда связь
/// вернётся (на это у ФН есть 30 дней).
///
/// Номер задания — id чека ([FiscalReceipt.receiptId]): повторная отправка
/// того же чека после обрыва связи не пробьёт его второй раз — веб-сервер
/// ответит 409, и мы просто заберём результат первого задания.
class AtolLocalKassaService implements KassaService {
  /// Адрес веб-сервера: `192.168.1.50`, `192.168.1.50:16732` или полный URL.
  final String baseUrl;
  final FiscalTaxSystem taxSystem;

  /// ФФД 1.2 (нужен для маркировки) или 1.05.
  final bool ffd12;

  /// Кассир (теги 1021/1203). Пусто — регистратор возьмёт кассира из своих
  /// настроек.
  final String cashierName;
  final String cashierInn;

  static const defaultPort = 16732;

  AtolLocalKassaService({
    required String address,
    this.taxSystem = FiscalTaxSystem.osn,
    this.ffd12 = true,
    this.cashierName = '',
    this.cashierInn = '',
  }) : baseUrl = normalizeAddress(address);

  static String normalizeAddress(String raw) {
    var a = raw.trim().replaceAll(RegExp(r'/+$'), '');
    if (a.isEmpty) return '';
    if (!a.startsWith('http://') && !a.startsWith('https://')) a = 'http://$a';
    final uri = Uri.tryParse(a);
    if (uri == null || uri.host.isEmpty) return '';
    return uri.hasPort ? '${uri.scheme}://${uri.host}:${uri.port}' : '${uri.scheme}://${uri.host}:$defaultPort';
  }

  @override
  bool get isAvailable => baseUrl.isNotEmpty;

  static String paymentType(String type) {
    switch (type) {
      case 'cash':
        return 'cash';
      case 'card':
        return 'electronically';
      case 'prepayment':
        return 'prepaid';
      default:
        return 'other';
    }
  }

  String _paymentObject(FiscalReceiptItem i) {
    final marked = ffd12 && (i.markingCode ?? '').isNotEmpty;
    switch (i.paymentObject) {
      case FiscalPaymentObject.service:
        return 'service';
      case FiscalPaymentObject.excise:
        return marked ? 'exciseWithMarking' : 'excise';
      case FiscalPaymentObject.commodity:
      case FiscalPaymentObject.markedGood:
        return marked ? 'commodityWithMarking' : 'commodity';
    }
  }

  Map<String, dynamic> _item(FiscalReceiptItem i) {
    final marked = ffd12 && (i.markingCode ?? '').isNotEmpty;
    final permit = i.markingPermit;
    return {
      'type': 'position',
      'name': i.name,
      'price': roundKopecks(i.price),
      'quantity': i.quantity,
      'amount': i.sum,
      'paymentMethod': 'fullPayment',
      'paymentObject': _paymentObject(i),
      'tax': {'type': i.vat.providerCode},
      if (ffd12) 'measurementUnit': 'piece',
      if (marked)
        'imcParams': {
          'imcType': 'auto',
          'imc': base64.encode(utf8.encode(i.markingCode!)),
          'itemEstimatedStatus': 'itemPieceSold',
          'imcModeProcessing': 0,
        },
      if (marked && permit != null)
        'industryInfo': [
          {
            'fois': MarkingPermit.federalId,
            'date': MarkingPermit.documentDate,
            'number': MarkingPermit.documentNumber,
            'industryAttribute': permit.value,
          },
        ],
    };
  }

  @visibleForTesting
  Map<String, dynamic> buildTask(FiscalReceipt receipt) {
    final contact = splitReceiptContact(receipt.buyerContact);
    final emailOrPhone = contact.email ?? contact.phone;
    return {
      'type': 'sell',
      'taxationType': taxSystem.name,
      if (cashierName.isNotEmpty)
        'operator': {'name': cashierName, if (cashierInn.isNotEmpty) 'vatin': cashierInn},
      if (emailOrPhone != null) 'clientInfo': {'emailOrPhone': emailOrPhone},
      'items': receipt.items.map(_item).toList(),
      'payments': receipt.payments
          .map((p) => {'type': paymentType(p.type), 'sum': roundKopecks(p.amount)})
          .toList(),
      'total': receipt.total,
    };
  }

  Future<http.Response> _post(String uuid, Map<String, dynamic> task) => http
      .post(
        Uri.parse('$baseUrl/api/v2/requests'),
        headers: {'Content-Type': 'application/json; charset=utf-8'},
        body: jsonEncode({
          'uuid': uuid,
          'request': [task],
        }),
      )
      .timeout(const Duration(seconds: 6));

  /// Результат задания: `ready` — выполнено, `error` — регистратор
  /// отказал, иначе ещё в очереди. null — так и не дождались.
  Future<Map<String, dynamic>?> _waitResult(String uuid, {int attempts = 30}) async {
    for (var i = 0; i < attempts; i++) {
      await Future.delayed(Duration(milliseconds: i == 0 ? 300 : 700));
      final resp = await http.get(Uri.parse('$baseUrl/api/v2/requests/$uuid')).timeout(const Duration(seconds: 5));
      if (resp.statusCode != 200) continue;
      final data = jsonDecode(utf8.decode(resp.bodyBytes, allowMalformed: true));
      final results = data is Map ? data['results'] : null;
      if (results is! List || results.isEmpty) continue;
      final r = Map<String, dynamic>.from(results.first as Map);
      final status = r['status'];
      if (status == 'ready' || status == 'error') return r;
    }
    return null;
  }

  static String _error(Map<String, dynamic> r) {
    final text = r['errorDescription'] ?? 'ошибка регистратора';
    return r['errorCode'] != null ? '$text (код ${r['errorCode']})' : '$text';
  }

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    if (!isAvailable) return const FiscalReceiptResult.failure('Не указан адрес веб-сервера АТОЛ');
    if (!ffd12 && receipt.items.any((i) => (i.markingCode ?? '').isNotEmpty)) {
      return const FiscalReceiptResult.failure(
          'Маркированный товар пробивается только по ФФД 1.2 — переключите формат в Настройках → Интеграции.');
    }
    final uuid = receipt.receiptId;
    try {
      final resp = await _post(uuid, buildTask(receipt));
      // 409 — задание с этим номером уже есть (чек отправляли до обрыва
      // связи): не пробиваем заново, а берём его результат.
      if (resp.statusCode != 201 && resp.statusCode != 200 && resp.statusCode != 409) {
        return FiscalReceiptResult.failure('Веб-сервер АТОЛ не принял чек (HTTP ${resp.statusCode}): ${resp.body}');
      }
      final r = await _waitResult(uuid);
      if (r == null) return FiscalReceiptResult.success(fiscalDocumentNumber: uuid, pending: true);
      if (r['status'] == 'error') return FiscalReceiptResult.failure('Регистратор отказал: ${_error(r)}');
      final result = r['result'];
      final fp = result is Map ? result['fiscalParams'] : null;
      final params = fp is Map ? fp : const {};
      return FiscalReceiptResult.success(
        fiscalDocumentNumber: params['fiscalDocumentNumber']?.toString(),
        fiscalSign: params['fiscalDocumentSign']?.toString(),
        fnNumber: params['fnNumber']?.toString(),
      );
    } catch (e) {
      if (isNetworkError(e)) {
        return FiscalReceiptResult.unreachable(
            'Регистратор АТОЛ не отвечает по адресу $baseUrl — проверьте, что он включён и веб-сервер запущен');
      }
      return FiscalReceiptResult.failure('Ошибка обмена с регистратором: $e');
    }
  }

  /// Проверка связи без чека: состояние регистратора (смена, бумага).
  Future<String> checkStatus() async {
    if (!isAvailable) return 'Укажите адрес веб-сервера АТОЛ';
    final uuid = 'status-${DateTime.now().millisecondsSinceEpoch}';
    try {
      final resp = await _post(uuid, {'type': 'getDeviceStatus'});
      if (resp.statusCode != 201 && resp.statusCode != 200) {
        return 'Веб-сервер ответил HTTP ${resp.statusCode}';
      }
      final r = await _waitResult(uuid, attempts: 12);
      if (r == null) return 'Веб-сервер на связи, но регистратор не ответил — проверьте кабель и питание';
      if (r['status'] == 'error') return 'Регистратор: ${_error(r)}';
      final result = r['result'];
      final st = result is Map && result['deviceStatus'] is Map ? result['deviceStatus'] as Map : const {};
      final shift = switch (st['shift']) {
        'opened' => 'смена открыта',
        'expired' => 'смена дольше 24 часов — закройте её',
        'closed' => 'смена закрыта (откроется с первым чеком)',
        _ => 'состояние смены неизвестно',
      };
      final paper = st['paperPresent'] == false ? ', нет бумаги' : '';
      return 'Регистратор на связи: $shift$paper';
    } catch (e) {
      return isNetworkError(e)
          ? 'Нет связи с $baseUrl — проверьте адрес, что регистратор включён и веб-сервер АТОЛ запущен'
          : 'Ошибка: $e';
    }
  }
}
