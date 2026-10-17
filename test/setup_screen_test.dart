import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/screens/setup_required_screen.dart';

void main() {
  test('инструкция по Firebase — только когда дело в Firebase', () {
    expect(SetupRequiredScreen.needsFirebaseSetup(null, configured: false), isTrue);
    expect(SetupRequiredScreen.needsFirebaseSetup('[core/no-app] No Firebase App has been created'), isTrue);
    expect(
        SetupRequiredScreen.needsFirebaseSetup('PlatformException(java.lang.NoSuchMethodError: no non-static method '
            '"Lio/flutter/plugins/sharedpreferences/SharedPreferencesApiRegistrar;.getAll'),
        isFalse);
  });
}
