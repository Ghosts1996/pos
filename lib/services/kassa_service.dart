import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:basic_utils/basic_utils.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:http/http.dart' as http;
import 'package:pointycastle/export.dart';
import '../models/fiscal_receipt.dart';

/// Абстракция над фискализацией чека по 54-ФЗ.
///
/// Экран оплаты работает только с этим интерфейсом и ничего не знает про
/// конкретного провайдера кассы — поэтому подключение реальной кассы
/// сводится к одному месту (см. [kassaService] в конце файла), как и с
/// платёжным терминалом в `payment_terminal_service.dart`.
///
/// Важный момент, на который стоит решиться осознанно: у розничного 54-ФЗ
/// есть два принципиально разных пути подключения кассы к такому
/// планшетному приложению, как это:
///
///   А) Физическая касса (АТОЛ 91Ф/92Ф, Штрих-М, Эвотор и т.п.) стоит
///      прямо в заведении рядом с планшетом. Приложению нужен нативный
///      SDK/драйвер этой кассы — Flutter не может напрямую говорить с
///      портом ККТ, нужен platform channel (Kotlin/Java на Android),
///      обычно этот SDK даёт сам производитель кассы.
///
///   Б) Облачная касса — физическое ККТ стоит у провайдера (АТОЛ Онлайн,
///      OrangeData, CloudKassir и т.п.), а приложение просто отправляет
///      ему чек по HTTPS и получает фискальные признаки в ответ. Не нужно
///      физического устройства в заведении и native-кода — именно поэтому
///      ниже реализованы клиенты именно такого типа: [AtolCloudKassaService]
///      (протокол "АТОЛ Онлайн" v4, которым говорят и сам АТОЛ, и часть его
///      реселлеров вроде Ferma/OFD.ru — просто с другим `baseUrl`) и
///      [OrangeDataKassaService] (протокол OrangeData: mTLS + RSA-подпись
///      тела запроса). Формально касса всё равно должна физически стоять и
///      быть зарегистрирована в ФНС на ваше юрлицо/ИП — просто не в зале, а
///      в дата-центре провайдера, который её обслуживает по договору.
///
/// Для любого пути нужен действующий договор с ОФД и регистрация ККТ в
/// личном кабинете налоговой (nalog.gov.ru) — это не техническая часть и
/// её нельзя автоматизировать кодом. Оба клиента ниже реализуют реальный
/// сетевой протокол своего провайдера (не имитацию) — после того как
/// заключён договор и в Настройки → Интеграции вписаны выданные провайдером
/// реквизиты, чек уходит по-настоящему. До этого момента — [MockKassaService].
abstract class KassaService {
  bool get isAvailable;
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt);
}

class MockKassaService implements KassaService {
  @override
  bool get isAvailable => true;

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    await Future.delayed(const Duration(milliseconds: 800));
    final n = DateTime.now().millisecondsSinceEpoch % 100000;
    return FiscalReceiptResult.success(
      fiscalDocumentNumber: 'MOCK-FD-$n',
      fiscalSign: 'MOCK-FPD-$n',
      fnNumber: 'MOCK-FN-0000000000',
    );
  }
}

/// Система налогообложения заведения (тег ФФД 1055) — общая для всех
/// облачных касс форма записи, поэтому вынесена сюда, а не дублируется в
/// каждом клиенте.
enum FiscalTaxSystem { osn, usnIncome, usnIncomeOutcome, envd, esn, patent }

extension FiscalTaxSystemX on FiscalTaxSystem {
  /// Строковый код для протокола АТОЛ Онлайн (`company.sno`).
  String get atolCode {
    switch (this) {
      case FiscalTaxSystem.osn:
        return 'osn';
      case FiscalTaxSystem.usnIncome:
        return 'usn_income';
      case FiscalTaxSystem.usnIncomeOutcome:
        return 'usn_income_outcome';
      case FiscalTaxSystem.envd:
        return 'envd';
      case FiscalTaxSystem.esn:
        return 'esn';
      case FiscalTaxSystem.patent:
        return 'patent';
    }
  }

