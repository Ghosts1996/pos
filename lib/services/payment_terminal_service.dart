import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// Результат одной операции оплаты через терминал.
class TerminalPaymentResult {
  final bool success;
  final String? errorMessage;
  final String? operationId; // номер операции/слипа от банка, для сверки
  final String? maskedCardNumber; // например "•• 4242" — если банк его отдаёт

  const TerminalPaymentResult.success({this.operationId, this.maskedCardNumber})
      : success = true,
        errorMessage = null;

  const TerminalPaymentResult.failure(this.errorMessage)
      : success = false,
        operationId = null,
        maskedCardNumber = null;
}

/// Абстракция над оплатой картой — терминалом или QR-кодом СБП.
///
/// Экран оплаты работает только с этим интерфейсом и ничего не знает про
/// конкретный банк, поэтому подключение любого нового провайдера — это
/// один новый класс здесь плюс новый пункт в списке [TerminalProvider], а
/// экран оплаты и настройки трогать почти не придётся.
///
/// Статус реализации по провайдерам:
///
///   • [ManualTerminalService] — работает с любым физическим терминалом:
///     Ingenico, Verifone, банковский mPOS-ридер, фирменный терминал
///     Сбера/Тинькофф/ВТБ/Альфы/Точки. Программная интеграция, при которой
///     касса сама передаёт сумму в терминал по кабелю или Bluetooth,
///     требует официального SDK банка — он выдаётся только после
///     заключения договора эквайринга на конкретное юрлицо. Кассир вбивает
///     сумму в терминал сам, а приложение фиксирует итог по слипу.
///
///   • [TinkoffSbpQrTerminalService] — рабочая интеграция через публичное
///     REST API Т-Банка (Интернет-эквайринг, oplata.tinkoff.ru): счёт и QR
///     СБП выставляются без физического терминала, гость сканирует код и
///     платит сам. Нужны TerminalKey и пароль из личного кабинета —
///     проприетарный SDK не требуется. Названия полей ответа стоит
///     сверить с документацией банка перед боевым использованием —
///     открытого Swagger нет, методичка уточняется банком время от времени.
///
///   • Сбербанк/ВТБ/Альфа-Банк/Точка Банк, mPOS, Ingenico/Verifone SDK —
///     заготовки с полями настроек (Настройки → Интеграции их сохранят).
///     HTTP- или SDK-вызов не реализован: у каждого банка свой протокол,
///     доступный только после подписания договора эквайринга. Дописать
///     конкретного провайдера по образцу Т-Банка выше — один класс, когда
///     появится его техническая документация.
abstract class PaymentTerminalService {
  /// Есть ли вообще подключённый терминал/провайдер (проверка заполненных
  /// настроек — не проверка реального Bluetooth/сетевого соединения).
  bool get isAvailable;

  /// Отправляет сумму [amount] (в рублях) на оплату и ждёт результат.
  /// [context], если передан, используется провайдерами, которым нужно
  /// что-то показать гостю (QR-код СБП, диалог подтверждения на
  /// терминале) — без него они просто ждут молча и отдают результат по
  /// готовности.
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context});
}

/// Терминал сотрудник обслуживает сам, вручную — рабочий вариант для
/// ЛЮБОГО физического терминала без специальной интеграции (см. докстринг
/// класса выше). Ничего не подделывает и не имитирует: спрашивает
/// сотрудника, прошла ли оплата на самом терминале, и верит его ответу —
/// ровно так это устроено в жизни, когда кассовое приложение и терминал
/// физически не связаны.
class ManualTerminalService implements PaymentTerminalService {
  @override
  bool get isAvailable => true;

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    if (context == null || !context.mounted) {
      // Без экрана спросить некого — считаем, что кассир уже провёл
      // оплату на терминале до вызова (иначе метод не вызвали бы).
      return const TerminalPaymentResult.success();
    }
    final ok = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Оплата на терминале'),
        content: Text(
          'Внесите ${amount.toStringAsFixed(0)} ₽ на терминале эквайринга и '
          'дождитесь его собственного чека/слипа.\n\n'
          'Нажмите «Оплата прошла» только после того, как терминал это подтвердил.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Отменить'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Оплата прошла'),
          ),
        ],
      ),
    );
    return ok == true
        ? const TerminalPaymentResult.success()
        : const TerminalPaymentResult.failure('Отменено сотрудником');
  }
}

