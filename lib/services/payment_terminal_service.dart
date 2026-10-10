import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'app_scope.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../models/terminal_bank.dart';
import '../utils/bank_http.dart';
import '../utils/money.dart';
import 'gateway_api.dart';

/// Результат одной операции оплаты через терминал.
class TerminalPaymentResult {
  final bool success;
  final String? errorMessage;
  final String? operationId; // номер операции/слипа от банка, для сверки
  final String? maskedCardNumber; // например "•• 4242" — если банк его отдаёт

  /// Через какой банк прошла оплата («Сбер», «QR · Т-Банк») — пишется в
  /// чек: деньги от каждого банка приходят своим платежом, сверка по ним.
  final String? bank;

  const TerminalPaymentResult.success({this.operationId, this.maskedCardNumber, this.bank})
      : success = true,
        errorMessage = null;

  const TerminalPaymentResult.failure(this.errorMessage)
      : success = false,
        operationId = null,
        maskedCardNumber = null,
        bank = null;
}

/// Оплата картой — терминалом или QR-кодом СБП. Экран оплаты знает только
/// этот интерфейс; новый банк — новый класс здесь и пункт в
/// [TerminalProvider].
///
///   • [ManualTerminalService] — любой терминал любого банка (и «терминал
///     в телефоне», и табличка с QR СБП): кассир вводит сумму на терминале
///     сам, касса спрашивает, прошла ли оплата и на каком терминале.
///   • [GatewayQrTerminalService] — QR на экране кассы через банк
///     онлайн-оплаты заведения (Т-Банк, Сбер, Альфа, ВТБ, МТС,
///     Райффайзен, Робокасса, другой банк на шлюзе RBS): платёж заводит
///     шлюз, реквизиты банка на кассе не нужны.
///   • [TinkoffSbpQrTerminalService] — прежний способ: QR СБП Т-Банка
///     прямо с кассы по TerminalKey и паролю.
///   • [SberUposTerminalService] — терминал Сбера на Windows-кассе (UPOS).
///   • [CliTerminalService] — терминал на Windows-кассе через программу
///     банка с командной строкой (ARCUS 2 и другие): сумма уходит сама,
///     итог — по правилу из настроек или со слов кассира.
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
/// ЛЮБОГО терминала любого банка без специальной интеграции (см. докстринг
/// класса выше). Ничего не подделывает и не имитирует: спрашивает
/// сотрудника, прошла ли оплата на самом терминале, и верит его ответу —
/// ровно так это устроено в жизни, когда кассовое приложение и терминал
/// физически не связаны.
///
/// [banks] — терминалы каких банков стоят в заведении (TerminalBank.id).
/// Несколько — касса спрашивает, на каком оплатили: в чеке и отчёте
/// деньги разложены по банкам.
class ManualTerminalService implements PaymentTerminalService {
  final List<String> banks;
  final String otherName;

  ManualTerminalService({this.banks = const [], this.otherName = ''});

  /// Последний выбранный терминал — подставляется в следующий раз.
  static String _lastBank = '';

  String _label(String id) => TerminalBank.label(id, other: otherName);

  @override
  bool get isAvailable => true;

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    final single = banks.length == 1 ? _label(banks.first) : null;
    if (context == null || !context.mounted) {
      // Без экрана спросить некого — считаем, что кассир уже провёл
      // оплату на терминале до вызова (иначе метод не вызвали бы).
      return TerminalPaymentResult.success(bank: single);
    }
    var chosen = banks.contains(_lastBank) ? _lastBank : (banks.isEmpty ? '' : banks.first);
    final ok = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          scrollable: true,
          title: Text(single == null ? 'Оплата на терминале' : 'Оплата на терминале · $single'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Внесите ${rub(amount)} на терминале и дождитесь его чека/слипа.\n\n'
                'Нажмите «Оплата прошла» только после того, как терминал это подтвердил.',
              ),
              if (banks.length > 1) ...[
                const SizedBox(height: 16),
                const Text('На каком терминале?', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final id in banks)
                      ChoiceChip(
                        label: Text(_label(id)),
                        selected: chosen == id,
                        onSelected: (_) => setLocal(() => chosen = id),
                      ),
                  ],
                ),
              ],
            ],
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
      ),
    );
    if (ok != true) return const TerminalPaymentResult.failure('Отменено сотрудником');
    if (chosen.isNotEmpty) _lastBank = chosen;
    return TerminalPaymentResult.success(bank: chosen.isEmpty ? null : _label(chosen));
  }
}

