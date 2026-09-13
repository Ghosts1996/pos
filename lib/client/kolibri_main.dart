import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:firebase_core/firebase_core.dart';
import '../firebase_options.dart';
import '../services/ai/ai_settings.dart';
import '../services/venue_service.dart';
import 'screens/kolibri_shell.dart';
import 'services/kolibri_auth_service.dart';
import 'theme/kolibri_theme.dart';

/// Точка входа клиентского приложения «Колибри Лаундж».
///
/// Это второе приложение того же проекта: общий Firebase, общие модели и
/// сервисы, отдельный main. Сборка:
///   flutter build apk --release -t lib/client/kolibri_main.dart
///
/// За счёт общего Firestore всё работает в связке с POS в реальном времени:
/// меню и стоп-лист, брони, живой счёт за столом, вызовы кальянщика.
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  String? startupError;
  var ready = false;

  if (DefaultFirebaseOptions.isConfigured) {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
      await KolibriAuthService().ensureGuest();
      ready = true;
      // Настройки ИИ подтягиваются в фоне — без них приложение просто
      // работает без ИИ-консьержа.
      unawaited(AiSettingsStore.instance.init());
      // Профиль заведения нужен не только для часов работы: из него
      // берётся флаг cloudFunctionsEnabled, по которому приложение решает,
      // показывать локальные уведомления самому или ждать push с сервера.
      VenueService.instance.watch();
    } catch (e) {
      startupError = e.toString();
    }
  }

  runApp(KolibriApp(ready: ready, startupError: startupError));
}

class KolibriApp extends StatelessWidget {
  final bool ready;
  final String? startupError;

  const KolibriApp({super.key, required this.ready, this.startupError});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Колибри Лаундж',
      debugShowCheckedModeBanner: false,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('ru', 'RU')],
      locale: const Locale('ru', 'RU'),
      theme: KolibriTheme.dark,
      darkTheme: KolibriTheme.dark,
      themeMode: ThemeMode.dark,
      home: ready ? const KolibriShell() : _StartupError(details: startupError),
    );
  }
}

class _StartupError extends StatelessWidget {
  final String? details;
  const _StartupError({this.details});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.wifi_off, size: 48, color: KolibriColors.textMuted),
              const SizedBox(height: 16),
              const Text(
                'Не удалось подключиться',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              const Text(
                'Проверьте интернет и перезапустите приложение.',
                textAlign: TextAlign.center,
                style: TextStyle(color: KolibriColors.textMuted),
              ),
              if (details != null) ...[
                const SizedBox(height: 16),
                Text(details!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: KolibriColors.textMuted, fontSize: 11)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
