import 'dart:async';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter/services.dart' show PlatformException;

/// Понятный русский текст ошибки вместо сырого исключения: что случилось и
/// что сделать. Свои исключения приложения уже по-русски — показываем их
/// текст без префиксов вроде «Exception:».
///
/// [lower] — со строчной буквы, для продолжения фразы после двоеточия:
/// «Не удалось сохранить: нет связи с сервером — проверьте интернет».
String humanError(Object? e, {bool lower = false}) {
  final text = _describe(e);
  if (lower || text.isEmpty) return text;
  return text[0].toUpperCase() + text.substring(1);
}

final _cyrillic = RegExp('[А-Яа-яЁё]');
final _prefixes = RegExp(r'^(Exception|Bad state|StateError|Invalid argument\(s\)|FormatException|Error):\s*');

String _describe(Object? e) {
  if (e == null) return 'что-то пошло не так — попробуйте ещё раз';
  if (e is FirebaseException) return _firebase(e.code, e.message);
  if (e is TimeoutException) return 'сервер не ответил вовремя — проверьте интернет';
  if (e is PlatformException) {
    final m = e.message ?? '';
    return _cyrillic.hasMatch(m) ? _lowerFirst(m) : 'устройство не смогло выполнить действие — попробуйте ещё раз';
  }
  final raw = e.toString().trim();
  if (_looksOffline(raw)) return 'нет связи с сервером — проверьте интернет';
  // Firebase из веба иногда приходит строкой вида «[cloud_firestore/permission-denied] …».
  final code = RegExp(r'\[[a-z_]+/([a-z-]+)\]').firstMatch(raw)?.group(1);
  if (code != null) return _firebase(code, raw);
  final clean = raw.replaceFirst(_prefixes, '').trim();
  if (_cyrillic.hasMatch(clean)) return _lowerFirst(clean);
  return 'что-то пошло не так — попробуйте ещё раз';
}

bool _looksOffline(String s) {
  final l = s.toLowerCase();
  return l.contains('socketexception') ||
      l.contains('failed host lookup') ||
      l.contains('connection refused') ||
      l.contains('connection reset') ||
      l.contains('network is unreachable') ||
      l.contains('xmlhttprequest error') ||
      l.contains('clientexception') ||
      l.contains('network-request-failed');
}

String _firebase(String code, String? message) {
  switch (code) {
    case 'permission-denied':
      return 'нет доступа — войдите заново или попросите администратора проверить права';
    case 'unavailable':
    case 'deadline-exceeded':
    case 'network-request-failed':
      return 'нет связи с сервером — проверьте интернет';
    case 'unauthenticated':
    case 'user-token-expired':
    case 'requires-recent-login':
      return 'сессия истекла — войдите заново';
    case 'not-found':
      return 'запись не найдена — возможно, её уже удалили';
    case 'already-exists':
      return 'такая запись уже есть';
    case 'aborted':
      return 'данные изменились на другом устройстве — попробуйте ещё раз';
    case 'resource-exhausted':
    case 'too-many-requests':
      return 'слишком много запросов — подождите минуту и попробуйте снова';
    case 'cancelled':
      return 'действие отменено';
    case 'invalid-argument':
      return 'некорректные данные — проверьте, что всё заполнено верно';
    case 'failed-precondition':
      if ((message ?? '').toLowerCase().contains('index')) {
        return 'база данных ещё не готова к этому запросу — сообщите в поддержку';
      }
      return 'действие сейчас недоступно — обновите экран и попробуйте снова';
    default:
      final m = message ?? '';
      return _cyrillic.hasMatch(m) ? _lowerFirst(m) : 'ошибка сервера — попробуйте ещё раз';
  }
}

String _lowerFirst(String s) {
  if (s.isEmpty) return s;
  // Аббревиатуры («ЕГАИС», «PIN») оставляем как есть.
  if (s.length > 1 && s[1].toUpperCase() == s[1] && s[1].toLowerCase() != s[1]) return s;
  return s[0].toLowerCase() + s.substring(1);
}