  /// Числовой код для протокола OrangeData (`checkClose.taxationSystem`).
  int get orangeDataCode {
    switch (this) {
      case FiscalTaxSystem.osn:
        return 0;
      case FiscalTaxSystem.usnIncome:
        return 1;
      case FiscalTaxSystem.usnIncomeOutcome:
        return 2;
      case FiscalTaxSystem.envd:
        return 3;
      case FiscalTaxSystem.esn:
        return 4;
      case FiscalTaxSystem.patent:
        return 5;
    }
  }

  static FiscalTaxSystem fromId(String? id) {
    switch (id) {
      case 'usn_income':
        return FiscalTaxSystem.usnIncome;
      case 'usn_income_outcome':
        return FiscalTaxSystem.usnIncomeOutcome;
      case 'envd':
        return FiscalTaxSystem.envd;
      case 'esn':
        return FiscalTaxSystem.esn;
      case 'patent':
        return FiscalTaxSystem.patent;
      case 'osn':
      default:
        return FiscalTaxSystem.osn;
    }
  }
}

/// Код способа расчёта (тег 1214) для позиции чека, закрываемого прямо
/// сейчас на кассе, — у этого приложения нет сценария "продажа в рассрочку"
/// или "зачёт предоплаты", закрытие стола всегда одномоментный полный расчёт.
const String _atolPaymentMethodFull = 'full_payment';

/// Код способа расчёта (тег 1214) для OrangeData — "полный расчёт".
const int _orangeDataPaymentMethodFull = 4;

int orangeDataVatCode(FiscalVatRate v) {
  // Используется только внутри OrangeData-клиента (см. ниже) — вынесен
  // сюда, чтобы не заводить два одинаковых свитча в разных классах.
  switch (v) {
    case FiscalVatRate.vat20:
      return 1;
    case FiscalVatRate.vat10:
      return 2;
    case FiscalVatRate.vat0:
      return 5;
    case FiscalVatRate.none:
      return 6;
  }
}

int atolPaymentTypeCode(String type) {
  switch (type) {
    case 'cash':
      return 1;
    case 'card':
      return 2;
    case 'prepayment':
      return 3;
    default:
      return 5;
  }
}

String atolPaymentObjectCode(FiscalPaymentObject o) {
  switch (o) {
    case FiscalPaymentObject.service:
      return 'service';
    case FiscalPaymentObject.excise:
      return 'excise';
    case FiscalPaymentObject.commodity:
    case FiscalPaymentObject.markedGood:
      // Признак "это маркированный товар" в протоколе передаётся полями
      // mark_code/mark_quantity у самой позиции, а не отдельным значением
      // payment_object — "markedGood" не входит в перечень ФФД для этого
      // тега, поэтому и для маркированного, и для обычного товара здесь
      // одно и то же значение "commodity".
      return 'commodity';
  }
}

int orangeDataPaymentSubjectType(FiscalPaymentObject o) {
  switch (o) {
    case FiscalPaymentObject.service:
      return 4;
    case FiscalPaymentObject.excise:
      return 2;
    case FiscalPaymentObject.commodity:
    case FiscalPaymentObject.markedGood:
      return 1;
  }
}

int orangeDataPaymentTypeCode(String type) {
  switch (type) {
    case 'cash':
      return 1;
    case 'card':
      return 2;
    case 'prepayment':
      return 14;
    default:
      return 16;
  }
}

String _fiscalTimestamp(DateTime d) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(d.day)}.${two(d.month)}.${d.year} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
}

/// email/телефон покупателя, определённые по формату строки — 54-ФЗ хочет
/// их в разных полях, а гость просто пишет один контакт, не выбирая тип.
({String? email, String? phone}) splitReceiptContact(String contact) {
  final c = contact.trim();
  if (c.isEmpty) return (email: null, phone: null);
  return c.contains('@') ? (email: c, phone: null) : (email: null, phone: c);
}