/// Заглушка для разработки: имитирует терминал с фейковой задержкой и
/// всегда успехом. В отличие от [ManualTerminalService] ничего не
/// спрашивает — удобно только для обкатки экрана оплаты на эмуляторе, без
/// реального терминала под рукой. Для настоящей смены не годится: она не
/// проверяет, дошли ли деньги, а просто говорит "да".
class MockPaymentTerminalService implements PaymentTerminalService {
  @override
  bool get isAvailable => true;

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    await Future.delayed(const Duration(seconds: 2));
    return TerminalPaymentResult.success(
      operationId: 'MOCK-${DateTime.now().millisecondsSinceEpoch}',
      maskedCardNumber: '•• 4242',
    );
  }
}

/// Оплата через QR СБП по публичному REST API Т-Банка
/// (https://oplata.tinkoff.ru/landing/develop/documentation, "Интернет-
/// эквайринг v2"). Никакого физического терминала не нужно: гость
/// сканирует код своим банковским приложением и переводит сумму сам.
///
/// Поток: Init (завести платёж) → GetQr (получить картинку QR-кода) →
/// показать гостю → опрашивать GetState, пока статус не станет CONFIRMED
/// (оплачено) или окончательно неуспешным.
///
/// [terminalKey]/[password] — выдаёт Т-Банк в личном кабинете эквайринга
/// после регистрации, отдельная пара для тестового и боевого контуров.
class TinkoffSbpQrTerminalService implements PaymentTerminalService {
  final String terminalKey;
  final String password;

  TinkoffSbpQrTerminalService({required this.terminalKey, required this.password});

  static const _baseUrl = 'https://securepay.tinkoff.ru/v2';

  @override
  bool get isAvailable => terminalKey.trim().isNotEmpty && password.trim().isNotEmpty;

  /// Подпись запроса: SHA-256 от конкатенации ЗНАЧЕНИЙ всех простых
  /// (не вложенных) полей запроса вместе с паролем, отсортированных по
  /// ИМЕНИ поля — точный алгоритм из документации Т-Банка "Формирование
  /// токена". Один из немногих шагов, который нельзя проверить без
  /// реального контура: перед боевым использованием сверьте подпись с
  /// ответом `Init` на тестовый платёж — банк вернёт `Success: false`
  /// с понятной ошибкой, если токен неверный, так что несовпадение будет
  /// видно сразу, а не тихо.
  String _token(Map<String, String> params) {
    final withPassword = {...params, 'Password': password};
    final keys = withPassword.keys.toList()..sort();
    final concatenated = keys.map((k) => withPassword[k]).join();
    return sha256.convert(utf8.encode(concatenated)).toString();
  }

