import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'screens/login_screen.dart';
import 'screens/setup_required_screen.dart';
import 'theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  String? startupError;
  var ready = false;

  // Если firebase_options.dart ещё не заполнен реальными ключами
  // (flutterfire configure не запускался), не пытаемся инициализировать
  // Firebase — сразу покажем понятный экран с инструкцией, а не упадём.
  if (DefaultFirebaseOptions.isConfigured) {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
      await AuthService().ensureSignedIn();
      ready = true;
    } catch (e) {
      startupError = e.toString();
    }
  }

  runApp(HookahPosApp(ready: ready, startupError: startupError));
}

class HookahPosApp extends StatelessWidget {
  final bool ready;
  final String? startupError;
  const HookahPosApp({super.key, required this.ready, this.startupError});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hookah Lounge POS',
      debugShowCheckedModeBanner: false,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('ru', 'RU'), Locale('en', 'US')],
      locale: const Locale('ru', 'RU'),
      // POS-система работает на планшетах в зале с переменным освещением —
      // фиксируем тёмную "Midnight Blue" тему как единственную, без
      // системного light/dark переключения, чтобы кассир не терял привычную
      // контрастность в течение смены.
      theme: AppTheme.dark,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.dark,
      home: ready ? const LoginScreen() : SetupRequiredScreen(errorDetails: startupError),
    );
  }
}