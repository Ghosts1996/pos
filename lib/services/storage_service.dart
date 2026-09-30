import 'dart:async';

import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../build_info.dart';
import 'app_lock.dart';
import 'app_scope.dart';

/// Загрузка фото категорий и позиций меню в Supabase Storage — Firebase
/// Storage требует тарифа Blaze.
///
/// Путь фиксирован на сущность (`categories/{id}.jpg`, `items/{id}.jpg`),
/// повторная загрузка перезаписывает файл. Публичный URL Supabase при этом
/// не меняется, поэтому к нему добавляется метка времени — иначе на
/// устройствах осталась бы старая картинка из кэша. URL пишется в imageUrl
/// документа (FirestoreService.updateCategoryImage/updateMenuItemImage).
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
  /// Возвращает null, если пользователь отменил выбор. Уход в галерею или
  /// камеру не блокирует кассу (AppLock).
  Future<XFile?> pickImage({ImageSource source = ImageSource.gallery}) {
    return AppLock.instance.whileAway(() => _picker.pickImage(
          source: source,
          maxWidth: 1600,
          maxHeight: 1600,
          imageQuality: 85,
        ));
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
    // SaaS: фото — в папку своего заведения на сервере платформы, а не в
    // общий бакет, где заведения видели и могли стереть файлы друг друга.
    if (AppScope.isSaasMode && kSaasGatewayUrl.isNotEmpty) {
      return _uploadViaGateway(bytes: bytes, ext: ext, folder: folder, entityId: entityId);
    }
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

  Future<String> _uploadViaGateway({
    required List<int> bytes,
    required String ext,
    required String folder,
    required String entityId,
  }) async {
    const types = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp'};
    final type = types[ext];
    if (type == null) {
      throw Exception('Формат .$ext не поддерживается — выберите фото в JPG, PNG или WebP');
    }
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    final base = kSaasGatewayUrl.replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/uploadMenuImage').replace(queryParameters: {
      'tenantId': AppScope.tenantId!,
      'folder': folder,
      'entityId': entityId,
    });
    final resp = await http
        .post(uri, headers: {'Content-Type': type, if (token != null) 'Authorization': 'Bearer $token'}, body: bytes)
        .timeout(const Duration(seconds: 60));
    Map<String, dynamic> data = const {};
    try {
      data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {}
    if (resp.statusCode != 200 || data['path'] is! String) {
      throw Exception('Не удалось загрузить фото (${resp.statusCode}): ${data['error'] ?? 'сервер не ответил'}');
    }
    return '${Uri.parse(base).origin}${data['path']}?t=${DateTime.now().millisecondsSinceEpoch}';
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