  Future<Map<String, dynamic>> _post(String method, Map<String, String> params) async {
    final body = {'TerminalKey': terminalKey, ...params};
    final resp = await http
        .post(
          Uri.parse('$_baseUrl/$method'),
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: jsonEncode({...body, 'Token': _token(body)}),
        )
        .timeout(const Duration(seconds: 15));
    final data = jsonDecode(resp.body) as Map<String, dynamic>;
    if (data['Success'] != true) {
      throw TerminalException(
          (data['Message'] ?? data['Details'] ?? 'Т-Банк отклонил запрос $method').toString());
    }
    return data;
  }

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    if (!isAvailable) {
      return const TerminalPaymentResult.failure(
          'Не заданы TerminalKey/пароль Т-Банка — Настройки → Интеграции');
    }
    try {
      final orderId = 'pos-${DateTime.now().millisecondsSinceEpoch}';
      // Сумма — в копейках, так требует API.
      final init = await _post('Init', {
        'Amount': (amount * 100).round().toString(),
        'OrderId': orderId,
        'Description': 'Оплата в Colibri POS',
      });
      final paymentId = init['PaymentId'].toString();

      final qr = await _post('GetQr', {
        'PaymentId': paymentId,
        'DataType': 'IMAGE',
      });
      final qrImageBase64 = qr['Data'] as String?;

      // Init/GetQr — это два похода в сеть; за это время экран оплаты
      // мог закрыться (сотрудник ушёл со стола). Показывать диалог в
      // мёртвом контексте нельзя — Flutter на этом падает, поэтому
      // проверяем context.mounted и в этом случае просто ждём молча.
      final ctx = context;
      bool confirmedByGuest;
      if (ctx != null && ctx.mounted && qrImageBase64 != null) {
        confirmedByGuest = await _waitForPayment(ctx, paymentId, qrImageBase64, amount);
      } else {
        confirmedByGuest = await _pollUntilDone(paymentId);
      }

      return confirmedByGuest
          ? TerminalPaymentResult.success(operationId: paymentId)
          : const TerminalPaymentResult.failure('Оплата по QR не завершена гостем');
    } on TerminalException catch (e) {
      return TerminalPaymentResult.failure(e.message);
    } catch (e) {
      return TerminalPaymentResult.failure('Ошибка связи с Т-Банком: $e');
    }
  }

  /// Показывает гостю QR и сам следит за статусом, закрывая диалог по
  /// готовности — кассиру нажимать больше ничего не нужно.
  Future<bool> _waitForPayment(
      BuildContext context, String paymentId, String qrImageBase64, double amount) async {
    final resultCompleter = Completer<bool>();
    Timer? poller;

    void stopPolling() {
      poller?.cancel();
      poller = null;
    }

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        poller = Timer.periodic(const Duration(seconds: 2), (_) async {
          final status = await _status(paymentId);
          if (status == 'CONFIRMED') {
            stopPolling();
            if (!resultCompleter.isCompleted) resultCompleter.complete(true);
            if (ctx.mounted) Navigator.pop(ctx);
          } else if (status == 'REJECTED' || status == 'DEADLINE_EXPIRED' || status == 'CANCELED') {
            stopPolling();
            if (!resultCompleter.isCompleted) resultCompleter.complete(false);
            if (ctx.mounted) Navigator.pop(ctx);
          }
        });
        return AlertDialog(
          title: const Text('Оплата по QR (СБП)'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Гость сканирует код и переводит ${amount.toStringAsFixed(0)} ₽ '
                  'в своём банковском приложении.'),
              const SizedBox(height: 16),
              Image.memory(base64Decode(qrImageBase64), width: 220, height: 220),
              const SizedBox(height: 16),
              const CircularProgressIndicator(),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                stopPolling();
                if (!resultCompleter.isCompleted) resultCompleter.complete(false);
                Navigator.pop(ctx);
              },
              child: const Text('Отменить'),
            ),
          ],
        );
      },
    );
    stopPolling();
    if (!resultCompleter.isCompleted) resultCompleter.complete(false);
    return resultCompleter.future;
  }

  /// Без экрана (context не передан) — просто ждём до двух минут молча.
  Future<bool> _pollUntilDone(String paymentId) async {
    for (var i = 0; i < 60; i++) {
      await Future.delayed(const Duration(seconds: 2));
      final status = await _status(paymentId);
      if (status == 'CONFIRMED') return true;
      if (status == 'REJECTED' || status == 'DEADLINE_EXPIRED' || status == 'CANCELED') return false;
    }
    return false;
  }

  Future<String?> _status(String paymentId) async {
    try {
      final data = await _post('GetState', {'PaymentId': paymentId});
      return data['Status'] as String?;
    } catch (_) {
      return null; // сеть моргнула — просто попробуем на следующем тике
    }
  }
}

/// ---------- ЗАГОТОВКИ ПОД ОСТАЛЬНЫЕ БАНКИ ----------
///
/// У каждого — свой протокол эквайринга, видимый только после подписания
/// договора. Ниже только поля настроек (чтобы Настройки → Интеграции уже
/// сегодня могли их сохранить) и понятная ошибка вместо угадывания API.
/// Как только появится документация конкретного банка — здесь дописывается
/// один класс по образцу [TinkoffSbpQrTerminalService].
class TerminalException implements Exception {
  final String message;
  TerminalException(this.message);
  @override
  String toString() => message;
}

class _NotImplementedTerminalService implements PaymentTerminalService {
  final String bankName;
  const _NotImplementedTerminalService(this.bankName);

  @override
  bool get isAvailable => false;

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async =>
      TerminalPaymentResult.failure(
          '$bankName: интеграция ждёт технической документации по договору эквайринга. '
          'Пока используйте «Ручной терминал» — Настройки → Интеграции.');
}

class SberAcquiringTerminalService extends _NotImplementedTerminalService {
  final String login;
  final String password;
  const SberAcquiringTerminalService({required this.login, required this.password})
      : super('Сбербанк Эквайринг');
}

class VtbAcquiringTerminalService extends _NotImplementedTerminalService {
  final String merchantId;
  final String secretKey;
  const VtbAcquiringTerminalService({required this.merchantId, required this.secretKey})
      : super('ВТБ Эквайринг');
}

class AlfaAcquiringTerminalService extends _NotImplementedTerminalService {
  final String username;
  final String password;
  const AlfaAcquiringTerminalService({required this.username, required this.password})
      : super('Альфа-Банк Эквайринг');
}

class TochkaAcquiringTerminalService extends _NotImplementedTerminalService {
  final String merchantId;
  final String apiToken;
  const TochkaAcquiringTerminalService({required this.merchantId, required this.apiToken})
      : super('Точка Банк Эквайринг');
}

