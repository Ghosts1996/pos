import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/widgets.dart';

/// Заранее скачивает и кладёт в ДИСКОВЫЙ кэш (cached_network_image /
/// flutter_cache_manager) все фото категорий и позиций меню.
///
/// Раньше фото грузились через Image.network прямо в момент отрисовки
/// плитки — без кэша это означало повторный сетевой запрос при каждом
/// открытии экрана меню, и именно это было причиной зависаний/фризов при
/// первом скролле меню на POS-планшете. Теперь фото качаются один раз
/// (при первом запуске приложения или когда появляются новые/изменённые
/// фото) через этот сервис, а сами виджеты (см. CachedNetworkImage в
/// menu_selection_screen.dart и menu_editor_screen.dart) в дальнейшем
/// читают их с диска — мгновенно и без сети.
class ImagePreloadService {
  final _db = FirebaseFirestore.instance;

  Future<List<String>> _collectImageUrls() async {
    final urls = <String>{};

    final catsSnap = await _db.collection('menuCategories').get();
    for (final d in catsSnap.docs) {
      final url = (d.data()['imageUrl'] as String?) ?? '';
      if (url.isNotEmpty) urls.add(url);
    }

    final itemsSnap = await _db.collection('menuItems').get();
    for (final d in itemsSnap.docs) {
      final url = (d.data()['imageUrl'] as String?) ?? '';
      if (url.isNotEmpty) urls.add(url);
    }

    return urls.toList();
  }

  /// Качает все фото меню в дисковый кэш. [onProgress] вызывается после
  /// каждого фото (готово/всего) — можно показать прогресс-бар на сплэше.
  ///
  /// Специально устойчив к сбоям: нет сети, битая ссылка на одно фото,
  /// пустое меню — ни одна из этих ситуаций не блокирует вызывающий код
  /// надолго и не мешает попасть в приложение. Каждое фото ограничено
  /// собственным таймаутом, плюс сбор списка URL — своим.
  Future<void> preloadAll(
    BuildContext context, {
    void Function(int done, int total)? onProgress,
  }) async {
    List<String> urls;
    try {
      urls = await _collectImageUrls().timeout(const Duration(seconds: 8));
    } catch (_) {
      // Нет сети или Firestore недоступен — не блокируем запуск, фото
      // догрузятся по месту использования, как и раньше.
      onProgress?.call(0, 0);
      return;
    }

    if (urls.isEmpty) {
      onProgress?.call(0, 0);
      return;
    }

    var done = 0;
    onProgress?.call(done, urls.length);

    // Ограниченный параллелизм — чтобы не забить сеть и память слабого
    // POS-планшета одновременным стартом десятков закачек при большом меню.
    const concurrency = 4;
    final queue = List<String>.from(urls);

    Future<void> worker() async {
      while (queue.isNotEmpty) {
        if (!context.mounted) return;
        final url = queue.removeLast();
        try {
          await precacheImage(CachedNetworkImageProvider(url), context)
              .timeout(const Duration(seconds: 10));
        } catch (_) {
          // Битая ссылка / оборвалась сеть на конкретном фото — пропускаем,
          // остальные продолжают качаться. Плейсхолдер на плитке меню и так
          // покроет случай отсутствующей картинки.
        }
        done++;
        onProgress?.call(done, urls.length);
      }
    }

    await Future.wait(List.generate(concurrency, (_) => worker()));
  }
}
