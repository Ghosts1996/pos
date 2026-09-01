import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:http/http.dart' as http;
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
///      OrangeData, CloudKassir, Ferma/ОФД.ру и т.п.), а приложение просто
///      отправляет ему чек по HTTPS и получает фискальные признаки в
///      ответ. Не нужно физического устройства в заведении и native-кода —
///      именно поэтому ниже реализован клиент такого типа
///      ([AtolCloudKassaService]), по образцу протокола "АТОЛ Онлайн".
///      Формально касса всё равно должна физически стоять и быть
///      зарегистрирована в ФНС на ваше юрлицо/ИП — просто не в зале, а в
///      дата-центре провайдера, который её обслуживает по договору.
///
/// Для обоих путей нужен действующий договор с ОФД и регистрация ККТ в
/// личном кабинете налоговой (nalog.gov.ru) — это не техническая часть и
/// её нельзя автоматизировать кодом.
///
/// До момента, пока не выбран и не оплачен реальный провайдер, используется
/// [MockKassaService] — как и [MockPaymentTerminalService], он ничего не
/// фискализирует по-настоящему, только имитирует задержку и всегда
/// возвращает успех с правдоподобно выглядящими номерами, чтобы можно было
/// обкатать весь UI-поток (включая передачу кодов маркировки в чек) уже
/// сейчас.
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

/// Клиент облачной кассы по протоколу в духе "АТОЛ Онлайн" (тот же общий
/// подход используют конвертеры OFD.ru/Ferma и большинство аналогичных
/// провайдеров: получить токен по логину/паролю, затем POST с телом чека
/// на `/possystem/v4/{group_code}/sell`, дальше опрашивать статус по
/// `uuid` из ответа). Три параметра ниже — `login`/`password`/`groupCode` —
/// выдаёт провайдер после заключения договора и регистрации кассы в его
/// личном кабинете, в коде их быть не должно — только в настройках
/// интеграций приложения.
///
/// ВНИМАНИЕ: конкретные пути и названия полей у провайдеров облачных касс
/// периодически меняются версиями (v4, v5...) и различаются между
/// провайдерами (АТОЛ Онлайн / OrangeData / Ferma и т.д. — у каждого
/// немного свой JSON). Прежде чем использовать в бою, сверьте этот класс с
/// актуальной документацией именно того провайдера, с которым заключён
/// договор — он и даст точный `baseUrl`.
class AtolCloudKassaService implements KassaService {
  final String baseUrl; // например https://online.atol.ru
  final String groupCode;
  final String login;
  final String password;

  String? _token;
  DateTime? _tokenExpiresAt;

  AtolCloudKassaService({
    required this.baseUrl,
    required this.groupCode,
    required this.login,
    required this.password,
  });

  @override
  bool get isAvailable => login.isNotEmpty && password.isNotEmpty && groupCode.isNotEmpty;

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

  @override
  Future<FiscalReceiptResult> sendReceipt(FiscalReceipt receipt) async {
    try {
      final token = await _ensureToken();
      final body = {
        'timestamp': _fiscalTimestamp(DateTime.now()),
        'external_id': receipt.receiptId,
        'receipt': {
          'client': receipt.buyerContact.isNotEmpty ? {'email_or_phone': receipt.buyerContact} : null,
          'items': receipt.items
              .map((i) => {
                    'name': i.name,
                    'price': i.price,
                    'quantity': i.quantity,
                    'sum': i.sum,
                    'measurement_unit': 'шт',
                    'payment_object': i.paymentObject.name,
                    'vat': {'type': i.vat.providerCode},
                    if (i.markingCode != null) 'mark_code': {'mark_code_raw': i.markingCode},
                  })
              .toList(),
          'payments': receipt.payments.map((p) => {'type': p.type, 'sum': p.amount}).toList(),
          'total': receipt.total,
        },
      };

      final resp = await http
          .post(
            Uri.parse('$baseUrl/possystem/v4/$groupCode/sell'),
            headers: {'Content-Type': 'application/json', 'Token': token},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 15));

      final data = jsonDecode(resp.body) as Map<String, dynamic>;
      if (resp.statusCode != 200 && resp.statusCode != 201) {
        return FiscalReceiptResult.failure('Касса отклонила чек: ${data['error'] ?? resp.body}');
      }
      // Отправка чека асинхронная — касса возвращает uuid документа сразу,
      // а сами фискальные признаки (ФД/ФПД) появляются чуть позже и
      // забираются отдельным запросом статуса по uuid. Для UI POS
      // достаточно факта "принят в обработку"; проверка итогового
      // статуса — расширение на будущее (см. TODO ниже).
      return FiscalReceiptResult.success(fiscalDocumentNumber: data['uuid'] as String?);
    } catch (e) {
      if (e is KassaException) return FiscalReceiptResult.failure(e.message);
      return FiscalReceiptResult.failure('Ошибка связи с кассой: $e');
    }
  }

  // TODO: реализовать опрос `/possystem/v4/{group_code}/report/{uuid}`,
  // когда будет известен конкретный провайдер — сейчас чек считается
  // принятым по факту 200 OK от sell, без ожидания итогового ФД/ФПД.

  String _fiscalTimestamp(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)}.${d.year} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
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
    final type = data['kassaType'] as String? ?? 'mock';
    if (type == 'atol_cloud') {
      kassaService = AtolCloudKassaService(
        baseUrl: data['kassaBaseUrl'] as String? ?? '',
        groupCode: data['kassaGroupCode'] as String? ?? '',
        login: data['kassaLogin'] as String? ?? '',
        password: data['kassaPassword'] as String? ?? '',
      );
    } else {
      kassaService = MockKassaService();
    }
  } catch (_) {
    // Нет сети/документа при первом запуске — остаётся MockKassaService
    // по умолчанию до захода в Настройки → Интеграции.
  }
}