import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'build_info.dart';
import 'firebase_options.dart';
import 'models/tenant_models.dart';
import 'services/app_bootstrap.dart';
import 'services/app_scope.dart';
import 'services/auth_service.dart';
import 'services/subscription_gate.dart';
import 'services/tenant_config_service.dart';
import 'screens/image_preload_screen.dart';
import 'screens/saas/saas_device_pairing_screen.dart';
import 'screens/saas/saas_subscription_blocked_screen.dart';
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
  // true — SaaS-сборка (kSaasMode), вход прошёл, но это устройство ещё не
  // состоит ни в одном заведении: показываем экран присоединения по коду
  // приглашения вместо обычного запуска. В обычной (не-SaaS) сборке этот
  // флаг всегда false — экран регистрации устройства остаётся тем же, что
  // и был (StaffDeviceSetupScreen внутри LoginScreen), см. ниже.
  var needsPairing = false;
  BrandingConfig? branding;

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
        Supabase.initialize(url: _supabaseUrl, publishableKey: _supabaseAnonKey),
      ]);

      if (kSaasMode) {
        // SaaS-режим: вместо общего на всю платформу секрета заведения —
        // членство в конкретном tenant (см. lib/services/app_scope.dart,
        // saas/firestore.rules). Устройство уже входило раньше → у него
        // либо уже есть членство (обычный перезапуск), либо ещё нет
        // (первый запуск на этом планшете, до сбора надо присоединиться).
        final tenantConfigService = TenantConfigService();
        await tenantConfigService.loadFromCache();
        final uid = FirebaseAuth.instance.currentUser?.uid;
        TenantConfig? config;
        if (uid != null) {
          try {
            config = await tenantConfigService.refresh(uid);
          } catch (_) {
            // Сети нет — доверяем локальному кэшу (офлайн-грейс-период,
            // см. TenantConfigService.isStale), а не блокируем POS.
            config = tenantConfigService.current;
          }
        }
        if (config != null) {
          AppScope.enterTenant(config.tenant.id,
              branding: config.branding, slug: config.tenant.slug, chainId: config.tenant.chainId);
          // Живой сторож жёсткой блокировки — держит смену
          // tenants/subscriptions под наблюдением всё время работы
          // приложения, а не только на старте (см. subscription_gate.dart:
          // без этого просрочка, наступившая посреди смены, ничего бы не
          // меняла до следующего перезапуска планшета).
          SubscriptionGate.watch(config.tenant.id, config);
          branding = config.branding;
          ready = true;
          startBackgroundServices();
        } else {
          needsPairing = true;
        }
      } else {
        // Обычная (одно-арендная) сборка — поведение не изменилось ни на
        // йоту по сравнению с версией до появления SaaS-режима.
        ready = true;
        startBackgroundServices();
      }
    } catch (e) {
      startupError = e.toString();
    }
  }

  runApp(HookahPosApp(
    ready: ready,
    needsPairing: needsPairing,
    startupError: startupError,
    branding: branding,
  ));
}

class HookahPosApp extends StatelessWidget {
  final bool ready;
  final bool needsPairing;
  final String? startupError;
  final BrandingConfig? branding;

  const HookahPosApp({
    super.key,
    required this.ready,
    this.needsPairing = false,
    this.startupError,
    this.branding,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: branding?.appName ?? 'Hookah POS',
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
      // контрастность в течение смены. В SaaS-режиме поверх неё накладывается
      // фирменная палитра заведения (см. AppTheme.branded — фон, текст,
      // вторичный цвет и цвет кнопок, с проверкой контраста фон/текст).
      theme: branding != null ? AppTheme.branded(branding!) : AppTheme.dark,
      darkTheme: branding != null ? AppTheme.branded(branding!) : AppTheme.dark,
      themeMode: ThemeMode.dark,
      // Перед экраном входа — прогрев дискового кэша фото меню (см.
      // ImagePreloadScreen), чтобы дальше открытие меню не грузило фото по
      // сети и не подвисало на слабых POS-планшетах.
      home: needsPairing
          ? const SaasDevicePairingScreen()
          : ready
              ? const ImagePreloadScreen()
              : SetupRequiredScreen(errorDetails: startupError),
      // Жёсткая блокировка при просроченной подписке (SubscriptionGate,
      // одно-арендная сборка её никогда не поднимает — blocked остаётся
      // false навсегда) — builder оборачивает ЛЮБОЙ текущий экран, а не
      // только "домашний": перекрывает происходящее посреди смены, а не
      // только при запуске.
      builder: (context, child) => ValueListenableBuilder<bool>(
        valueListenable: SubscriptionGate.blocked,
        builder: (context, isBlocked, _) =>
            isBlocked ? const SaasSubscriptionBlockedScreen() : (child ?? const SizedBox.shrink()),
      ),
    );
  }
}
