import 'dart:typed_data';

import 'package:firebase_storage_mocks/firebase_storage_mocks.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

import '../lib/services/storage_service.dart';

/// Регрессионный тест на баг из RCA: getDownloadURL() падал с
/// firebase_storage/object-not-found, потому что очистка старых файлов
/// сущности выполнялась ДО получения ссылки на только что загруженный
/// файл и в некоторых сценариях успевала удалить его раньше, чем мы
/// получали на него URL. Тест проверяет, что после uploadMenuImage()
/// возвращается непустая ссылка и файл действительно существует в Storage
/// даже при повторной (второй) загрузке для той же сущности, когда
/// срабатывает очистка предыдущего файла.
void main() {
  test('uploadMenuImage возвращает валидный downloadURL и не теряет файл '
      'при последующей очистке старых файлов той же сущности', () async {
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

    // Вторая загрузка для той же сущности — запускает очистку старого
    // файла. Ключевая проверка регрессии: ссылка на новый файл должна
    // остаться рабочей после того, как очистка отработает.
    final url2 = await service.uploadMenuImage(
      file: file2,
      folder: 'items',
      entityId: 'item_42',
    );
    expect(url2, isNotEmpty);
    expect(url2, isNot(equals(url1)));

    // Старый файл должен быть вычищен, новый — обязан существовать и
    // отдавать ссылку без исключений.
    final refToNewFile = mockStorage.ref().child('menu_images/items').listAll();
    final listing = await refToNewFile;
    expect(listing.items, hasLength(1));
  });
}