/// Клиент облачной кассы по протоколу "АТОЛ Онлайн" v4 — тем же протоколом
/// пользуются некоторые реселлеры (например, Ferma/OFD.ru предоставляет
/// совместимый API-конвертер поверх АТОЛ Онлайн), поэтому для них достаточно
/// указать в `baseUrl` их собственный адрес API, оставив всё остальное как
/// есть. Три параметра `login`/`password`/`groupCode`, а также реквизиты
/// организации ниже — выдаёт провайдер после заключения договора и
/// регистрации кассы в его личном кабинете; в коде их быть не должно —
/// только в настройках интеграций приложения.
///
/// ВНИМАНИЕ: конкретные названия полей у облачных касс время от времени
/// уточняются версиями протокола (v4 для ФФД 1.05, v5 для ФФД 1.2, который
/// обязателен при продаже маркированных товаров). Схема ниже соответствует
/// стабильному, годами не менявшемуся ядру протокола v4 — перед подключением
/// к продаже маркированного товара сверьте раздел про `mark_code`/
/// `mark_quantity` с актуальной документацией именно вашего провайдера.
class AtolCloudKassaService implements KassaService {
  final String baseUrl; // например https://online.atol.ru
  final String groupCode;
  final String login;
  final String password;

  /// ИНН, система налогообложения, e-mail и адрес расчётов организации —
  /// обязательные поля блока `company` протокола, без них касса отклоняет
  /// чек на этапе валидации (это не опция самой кассы, а требование 54-ФЗ:
  /// каждый фискальный чек обязан нести реквизиты продавца).
  final String companyInn;
  final FiscalTaxSystem companySno;
  final String companyEmail;

  /// Место расчётов (тег 1187) — для стационарного заведения это адрес
  /// заведения, а не сайт (сайт указывается только для дистанционных продаж).
  final String companyPaymentAddress;

  String? _token;
  DateTime? _tokenExpiresAt;

  AtolCloudKassaService({
    required this.baseUrl,
    required this.groupCode,
    required this.login,
    required this.password,
    required this.companyInn,
    required this.companyEmail,
    required this.companyPaymentAddress,
    this.companySno = FiscalTaxSystem.osn,
  });

  @override
  bool get isAvailable =>
      login.isNotEmpty && password.isNotEmpty && groupCode.isNotEmpty && companyInn.isNotEmpty;

