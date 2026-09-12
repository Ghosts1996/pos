import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import '../../models/menu_models.dart';

/// Прогрев кэша картинок меню.
///
/// Без него каждая позиция тянет фото по сети в момент прокрутки — на
/// мобильном интернете это выглядит как «долго грузится». Здесь все фото
/// скачиваются один раз при запуске приложения в фоне, и дальше меню
/// открывается мгновенно, в том числе офлайн.
///
/// Скачивание идёт пачками, чтобы не забивать канал и не мешать первому
/// экрану: гость листает главную, пока фото докачиваются.
class KolibriImageCache {
  KolibriImageCache._();
  static final KolibriImageCache instance = KolibriImageCache._();

  final _cache = DefaultCacheManager();
  bool _running = false;
  bool _done = false;

  /// Сколько фото качаем одновременно. 4 — компромисс: быстрее, чем по
  /// одному, и не съедает весь канал на слабой сети.
  static const _batchSize = 4;

  /// Запускается один раз при старте приложения. Ошибки игнорируются:
  /// не скачалось — покажем картинку обычным способом при прокрутке.
  Future<void> warmUp() async {
    if (_running || _done) return;
    _running = true;
    try {
      final snap = await FirebaseFirestore.instance.collection('menuItems').get();
      final urls = snap.docs
          .map(MenuItem.fromDoc)
          .where((i) => i.available && i.imageUrl.isNotEmpty)
          .map((i) => i.imageUrl)
          .toSet()
          .toList();

      for (var i = 0; i < urls.length; i += _batchSize) {
        final batch = urls.skip(i).take(_batchSize);
        await Future.wait(batch.map(_download));
      }
      _done = true;
    } catch (_) {
      // Нет сети при старте — попробуем в следующий запуск.
    }
    _running = false;
  }

  Future<void> _download(String url) async {
    try {
      // getFileFromCache не качает повторно уже скачанное — поэтому
      // повторные запуски приложения почти бесплатны.
      final cached = await _cache.getFileFromCache(url);
      if (cached != null) return;
      await _cache.downloadFile(url);
    } catch (_) {}
  }

  /// Прогрев конкретного списка URL — например, когда администратор
  /// добавил новые позиции, пока приложение открыто.
  Future<void> warmUpUrls(Iterable<String> urls) async {
    for (final url in urls.where((u) => u.isNotEmpty)) {
      unawaited(_download(url));
    }
  }

  /// Декодирование в память для самых заметных картинок (афиша на главной):
  /// файл уже в кэше, но декодирование тоже занимает кадр-другой.
  Future<void> precacheInto(BuildContext context, Iterable<String> urls) async {
    for (final url in urls.where((u) => u.isNotEmpty).take(10)) {
      if (!context.mounted) return;
      try {
        await precacheImage(NetworkImage(url), context);
      } catch (_) {}
    }
  }

  /// Полная очистка кэша — на случай, если администратор заменил фото,
  /// а у гостей осталось старое.
  Future<void> clear() async {
    await _cache.emptyCache();
    _done = false;
  }
}
