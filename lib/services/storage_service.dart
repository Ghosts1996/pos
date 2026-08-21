import 'dart:typed_data';

import 'package:firebase_storage/firebase_storage.dart';
import 'package:image_picker/image_picker.dart';

/// Тонкая обёртка над Firebase Storage для загрузки фото категорий и
/// позиций меню (аналог фото-плиток "Бургеры", "Барная карта" в Restik POS).
///
/// Файлы кладутся в:
///   menu_images/categories/{categoryId}_{timestamp}.jpg
///   menu_images/items/{itemId}_{timestamp}.jpg
/// Публичный downloadURL сохраняется в поле imageUrl соответствующего
/// документа Firestore (см. FirestoreService.updateCategoryImage /
/// updateMenuItemImage).
class StorageService {
  final FirebaseStorage _storage = FirebaseStorage.instance;
  final ImagePicker _picker = ImagePicker();

  /// Открывает системный выбор фото (галерея) с уменьшением размера, чтобы
  /// не грузить в Storage многометровые оригиналы с камеры телефона.
  /// Возвращает null, если пользователь отменил выбор.
  Future<XFile?> pickImage({ImageSource source = ImageSource.gallery}) {
    return _picker.pickImage(
      source: source,
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 85,
    );
  }

  /// Загружает выбранное фото в Storage и возвращает публичный download URL.
  /// [folder] — 'categories' или 'items', [entityId] — id категории/позиции,
  /// используется как часть пути, чтобы повторная загрузка не плодила мусор
  /// бесконечно (старый файл этой сущности вычищается ниже).
  Future<String> uploadMenuImage({
    required XFile file,
    required String folder,
    required String entityId,
  }) async {
    final bytes = await file.readAsBytes();
    final ext = _extensionOf(file.name);
    final path =
        'menu_images/$folder/${entityId}_${DateTime.now().millisecondsSinceEpoch}.$ext';
    final ref = _storage.ref().child(path);

    await ref.putData(
      Uint8List.fromList(bytes),
      SettableMetadata(contentType: _contentTypeOf(ext)),
    );

    // Подчищаем предыдущие файлы этой сущности в той же папке, чтобы в
    // Storage не копились неиспользуемые фото при каждой замене картинки.
    await _cleanupOldFiles(folder: folder, entityId: entityId, keepPath: path);

    return ref.getDownloadURL();
  }

  Future<void> _cleanupOldFiles({
    required String folder,
    required String entityId,
    required String keepPath,
  }) async {
    try {
      final dir = _storage.ref().child('menu_images/$folder');
      final listing = await dir.listAll();
      for (final item in listing.items) {
        final isSameEntity = item.name.startsWith('${entityId}_');
        final isKept = item.fullPath == keepPath;
        if (isSameEntity && !isKept) {
          await item.delete();
        }
      }
    } catch (_) {
      // Очистка старых файлов — не критичная операция: если она не удалась
      // (нет прав, нестабильная сеть), новая картинка всё равно уже
      // загружена и сохранена, поэтому просто молча игнорируем ошибку.
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