// SaaS-сборка без Firebase (Google, США): вход и данные — только свой сервер
// в РФ, Firebase не запускается (трансграничной передачи нет).
// Запуск: flutter test --dart-define=SAAS_MODE=true --dart-define=SAAS_GATEWAY_URL=http://127.0.0.1:9 test/saas_no_firebase_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/firebase_options.dart';
import 'package:hookah_pos/services/app_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final saas = kSaasMode && kSaasGatewayUrl.isNotEmpty;

  test('обычная сборка (hookah-pos) — Firebase как раньше', () {
    if (saas) return;
    expect(DefaultFirebaseOptions.useFirebase, isTrue);
  });

  test('SaaS: Firebase не запускается, вход свой с первой строки — без Firebase.initializeApp ничего не падает', () async {
    if (!saas) return;
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
