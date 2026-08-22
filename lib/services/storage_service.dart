import 'dart:async';

import 'package:image_picker/image_picker.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Тонкая обёртка над Supabase Storage для загрузки фото категорий и
/// позиций меню (аналог фото-плиток "Бургеры", "Барная карта" в Restik POS).
///
/// Ранее использовался Firebase Storage, но он недоступен без перехода
/// проекта на платный тариф Blaze с привязкой биллинг-аккаунта (см. историю
/// изменений). Supabase Storage даёт тот же функционал (файлы + публичные
/// ссылки) на бесплатном тарифе без обязательной привязки карты.
///
/// Файлы кладутся по ФИКСИРОВАННОМУ пути на сущность (без временной метки):
///   categories/{categoryId}.jpg
///   items/{itemId}.jpg
/// Публичный URL сохраняется в поле imageUrl соответствующего документа
/// Firestore (см. FirestoreService.updateCategoryImage / updateMenuItemImage
/// — эта часть не менялась).
///
/// Путь на сущность фиксированный — повторная загрузка просто перезаписывает
/// объект по тому же пути (upsert: true), без листинга и удаления старых
/// файлов. Чтобы закэшированная на устройстве картинка не "залипала" после
/// перезаписи (публичный URL Supabase не меняется сам по себе, в отличие от
/// Firebase, где менялся download-токен), к URL добавляется query-параметр
/// с меткой времени — он не влияет на сам файл в бакете, но заставляет
/// Image.network(...) в приложении запросить файл заново.
class StorageService {
  final SupabaseClient _client;
  final ImagePicker _picker;

  /// Имя бакета в Supabase Storage. Бакет должен быть создан заранее в
  /// Supabase Dashboard → Storage → New bucket → "menu-images" (Public).
  static const _bucket = 'menu-images';

  StorageService({SupabaseClient? client, ImagePicker? picker})
      : _client = client ?? Supabase.instance.client,
        _picker = picker ?? ImagePicker();

  /// Открывает системный выбор фото (галерея/камера) с уменьшением размера,
  /// чтобы не грузить в Storage многометровые оригиналы с камеры телефона.
  /// Возвращает null, если пользователь отменил выбор.
  Future<XFile?> pickImage({ImageSource source = ImageSource.gallery}) {
    return _picker.pickImage(
      source: source,
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 85,
    );
  }

  /// Загружает выбранное фото в Storage и возвращает публичный URL.
  /// [folder] — 'categories' или 'items', [entityId] — id категории/позиции.
  Future<String> uploadMenuImage({
    required XFile file,
    required String folder,
    required String entityId,
  }) async {
    final bytes = await file.readAsBytes();
    final ext = _extensionOf(file.name);
    final path = '$folder/$entityId.$ext';

    await _client.storage.from(_bucket).uploadBinary(
          path,
          bytes,
          fileOptions: FileOptions(
            contentType: _contentTypeOf(ext),
            // Перезаписываем объект по тому же пути вместо ошибки "уже
            // существует" — это и есть весь фикс: один фиксированный путь
            // на сущность, без гонок между листингом/удалением и загрузкой.
            upsert: true,
          ),
        );

    // Лучшими усилиями подчищаем файлы этой же сущности с ДРУГИМ
    // расширением (единственный случай, когда путь мог измениться,
    // например заменили .png на .jpg). Ошибка очистки не влияет на
    // результат и не пробрасывается наружу.
    unawaited(_cleanupStaleExtensions(folder: folder, entityId: entityId, keepPath: path));

    final publicUrl = _client.storage.from(_bucket).getPublicUrl(path);
    // Метка времени в query — только чтобы у клиента (Image.network) не
    // залипал старый закэшированный файл после перезаписи по тому же пути.
    return '$publicUrl?t=${DateTime.now().millisecondsSinceEpoch}';
  }

  Future<void> _cleanupStaleExtensions({
    required String folder,
    required String entityId,
    required String keepPath,
  }) async {
    try {
      final listing = await _client.storage.from(_bucket).list(path: folder);
      final staleNames = listing
          .where((f) => f.name.startsWith('$entityId.') && '$folder/${f.name}' != keepPath)
          .map((f) => '$folder/${f.name}')
          .toList();
      if (staleNames.isNotEmpty) {
        await _client.storage.from(_bucket).remove(staleNames);
      }
    } catch (_) {
      // Не критично: нет прав/нестабильная сеть — новая картинка уже
      // загружена и сохранена, просто останется один лишний файл с
      // устаревшим расширением.
    }
  }

  String _extensionOf(String fileName) {
    final dot = fileName.lastIndexOf('.');
    if (dot == -1 || dot == fileName.length - 1) return 'jpg';
    return fileName.substring(dot + 1).toLowerCase();
  }

  String _contentTypeOf(String ext) {
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'heic':
        return 'image/heic';
      default:
        return 'image/jpeg';
    }
  }
}