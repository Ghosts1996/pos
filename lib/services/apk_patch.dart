import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Обновление «как у Google Play»: вместо всего APK (~90 МБ) устройство
/// качает патч — разницу с версией, которая уже установлена, — и собирает
/// новый APK у себя. Формат патча и как его строит сервер —
/// saas-gateway/apk-delta.js. Результат сверяется по SHA-256 с тем, что
/// собрал GitHub: не сошлось — касса качает APK целиком, как раньше.
class ApkPatch {
  ApkPatch._();

  static final _magic = Uint8List.fromList('ZPATCH1\n'.codeUnits);

  /// Где лежит установленный APK этого приложения. Android открывает его
  /// приложению на чтение; путь виден в /proc/self/maps. Нужен файл ровно
  /// того размера, что прислал сервер (рядом могут быть APK WebView и др.).
  static Future<String?> installedApk(int size) async {
    try {
      final lines = await File('/proc/self/maps').readAsLines();
      final seen = <String>{};
      for (final line in lines) {
        final m = RegExp(r'\s(/\S+/base\.apk)$').firstMatch(line);
        if (m == null || !seen.add(m.group(1)!)) continue;
        final f = File(m.group(1)!);
        try {
          if (await f.length() == size) return f.path;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  /// Собрать новый APK в фоне (отдельный изолят — экран не подвисает).
  static Future<void> apply({required String oldPath, required String patchPath, required String outPath}) =>
      Isolate.run(() => applySync(oldPath: oldPath, patchPath: patchPath, outPath: outPath));

  /// SHA-256 файла (hex) — чтобы убедиться, что установлена та самая версия.
  static String fileSha256(String path) {
    final out = _DigestSink();
    final input = sha256.startChunkedConversion(out);
    final f = File(path).openSync();
    try {
      final buf = Uint8List(1 << 20);
      for (;;) {
        final n = f.readIntoSync(buf);
        if (n <= 0) break;
        input.add(Uint8List.sublistView(buf, 0, n));
      }
    } finally {
      f.closeSync();
    }
    input.close();
    return out.value.toString();
  }

  static void applySync({required String oldPath, required String patchPath, required String outPath}) {
    final raw = Uint8List.fromList(gzip.decode(File(patchPath).readAsBytesSync()));
    final r = _Reader(raw);
    final magic = r.take(_magic.length);
    for (var i = 0; i < _magic.length; i++) {
      if (magic[i] != _magic[i]) throw const ApkPatchException('это не патч обновления');
    }
    final newSize = r.u64();
    final newSha = r.take(32);
    final oldSize = r.u64();
    final oldSha = r.take(32);
    final old = File(oldPath).openSync();
    final out = File(outPath).openSync(mode: FileMode.write);
    final digest = _DigestSink();
    final hash = sha256.startChunkedConversion(digest);
    var written = 0;
    void emit(Uint8List b) {
      out.writeFromSync(b);
      hash.add(b);
      written += b.length;
    }

    Uint8List readOld(int off, int len) {
      old.setPositionSync(off);
      final b = old.readSync(len);
      if (b.length != len) throw const ApkPatchException('установленная версия короче, чем ждёт патч');
      return b;
    }

    try {
      if (old.lengthSync() != oldSize) throw const ApkPatchException('патч не к этой версии');
      final want = oldSha.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
      if (fileSha256(oldPath) != want) throw const ApkPatchException('патч не к этой версии');
      for (;;) {
        final op = r.u8();
        if (op == 0) break;
        if (op == 1) {
          var off = r.u64();
          var len = r.u64();
          while (len > 0) {
            final n = len > (1 << 20) ? (1 << 20) : len;
            emit(readOld(off, n));
            off += n;
            len -= n;
          }
        } else if (op == 2) {
          emit(r.take(r.u64()));
        } else if (op == 3) {
          final off = r.u64();
          final oldLen = r.u64();
          final newLen = r.u64();
          final n = r.u32();
          final ctrl = <List<int>>[for (var i = 0; i < n; i++) [r.i64(), r.i64(), r.i64()]];
          final diff = r.take(r.u64());
          final extra = r.take(r.u64());
          emit(bspatch(readOld(off, oldLen), newLen, ctrl, diff, extra));
        } else {
          throw const ApkPatchException('неизвестная операция патча');
        }
      }
    } finally {
      old.closeSync();
      out.closeSync();
    }
    hash.close();
    if (written != newSize || !_same(Uint8List.fromList(digest.value.bytes), newSha)) {
      throw const ApkPatchException('собранный файл не совпал с новой версией');
    }
  }

  /// bspatch (К. Персиваль): x байт «старое + разница», y байт как есть,
  /// сдвиг по старому на z.
  static Uint8List bspatch(Uint8List old, int newSize, List<List<int>> ctrl, Uint8List diff, Uint8List extra) {
    final out = Uint8List(newSize);
    var oldPos = 0, newPos = 0, di = 0, ei = 0;
    for (final c in ctrl) {
      final x = c[0], y = c[1], z = c[2];
      if (x < 0 || y < 0 || newPos + x > newSize || di + x > diff.length) {
        throw const ApkPatchException('патч повреждён');
      }
      for (var i = 0; i < x; i++) {
        final o = oldPos + i;
        out[newPos + i] = (diff[di + i] + (o >= 0 && o < old.length ? old[o] : 0)) & 0xff;
      }
      di += x;
      newPos += x;
      oldPos += x;
      if (newPos + y > newSize || ei + y > extra.length) throw const ApkPatchException('патч повреждён');
      out.setRange(newPos, newPos + y, extra, ei);
      ei += y;
      newPos += y;
      oldPos += z;
    }
    if (newPos != newSize) throw const ApkPatchException('патч повреждён');
    return out;
  }

  static bool _same(Uint8List a, Uint8List b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

class ApkPatchException implements Exception {
  final String message;
  const ApkPatchException(this.message);
  @override
  String toString() => message;
}

class _DigestSink implements Sink<Digest> {
  Digest? _value;
  Digest get value => _value!;
  @override
  void add(Digest data) => _value = data;
  @override
  void close() {}
}

class _Reader {
  final Uint8List b;
  final ByteData d;
  int p = 0;
  _Reader(this.b) : d = ByteData.sublistView(b);

  void _need(int n) {
    if (p + n > b.length) throw const ApkPatchException('патч оборван');
  }

  int u8() {
    _need(1);
    return b[p++];
  }

  int u32() {
    _need(4);
    final v = d.getUint32(p, Endian.little);
    p += 4;
    return v;
  }

  int u64() {
    _need(8);
    final v = d.getUint64(p, Endian.little);
    p += 8;
    if (v < 0) throw const ApkPatchException('патч повреждён');
    return v;
  }

  int i64() {
    _need(8);
    final v = d.getInt64(p, Endian.little);
    p += 8;
    return v;
  }

  Uint8List take(int n) {
    if (n < 0) throw const ApkPatchException('патч повреждён');
    _need(n);
    final v = Uint8List.sublistView(b, p, p + n);
    p += n;
    return v;
  }
}