/// Спросить кассира, что показал терминал, — когда программа банка не дала
/// однозначного ответа. [details] — что она всё-таки вернула.
Future<bool> confirmOnTerminal(BuildContext context, double amount, {String title = 'Что показал терминал?', String details = ''}) async {
  final ok = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      title: Text(title),
      content: Text(
        'Посмотрите на экран терминала: оплата ${rub(amount)} одобрена?'
        '${details.trim().isEmpty ? '' : '\n\nОтвет программы банка:\n${details.trim()}'}',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Не прошла')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Оплата прошла')),
      ],
    ),
  );
  return ok == true;
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
    final client = bankHttpClient();
    final resp = await client
        .post(
          Uri.parse('$_baseUrl/$method'),
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: jsonEncode({...body, 'Token': _token(body)}),
        )
        .timeout(const Duration(seconds: 15))
        .whenComplete(client.close);
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
        if (paidMeanwhile) return TerminalPaymentResult.success(operationId: paymentId, bank: 'QR · Т-Банк');
      }
      return confirmedByGuest
          ? TerminalPaymentResult.success(operationId: paymentId, bank: 'QR · Т-Банк')
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

/// Ошибка банка с текстом для кассира.
class TerminalException implements Exception {
  final String message;
  TerminalException(this.message);
  @override
  String toString() => message;
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
      bank: 'Сбер',
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

/// Терминал, подключённый кабелем к Windows-кассе через программу банка с
/// командной строкой: ARCUS 2 (её ставят многие банки на терминалы
/// Ingenico/Verifone/PAX) или другую, которую дал банк. Сумма уходит на
/// терминал сама — кассиру не нужно её набирать.
///
/// Как программа сообщает итог, у банков и версий разное, поэтому оплата
/// считается прошедшей автоматически только по правилу из настроек: в
/// файле итога есть текст [approve] (например, код «000» или «ОДОБРЕНО»).
/// Правило не задано, файла нет или ответ не распознан — касса спрашивает
/// кассира, что показал терминал. Оплата не «теряется» и не проходит
/// дважды из-за непонятого ответа.
class CliTerminalService implements PaymentTerminalService {
  /// Путь к программе банка.
  final String exe;

  /// Аргументы: {kop} — сумма в копейках, {rub} — в рублях (123.45).
  final String args;

  /// Файл, куда программа пишет итог (пусто — не читаем).
  final String resultFile;

  /// Текст или регулярное выражение «одобрено» в файле итога.
  final String approve;

  /// Чей терминал — подпись в чеке и отчёте.
  final String bank;

  /// Сколько ждать программу: гость может долго вводить PIN.
  final Duration timeout;

  CliTerminalService({
    required String exe,
    String args = '',
    String resultFile = '',
    String approve = '',
    this.bank = '',
    this.timeout = const Duration(minutes: 3),
  })  : exe = exe.trim(),
        args = args.trim(),
        resultFile = resultFile.trim(),
        approve = approve.trim();

  /// Шаблон ARCUS 2 — проверьте тестом на 1 ₽: параметры у банков бывают
  /// свои, их подскажет инженер банка.
  static const arcusExe = r'C:\Arcus2\CommandLineTool\bin\CommandLineTool.exe';
  static const arcusArgs = '/o1 /a{kop} /c643';
  static const arcusResult = r'C:\Arcus2\rc.out';

  @override
  bool get isAvailable => Platform.isWindows && exe.isNotEmpty;

  /// Аргументы с подставленной суммой. Кавычки "…" держат пробелы внутри.
  static List<String> buildArgs(String template, double amount) {
    final kop = (amount * 100).round();
    final rubStr = (kop / 100).toStringAsFixed(2);
    final out = <String>[];
    for (final m in RegExp(r'"([^"]*)"|(\S+)').allMatches(template)) {
      final raw = m.group(1) ?? m.group(2) ?? '';
      out.add(raw.replaceAll('{kop}', '$kop').replaceAll('{rub}', rubStr));
    }
    return out;
  }

