import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

/// Снимок, готовый к отправке ИИ.
class PreparedPhoto {
  final String base64;
  final String mediaType;

  /// Фото было тёмным — касса его осветлила.
  final bool brightened;
  const PreparedPhoto(this.base64, this.mediaType, {this.brightened = false});
}

/// Фото полки табака перед отправкой ИИ (в отдельном изоляте, экран не
/// замирает): поворот по EXIF, длинная сторона до [maxSide] px, тёмный
/// снимок (полка в глубине бара, вечерний свет) — светлее кривой гаммы по
/// средней яркости, и JPEG с таким качеством, чтобы влезть в лимит сервера
/// ([maxBase64] знаков) без уменьшения картинки — мелкие надписи на банках
/// важнее качества фона. null — файл не картинка.
Future<PreparedPhoto?> preparePhoto(Uint8List bytes, {int maxSide = 1700, int maxBase64 = 950000}) =>
    compute(_prepare, _Job(bytes, maxSide, maxBase64));

class _Job {
  final Uint8List bytes;
  final int maxSide;
  final int maxBase64;
  const _Job(this.bytes, this.maxSide, this.maxBase64);
}

/// Средняя яркость 0…1 (по сетке точек — быстро и на большом снимке).
double meanLuminance(img.Image im) {
  final stepX = math.max(1, im.width ~/ 120);
  final stepY = math.max(1, im.height ~/ 120);
  var sum = 0.0;
  var n = 0;
  for (var y = 0; y < im.height; y += stepY) {
    for (var x = 0; x < im.width; x += stepX) {
      final p = im.getPixel(x, y);
      sum += (0.2126 * p.rNormalized + 0.7152 * p.gNormalized + 0.0722 * p.bNormalized);
      n++;
    }
  }
  return n == 0 ? 0 : sum / n;
}

PreparedPhoto? _prepare(_Job job) {
  var im = img.decodeImage(job.bytes);
  if (im == null) return null;
  im = img.bakeOrientation(im);
  final side = math.max(im.width, im.height);
  if (side > job.maxSide) {
    im = im.width >= im.height
        ? img.copyResize(im, width: job.maxSide, interpolation: img.Interpolation.average)
        : img.copyResize(im, height: job.maxSide, interpolation: img.Interpolation.average);
  }
  var brightened = false;
  final lum = meanLuminance(im);
  if (lum < 0.28) {
    // Гамма < 1 осветляет тени, не выжигая светлые надписи: средняя
    // яркость тянется к ~0,42.
    final g = (math.log(0.42) / math.log(math.max(lum, 0.02))).clamp(0.3, 1.0);
    im = img.gamma(im, gamma: g);
    im = img.adjustColor(im, contrast: 1.12);
    brightened = true;
  }
  for (final q in const [84, 76, 68, 60, 52, 44]) {
    final b = base64Encode(img.encodeJpg(im, quality: q));
    if (b.length <= job.maxBase64) return PreparedPhoto(b, 'image/jpeg', brightened: brightened);
  }
  // Очень «пёстрая» картинка — тогда уже меньше по размеру.
  var cur = im;
  // Несколько снимков одной банки делят лимит сервера — уменьшаем дальше.
  for (var i = 0; i < 8; i++) {
    cur = img.copyResize(cur, width: (cur.width * 0.8).round(), interpolation: img.Interpolation.average);
    final b = base64Encode(img.encodeJpg(cur, quality: 60));
    if (b.length <= job.maxBase64) return PreparedPhoto(b, 'image/jpeg', brightened: brightened);
  }
  return null;
}
