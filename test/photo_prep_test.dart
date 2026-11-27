import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/hookah/photo_prep.dart';
import 'package:image/image.dart' as img;

// Фото полки табака перед ИИ: тёмный снимок касса осветляет, большой —
// уменьшает до 1700 px и укладывает в лимит сервера; обычный не трогает.
Uint8List _jpg(int w, int h, int base, {bool noise = false}) {
  final rnd = Random(7);
  final im = img.Image(width: w, height: h);
  for (final p in im) {
    final v = noise ? rnd.nextInt(256) : base;
    p
      ..r = v
      ..g = v
      ..b = noise ? rnd.nextInt(256) : base + 4;
  }
  // «Надпись» на банке — светлый прямоугольник.
  img.fillRect(im, x1: w ~/ 4, y1: h ~/ 3, x2: w ~/ 2, y2: h ~/ 2, color: img.ColorRgb8(base * 4, base * 4, base * 4));
  return Uint8List.fromList(img.encodeJpg(im, quality: 92));
}

void main() {
  test('тёмный снимок осветляется и уменьшается до 1700 px', () async {
    final p = (await preparePhoto(_jpg(2400, 1080, 12)))!;
    expect(p.brightened, isTrue);
    final out = img.decodeImage(base64Decode(p.base64))!;
    expect(out.width, 1700);
    expect(meanLuminance(out), greaterThan(0.2));
    expect(p.base64.length, lessThanOrEqualTo(950000));
  });

  test('обычный снимок не осветляется', () async {
    final p = (await preparePhoto(_jpg(1200, 900, 120)))!;
    expect(p.brightened, isFalse);
    expect(img.decodeImage(base64Decode(p.base64))!.width, 1200);
  });

  test('очень «пёстрый» снимок всё равно влезает в лимит сервера', () async {
    final p = (await preparePhoto(_jpg(2400, 2400, 0, noise: true)))!;
    expect(p.base64.length, lessThanOrEqualTo(950000));
  });

  test('не картинка — null, касса шлёт как есть', () async {
    expect(await preparePhoto(Uint8List.fromList(utf8.encode('не фото'))), isNull);
  });
}
