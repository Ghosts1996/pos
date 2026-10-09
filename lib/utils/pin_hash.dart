import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:pointycastle/export.dart';

import '../services/app_scope.dart';

/// PIN сотрудника в базе хранится только хэшем: PBKDF2-HMAC-SHA256,
/// 20 000 итераций, соль — заведение. Соль общая на заведение, чтобы вход
/// оставался одним запросом «pinHash == …» (и без интернета — по копии на
/// устройстве), а PIN двух заведений не совпадали по хэшу.
///
/// Тот же расчёт — в кабинете (WebCrypto) и на сервере (демо-заведения):
/// менять параметры только синхронно во всех трёх местах.
class PinHash {
  PinHash._();

  static const iterations = 20000;

  static String saltFor(String tenantId) => 'zalpos-pin:$tenantId';

  static String hashSync(String pin, String tenantId) {
    final d = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
      ..init(Pbkdf2Parameters(Uint8List.fromList(utf8.encode(saltFor(tenantId))), iterations, 32));
    final out = d.process(Uint8List.fromList(utf8.encode(pin)));
    return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  static String _run(List<String> a) => hashSync(a[0], a[1]);

  /// Хэш PIN для текущего заведения — в фоновом потоке, чтобы не дёргать
  /// экран ввода PIN.
  static Future<String> of(String pin) => compute(_run, [pin, AppScope.tenantId ?? 'single']);
}
