import 'dart:convert';
import 'dart:typed_data';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';

import 'raster_font.dart';

/// Печать картинкой: касса сама рисует буквы встроенным шрифтом и шлёт
/// принтеру растровое изображение (GS v 0). Кодовые таблицы принтера не
/// участвуют вовсе, поэтому русский текст печатается одинаково на любом
/// чековом принтере ESC/POS — Epson, Xprinter, POS-58, Rongta, Gprinter,
/// безымянных китайских: у них разные номера таблиц, а картинку все
/// понимают одинаково.
///
/// Генератор подменяет только text/row/hr; отрезка, подача бумаги, ящик и
/// остальные команды — как у обычного [Generator].
class RasterGenerator extends Generator {
  RasterGenerator(PaperSize paper, CapabilityProfile profile)
      : dots = paper.width,
        super(paper, profile);

  /// Ширина печати в точках: 384 (58 мм) или 576 (80 мм).
  final int dots;

  static final Uint8List _font = base64.decode(kRasterFontB64);
  static final Map<int, int> _index = {
    for (var i = 0; i < kRasterChars.runes.length; i++) kRasterChars.runes.elementAt(i): i,
  };

  /// Знаков в строке обычным шрифтом: 32 на 58 мм, 48 на 80 мм.
  int get charsPerLine => dots ~/ kRasterGlyphW;

  static const _replace = {' ': ' ', '\t': ' '};

  /// Номер буквы в шрифте; нет такой — «?».
  static int _glyph(int rune) => _index[rune] ?? _index[0x3F]!;

  static String _clean(String s) {
    var t = s;
    _replace.forEach((a, b) => t = t.replaceAll(a, b));
    return t;
  }

  /// Перенос по словам: строки не длиннее [width] знаков.
  static List<String> wrap(String text, int width) {
    final out = <String>[];
    for (final para in _clean(text).split('\n')) {
      final words = para.split(' ');
      var line = '';
      for (var w in words) {
        while (w.runes.length > width) {
          // Слово длиннее строки — режем.
          if (line.isNotEmpty) {
            out.add(line);
            line = '';
          }
          out.add(String.fromCharCodes(w.runes.take(width)));
          w = String.fromCharCodes(w.runes.skip(width));
        }
        if (line.isEmpty) {
          line = w;
        } else if (line.runes.length + 1 + w.runes.length <= width) {
          line = '$line $w';
        } else {
          out.add(line);
          line = w;
        }
      }
      out.add(line);
    }
    return out;
  }

  int _scale(PosStyles s) => s.height.value >= 2 || s.width.value >= 2 ? 2 : 1;

  /// Нарисовать строку в полосу [canvas] шириной [dots] с левого края [x].
  void _draw(Uint8List canvas, int bandH, String text, int x, int scale) {
    final rowBytes = dots ~/ 8;
    var cx = x;
    for (final r in text.runes) {
      final g = _glyph(r) * kRasterGlyphH * 2;
      for (var gy = 0; gy < kRasterGlyphH; gy++) {
        final bits = (_font[g + gy * 2] << 8) | _font[g + gy * 2 + 1];
        if (bits == 0) continue;
        for (var gx = 0; gx < kRasterGlyphW; gx++) {
          if ((bits >> (11 - gx)) & 1 == 0) continue;
          for (var sy = 0; sy < scale; sy++) {
            final y = gy * scale + sy;
            if (y >= bandH) continue;
            for (var sx = 0; sx < scale; sx++) {
              final px = cx + gx * scale + sx;
              if (px < 0 || px >= dots) continue;
              canvas[y * rowBytes + (px >> 3)] |= 0x80 >> (px & 7);
            }
          }
        }
      }
      cx += kRasterGlyphW * scale;
    }
  }

  /// Полоса точек → команда GS v 0 (растр, обычная плотность).
  List<int> _raster(Uint8List canvas, int height) {
    final w = dots ~/ 8;
    return [0x1D, 0x76, 0x30, 0x00, w & 0xFF, w >> 8, height & 0xFF, height >> 8, ...canvas];
  }

  int _x(String line, int left, int width, PosAlign align, int scale) {
    final used = line.runes.length * kRasterGlyphW * scale;
    return switch (align) {
      PosAlign.center => left + (width - used) ~/ 2,
      PosAlign.right => left + width - used,
      _ => left,
    };
  }

  @override
  List<int> text(
    String text, {
    PosStyles styles = const PosStyles(),
    int linesAfter = 0,
    bool containsChinese = false,
    int? maxCharsPerLine,
  }) {
    final scale = _scale(styles);
    final lines = wrap(text, charsPerLine ~/ scale);
    final out = <int>[];
    for (final line in lines) {
      final h = kRasterGlyphH * scale;
      final canvas = Uint8List(dots ~/ 8 * h);
      _draw(canvas, h, line, _x(line, 0, dots, styles.align, scale), scale);
      out.addAll(_raster(canvas, h));
    }
    if (linesAfter > 0) out.addAll(feed(linesAfter));
    return out;
  }

  @override
  List<int> row(List<PosColumn> cols, {bool multiLine = true}) {
    final total = cols.fold<int>(0, (a, c) => a + c.width);
    final scale = cols.map((c) => _scale(c.styles)).fold<int>(1, (a, b) => a > b ? a : b);
    // Колонки — доли ширины (из 12), каждая со своим переносом.
    final parts = <({int left, int width, List<String> lines, PosAlign align})>[];
    var left = 0;
    for (final c in cols) {
      final width = dots * c.width ~/ (total == 0 ? 12 : total);
      final chars = width ~/ (kRasterGlyphW * scale);
      final lines = wrap(c.text, chars < 1 ? 1 : chars);
      parts.add((left: left, width: width, lines: lines, align: c.styles.align));
      left += width;
    }
    final n = parts.fold<int>(1, (a, p) => a > p.lines.length ? a : p.lines.length);
    final out = <int>[];
    for (var i = 0; i < n; i++) {
      final h = kRasterGlyphH * scale;
      final canvas = Uint8List(dots ~/ 8 * h);
      for (final p in parts) {
        if (i >= p.lines.length) continue;
        final line = p.lines[i];
        _draw(canvas, h, line, _x(line, p.left, p.width, p.align, scale), scale);
      }
      out.addAll(_raster(canvas, h));
    }
    return out;
  }

  /// Разделитель — тонкая сплошная линия.
  @override
  List<int> hr({String ch = '-', int? len, int linesAfter = 0}) {
    const h = 12;
    final canvas = Uint8List(dots ~/ 8 * h);
    final rowBytes = dots ~/ 8;
    for (var y = 5; y <= 6; y++) {
      for (var i = 0; i < rowBytes; i++) {
        canvas[y * rowBytes + i] = 0xFF;
      }
    }
    return [..._raster(canvas, h), if (linesAfter > 0) ...feed(linesAfter)];
  }
}