  Future<String> _ensureToken() async {
    if (_token != null && _tokenExpiresAt != null && DateTime.now().isBefore(_tokenExpiresAt!)) {
      return _token!;
    }
    final resp = await http
        .post(
          Uri.parse('$baseUrl/possystem/v4/getToken'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'login': login, 'pass': password}),
        )
        .timeout(const Duration(seconds: 10));
    final data = jsonDecode(resp.body) as Map<String, dynamic>;
    if (resp.statusCode != 200 || data['token'] == null) {
      throw KassaException('Не удалось авторизоваться в кассе: ${data['error'] ?? resp.body}');
    }
    _token = data['token'] as String;
    // Токен обычно живёт около 24 часов — обновляем заранее, за час до
    // истечения, чтобы не ловить протухший токен посреди смены.
    _tokenExpiresAt = DateTime.now().add(const Duration(hours: 23));
    return _token!;
  }

  Map<String, dynamic> _buildReceiptBody(FiscalReceipt receipt) {
    final contact = splitReceiptContact(receipt.buyerContact);
    return {
      'timestamp': _fiscalTimestamp(DateTime.now()),
      'external_id': receipt.receiptId,
      'receipt': {
        if (contact.email != null || contact.phone != null)
          'client': {
            if (contact.email != null) 'email': contact.email,
            if (contact.phone != null) 'phone': contact.phone,
          },
        'company': {
          'email': companyEmail,
          'sno': companySno.atolCode,
          'inn': companyInn,
          'payment_address': companyPaymentAddress,
        },
        'items': receipt.items
            .map((i) => {
                  'name': i.name,
                  'price': i.price,
                  'quantity': i.quantity,
                  'sum': i.sum,
                  'measurement_unit': 'шт',
                  'payment_method': _atolPaymentMethodFull,
                  'payment_object': atolPaymentObjectCode(i.paymentObject),
                  'vat': {'type': i.vat.providerCode},
                  if (i.markingCode != null) ...{
                    'mark_quantity': {'numerator': 1, 'denominator': 1},
                    'mark_code': {'mark_code_raw': i.markingCode},
                  },
                })
            .toList(),
        'payments': receipt.payments
            .map((p) => {'type': atolPaymentTypeCode(p.type), 'sum': p.amount})
            .toList(),
        'total': receipt.total,
      },
    };
  }

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    String uuid;
    try {
      final token = await _ensureToken();
      final resp = await http
          .post(
            Uri.parse('$baseUrl/possystem/v4/$groupCode/sell'),
            headers: {'Content-Type': 'application/json', 'Token': token},
            body: jsonEncode(_buildReceiptBody(receipt)),
          )
          .timeout(const Duration(seconds: 15));

      final data = jsonDecode(resp.body) as Map<String, dynamic>;
      if (resp.statusCode != 200 && resp.statusCode != 201) {
        return FiscalReceiptResult.failure('Касса отклонила чек: ${data['error'] ?? resp.body}');
      }
      final receivedUuid = data['uuid'] as String?;
      if (receivedUuid == null) {
        return FiscalReceiptResult.failure('Касса не вернула номер документа: ${resp.body}');
      }
      uuid = receivedUuid;
    } catch (e) {
      if (e is KassaException) return FiscalReceiptResult.failure(e.message);
      return FiscalReceiptResult.failure('Ошибка связи с кассой: $e');
    }

    // Отправка чека асинхронная: касса возвращает uuid документа сразу, а
    // фискальные признаки (ФД/ФПД) готовы чуть позже. Опрашиваем статус,
    // чтобы кассир увидел настоящий номер ФД, а не просто "принято в
    // обработку" — но не дольше ~20 секунд, чтобы не морозить экран оплаты,
    // если касса в этот момент перегружена.
    return _pollReport(uuid);
  }

  Future<FiscalReceiptResult> _pollReport(String uuid) async {
    for (var attempt = 0; attempt < 10; attempt++) {
      await Future.delayed(const Duration(seconds: 2));
      try {
        final token = await _ensureToken();
        final resp = await http
            .get(
              Uri.parse('$baseUrl/possystem/v4/$groupCode/report/$uuid'),
              headers: {'Token': token},
            )
            .timeout(const Duration(seconds: 10));
        final data = jsonDecode(resp.body) as Map<String, dynamic>;
        final status = data['status'] as String?;
        if (status == 'fail') {
          final error = data['error'] as Map<String, dynamic>?;
          return FiscalReceiptResult.failure('Касса отклонила чек: ${error?['text'] ?? data}');
        }
        if (status == 'done') {
          final payload = data['payload'] as Map<String, dynamic>? ?? {};
          return FiscalReceiptResult.success(
            fiscalDocumentNumber: payload['fiscal_document_number']?.toString(),
            fiscalSign: payload['fiscal_document_attribute']?.toString(),
            fnNumber: payload['fn_number']?.toString(),
            receiptUrl: payload['fiscal_receipt_url'] as String?,
          );
        }
        // status == 'wait' — касса ещё обрабатывает, пробуем ещё раз.
      } catch (_) {
        // Сбой на опросе статуса не значит, что чек не пробит — sell уже
        // вернул uuid успешно. Пробуем ещё раз на следующей итерации.
      }
    }
    // Не дождались "done" за отведённое время — чек уже принят кассой
    // (uuid получен), просто подтверждение задерживается. Это не ошибка.
    return FiscalReceiptResult.success(fiscalDocumentNumber: uuid, pending: true);
  }
}

/// Клиент облачной кассы OrangeData (Nebula API v2). В отличие от АТОЛ
/// Онлайн, OrangeData не использует логин/пароль и Bearer-токен — каждый
/// запрос подписывается RSA-SHA256 закрытым ключом организации (заголовок
/// `X-Signature`), а соединение дополнительно защищено клиентским
/// TLS-сертификатом (mTLS). И сертификат, и ключ подписи выдаёт OrangeData
/// после регистрации кассы в личном кабинете — это один и тот же ключ для
/// обеих ролей.
///
/// ВНИМАНИЕ: маркированные товары («Честный ЗНАК») здесь пока не
/// поддержаны — `nomenclatureCode` в протоколе OrangeData представляет
/// собой не просто отсканированную строку, а отдельно кодируемую
/// бинарную структуру, и без официальной документации/SDK OrangeData под
/// рукой рисковать точностью этой части не стоит: неверно собранный код
/// может увести настоящий товар "в никуда" вместо легального выбытия из
/// оборота. Для продажи маркированных товаров используйте
/// [AtolCloudKassaService], где формат проще и подтверждён публичным
/// протоколом. Обычные (немаркированные) чеки эта реализация фискализирует
/// по-настоящему.
class OrangeDataKassaService implements KassaService {
  final String baseUrl;
  final String inn;
  final String? group;
  final String? keyName;
  final String clientCertPem;
  final String clientKeyPem;
  final String? certPassphrase;
  final FiscalTaxSystem taxationSystem;

