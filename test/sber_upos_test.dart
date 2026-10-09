import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/payment_terminal_service.dart';

void main() {
  test('UPOS: код 0 — оплата прошла, маска карты из второй строки', () {
    final r = SberUposTerminalService.parseResult(latin1.encode('0,OK\r\n************1234\r\n12/29\r\n123456\r\n'));
    expect(r.success, isTrue);
    expect(r.maskedCardNumber, '•• 1234');
    expect(r.operationId, '123456');
  });

  test('UPOS: ненулевой код или мусор — отказ', () {
    expect(SberUposTerminalService.parseResult(latin1.encode('2000,X\r\n')).success, isFalse);
    expect(SberUposTerminalService.parseResult(latin1.encode('')).success, isFalse);
    expect(SberUposTerminalService.parseResult(latin1.encode('abc')).success, isFalse);
  });
}
