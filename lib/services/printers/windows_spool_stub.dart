/// Заглушка для сборок без dart:ffi (веб): принтеров Windows нет.
Future<String?> rawPrint(String printer, List<int> bytes) async => 'печать на принтер Windows здесь недоступна';

Future<List<String>> listPrinters() async => const <String>[];
