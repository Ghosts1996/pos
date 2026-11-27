import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:image_picker/image_picker.dart';

import '../app_scope.dart';
import '../../data/app_db.dart';
import '../gateway_api.dart';
import 'brand_profiles.dart';
import 'flavors.dart';
import 'mix_engine.dart';
import 'photo_prep.dart';
import 'tobacco_catalog.dart';

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

  /// Банка из ответа распознавания: марка — к одному написанию по каталогу
  /// («блэк берн» → «Black Burn»), вкусы известной банки — из каталога
  /// (tobacco_catalog.dart), иначе по словам ИИ и названию; крепость — как
  /// прочитал ИИ, иначе обычная для марки.
  static TobaccoCan fromScan(Map<String, dynamic> m) {
    var brand = canonicalBrand('${m['brand'] ?? ''}');
    // Марку не видно — по известному названию банки (Spectrum «Мощная мята»).
    if (brand.isEmpty) brand = brandByName('${m['name'] ?? ''}');
    // Ошибка ИИ в букву-две у известной банки — правим по каталогу.
    final name = fixCanName(brand, '${m['name'] ?? ''}'.trim());
    var line = '${m['line'] ?? ''}'.trim();
    if (line.length > 30 || line.toLowerCase() == brand.toLowerCase()) line = '';
    // Линейка в самой надписи марки: «Darkside Shot», «Сарма 360», «Noir».
    if (line.isEmpty) line = lineFromBrandText('${m['brand'] ?? ''}');
    final words = (m['flavors'] is List) ? (m['flavors'] as List).join(', ') : '${m['flavors'] ?? ''}';
    final flavors = flavorsOfCan(brand, name, words);
    var strength = '${m['strength'] ?? ''}';
    if (!const {'light', 'medium', 'strong'}.contains(strength)) strength = brandOf(brand)?.strength ?? '';
    return TobaccoCan(id: idOf(brand, name), brand: brand, name: name, flavors: flavors, strength: strength, line: line);
  }

  /// Исправить банку вручную: марка, название, вкусы словами. Поменялись
  /// марка или название — у банки новый номер, старая запись удаляется.
  static Future<TobaccoCan> edit(TobaccoCan old, {required String brand, required String name, required String flavorWords}) async {
    final b = canonicalBrand(brand);
    final n = name.trim();
    final words = flavorWords.trim();
    var flavors = words.isEmpty ? flavorsOfCan(b, n, '') : flavorsInText(words);
    if (flavors.isEmpty) flavors = flavorsOfCan(b, n, words);
    var strength = old.strength;
    if (b != old.brand) strength = brandOf(b)?.strength ?? '';
    final can = TobaccoCan(id: idOf(b, n), brand: b, name: n, flavors: flavors, strength: strength, inStock: old.inStock, line: old.line);
    final batch = AppDb.instance.batch();
    batch.set(_col().doc(can.id), {...can.toMap(), 'manual': true, 'updatedAt': FieldValue.serverTimestamp()});
    if (can.id != old.id) batch.delete(_col().doc(old.id));
    await batch.commit();
    return can;
  }

  /// Фото полки → банки (через ИИ заведения на сервере). Снимок готовит
  /// касса (preparePhoto): осветляет тёмный и укладывает в лимит 0,9 МБ.
  /// [photos] — 1–4 снимка одной банки или полки с разных сторон
  /// (название на крышке, марка и «аромат …» сбоку): ИИ сводит их в одну
  /// запись. Все снимки вместе — в лимит сервера 0,9 МБ.
  static Future<List<TobaccoCan>> scan(List<XFile> photos) async {
    if (photos.isEmpty) return const [];
    final list = photos.take(4).toList();
    final budget = 940000 ~/ list.length;
    final pages = <Map<String, dynamic>>[];
    for (final photo in list) {
      final bytes = await photo.readAsBytes();
      // Тёмное фото — светлее, большое — в лимит сервера без потери надписей.
      // Один снимок полки — крупнее (до 2048 точек): на полке 15–25 банок и
      // мелкие надписи; несколько снимков делят лимит — по 1400.
      final prepared = await preparePhoto(bytes, maxSide: list.length > 1 ? 1400 : 2048, maxBase64: budget)
          .catchError((Object _) => null);
      String data;
      String type;
      if (prepared != null) {
        data = prepared.base64;
        type = prepared.mediaType;
      } else {
        data = base64Encode(bytes);
        final name = photo.name.toLowerCase();
        type = name.endsWith('.png') ? 'image/png' : (name.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      }
      if (data.length > budget + 20000) {
        throw GatewayException(list.length > 1
            ? 'Снимки слишком подробные — сделайте меньше снимков или снимите ближе'
            : 'Фото слишком подробное — снимите полку частями, по одной-две полки');
      }
      pages.add({'mediaType': type, 'data': data});
    }
    final res = await _scanOnServer(pages);
    return [
      for (final m in (res['items'] as List? ?? const []))
        if (m is Map) fromScan(Map<String, dynamic>.from(m)),
    ];
  }

  /// Большая полка читается ИИ дольше минуты — столько не ждут ни касса,
  /// ни прокси сервера. Поэтому снимок уходит заданием (scanStart), а
  /// результат касса забирает раз в 3 с (scanResult), до 4 минут. Пропала
  /// связь на пару опросов — ждём дальше, а не пишем «нет связи».
  static Future<Map<String, dynamic>> _scanOnServer(List<Map<String, dynamic>> pages) async {
    // page — для сервера старой версии (он читает только первый снимок).
    final body = {'page': pages.first, if (pages.length > 1) 'pages': pages};
    Map<String, dynamic> start;
    try {
      start = await gatewayPost('tobaccoShelf', {'action': 'scanStart', ...body}, const Duration(seconds: 90));
    } on GatewayException catch (e) {
      // Сервер старой версии — по-старому, одним запросом.
      if (!e.message.contains('Неизвестное действие')) rethrow;
      return gatewayPost('tobaccoShelf', {'action': 'scan', ...body}, const Duration(seconds: 90));
    }
    final job = start['job'];
    if (job is! String || job.isEmpty) throw GatewayException('Сервер не принял снимок — попробуйте ещё раз');
    final until = DateTime.now().add(const Duration(minutes: 4));
    var misses = 0;
    while (DateTime.now().isBefore(until)) {
      await Future<void>.delayed(scanPollEvery);
      Map<String, dynamic> r;
      try {
        r = await gatewayPost('tobaccoShelf', {'action': 'scanResult', 'job': job}, const Duration(seconds: 25));
      } on GatewayException catch (e) {
        if (!e.message.startsWith('Нет связи') || ++misses > 10) rethrow;
        continue;
      }
      misses = 0;
      switch (r['status']) {
        case 'done':
          return r;
        case 'failed':
          throw GatewayException((r['error'] ?? 'ИИ не прочитал полку').toString());
      }
    }
    throw GatewayException('ИИ читает полку дольше 4 минут — снимите полку частями, по одной-две полки');
  }

  /// Запрос к серверу (тесты подменяют).
  static Future<Map<String, dynamic>> Function(String path, Map<String, dynamic> body, Duration timeout) gatewayPost =
      GatewayApi.post;

  /// Разбор снимка на сервере — для тестов без камеры.
  static Future<Map<String, dynamic>> scanPageForTest(Map<String, dynamic> page) => _scanOnServer([page]);

  /// Пауза между опросами результата (тесты ставят меньше).
  static Duration scanPollEvery = const Duration(seconds: 3);

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