  /// Одобрено ли по правилу: true — да, null — не понять (спросить кассира).
  /// Правило сравнивается со строкой файла целиком (без пробелов по краям):
  /// иначе «000» нашлось бы и внутри суммы 10 000 ₽ или кода отказа 1000.
  static bool? judge(String text, String approve) {
    final rule = approve.trim();
    if (rule.isEmpty || text.trim().isEmpty) return null;
    final lines = text.split(RegExp(r'\r?\n')).map((l) => l.trim());
    RegExp? re;
    try {
      re = RegExp('^(?:$rule)\$');
    } on FormatException {
      re = null;
    }
    for (final line in lines) {
      if (line == rule || (re != null && re.hasMatch(line))) return true;
    }
    return null;
  }

  /// Текст файла итога: программы банков пишут в cp1251 или UTF-8.
  static String decode(List<int> bytes) {
    try {
      return utf8.decode(bytes);
    } on FormatException {
      return cp1251(bytes);
    }
  }

  /// cp1251 → строка (русские буквы, остальное как в latin1).
  static String cp1251(List<int> bytes) {
    final b = StringBuffer();
    for (final c in bytes) {
      if (c >= 0xC0) {
        b.writeCharCode(0x0410 + (c - 0xC0));
      } else if (c == 0xA8) {
        b.write('Ё');
      } else if (c == 0xB8) {
        b.write('ё');
      } else if (c == 0xB9) {
        b.write('№');
      } else {
        b.writeCharCode(c);
      }
    }
    return b.toString();
  }

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    if (!Platform.isWindows) {
      return const TerminalPaymentResult.failure('Терминал по кабелю работает только на Windows-кассе');
    }
    final program = File(exe);
    if (exe.isEmpty || !program.existsSync()) {
      return TerminalPaymentResult.failure('Не найдена программа банка ${exe.isEmpty ? '' : exe} — проверьте путь в Настройки → Интеграции');
    }
    final result = resultFile.isEmpty ? null : File(resultFile);
    try {
      if (result != null && result.existsSync()) result.deleteSync();
    } catch (_) {}
    // Файл итога не удалился (занят программой банка) — «одобрено» в нём
    // может остаться от прошлой оплаты: верим только файлу, записанному
    // после запуска. Запас — на грубые часы файловой системы.
    final startedAt = DateTime.now().subtract(const Duration(seconds: 2));
    var details = '';
    var started = false;
    try {
      final run = await Process.run(exe, buildArgs(args, amount), workingDirectory: program.parent.path)
          .timeout(timeout);
      started = true;
      if (run.exitCode != 0) details = 'код завершения ${run.exitCode}';
    } on TimeoutException {
      started = true;
      details = 'программа банка не ответила за ${timeout.inMinutes} мин.';
    } catch (e) {
      // Программа не запустилась — на терминал ничего не ушло.
      return TerminalPaymentResult.failure('Не удалось запустить программу банка: $e');
    }
    if (result != null && result.existsSync()) {
      final text = decode(await result.readAsBytes());
      final fresh = !result.lastModifiedSync().isBefore(startedAt);
      if (fresh && judge(text, approve) == true) return TerminalPaymentResult.success(bank: bank.isEmpty ? null : bank);
      details = [details, fresh ? text.trim() : 'файл итога не обновился — ответа терминала нет']
          .where((x) => x.isNotEmpty)
          .join('\n');
    }
    // Ответ не распознан — решает кассир по экрану терминала.
    if (started && context != null && context.mounted) {
      final ok = await confirmOnTerminal(context, amount,
          details: details.length > 400 ? '${details.substring(0, 400)}…' : details);
      return ok
          ? TerminalPaymentResult.success(bank: bank.isEmpty ? null : bank)
          : const TerminalPaymentResult.failure('Терминал не подтвердил оплату');
    }
    return const TerminalPaymentResult.failure('Не удалось понять ответ терминала — проверьте его экран');
  }
}

