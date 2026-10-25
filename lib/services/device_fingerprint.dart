import 'dart:convert';
import 'dart:io';

import 'package:android_id/android_id.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

/// Постоянный номер устройства — чтобы касса, обновлённая или
/// переустановленная на том же телефоне, оставалась тем же устройством в
/// кабинете, а не занимала новое место по тарифу (saas-gateway,
/// /deviceIdentify).
///
/// Android — ANDROID_ID (не меняется при переустановке приложения с той же
/// подписью), Windows — MachineGuid. Наружу уходит только хеш: сам номер
/// с устройства не передаётся. Не получилось узнать — null, касса работает
/// как раньше.
class DeviceFingerprint {
  static Future<String?>? _cached;

  static Future<String?> get() => _cached ??= _read();

  static Future<String?> _read() async {
    if (kIsWeb) return null;
    try {
      String? raw;
      if (defaultTargetPlatform == TargetPlatform.android) {
        raw = await const AndroidId().getId();
      } else if (defaultTargetPlatform == TargetPlatform.windows) {
        final r = await Process.run('reg', [r'query', r'HKLM\SOFTWARE\Microsoft\Cryptography', '/v', 'MachineGuid'])
            .timeout(const Duration(seconds: 5));
        raw = RegExp(r'MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{16,})').firstMatch('${r.stdout}')?.group(1);
      }
      raw = raw?.trim().toLowerCase();
      // 9774d56d682e549c — одинаковый у части старых прошивок, по нему устройства не различить.
      if (raw == null || raw.length < 8 || raw == '9774d56d682e549c') return null;
      return sha256.convert(utf8.encode('zalpos-device|${defaultTargetPlatform.name}|$raw')).toString();
    } catch (_) {
      return null;
    }
  }
}
