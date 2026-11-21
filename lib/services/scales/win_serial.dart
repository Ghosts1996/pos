// Чтение COM-порта на Windows (kernel32: CreateFileW, SetCommState,
// SetCommTimeouts, ReadFile) — для весов, подключённых кабелем RS-232 или
// через переходник USB-COM. Вызовы идут в отдельном изоляте: окно кассы не
// замирает, пока ждём ответа весов.
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

typedef _CreateC = IntPtr Function(Pointer<Utf16>, Uint32, Uint32, Pointer<Void>, Uint32, Uint32, IntPtr);
typedef _CreateD = int Function(Pointer<Utf16>, int, int, Pointer<Void>, int, int, int);
typedef _StateC = Int32 Function(IntPtr, Pointer<Uint8>);
typedef _StateD = int Function(int, Pointer<Uint8>);
typedef _TimeoutsC = Int32 Function(IntPtr, Pointer<Uint32>);
typedef _TimeoutsD = int Function(int, Pointer<Uint32>);
typedef _RwC = Int32 Function(IntPtr, Pointer<Uint8>, Uint32, Pointer<Uint32>, Pointer<Void>);
typedef _RwD = int Function(int, Pointer<Uint8>, int, Pointer<Uint32>, Pointer<Void>);
typedef _PurgeC = Int32 Function(IntPtr, Uint32);
typedef _PurgeD = int Function(int, int);
typedef _CloseC = Int32 Function(IntPtr);
typedef _CloseD = int Function(int);

const _genericRead = 0x80000000;
const _genericWrite = 0x40000000;
const _openExisting = 3;
const _purgeRx = 0x0008;

/// Ответ: байты или текст ошибки (изолят не бросает наружу FFI-исключения).
Object _readSync(String port, int baud, List<int> request, int ms) {
  final DynamicLibrary k;
  try {
    k = DynamicLibrary.open('kernel32.dll');
  } catch (_) {
    return 'kernel32 недоступен';
  }
  final create = k.lookupFunction<_CreateC, _CreateD>('CreateFileW');
  final getState = k.lookupFunction<_StateC, _StateD>('GetCommState');
  final setState = k.lookupFunction<_StateC, _StateD>('SetCommState');
  final setTimeouts = k.lookupFunction<_TimeoutsC, _TimeoutsD>('SetCommTimeouts');
  final read = k.lookupFunction<_RwC, _RwD>('ReadFile');
  final write = k.lookupFunction<_RwC, _RwD>('WriteFile');
  final purge = k.lookupFunction<_PurgeC, _PurgeD>('PurgeComm');
  final close = k.lookupFunction<_CloseC, _CloseD>('CloseHandle');

  final name = '\\\\.\\${port.trim().toUpperCase()}'.toNativeUtf16();
  final dcb = calloc<Uint8>(28);
  final timeouts = calloc<Uint32>(5);
  final buf = calloc<Uint8>(256);
  final got = calloc<Uint32>();
  try {
    final h = create(name, _genericRead | _genericWrite, 0, nullptr, _openExisting, 0, 0);
    if (h == -1 || h == 0) return 'порт $port не открылся — занят другой программой или его нет';
    try {
      // DCB: длина 28 байт; скорость — смещение 4; флаги — 8; размер байта — 18,
      // чётность — 19, стоп-биты — 20. 8N1, двоичный режим, DTR и RTS включены
      // (часть весов питает от них интерфейс).
      final d = dcb.asTypedList(28);
      d.buffer.asByteData(d.offsetInBytes).setUint32(0, 28, Endian.little);
      if (getState(h, dcb) == 0) return 'порт $port не настраивается';
      final bd = d.buffer.asByteData(d.offsetInBytes);
      bd.setUint32(4, baud, Endian.little);
      var flags = bd.getUint32(8, Endian.little);
      flags |= 0x1; // fBinary
      flags &= ~0x2; // без контроля чётности
      flags = (flags & ~0x30) | 0x10; // DTR_CONTROL_ENABLE
      flags = (flags & ~0x3000) | 0x1000; // RTS_CONTROL_ENABLE
      flags &= ~(0x4 | 0x8 | 0x100 | 0x200); // без CTS/DSR и XON/XOFF
      bd.setUint32(8, flags, Endian.little);
      d[18] = 8;
      d[19] = 0;
      d[20] = 0;
      if (setState(h, dcb) == 0) return 'порт $port не принял скорость $baud';
      final t = timeouts.asTypedList(5);
      t[0] = 60; // пауза между байтами
      t[1] = 0;
      t[2] = ms; // общий срок чтения
      t[3] = 0;
      t[4] = 500;
      setTimeouts(h, timeouts);
      purge(h, _purgeRx);
      if (request.isNotEmpty) {
        final out = calloc<Uint8>(request.length);
        try {
          out.asTypedList(request.length).setAll(0, request);
          write(h, out, request.length, got, nullptr);
        } finally {
          calloc.free(out);
        }
      }
      final all = <int>[];
      final until = DateTime.now().add(Duration(milliseconds: ms));
      while (DateTime.now().isBefore(until) && all.length < 1024) {
        got.value = 0;
        if (read(h, buf, 256, got, nullptr) == 0) break;
        if (got.value == 0) {
          if (all.isNotEmpty) break;
          continue;
        }
        all.addAll(buf.asTypedList(got.value));
        // Две полные строки — хватит, чтобы взять последнюю целой.
        if ('\n'.allMatches(String.fromCharCodes(all)).length >= 2) break;
      }
      return all;
    } finally {
      close(h);
    }
  } finally {
    calloc.free(name);
    calloc.free(dcb);
    calloc.free(timeouts);
    calloc.free(buf);
    calloc.free(got);
  }
}

/// Прочитать то, что весы прислали за [ms] мс (после [request], если задан).
Future<List<int>> readComPort(String port, int baud, {List<int> request = const [], int ms = 700}) async {
  if (!Platform.isWindows) throw StateError('COM-порт — только на Windows');
  final r = await Isolate.run(() => _readSync(port, baud, request, ms));
  if (r is String) throw StateError(r);
  final bytes = r as List<int>;
  if (bytes.isEmpty) throw StateError('Весы молчат — проверьте кабель, порт и скорость');
  return bytes;
}