  OrangeDataKassaService({
    this.baseUrl = 'https://apip.orangedata.ru:2443/api/v2',
    required this.inn,
    required this.clientCertPem,
    required this.clientKeyPem,
    this.group,
    this.keyName,
    this.certPassphrase,
    this.taxationSystem = FiscalTaxSystem.osn,
  });

  @override
  bool get isAvailable => inn.isNotEmpty && clientCertPem.isNotEmpty && clientKeyPem.isNotEmpty;

  HttpClient _mtlsClient() {
    final ctx = SecurityContext(withTrustedRoots: true);
    ctx.useCertificateChainBytes(Uint8List.fromList(utf8.encode(clientCertPem)));
    ctx.usePrivateKeyBytes(
      Uint8List.fromList(utf8.encode(clientKeyPem)),
      password: certPassphrase,
    );
    return HttpClient(context: ctx);
  }

  String _sign(String body) {
    final privateKey = CryptoUtils.rsaPrivateKeyFromPem(clientKeyPem);
    final signer = RSASigner(SHA256Digest(), '0609608648016503040201');
    signer.init(true, PrivateKeyParameter<RSAPrivateKey>(privateKey));
    final sig = signer.generateSignature(Uint8List.fromList(utf8.encode(body)));
    return base64.encode(sig.bytes);
  }

  Map<String, dynamic> _buildDocument(FiscalReceipt receipt) {
    final contact = splitReceiptContact(receipt.buyerContact);
    return {
      'id': receipt.receiptId,
      'inn': inn,
      if (group != null && group!.isNotEmpty) 'group': group,
      if (keyName != null && keyName!.isNotEmpty) 'key': keyName,
      'content': {
        'type': 1, // приход
        'positions': receipt.items
            .map((i) => {
                  'quantity': i.quantity,
                  'price': i.price,
                  'tax': orangeDataVatCode(i.vat),
                  'text': i.name,
                  'paymentMethodType': _orangeDataPaymentMethodFull,
                  'paymentSubjectType': orangeDataPaymentSubjectType(i.paymentObject),
                })
            .toList(),
        'checkClose': {
          'payments': receipt.payments
              .map((p) => {'type': orangeDataPaymentTypeCode(p.type), 'amount': p.amount})
              .toList(),
          'taxationSystem': taxationSystem.orangeDataCode,
        },
        if (contact.email != null || contact.phone != null)
          'customerContact': contact.email ?? contact.phone,
      },
    };
  }

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    if (receipt.items.any((i) => i.markingCode != null)) {
      return const FiscalReceiptResult.failure(
        'OrangeData: продажа маркированных товаров здесь не поддержана — '
        'выберите АТОЛ Онлайн для чеков с кодами «Честного знака».',
      );
    }
    HttpClient? client;
    try {
      client = _mtlsClient();
      final body = jsonEncode(_buildDocument(receipt));
      final signature = _sign(body);

      final req = await client.postUrl(Uri.parse('$baseUrl/documents'));
      req.headers.set('Content-Type', 'application/json; charset=utf-8');
      req.headers.set('X-Signature', signature);
      req.add(utf8.encode(body));
      final resp = await req.close().timeout(const Duration(seconds: 15));
      final respBody = await resp.transform(utf8.decoder).join();

      if (resp.statusCode == 201 || resp.statusCode == 202) {
        // await, а не bare return: клиент mTLS закрывается в finally сразу,
        // как только этот try-блок отдаст управление — если вернуть Future
        // без ожидания, опрос статуса ниже останется без соединения.
        return await _pollStatus(client, receipt.receiptId);
      }
      return FiscalReceiptResult.failure('Касса отклонила чек (${resp.statusCode}): $respBody');
    } catch (e) {
      return FiscalReceiptResult.failure('Ошибка связи с кассой OrangeData: $e');
    } finally {
      client?.close(force: true);
    }
  }

  Future<FiscalReceiptResult> _pollStatus(HttpClient client, String id) async {
    for (var attempt = 0; attempt < 10; attempt++) {
      await Future.delayed(const Duration(seconds: 2));
      try {
        final req = await client.getUrl(Uri.parse('$baseUrl/documents/$inn/status/$id'));
        final resp = await req.close().timeout(const Duration(seconds: 10));
        final respBody = await resp.transform(utf8.decoder).join();
        if (resp.statusCode == 200) {
          final data = jsonDecode(respBody) as Map<String, dynamic>;
          return FiscalReceiptResult.success(
            fiscalDocumentNumber: data['documentNumber']?.toString(),
            fiscalSign: data['fp']?.toString(),
            fnNumber: data['fsNumber']?.toString(),
          );
        }
        // 202 — документ ещё в очереди на обработку, пробуем ещё раз.
      } catch (_) {
        // Не мешаем повторной попытке из-за одиночного сетевого сбоя.
      }
    }
    return FiscalReceiptResult.success(fiscalDocumentNumber: id, pending: true);
  }
}