/// QR на экране кассы через банк онлайн-оплаты заведения (Настройки →
/// Интеграции → «Онлайн-оплата гостей»). Платёж заводит шлюз
/// (saas-gateway/guest-pay.js, handleKassa*), реквизиты банка остаются на
/// сервере. Гость сканирует код телефоном: по СБП (Т-Банк, Райффайзен)
/// открывается приложение его банка, у остальных — страница оплаты банка,
/// где можно заплатить картой или через СБП.
///
/// Окно закрыли или код истёк — шлюз сперва проверяет, не успел ли гость
/// заплатить, и только потом отменяет платёж. Деньги, пришедшие ещё
/// позже, шлюз не теряет: персонал получит «Оплачено онлайн» с суммой.
class GatewayQrTerminalService implements PaymentTerminalService {
  /// Запрос к шлюзу; в тестах — подделка.
  final Future<Map<String, dynamic>> Function(String path, Map<String, dynamic> body) _post;

  /// Как часто спрашивать статус, пока открыт QR.
  final Duration pollEvery;

  GatewayQrTerminalService({
    Future<Map<String, dynamic>> Function(String path, Map<String, dynamic> body)? post,
    this.pollEvery = const Duration(seconds: 2),
  }) : _post = post ?? ((path, body) => GatewayApi.post(path, body));

  @override
  bool get isAvailable => true;

  @override
  Future<TerminalPaymentResult> pay(double amount, {BuildContext? context}) async {
    final Map<String, dynamic> start;
    try {
      start = await _post('kassaPayStart', {'amount': (amount * 100).round() / 100});
    } on GatewayException catch (e) {
      return TerminalPaymentResult.failure(e.message);
    } catch (e) {
      return TerminalPaymentResult.failure('Нет связи с сервером: $e');
    }
    final id = '${start['paymentId'] ?? ''}';
    final url = '${start['url'] ?? ''}';
    if (id.isEmpty || url.isEmpty) return const TerminalPaymentResult.failure('Банк не выдал код для оплаты');
    final ttl = Duration(seconds: (start['ttlSec'] as num?)?.toInt() ?? 300);
    final info = _QrInfo(
      url: url,
      amount: amount,
      bank: '${start['bank'] ?? 'Банк'}',
      sbp: start['sbp'] == true,
      test: start['test'] == true,
      ttl: ttl,
    );

    final ctx = context;
    final String outcome;
    if (ctx != null && ctx.mounted) {
      outcome = await _showQr(ctx, id, info);
    } else {
      outcome = await _pollSilently(id, ttl);
    }
    final bank = 'QR · ${info.bank}';
    if (outcome == 'paid') return TerminalPaymentResult.success(operationId: id, bank: bank);
    if (outcome == 'failed') return const TerminalPaymentResult.failure('Банк отклонил оплату');
    // Закрыли окно или код истёк: вдруг гость успел заплатить в последний момент.
    if (await _cancel(id) == 'paid') return TerminalPaymentResult.success(operationId: id, bank: bank);
    return const TerminalPaymentResult.failure('Оплата по QR не завершена');
  }

  Future<String> _status(String id) async {
    try {
      return '${(await _post('kassaPayStatus', {'paymentId': id}))['status'] ?? 'pending'}';
    } catch (_) {
      return 'pending'; // сеть моргнула — спросим на следующем шаге
    }
  }

  Future<String> _cancel(String id) async {
    for (var i = 0; i < 3; i++) {
      try {
        return '${(await _post('kassaPayCancel', {'paymentId': id}))['status'] ?? 'cancelled'}';
      } catch (_) {
        await Future.delayed(const Duration(seconds: 1));
      }
    }
    return 'cancelled';
  }

  Future<String> _pollSilently(String id, Duration ttl) async {
    final until = DateTime.now().add(ttl);
    while (DateTime.now().isBefore(until)) {
      await Future.delayed(pollEvery);
      final st = await _status(id);
      if (st == 'paid' || st == 'failed') return st;
    }
    return 'timeout';
  }

