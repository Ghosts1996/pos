import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/terminal_bank.dart';
import 'package:hookah_pos/screens/employee/x_report_screen.dart';
import 'package:hookah_pos/services/payment_terminal_service.dart';

SessionModel _s(double terminal, String bank, {bool unpaid = false}) => SessionModel(
      id: 's',
      tableId: 't',
      tableName: 'Стол 1',
      employeeName: 'Анна',
      startTime: DateTime(2026, 10, 10, 18),
      plannedEnd: DateTime(2026, 10, 10, 20),
      status: 'closed',
      paymentTerminal: terminal,
      terminalBank: bank,
      closedWithoutPayment: unpaid,
    );

void main() {
  group('Банки терминалов', () {
    test('в справочнике крупнейшие банки, id без повторов', () {
      final ids = TerminalBank.all.map((b) => b.id).toList();
      expect(ids.toSet().length, ids.length);
      for (final id in ['sber', 'vtb', 'alfa', 'tbank', 'gpb', 'psb', 'raif', 'sovcom', 'rshb', 'mts']) {
        expect(TerminalBank.byId(id), isNotNull, reason: id);
      }
      expect(TerminalBank.all.length, greaterThanOrEqualTo(25));
    });

    test('из настроек — только известные банки и «другой», без повторов', () {
      expect(TerminalBank.parseIds(['sber', 'x', 'sber', 'other', 3]), ['sber', 'other']);
      expect(TerminalBank.parseIds(null), isEmpty);
      expect(TerminalBank.label('other', other: ' Хлынов '), 'Хлынов');
      expect(TerminalBank.label('other'), 'Другой банк');
      expect(TerminalBank.label('tbank'), 'Т-Банк');
    });

    test('ручной терминал с одним банком записывает его в оплату без вопросов', () async {
      final r = await ManualTerminalService(banks: const ['sber']).pay(100);
      expect(r.success, isTrue);
      expect(r.bank, 'Сбер');
      final none = await ManualTerminalService().pay(100);
      expect(none.bank, isNull);
    });

    test('настройки собирают нужный терминал', () {
      final manual = buildTerminalService({'terminalProvider': 'manual', 'terminalBanks': ['sber', 'tbank']});
      expect(manual, isA<ManualTerminalService>());
      expect((manual as ManualTerminalService).banks, ['sber', 'tbank']);
      final cli = buildTerminalService({
        'terminalProvider': 'cli',
        'terminalCliExe': r'C:\Arcus2\CommandLineTool\bin\CommandLineTool.exe',
        'terminalBanks': ['vtb'],
      });
      expect(cli, isA<CliTerminalService>());
      expect((cli as CliTerminalService).bank, 'ВТБ');
    });
  });

  group('Терминал по кабелю', () {
    test('сумма подставляется в копейках и рублях, кавычки держат пробелы', () {
      expect(CliTerminalService.buildArgs('/o1 /a{kop} /c643', 1234.5), ['/o1', '/a123450', '/c643']);
      expect(CliTerminalService.buildArgs('pay {rub} "C:\\Program Files\\x.txt"', 99.999),
          ['pay', '100.00', 'C:\\Program Files\\x.txt']);
      expect(CliTerminalService.buildArgs('', 10), isEmpty);
    });

    test('«одобрено» — только целой строкой: 000 внутри суммы не считается', () {
      expect(CliTerminalService.judge('000\r\nОДОБРЕНО', '000'), isTrue);
      expect(CliTerminalService.judge('СУММА 10000\r\n005', '000'), isNull);
      expect(CliTerminalService.judge('  ОДОБРЕНО  ', 'ОДОБРЕНО'), isTrue);
      expect(CliTerminalService.judge('00', r'0+'), isTrue);
      expect(CliTerminalService.judge('anything', ''), isNull);
      expect(CliTerminalService.judge('', '000'), isNull);
      // Ошибочное выражение — сравнение как с текстом.
      expect(CliTerminalService.judge('(\n', '('), isTrue);
    });

    test('ответ программы банка в cp1251 читается по-русски', () {
      final bytes = [0xCE, 0xC4, 0xCE, 0xC1, 0xD0, 0xC5, 0xCD, 0xCE]; // ОДОБРЕНО
      expect(CliTerminalService.decode(bytes), 'ОДОБРЕНО');
      expect(CliTerminalService.decode(utf8.encode('Одобрено')), 'Одобрено');
    });
  });

  group('X-отчёт по банкам', () {
    test('терминал раскладывается по банкам, «без оплаты» не считается', () {
      final m = terminalByBank([_s(1000, 'Сбер'), _s(500, 'Т-Банк'), _s(200, 'Сбер'), _s(300, ''), _s(999, 'Сбер', unpaid: true)]);
      expect(m, {'Сбер': 1200.0, 'Т-Банк': 500.0, 'банк не указан': 300.0});
    });

    test('банк нигде не записан — разбивки нет', () {
      expect(terminalByBank([_s(1000, ''), _s(10, '')]), isEmpty);
    });

    test('в тексте отчёта строки по банкам под терминалом', () {
      final text = xReportTotalsText(
        period: 'смена',
        orderTotal: 1500,
        revenue: 1500,
        card: 0,
        cash: 0,
        terminal: 1500,
        terminalBanks: const {'Сбер': 1000, 'Т-Банк': 500},
        comp: 0,
        collections: 0,
      );
      expect(text, contains('Оплачено терминалом: 1'));
      expect(text, contains('· Сбер: 1'));
      expect(text, contains('· Т-Банк: 500'));
    });
  });
}
