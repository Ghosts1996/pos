import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'firebase_options.dart';
import 'services/auth_service.dart';
import 'services/printer_service.dart';
import 'services/kassa_service.dart';
import 'services/egais_service.dart';
import 'services/chestny_znak_api_service.dart';
import 'services/push_service.dart';
import 'services/venue_service.dart';
import 'services/auto_stoplist_service.dart';
import 'services/notification_service.dart';
import 'services/session_alerts_service.dart';
import 'services/ai/ai_settings.dart';
import 'services/ai/ai_scheduler.dart';
import 'services/background_jobs_service.dart';
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

      // Офлайн-режим кассы: при обрыве интернета зал продолжает работать
      // на локальном кэше, изменения уезжают в облако при восстановлении
      // связи. Ставится до первого обращения к Firestore.
      FirebaseFirestore.instance.settings = const Settings(
        persistenceEnabled: true,
        cacheSizeBytes: Settings.CACHE_SIZE_UNLIMITED,
      );

      // Вход в Firebase Auth и инициализация Supabase не зависят друг от
      // друга — запускаем параллельно, чтобы старт приложения ждал только
      // большее из двух, а не их сумму.
      await Future.wait([
        AuthService().ensureSignedIn(),
        Supabase.initialize(url: _supabaseUrl, anonKey: _supabaseAnonKey),
      ]);
      ready = true;

      // Не блокирует старт приложения — принтер/касса/ИИ подтянутся чуть
      // позже, если настроены, а не настроены — ничего не сломается.
      unawaited(loadSavedPrinterSettings());
      unawaited(loadSavedKassaSettings());
      unawaited(loadSavedEgaisSettings());
      unawaited(loadSavedChestnyZnakSettings());
      unawaited(AiSettingsStore.instance.init());
      unawaited(PushService.instance.initStaff());

      // Локальные уведомления зала: новые брони, вызовы гостей, угли через
      // 35 минут и предупреждение за 10 минут до конца сеанса. Работают без
      // сервера и без платного тарифа Firebase.
      unawaited(NotificationService.instance.init().then(
        (_) => SessionAlertsService.instance.start(),
      ));
      VenueService.instance.watch();

      // Автостоп-лист следит за остатками и сам убирает из меню то, чего
      // нет в зале, — иначе гость закажет это в «Colibri Lounge».
      AutoStopListService.instance.start();

      // Фоновые ИИ-задания. Замок внутри планировщика гарантирует, что
      // работу выполнит только одно устройство в зале.
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid != null) AiScheduler.instance.start(deviceId: uid);

      // То, что раньше делали Cloud Functions: снять брони, к которым
      // гость не пришёл, и поздравить именинников. Функции доступны только
      // на платном тарифе Blaze, поэтому на бесплатном эту работу ведёт
      // сам POS — тоже под замком «дежурного устройства».
      if (uid != null) BackgroundJobsService.instance.start(deviceId: uid);
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
      title: 'Kolibri POS',
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