  /// QR и ожидание. → 'paid' | 'failed' | 'cancelled' | 'timeout'.
  Future<String> _showQr(BuildContext context, String id, _QrInfo info) async {
    final done = Completer<String>();
    BuildContext? dialogCtx;
    var polling = false;
    final until = DateTime.now().add(info.ttl);

    void finish(String outcome) {
      if (done.isCompleted) return;
      done.complete(outcome);
      final c = dialogCtx;
      if (c != null && c.mounted) Navigator.pop(c);
    }

    final poller = Timer.periodic(pollEvery, (_) async {
      if (polling || done.isCompleted) return;
      if (DateTime.now().isAfter(until)) return finish('timeout');
      polling = true;
      final st = await _status(id);
      polling = false;
      if (st == 'paid' || st == 'failed') finish(st);
    });

    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        dialogCtx = ctx;
        return _QrDialog(info: info, until: until, onCancel: () => finish('cancelled'));
      },
    );
    poller.cancel();
    if (!done.isCompleted) done.complete('cancelled');
    return done.future;
  }
}

class _QrInfo {
  final String url;
  final double amount;
  final String bank;
  final bool sbp;
  final bool test;
  final Duration ttl;
  const _QrInfo({
    required this.url,
    required this.amount,
    required this.bank,
    required this.sbp,
    required this.test,
    required this.ttl,
  });
}

/// Окно с QR: сумма, банк, как платить и сколько ещё действует код.
class _QrDialog extends StatefulWidget {
  final _QrInfo info;
  final DateTime until;
  final VoidCallback onCancel;
  const _QrDialog({required this.info, required this.until, required this.onCancel});

  @override
  State<_QrDialog> createState() => _QrDialogState();
}

class _QrDialogState extends State<_QrDialog> {
  late final Timer _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final i = widget.info;
    final left = widget.until.difference(DateTime.now());
    final secs = left.isNegative ? 0 : left.inSeconds;
    final clock = '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}';
    final muted = Theme.of(context).textTheme.bodySmall?.color;
    return AlertDialog(
      scrollable: true,
      title: Text(i.sbp ? 'Оплата по QR (СБП)' : 'Оплата по QR'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(rub(i.amount), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(i.bank, style: TextStyle(color: muted)),
          if (i.test) ...[
            const SizedBox(height: 4),
            const Text('Тестовый контур — деньги не списываются', style: TextStyle(color: Colors.orange)),
          ],
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
            child: SizedBox(
              width: 240,
              height: 240,
              child: QrImageView(data: i.url, backgroundColor: Colors.white, padding: EdgeInsets.zero),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            i.sbp
                ? 'Гость наводит камеру телефона на код — откроется приложение его банка, остаётся подтвердить перевод.'
                : 'Гость наводит камеру телефона на код — откроется страница банка: оплата картой или через СБП.',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: 10),
              Text('Ждём оплату · код действует $clock', style: TextStyle(color: muted)),
            ],
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: widget.onCancel, child: const Text('Отменить')),
      ],
    );
  }
}

/// Провайдеры терминала оплаты — список для выпадающего меню в
/// Настройки → Интеграции. id хранится в Firestore, name — подпись в UI.
enum TerminalProvider {
  manual('manual', 'Терминал любого банка'),
  onlineQr('online_qr', 'QR на экране кассы — банк онлайн-оплаты'),
  tinkoffSbp('tinkoff_sbp', 'Т-Банк — QR СБП (TerminalKey на кассе)'),
  sberUpos('sber_upos', 'Сбер — терминал на кассе (UPOS, Windows)'),
  cli('cli', 'Терминал по кабелю — ARCUS 2 и др. (Windows)');

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
  final banks = TerminalBank.parseIds(data['terminalBanks']);
  switch (provider) {
    case TerminalProvider.manual:
      return ManualTerminalService(banks: banks, otherName: s('terminalBankOther'));
    case TerminalProvider.onlineQr:
      return GatewayQrTerminalService();
    case TerminalProvider.tinkoffSbp:
      return TinkoffSbpQrTerminalService(
          terminalKey: s('terminalLogin'), password: s('terminalPassword'));
    case TerminalProvider.sberUpos:
      return SberUposTerminalService(folder: s('terminalLogin'));
    case TerminalProvider.cli:
      return CliTerminalService(
        exe: s('terminalCliExe'),
        args: s('terminalCliArgs'),
        resultFile: s('terminalCliResult'),
        approve: s('terminalCliApprove'),
        bank: banks.isEmpty ? '' : TerminalBank.label(banks.first, other: s('terminalBankOther')),
      );
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
