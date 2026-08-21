import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:image_picker/image_picker.dart';

/// Тонкая обёртка над Firebase Storage для загрузки фото категорий и
/// позиций меню (аналог фото-плиток "Бургеры", "Барная карта" в Restik POS).
///
/// Файлы кладутся по ФИКСИРОВАННОМУ пути на сущность (без временной метки):
///   menu_images/categories/{categoryId}.jpg
///   menu_images/items/{itemId}.jpg
/// Публичный downloadURL сохраняется в поле imageUrl соответствующего
/// документа Firestore (см. FirestoreService.updateCategoryImage /
/// updateMenuItemImage).
///
/// RCA "не удалось загрузить фото: [firebase_storage/object-not-found]":
/// раньше файл клался под путём с timestamp (…_{millis}.jpg), а старые
/// файлы этой же сущности вычищались отдельным проходом listAll() +
/// delete(). При повторной/двойной загрузке одной и той же сущности
/// (двойной тап, повторная попытка после плохой сети и т.п.) две загрузки
/// могли пересечься по времени и удалить объект, на который другая
/// загрузка только что получила downloadURL — независимо от того, до или
/// после getDownloadURL() стоит очистка, потому что это ДВА разных вызова
/// uploadMenuImage() с двумя разными путями, и очистка одного вызова не
/// знает о keepPath другого. Плюс сама схема "лист + точечное удаление"
/// требовала прав на list в Storage Rules и лишний сетевой round-trip.
///
/// Исправление: путь на сущность фиксированный (без метки времени), запись
/// идёт через putData на этот же путь, что в Storage — простая замена
/// объекта, без листинга и без удаления. Firebase Storage при каждой
/// перезаписи выдаёт файлу новый download-токен, поэтому URL всё равно
/// меняется на новый и старая закэшированная картинка не "залипает" — при
/// этом гонки между двумя загрузками одной сущности больше нет: последняя
/// успешная запись просто выигрывает, и downloadURL всегда берётся у
/// объекта, который только что реально записан (snapshot.ref), а не у
/// URL, который могла успеть стереть чужая параллельная очистка.
class StorageService {
  final FirebaseStorage _storage;
  final ImagePicker _picker;

  /// [storage] позволяет подставить мок в тестах (см.
  /// test/storage_service_test.dart) — по умолчанию используется реальный
  /// синглтон FirebaseStorage.instance.
  StorageService({FirebaseStorage? storage, ImagePicker? picker})
      : _storage = storage ?? FirebaseStorage.instance,
        _picker = picker ?? ImagePicker();

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
  /// [folder] — 'categories' или 'items', [entityId] — id категории/позиции.
  ///
  /// Путь на сущность фиксированный (см. RCA в комментарии класса выше) —
  /// повторная загрузка просто перезаписывает объект по тому же пути, без
  /// листинга и удаления старых файлов, поэтому гонка, приводившая к
  /// firebase_storage/object-not-found, больше структурно невозможна.
  ///
  /// downloadURL берётся у snapshot.ref только после того, как
  /// snapshot.state подтверждает успешную запись (TaskState.success) — это
  /// защищает от редкого случая, когда putData() возвращает управление
  /// раньше, чем задача реально дошла до финального состояния.
  ///
  /// Если у сущности раньше было фото с ДРУГИМ расширением (например,
  /// заменили .png на .jpg), старый файл лучшими усилиями подчищается уже
  /// после успешной загрузки нового — ошибка очистки не влияет на
  /// результат и не пробрасывается наружу.
  Future<String> uploadMenuImage({
    required XFile file,
    required String folder,
    required String entityId,
  }) async {
    // Защитная проверка: анонимная сессия Firebase Auth ставится один раз
    // при старте приложения (main.dart). Если токен успел протухнуть/
    // обнулиться (долгое пребывание в фоне без сети и т.п.), запись в
    // Storage упадёт с [firebase_storage/unauthorized] ещё ДО того, как
    // объект вообще появится — тогда следующий getDownloadURL() закономерно
    // получает object-not-found. Поэтому перед каждой загрузкой на всякий
    // случай убеждаемся, что подписаны анонимно.
    if (FirebaseAuth.instance.currentUser == null) {
      await FirebaseAuth.instance.signInAnonymously();
    }

    final bytes = await file.readAsBytes();
    final ext = _extensionOf(file.name);
    final path = 'menu_images/$folder/$entityId.$ext';

    // Вся операция «залить и получить ссылку» оборачивается в ДО ДВУХ
    // полных попыток. Раньше при неудаче getDownloadURL() (после серии
    // ретраев) сразу пробрасывалась ошибка пользователю — но иногда сам
    // putData() отчитывается state=success раньше, чем объект реально
    // зафиксирован на стороне Storage (известная гонка SDK при нестабильной
    // сети — на скриншоте одновременно активны Wi-Fi и мобильная сеть, это
    // типичный триггер). Один повторный полный перезалив «лечит» такие
    // случаи практически всегда.
    Object? lastError;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final ref = _storage.ref().child(path);
        final task = await ref.putData(
          Uint8List.fromList(bytes),
          SettableMetadata(contentType: _contentTypeOf(ext)),
        );

        if (task.state != TaskState.success) {
          throw StateError(
              'Загрузка фото не завершилась успешно (состояние: ${task.state}).');
        }

        final downloadUrl = await _getDownloadUrlWithRetry(task.ref);

        // Лучшими усилиями подчищаем файлы этой же сущности с ДРУГИМ
        // расширением (единственный случай, когда путь мог измениться).
        // Идёт строго после getDownloadURL уже загруженного файла — ошибка
        // здесь никак не влияет на возвращаемую ссылку.
        unawaited(_cleanupStaleExtensions(folder: folder, entityId: entityId, keepPath: path));

        return downloadUrl;
      } on FirebaseException catch (e) {
        lastError = e;
        if (e.code != 'object-not-found' || attempt == 1) rethrow;
        // Даём Storage ещё немного времени и пробуем весь цикл заново.
        await Future.delayed(const Duration(seconds: 2));
      }
    }
    throw lastError ?? StateError('Не удалось загрузить фото.');
  }

  /// Ждём появления объекта на стороне Storage перед тем, как запрашивать
  /// download URL. getMetadata() — более лёгкий вызов, чем getDownloadURL(),
  /// и на практике быстрее отражает реально записанный объект.
  Future<String> _getDownloadUrlWithRetry(Reference ref, {int attempts = 6}) async {
    Object? lastError;
    for (var i = 0; i < attempts; i++) {
      try {
        await ref.getMetadata();
        return await ref.getDownloadURL();
      } on FirebaseException catch (e) {
        lastError = e;
        if (e.code != 'object-not-found') rethrow;
        // Экспоненциальная пауза с потолком в 4с: 400, 800, 1600, 3200,
        // 4000, 4000мс — суммарно даём объекту около 14 секунд на то,
        // чтобы стать видимым, прежде чем считать это настоящей ошибкой.
        final delayMs = (400 * (1 << i)).clamp(400, 4000);
        await Future.delayed(Duration(milliseconds: delayMs));
      }
    }
    throw lastError ?? StateError('Не удалось получить ссылку на фото.');
  }

  Future<void> _cleanupStaleExtensions({
    required String folder,
    required String entityId,
    required String keepPath,
  }) async {
    try {
      final dir = _storage.ref().child('menu_images/$folder');
      final listing = await dir.listAll();
      for (final item in listing.items) {
        final isSameEntity = item.name.startsWith('$entityId.');
        final isKept = item.fullPath == keepPath;
        if (isSameEntity && !isKept) {
          await item.delete();
        }
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