import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'services/printer_service.dart';
import 'services/kassa_service.dart';
import 'screens/image_preload_screen.dart';
import 'screens/setup_required_screen.dart';
import 'theme/app_theme.dart';

// Данные проекта Supabase (Project Settings → API в Supabase Dashboard).
// Используется ТОЛЬКО для хранения фото меню (Storage) — anon key публичный
// по своей природе (как web API key у Firebase), доступ к бакету
// регулируется policy в Supabase, а не секретностью этого ключа.
const _supabaseUrl = 'https://acmdrgwemtbbroedilnk.supabase.co';
const _supabaseAnonKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjbWRyZ3dlbXRiYnJvZWRpbG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNTIyODEsImV4cCI6MjEwMjkyODI4MX0.fHrTveYc2bj_WPy4OCOkwzipVFoEL7mQxmbAKYGEy3o';

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
      // Вход в Firebase Auth и инициализация Supabase не зависят друг от
      // друга — раньше шли строго последовательно (два похода в сеть один
      // за другим), хотя оба нужны только к моменту первого обращения к
      // базе/хранилищу. Запускаем параллельно, чтобы старт приложения не
      // ждал их суммарное время, а только большее из двух.
      await Future.wait([
        AuthService().ensureSignedIn(),
        Supabase.initialize(url: _supabaseUrl, anonKey: _supabaseAnonKey),
      ]);
      ready = true;
      // Не блокирует старт приложения — принтер/касса подтянутся чуть
      // позже, если настроены, а не настроены — ничего не сломается.
      unawaited(loadSavedPrinterSettings());
      unawaited(loadSavedKassaSettings());
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
      // Перед экраном входа — прогрев дискового кэша фото меню (см.
      // ImagePreloadScreen), чтобы дальше открытие меню не грузило фото по
      // сети и не подвисало на слабых POS-планшетах.
      home: ready ? const ImagePreloadScreen() : SetupRequiredScreen(errorDetails: startupError),
    );
  }
}