class MposTerminalService extends _NotImplementedTerminalService {
  final String apiKey;
  const MposTerminalService({required this.apiKey}) : super('mPOS-терминал');
}

class IngenicoTerminalService extends _NotImplementedTerminalService {
  final String pairing; // MAC/серийный номер сопряжения
  const IngenicoTerminalService({required this.pairing}) : super('Ingenico');
}

class VerifoneTerminalService extends _NotImplementedTerminalService {
  final String pairing;
  const VerifoneTerminalService({required this.pairing}) : super('Verifone');
}

/// Провайдеры терминала оплаты — список для выпадающего меню в
/// Настройки → Интеграции. id хранится в Firestore, name — подпись в UI.
enum TerminalProvider {
  manual('manual', 'Ручной терминал (любой банк)'),
  tinkoffSbp('tinkoff_sbp', 'Т-Банк — QR СБП (без терминала)'),
  sber('sber', 'Сбербанк Эквайринг'),
  vtb('vtb', 'ВТБ Эквайринг'),
  alfa('alfa', 'Альфа-Банк Эквайринг'),
  tochka('tochka', 'Точка Банк Эквайринг'),
  mpos('mpos', 'mPOS-терминал'),
  ingenico('ingenico', 'Ingenico'),
  verifone('verifone', 'Verifone'),
  mock('mock', 'Тестовая заглушка (для разработки)');

  final String id;
  final String label;
  const TerminalProvider(this.id, this.label);

  static TerminalProvider fromId(String id) =>
      TerminalProvider.values.firstWhere((p) => p.id == id, orElse: () => manual);
}

/// Единая точка получения активного терминала во всём приложении.
/// По умолчанию — ручной: он работает без всякой настройки, ровно как
/// сегодня работает касса с физическим терминалом рядом.
PaymentTerminalService paymentTerminalService = ManualTerminalService();

/// Собирает [PaymentTerminalService] из сохранённых настроек
/// (settings/integrations, поля terminal*) — вызывается при старте
/// приложения и при сохранении экрана настроек, аналогично
/// [loadSavedKassaSettings].
PaymentTerminalService buildTerminalService(Map<String, dynamic> data) {
  final provider = TerminalProvider.fromId(data['terminalProvider'] as String? ?? 'manual');
  String s(String key) => (data[key] as String?) ?? '';
  switch (provider) {
    case TerminalProvider.manual:
      return ManualTerminalService();
    case TerminalProvider.mock:
      return MockPaymentTerminalService();
    case TerminalProvider.tinkoffSbp:
      return TinkoffSbpQrTerminalService(
          terminalKey: s('terminalLogin'), password: s('terminalPassword'));
    case TerminalProvider.sber:
      return SberAcquiringTerminalService(login: s('terminalLogin'), password: s('terminalPassword'));
    case TerminalProvider.vtb:
      return VtbAcquiringTerminalService(merchantId: s('terminalLogin'), secretKey: s('terminalPassword'));
    case TerminalProvider.alfa:
      return AlfaAcquiringTerminalService(username: s('terminalLogin'), password: s('terminalPassword'));
    case TerminalProvider.tochka:
      return TochkaAcquiringTerminalService(merchantId: s('terminalLogin'), apiToken: s('terminalPassword'));
    case TerminalProvider.mpos:
      // Единственное поле у mPOS в настройках — «API-ключ», и оно, как и
      // у Ingenico/Verifone ниже, сохраняется в terminalLogin: у этих
      // трёх провайдеров в форме показывается только одно поле, и это
      // первое (см. _terminalFields в integrations_settings_screen.dart).
      return MposTerminalService(apiKey: s('terminalLogin'));
    case TerminalProvider.ingenico:
      return IngenicoTerminalService(pairing: s('terminalLogin'));
    case TerminalProvider.verifone:
      return VerifoneTerminalService(pairing: s('terminalLogin'));
  }
}

/// Подтягивает сохранённые настройки терминала (settings/integrations) и
/// заполняет [paymentTerminalService] — вызывается один раз при старте
/// приложения, аналогично [loadSavedKassaSettings]. Ошибка/отсутствие
/// документа оставляет терминал ручным — он и без настройки работает.
Future<void> loadSavedTerminalSettings() async {
  try {
    final doc =
        await FirebaseFirestore.instance.collection('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    paymentTerminalService = buildTerminalService(data);
  } catch (_) {
    // Нет сети/документа при первом запуске — остаётся ManualTerminalService.
  }
}
