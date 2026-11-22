import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';

import '../build_info.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import 'app_scope.dart';
import 'people_directory.dart';

/// Кега разливного пива на кране (SaaS, «Честный знак»).
///
/// Кега маркирована одним кодом. Бармен «ставит её на кран» в кассе:
/// сканирует код, указывает объём и какие позиции меню наливаются из неё
/// (и сколько литров в порции). Дальше каждая проданная порция уходит в
/// фискальный чек с кодом кеги, количеством в литрах и мерой «литр»
/// (ФФД 1.2: мерный маркированный товар), а остаток кеги уменьшается.
/// Подключение кеги к оборудованию отмечается и в личном кабинете
/// «Честного знака» (документ подписывается УКЭП — из кассы это сделать
/// нельзя), касса напоминает об этом и хранит отметку.
class Keg {
  final String id;
  final String code;
  final String name;
  final double volumeL;
  final double pouredL;

  /// Позиции меню из этой кеги → литров в порции.
  final Map<String, double> portions;
  final bool onTap;
  final DateTime? connectedAt;

  /// Бармен отметил: подключение кеги внесено в ЛК «Честного знака».
  final bool czNotified;

  const Keg({
    required this.id,
    required this.code,
    required this.name,
    required this.volumeL,
    this.pouredL = 0,
    this.portions = const {},
    this.onTap = true,
    this.connectedAt,
    this.czNotified = false,
  });

  double get leftL {
    final v = volumeL - pouredL;
    return v < 0 ? 0 : (v * 100).roundToDouble() / 100;
  }

  double get leftShare => volumeL <= 0 ? 0 : (leftL / volumeL).clamp(0.0, 1.0);

  factory Keg.fromMap(String id, Map<String, dynamic> m) {
    final at = m['connectedAt'];
    final p = m['portions'] is Map ? Map<String, dynamic>.from(m['portions'] as Map) : const <String, dynamic>{};
    return Keg(
      id: id,
      code: (m['code'] ?? '').toString(),
      name: (m['name'] ?? '').toString(),
      volumeL: (m['volumeL'] as num?)?.toDouble() ?? 0,
      pouredL: (m['pouredL'] as num?)?.toDouble() ?? 0,
      portions: {for (final e in p.entries) if (e.value is num && (e.value as num) > 0) e.key: (e.value as num).toDouble()},
      onTap: m['status'] != 'off',
      connectedAt: at is Timestamp ? at.toDate() : null,
      czNotified: m['czNotified'] == true,
    );
  }
}

/// Литров в порции по карточке меню: «Выход» 500 мл → 0,5. 0 — не указан.
double portionLitersOf(MenuItem m) {
  final w = m.weight;
  if (w <= 0) return 0;
  switch (m.weightUnit.name) {
    case 'ml':
      return w / 1000;
    case 'l':
      return w;
    default:
      return 0;
  }
}

/// Какой кеге принадлежит позиция: из включённых — та, что поставлена раньше
/// (допиваем старую). null — позиция не из кеги.
Keg? kegForItem(Iterable<Keg> kegs, String menuItemId) {
  final list = kegs.where((k) => k.onTap && k.portions.containsKey(menuItemId)).toList()
    ..sort((a, b) => (a.connectedAt ?? DateTime(2000)).compareTo(b.connectedAt ?? DateTime(2000)));
  return list.isEmpty ? null : list.first;
}

/// Сколько литров ушло из каждой кеги по строкам чека: { kegId: литры }.
Map<String, double> pourByKeg(Iterable<Keg> kegs, List<OrderItem> lines) {
  final out = <String, double>{};
  for (final l in lines) {
    if (l.qty <= 0) continue;
    final k = kegForItem(kegs, l.menuItemId);
    if (k == null) continue;
    out[k.id] = (out[k.id] ?? 0) + k.portions[l.menuItemId]! * l.qty;
  }
  return out;
}

class KegService {
  KegService._();
  static final KegService instance = KegService._();

  CollectionReference<Map<String, dynamic>> get _col => AppScope.col('kegs');

  Stream<List<Keg>> onTapStream() => _col.where('status', isEqualTo: 'on').snapshots().map(
      (q) => [for (final d in q.docs) Keg.fromMap(d.id, d.data())]..sort((a, b) => a.name.compareTo(b.name)));

  Future<List<Keg>> onTap() async {
    try {
      final q = await _col.where('status', isEqualTo: 'on').get();
      return [for (final d in q.docs) Keg.fromMap(d.id, d.data())];
    } catch (_) {
      return const [];
    }
  }

  /// Поставить кегу на кран. Тот же код уже на кране — ошибка.
  Future<String> connect({
    required String code,
    required String name,
    required double volumeL,
    required Map<String, double> portions,
    required String employeeName,
    bool czNotified = false,
  }) async {
    final clean = code.trim();
    if (clean.length < 20) throw StateError('Это не код маркировки кеги — отсканируйте DataMatrix на кеге');
    if (volumeL <= 0 || volumeL > 200) throw StateError('Объём кеги — от 1 до 200 литров');
    if (portions.isEmpty) throw StateError('Отметьте, какие позиции меню наливаются из этой кеги');
    final same = await _col.where('code', isEqualTo: clean).get();
    if (same.docs.any((d) => d.data()['status'] == 'on')) throw StateError('Эта кега уже на кране');
    if (same.docs.isNotEmpty) throw StateError('Эта кега уже была на кране и снята — повторно её не подключают');
    final ref = _col.doc();
    await ref.set({
      'code': clean,
      'name': name.trim().isEmpty ? 'Кега' : name.trim(),
      'volumeL': volumeL,
      'pouredL': 0,
      'portions': portions,
      'status': 'on',
      'connectedAt': Timestamp.now(),
      'connectedBy': Pd.who(employeeName),
      'czNotified': czNotified,
    });
    return ref.id;
  }

  Future<void> setCzNotified(String id, bool v) => _col.doc(id).update({'czNotified': v});

  Future<void> setPortions(String id, Map<String, double> portions) => _col.doc(id).update({'portions': portions});

  /// Кега закончилась (или её сняли) — больше не наливаем.
  Future<void> disconnect(String id, String employeeName) => _col.doc(id).update({
        'status': 'off',
        'offAt': Timestamp.now(),
        'offBy': Pd.who(employeeName),
      });

  /// После оплаты чека: сколько налили — в остаток кег.
  Future<void> recordPour(List<OrderItem> lines) async {
    if (!kSaasMode) return;
    final kegs = await onTap();
    if (kegs.isEmpty) return;
    for (final e in pourByKeg(kegs, lines).entries) {
      try {
        await _col.doc(e.key).update({'pouredL': FieldValue.increment((e.value * 1000).roundToDouble() / 1000)});
      } catch (err) {
        debugPrint('Кега ${e.key}: $err');
      }
    }
  }
}
