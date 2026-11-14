// ignore_for_file: invalid_use_of_visible_for_testing_member — это тест (папка вне test/, её запускают отдельно)
// SaaS-сборка без Firebase (Google, США): вход и данные — только свой сервер
// в РФ, Firebase не запускается (трансграничной передачи нет).
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/firebase_options.dart';
import 'package:hookah_pos/services/app_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/harness_lock.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  requireSaasHarness(harness: false);

  test('Firebase не запускается, вход свой с первой строки — без Firebase.initializeApp ничего не падает', () async {
    SharedPreferences.setMockInitialValues({});
    expect(DefaultFirebaseOptions.useFirebase, isFalse);
    expect(DefaultFirebaseOptions.isConfigured, isTrue, reason: 'касса стартует без ключей Firebase');
    // Движок данных подписывается на uidChanges ещё до init — без Firebase это не должно бросать.
    final sub = AppAuth.instance.uidChanges.listen((_) {});
    expect(AppAuth.instance.isOwn, isTrue);
    await AppAuth.instance.init();
    expect(AppAuth.instance.isOwn, isTrue);
    expect(AppAuth.instance.currentUser, isNull);
    await sub.cancel();
  });
}
