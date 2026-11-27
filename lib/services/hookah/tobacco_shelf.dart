import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:image_picker/image_picker.dart';

import '../app_scope.dart';
import '../../data/app_db.dart';
import '../gateway_api.dart';
import 'flavors.dart';
import 'mix_engine.dart';

/// Полка табака заведения: tenants/{t}/tobaccoShelf/{id}. Пишет персонал
/// (фото полки или вручную), читают касса и приложение гостя — по ней
/// подбираются миксы (MixEngine) без ИИ.
class TobaccoShelf {
  TobaccoShelf._();

  static CollectionReference<Map<String, dynamic>> _col() => AppScope.col('tobaccoShelf');

  /// Постоянный номер банки: марка + название (повторное фото не плодит копий).
  static String idOf(String brand, String name) {
    final raw = '${brand.trim()}_${name.trim()}'.toLowerCase().replaceAll('ё', 'е');
    final id = raw.replaceAll(RegExp(r'[^a-zа-я0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
    return id.length > 80 ? id.substring(0, 80) : (id.isEmpty ? 'can' : id);
  }

  static List<TobaccoCan> _parse(QuerySnapshot<Map<String, dynamic>> s) {
    final list = [for (final d in s.docs) TobaccoCan.fromMap(d.id, d.data())];
    list.sort((a, b) => '${a.brand} ${a.name}'.toLowerCase().compareTo('${b.brand} ${b.name}'.toLowerCase()));
    return list;
  }

  static Stream<List<TobaccoCan>> stream() => _col().snapshots().map(_parse);

  static Future<List<TobaccoCan>> once() async {
    try {
      return _parse(await _col().get().timeout(const Duration(seconds: 8)));
    } catch (_) {
      return const [];
    }
  }

  /// Банка из ответа распознавания: вкусы — по словам ИИ и по названию.
  static TobaccoCan fromScan(Map<String, dynamic> m) {
    final brand = '${m['brand'] ?? ''}'.trim();
    final name = '${m['name'] ?? ''}'.trim();
    final words = (m['flavors'] is List) ? (m['flavors'] as List).join(', ') : '${m['flavors'] ?? ''}';
    final flavors = flavorsInText('$words, $name');
    return TobaccoCan(id: idOf(brand, name), brand: brand, name: name, flavors: flavors, strength: '${m['strength'] ?? ''}');
  }

  /// Фото полки → банки (через ИИ заведения на сервере). Снимок ужат
  /// камерой до ~1400 точек, чтобы уложиться в лимит 0,9 МБ.
  static Future<List<TobaccoCan>> scan(XFile photo) async {
    final bytes = await photo.readAsBytes();
    final data = base64Encode(bytes);
    if (data.length > 960000) {
      throw GatewayException('Фото слишком большое — снимите полку ещё раз (ближе, без зума)');
    }
    final name = photo.name.toLowerCase();
    final type = name.endsWith('.png') ? 'image/png' : (name.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    final res = await GatewayApi.post('tobaccoShelf', {
      'action': 'scan',
      'page': {'mediaType': type, 'data': data},
    });
    return [
      for (final m in (res['items'] as List? ?? const []))
        if (m is Map) fromScan(Map<String, dynamic>.from(m)),
    ];
  }

  /// Сохранить банки на полку (повторы обновляются, «в наличии» включается)
  /// и пополнить общий каталог вкусов — так база узнаёт о новинках.
  static Future<void> saveAll(List<TobaccoCan> cans) async {
    if (cans.isEmpty) return;
    final batch = AppDb.instance.batch();
    for (final c in cans) {
      batch.set(_col().doc(c.id), {...c.toMap(), 'inStock': true, 'updatedAt': FieldValue.serverTimestamp()}, SetOptions(merge: true));
    }
    await batch.commit();
    unawaited(GatewayApi.post('tobaccoShelf', {
      'action': 'learn',
      'items': [
        for (final c in cans) {'brand': c.brand, 'name': c.name, 'flavors': [for (final f in c.flavors) kFlavorByKey[f]?.name ?? f], 'strength': c.strength},
      ],
    }).catchError((Object _) => const <String, dynamic>{}));
  }

  static Future<void> setInStock(String id, bool inStock) =>
      _col().doc(id).set({'inStock': inStock, 'updatedAt': FieldValue.serverTimestamp()}, SetOptions(merge: true));

  static Future<void> remove(String id) => _col().doc(id).delete();

  /// Новинки вкусов: банки, впервые замеченные на полках заведений за 60 дней.
  static Future<List<TobaccoCan>> fresh() async {
    final res = await GatewayApi.post('tobaccoShelf', {'action': 'catalog', 'limit': 40});
    return [
      for (final m in (res['fresh'] as List? ?? const []))
        if (m is Map) fromScan(Map<String, dynamic>.from(m)),
    ];
  }
}
