import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/firebase_options.dart';

// Firebase запускается только в сборке hookah-pos; в SaaS — никогда
// (подробная проверка SaaS-сборки — test_saas/saas_no_firebase_test.dart).
void main() {
  test('Firebase — только вне SaaS', () {
    expect(DefaultFirebaseOptions.useFirebase, !kSaasMode);
  });
}
