import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/terminal_charge.dart';

void main() {
  group('terminalCharge — сколько провести кнопкой терминала', () {
    test('сразу нажали терминал: наличные-подсказка не считаются, списываем весь счёт', () {
      expect(terminalCharge(due: 1500, received: 0, terminalField: 0, terminalTyped: false, others: 0), 1500);
    });

    test('гость уже оплатил часть по СБП со стола — берём только остаток', () {
      expect(terminalCharge(due: 1500, received: 400, terminalField: 400, terminalTyped: false, others: 0), 1100);
    });

    test('кассир вписал наличные 500 — терминалом остальное', () {
      expect(terminalCharge(due: 1500, received: 0, terminalField: 0, terminalTyped: false, others: 500), 1000);
    });

    test('кассир перенёс сумму в поле терминала — проводим её, а не удвоенную', () {
      expect(terminalCharge(due: 1500, received: 0, terminalField: 1500, terminalTyped: true, others: 0), 1500);
      expect(terminalCharge(due: 1500, received: 0, terminalField: 600, terminalTyped: true, others: 0), 600);
    });

    test('повторное нажатие после успешной оплаты не списывает второй раз', () {
      expect(terminalCharge(due: 1500, received: 1500, terminalField: 1500, terminalTyped: true, others: 0), 0);
    });

    test('вся сумма уже в других способах — проводить нечего', () {
      expect(terminalCharge(due: 1500, received: 0, terminalField: 0, terminalTyped: false, others: 1500), 0);
    });

    test('копейки не теряются и не накапливаются', () {
      expect(terminalCharge(due: 1000.1, received: 0.2, terminalField: 0.2, terminalTyped: false, others: 0), 999.9);
    });
  });

  group('terminalReceived — полученный безнал', () {
    test('СБП гостя больше счёта — в поле только счёт', () {
      expect(terminalReceived(due: 800, guestPaid: 1000, charged: 0), 800);
    });

    test('СБП гостя и оплата терминалом складываются', () {
      expect(terminalReceived(due: 2000, guestPaid: 500, charged: 1500), 2000);
    });
  });
}
