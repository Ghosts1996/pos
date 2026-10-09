import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'app_scope.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:qr_flutter/qr_flutter.dart';
import '../utils/money.dart';

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

/// Оплата картой — терминалом или QR-кодом СБП. Экран оплаты знает только
/// этот интерфейс; новый банк — новый класс здесь и пункт в
/// [TerminalProvider].
///
///   • [ManualTerminalService] — любой физический терминал: кассир вводит
///     сумму в терминал сам, приложение фиксирует итог. Передача суммы по
///     кабелю или Bluetooth требует SDK банка, его выдают по договору
///     эквайринга.
///   • [TinkoffSbpQrTerminalService] — REST API интернет-эквайринга
///     Т-Банка: счёт и QR СБП без терминала, нужны TerminalKey и пароль.
///     Открытой схемы ответа нет — перед боевым запуском сверьте поля.
///   • Сбер, ВТБ, Альфа, Точка, mPOS, SDK Ingenico/Verifone — только
///     настройки; протокол каждого банка доступен после договора.
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
        scrollable: true,
        title: const Text('Оплата на терминале'),
        content: Text(
          'Внесите ${rub(amount)} на терминале эквайринга и '
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
        'Description': 'Оплата в ZalPOS',
      });
      final paymentId = init['PaymentId'].toString();

      // PAYLOAD — ссылка СБП, QR рисуем сами. IMAGE отдаёт SVG-разметку
      // (не картинку в base64), и Image.memory падал на ней.
      final qr = await _post('GetQr', {
        'PaymentId': paymentId,
        'DataType': 'PAYLOAD',
      });
      final qrPayload = qr['Data'] as String?;

      // Init/GetQr — это два похода в сеть; за это время экран оплаты
      // мог закрыться (сотрудник ушёл со стола). Показывать диалог в
      // мёртвом контексте нельзя — Flutter на этом падает, поэтому
      // проверяем context.mounted и в этом случае просто ждём молча.
      final ctx = context;
      bool confirmedByGuest;
      if (ctx != null && ctx.mounted && qrPayload != null && qrPayload.isNotEmpty) {
        confirmedByGuest = await _waitForPayment(ctx, paymentId, qrPayload, amount);
      } else {
        confirmedByGuest = await _pollUntilDone(paymentId);
      }

      if (!confirmedByGuest) {
        // QR ещё действует: без отмены гость мог бы оплатить уже после
        // того, как кассир закрыл окно, — деньги пришли бы мимо чека.
        final paidMeanwhile = await _cancel(paymentId);
        if (paidMeanwhile) return TerminalPaymentResult.success(operationId: paymentId);
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
      BuildContext context, String paymentId, String qrPayload, double amount) async {
    final resultCompleter = Completer<bool>();
    BuildContext? dialogCtx;
    var polling = false;

    void finish(bool ok) {
      if (resultCompleter.isCompleted) return;
      resultCompleter.complete(ok);
      final c = dialogCtx;
      if (c != null && c.mounted) Navigator.pop(c);
    }

    // Таймер один на весь диалог (а не в builder — тот вызывается при
    // каждой перестройке, и опросов становилось несколько).
    final poller = Timer.periodic(const Duration(seconds: 2), (_) async {
      // Медленная сеть: не запускаем новый опрос, пока не ответил прошлый.
      if (polling || resultCompleter.isCompleted) return;
      polling = true;
      final status = await _status(paymentId);
      polling = false;
      if (status == 'CONFIRMED') {
        finish(true);
      } else if (_failedStatuses.contains(status)) {
        finish(false);
      }
    });

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        dialogCtx = ctx;
        return AlertDialog(
          scrollable: true,
          title: const Text('Оплата по QR (СБП)'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Гость сканирует код и переводит ${rub(amount)} '
                  'в своём банковском приложении.'),
              const SizedBox(height: 16),
              SizedBox(
                width: 220,
                height: 220,
                child: QrImageView(data: qrPayload, backgroundColor: Colors.white),
              ),
              const SizedBox(height: 16),
              const CircularProgressIndicator(),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => finish(false),
              child: const Text('Отменить'),
            ),
          ],
        );
      },
    );
    poller.cancel();
    if (!resultCompleter.isCompleted) resultCompleter.complete(false);
    return resultCompleter.future;
  }

  /// Без экрана (context не передан) — просто ждём до двух минут молча.
  Future<bool> _pollUntilDone(String paymentId) async {
    for (var i = 0; i < 60; i++) {
      await Future.delayed(const Duration(seconds: 2));
      final status = await _status(paymentId);
      if (status == 'CONFIRMED') return true;
      if (_failedStatuses.contains(status)) return false;
    }
    return false;
  }

  static const _failedStatuses = {'REJECTED', 'DEADLINE_EXPIRED', 'CANCELED', 'AUTH_FAIL', 'REVERSED'};

  /// Отменяет неоплаченный платёж. true — если выяснилось, что гость уже
  /// успел заплатить (тогда отменять нельзя, и оплата засчитывается).
  Future<bool> _cancel(String paymentId) async {
    if (await _status(paymentId) == 'CONFIRMED') return true;
    try {
      await _post('Cancel', {'PaymentId': paymentId});
    } catch (_) {
      // Уже отменён/истёк — нечего отменять.
    }
    return await _status(paymentId) == 'CONFIRMED';
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

/// Терминал Сбера (Verifone/Ingenico/PAX с ПО UPOS), подключённый к
/// Windows-кассе кабелем: сумма уходит на терминал сама, кассиру не нужно
/// её набирать. Работает через `sb_pilot.exe` из комплекта UPOS, который
/// банк ставит вместе с терминалом: `sb_pilot.exe 1 <сумма в копейках>` —
/// оплата, итог — в файле `e` (первая строка «код,текст», 0 — одобрено),
/// слип — в файле `p`.
///
/// Код ответа читаем строго: оплата считается прошедшей только при коде 0.
/// Любой другой результат (нет файла, мусор) — отказ, кассир повторит или
/// примет оплату вручную.
class SberUposTerminalService implements PaymentTerminalService {
  /// Папка UPOS, где лежит sb_pilot.exe (обычно C:\sc552).
  final String folder;
  SberUposTerminalService({required String folder})
      : folder = folder.trim().isEmpty ? r'C:\sc552' : folder.trim();

  @override
  bool get isAvailable => Platform.isWindows;

  /// Разбор файла `e`. Кодировка — cp1251, но нам нужны только код и
  /// маска карты (ASCII), поэтому читаем как latin1.
  static TerminalPaymentResult parseResult(List<int> bytes) {
    final lines = latin1.decode(bytes).split(RegExp(r'\r?\n'));
    final head = lines.isEmpty ? '' : lines.first.trim();
    final code = int.tryParse(head.split(',').first.trim());
    if (code == null) return const TerminalPaymentResult.failure('Терминал не вернул результат операции');
    if (code != 0) return TerminalPaymentResult.failure('Терминал отклонил оплату (код $code)');
    String? line(int i) => lines.length > i && lines[i].trim().isNotEmpty ? lines[i].trim() : null;
    final card = line(1);
    final digits = card?.replaceAll(RegExp(r'[^0-9]'), '') ?? '';
    return TerminalPaymentResult.success(
      operationId: line(3),
      maskedCardNumber: digits.length >= 4 ? '•• ${digits.substring(digits.length - 4)}' : null,
    );
  }

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    if (!Platform.isWindows) {
      return const TerminalPaymentResult.failure('Терминал Сбера через UPOS работает только на Windows-кассе');
    }
    final exe = File('$folder\\sb_pilot.exe');
    if (!exe.existsSync()) {
      return TerminalPaymentResult.failure('Не найден ${exe.path} — укажите папку UPOS в Настройках → Интеграции');
    }
    final result = File('$folder\\e');
    try {
      if (result.existsSync()) result.deleteSync();
    } catch (_) {}
    final kopecks = (amount * 100).round();
    try {
      await Process.run(exe.path, ['1', '$kopecks'], workingDirectory: folder)
          .timeout(const Duration(minutes: 3));
    } on TimeoutException {
      return const TerminalPaymentResult.failure(
          'Терминал не ответил за 3 минуты — проверьте на экране терминала, прошла ли оплата');
    } catch (e) {
      return TerminalPaymentResult.failure('Не удалось запустить UPOS: $e');
    }
    if (!result.existsSync()) return const TerminalPaymentResult.failure('Терминал не вернул результат операции');
    return parseResult(await result.readAsBytes());
  }
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
  sberUpos('sber_upos', 'Сбер — терминал на кассе (UPOS, Windows)'),
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
    case TerminalProvider.sberUpos:
      return SberUposTerminalService(folder: s('terminalLogin'));
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
        await AppScope.col('settings').doc('integrations').get();
    final data = doc.data();
    if (data == null) return;
    paymentTerminalService = buildTerminalService(data);
  } catch (_) {
    // Нет сети/документа при первом запуске — остаётся ManualTerminalService.
  }
}
