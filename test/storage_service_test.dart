import 'dart:typed_data';

import 'package:firebase_storage_mocks/firebase_storage_mocks.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

import '../lib/services/storage_service.dart';

/// Регрессионный тест на баг из RCA: getDownloadURL() падал с
/// firebase_storage/object-not-found из-за гонки между записью нового
/// файла (с timestamp в имени) и удалением старых файлов той же сущности.
///
/// Теперь путь на сущность фиксированный (menu_images/{folder}/{id}.{ext})
/// и повторная загрузка — это просто перезапись объекта по тому же пути,
/// без листинга/удаления. Тест проверяет: (1) первая загрузка отдаёт
/// рабочую ссылку; (2) повторная загрузка той же сущности перезаписывает
/// файл, отдаёт НОВУЮ ссылку (новый download-токен) и не оставляет в
/// Storage больше одного файла на сущность.
void main() {
  test('uploadMenuImage перезаписывает файл по фиксированному пути и не '
      'падает с object-not-found при повторной загрузке той же сущности',
      () async {
    final mockStorage = MockFirebaseStorage();
    final service = StorageService(storage: mockStorage);

    final bytes = Uint8List.fromList(List.filled(16, 1));
    final file1 = XFile.fromData(bytes, name: 'photo1.jpg', mimeType: 'image/jpeg');
    final file2 = XFile.fromData(bytes, name: 'photo2.jpg', mimeType: 'image/jpeg');

    final url1 = await service.uploadMenuImage(
      file: file1,
      folder: 'items',
      entityId: 'item_42',
    );
    expect(url1, isNotEmpty);

    // Повторная загрузка для той же сущности — перезаписывает объект по
    // тому же пути. Ключевая проверка регрессии: это не должно кидать
    // firebase_storage/object-not-found и должно отдать рабочую ссылку.
    final url2 = await service.uploadMenuImage(
      file: file2,
      folder: 'items',
      entityId: 'item_42',
    );
    expect(url2, isNotEmpty);
    expect(url2, isNot(equals(url1)));

    // В Storage должен остаться ровно один файл на эту сущность.
    final listing = await mockStorage.ref().child('menu_images/items').listAll();
    expect(listing.items, hasLength(1));
    expect(listing.items.first.fullPath, 'menu_images/items/item_42.jpg');
  });

  test('загрузка с другим расширением подчищает файл со старым расширением',
      () async {
    final mockStorage = MockFirebaseStorage();
    final service = StorageService(storage: mockStorage);

    final bytes = Uint8List.fromList(List.filled(16, 1));
    final pngFile = XFile.fromData(bytes, name: 'photo.png', mimeType: 'image/png');
    final jpgFile = XFile.fromData(bytes, name: 'photo.jpg', mimeType: 'image/jpeg');

    await service.uploadMenuImage(file: pngFile, folder: 'categories', entityId: 'cat_1');
    await service.uploadMenuImage(file: jpgFile, folder: 'categories', entityId: 'cat_1');

    // Даём фоновой (unawaited) очистке старого расширения отработать.
    await Future<void>.delayed(const Duration(milliseconds: 50));

    final listing = await mockStorage.ref().child('menu_images/categories').listAll();
    expect(listing.items, hasLength(1));
    expect(listing.items.first.fullPath, 'menu_images/categories/cat_1.jpg');
  });
}