// Сырая печать в очередь Windows (winspool.drv): OpenPrinterW →
// StartDocPrinterW (тип данных RAW) → WritePrinter → EndDocPrinter. Так
// ESC/POS-команды доходят до чекового принтера без преобразования
// драйвером. Вызовы идут в отдельном изоляте — окно кассы не замирает,
// пока очередь печати думает.
import 'dart:ffi';
import 'dart:isolate';

import 'package:ffi/ffi.dart';

final class _DocInfo1 extends Struct {
  external Pointer<Utf16> pDocName;
  external Pointer<Utf16> pOutputFile;
  external Pointer<Utf16> pDatatype;
}

final class _PrinterInfo4 extends Struct {
  external Pointer<Utf16> pPrinterName;
  external Pointer<Utf16> pServerName;
  @Uint32()
  external int attributes;
}

typedef _OpenC = Int32 Function(Pointer<Utf16>, Pointer<IntPtr>, Pointer<Void>);
typedef _OpenD = int Function(Pointer<Utf16>, Pointer<IntPtr>, Pointer<Void>);
typedef _StartDocC = Uint32 Function(IntPtr, Uint32, Pointer<_DocInfo1>);
typedef _StartDocD = int Function(int, int, Pointer<_DocInfo1>);
typedef _HandleC = Int32 Function(IntPtr);
typedef _HandleD = int Function(int);
typedef _WriteC = Int32 Function(IntPtr, Pointer<Uint8>, Uint32, Pointer<Uint32>);
typedef _WriteD = int Function(int, Pointer<Uint8>, int, Pointer<Uint32>);
typedef _EnumC = Int32 Function(Uint32, Pointer<Utf16>, Uint32, Pointer<Uint8>, Uint32, Pointer<Uint32>, Pointer<Uint32>);
typedef _EnumD = int Function(int, Pointer<Utf16>, int, Pointer<Uint8>, int, Pointer<Uint32>, Pointer<Uint32>);

const _printerEnumLocal = 0x2;
const _printerEnumConnections = 0x4;

String? _rawPrintSync(String printer, List<int> bytes) {
  final DynamicLibrary lib;
  try {
    lib = DynamicLibrary.open('winspool.drv');
  } catch (_) {
    return 'служба печати Windows недоступна';
  }
  final open = lib.lookupFunction<_OpenC, _OpenD>('OpenPrinterW');
  final startDoc = lib.lookupFunction<_StartDocC, _StartDocD>('StartDocPrinterW');
  final startPage = lib.lookupFunction<_HandleC, _HandleD>('StartPagePrinter');
  final write = lib.lookupFunction<_WriteC, _WriteD>('WritePrinter');
  final endPage = lib.lookupFunction<_HandleC, _HandleD>('EndPagePrinter');
  final endDoc = lib.lookupFunction<_HandleC, _HandleD>('EndDocPrinter');
  final close = lib.lookupFunction<_HandleC, _HandleD>('ClosePrinter');

  final name = printer.toNativeUtf16();
  final docName = 'ZalPOS'.toNativeUtf16();
  final dataType = 'RAW'.toNativeUtf16();
  final handle = calloc<IntPtr>();
  final info = calloc<_DocInfo1>();
  final buf = calloc<Uint8>(bytes.isEmpty ? 1 : bytes.length);
  final written = calloc<Uint32>();
  try {
    if (open(name, handle, nullptr) == 0) return 'не найден в Windows — проверьте имя и что он включён';
    final h = handle.value;
    try {
      info.ref
        ..pDocName = docName
        ..pOutputFile = nullptr
        ..pDatatype = dataType;
      if (startDoc(h, 1, info) == 0) return 'очередь печати не приняла задание';
      try {
        startPage(h);
        buf.asTypedList(bytes.length).setAll(0, bytes);
        final ok = write(h, buf, bytes.length, written);
        endPage(h);
        if (ok == 0 || written.value != bytes.length) return 'принтер принял не все данные';
      } finally {
        endDoc(h);
      }
      return null;
    } finally {
      close(h);
    }
  } finally {
    calloc.free(name);
    calloc.free(docName);
    calloc.free(dataType);
    calloc.free(handle);
    calloc.free(info);
    calloc.free(buf);
    calloc.free(written);
  }
}

List<String> _listSync() {
  final DynamicLibrary lib;
  try {
    lib = DynamicLibrary.open('winspool.drv');
  } catch (_) {
    return const [];
  }
  final enumPrinters = lib.lookupFunction<_EnumC, _EnumD>('EnumPrintersW');
  const flags = _printerEnumLocal | _printerEnumConnections;
  final needed = calloc<Uint32>();
  final count = calloc<Uint32>();
  try {
    enumPrinters(flags, nullptr, 4, nullptr, 0, needed, count);
    if (needed.value == 0) return const [];
    final buf = calloc<Uint8>(needed.value);
    try {
      if (enumPrinters(flags, nullptr, 4, buf, needed.value, needed, count) == 0) return const [];
      final items = buf.cast<_PrinterInfo4>();
      return [
        for (var i = 0; i < count.value; i++)
          if (items[i].pPrinterName != nullptr) items[i].pPrinterName.toDartString(),
      ];
    } finally {
      calloc.free(buf);
    }
  } finally {
    calloc.free(needed);
    calloc.free(count);
  }
}

Future<String?> rawPrint(String printer, List<int> bytes) {
  final data = List<int>.of(bytes);
  return Isolate.run(() => _rawPrintSync(printer, data));
}

Future<List<String>> listPrinters() => Isolate.run(_listSync);