/// Честная заготовка для CloudKassir — на момент написания в открытом
/// доступе нет полной технической документации по API фискализации
/// (developers.cloudkassir.ru отдаёт только общее описание), поэтому
/// точный протокол не реализован: рисковать точностью в фискальном
/// документе без подтверждённой схемы неправильно. Как только появится
/// договор с CloudKassir и техническая документация — реализация сюда
/// добавляется по образцу [AtolCloudKassaService]/[OrangeDataKassaService].
class CloudKassirKassaService implements KassaService {
  final String apiKey;
  CloudKassirKassaService({required this.apiKey});

  @override
  bool get isAvailable => false;

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    return const FiscalReceiptResult.failure(
      'CloudKassir: интеграция ждёт технической документации по API '
      'фискализации — обратитесь в поддержку CloudKassir за протоколом '
      'после заключения договора.',
    );
  }
}

class KassaException implements Exception {
  final String message;
  KassaException(this.message);
  @override
  String toString() => message;
}

/// Единая точка получения активной кассы во всём приложении. Когда будет
/// выбран и оплачен реальный провайдер — меняется только это значение
/// (или инициализация в `main.dart`/экране настроек), экран оплаты трогать
/// не придётся.
KassaService kassaService = MockKassaService();

/// Подтягивает сохранённые настройки кассы (settings/integrations) и
/// заполняет [kassaService] — вызывается один раз при старте приложения,
/// аналогично [loadSavedPrinterSettings] в `printer_service.dart`.
Future<void> loadSavedKassaSettings() async {
  try {
    final doc = await FirebaseFirestore.instance.collection('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    kassaService = buildKassaService(data);
  } catch (_) {
    // Нет сети/документа при первом запуске — остаётся MockKassaService
    // по умолчанию до захода в Настройки → Интеграции.
  }
}

/// Собирает [KassaService] из сохранённых настроек — вынесено отдельной
/// функцией, чтобы экран настроек и загрузка при старте не расходились в
/// том, какие поля к какому провайдеру относятся.
KassaService buildKassaService(Map<String, dynamic> data) {
  final type = data['kassaType'] as String? ?? 'mock';
  String s(String key) => data[key] as String? ?? '';
  final sno = FiscalTaxSystemX.fromId(data['kassaSno'] as String?);
  switch (type) {
    case 'atol_cloud':
      return AtolCloudKassaService(
        baseUrl: s('kassaBaseUrl'),
        groupCode: s('kassaGroupCode'),
        login: s('kassaLogin'),
        password: s('kassaPassword'),
        companyInn: s('kassaInn'),
        companyEmail: s('kassaEmail'),
        companyPaymentAddress: s('kassaPaymentAddress'),
        companySno: sno,
      );
    case 'orange_data':
      return OrangeDataKassaService(
        baseUrl: s('kassaBaseUrl').isEmpty
            ? 'https://apip.orangedata.ru:2443/api/v2'
            : s('kassaBaseUrl'),
        inn: s('kassaInn'),
        group: s('kassaGroupCode'),
        keyName: s('kassaOrangeKeyName'),
        clientCertPem: s('kassaOrangeCertPem'),
        clientKeyPem: s('kassaOrangeKeyPem'),
        taxationSystem: sno,
      );
    case 'cloud_kassir':
      return CloudKassirKassaService(apiKey: s('kassaLogin'));
    default:
      return MockKassaService();
  }
}
