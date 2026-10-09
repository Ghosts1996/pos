import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/pin_hash.dart';

void main() {
  test('PIN-хэш: стабильный, зависит от заведения, совпадает с эталоном', () {
    final a = PinHash.hashSync('1234', 't1');
    expect(a, PinHash.hashSync('1234', 't1'));
    expect(a, isNot(PinHash.hashSync('1234', 't2')));
    expect(a, isNot(PinHash.hashSync('1235', 't1')));
    expect(a.length, 64);
    // Эталон — тот же расчёт в Node (crypto.pbkdf2Sync) и WebCrypto кабинета.
    expect(a, PIN_REF);
  });
}

// ignore: constant_identifier_names
const PIN_REF = '45063e30e69a4a2e0e87b3fd13cf0d947df466cbd6a9116d4d53fb7414163cea';
