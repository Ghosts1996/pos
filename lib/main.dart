import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'build_info.dart';
import 'firebase_options.dart';
import 'models/employee.dart';
import 'models/tenant_models.dart';
import 'services/app_bootstrap.dart';
import 'services/app_lock.dart';
import 'services/app_scope.dart';
import 'services/app_update_service.dart';
import 'services/auth_service.dart';
import 'services/demo_gate.dart';
import 'services/saas_device_join_service.dart';
import 'services/subscription_gate.dart';
import 'services/tenant_config_service.dart';
import 'screens/image_preload_screen.dart';
import 'screens/pin_lock_screen.dart';
import 'screens/saas/demo_reset_screen.dart';
import 'screens/saas/saas_device_pairing_screen.dart';
import 'screens/saas/saas_subscription_blocked_screen.dart';
import 'screens/setup_required_screen.dart';
import 'theme/app_theme.dart';
import 'utils/adaptive.dart';
import 'utils/release_error_widget.dart';
import 'widgets/app_update_banner.dart';

// Данные проекта Supabase (Project Settings → API в Supabase Dashboard).
// Используется ТОЛЬКО для хранения фото меню (Storage) — anon key публичный
// по своей природе (как web API key у Firebase), доступ к бакету
// регулируется policy в Supabase, а не секретностью этого ключа.
const _supabaseUrl = 'https://acmdrgwemtbbroedilnk.supabase.co';
const _supabaseAnonKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjbWRyZ3dlbXRiYnJvZWRpbG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNTIyODEsImV4cCI6MjEwMjkyODI4MX0.fHrTveYc2bj_WPy4OCOkwzipVFoEL7mQxmbAKYGEy3o';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  installReleaseErrorWidget();
  // Свернули кассу — при возвращении PIN (AppLock). До runApp: «Назад» под
  // блокировкой должен достаться ему раньше, чем навигатору.
  AppLock.instance.start();

  String? startupError;
  var ready = false;
  // true — SaaS-сборка (kSaasMode), вход прошёл, но это устройство ещё не
  // состоит ни в одном заведении: показываем экран присоединения по коду
  // приглашения вместо обычного запуска. В обычной (не-SaaS) сборке этот
  // флаг всегда false — экран регистрации устройства остаётся тем же, что
  // и был (StaffDeviceSetupScreen внутри LoginScreen), см. ниже.
  var needsPairing = false;
  // Прежнее заведение — демо, которое за 3 дня удалилось на сервере:
  // экран присоединения сразу откроет новое демо (см. DemoGate).
  var lostDemo = false;

  // Если firebase_options.dart ещё не заполнен реальными ключами
  // (flutterfire configure не запускался), не пытаемся инициализировать
  // Firebase — сразу покажем понятный экран с инструкцией, а не упадём.
  if (DefaultFirebaseOptions.isConfigured) {
    try {
      // Windows — единственная платформа, где ключи Firebase не запечены в
      // сборку через --dart-define, а приходят рантайм-запросом к
      // saas-gateway (см. docstring resolveWindowsOptions в
      // firebase_options.dart) — вызывается ДО initializeApp, иначе
      // currentPlatform ниже бросит StateError.
      if (kSaasMode && defaultTargetPlatform == TargetPlatform.windows) {
        await DefaultFirebaseOptions.resolveWindowsOptions();
      }
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
        // SaaS: доступ — членство в заведении, а не общий секрет. После
        // перезапуска оно уже есть, при первом запуске надо присоединиться.
        final tenantConfigService = TenantConfigService();
        await tenantConfigService.loadFromCache();
        var cachedDemo = tenantConfigService.current?.tenant.demo == true;
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
        // Касса заведения поставлена поверх другой (обычно поверх демо с
        // сайта) — сначала присоединяемся к заведению этой сборки.
        if (config != null && await PresetJoinMarker.pending(config.tenant.slug)) {
          config = null;
          cachedDemo = false;
        }
        if (config != null) {
          AppScope.enterTenant(config.tenant.id,
              branding: config.branding, slug: config.tenant.slug, chainId: config.tenant.chainId, demo: config.tenant.demo, demoPins: config.tenant.demoPins, demoCode: config.tenant.demoCode);
          // Живой сторож жёсткой блокировки — держит смену
          // tenants/subscriptions под наблюдением всё время работы
          // приложения, а не только на старте (см. subscription_gate.dart:
          // без этого просрочка, наступившая посреди смены, ничего бы не
          // меняла до следующего перезапуска планшета).
          SubscriptionGate.watch(config.tenant.id, config);
          // Демо живёт 3 дня, потом сбрасывается в исходный вид.
          DemoGate.watch(config);
          final chainId = config.tenant.chainId;
          if (chainId != null && uid != null) {
            unawaited(SaasDeviceJoinService.ensureChainMembership(
                chainId: chainId, tenantId: config.tenant.id, uid: uid));
          }
          ready = true;
          startBackgroundServices();
        } else {
          needsPairing = true;
          lostDemo = cachedDemo;
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

  // Обновления изнутри — только у сборок из «Собрать APK» (см. AppUpdateService).
  AppUpdateService.start(app: 'pos');

  runApp(HookahPosApp(
    ready: ready,
    needsPairing: needsPairing,
    lostDemo: lostDemo,
    startupError: startupError,
  ));
}

class HookahPosApp extends StatelessWidget {
  final bool ready;
  final bool needsPairing;
  final bool lostDemo;
  final String? startupError;

  const HookahPosApp({
    super.key,
    required this.ready,
    this.needsPairing = false,
    this.lostDemo = false,
    this.startupError,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ZalPOS',
      navigatorKey: appNavigatorKey,
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
      //
      // Касса у всех заведений в фирменном стиле ZalPOS: это рабочий
      // инструмент персонала, гости её не видят. Брендинг заведения (цвета,
      // логотип, название) — только для приложения гостя и веб-меню.
      theme: AppTheme.dark,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.dark,
      // Перед экраном входа — прогрев дискового кэша фото меню (см.
      // ImagePreloadScreen), чтобы дальше открытие меню не грузило фото по
      // сети и не подвисало на слабых POS-планшетах.
      home: needsPairing
          ? SaasDevicePairingScreen(lostDemo: lostDemo)
          : ready
              ? const ImagePreloadScreen()
              : SetupRequiredScreen(errorDetails: startupError),
      // Жёсткая блокировка при просроченной подписке (SubscriptionGate,
      // одно-арендная сборка её никогда не поднимает — blocked остаётся
      // false навсегда) — builder оборачивает ЛЮБОЙ текущий экран, а не
      // только "домашний": перекрывает происходящее посреди смены, а не
      // только при запуске.
      //
      // Поверх — плашка «Вышла новая версия» (AppUpdateBanner): видна на
      // любом экране, обновление качается и ставится прямо из кассы.
      //
      // Снаружи всего — AdaptiveAppFrame: предел системного шрифта и
      // вертикальная ориентация на телефоне (планшет — любая).
      //
      // Кассу свернули (AppLock) — поверх ввод PIN того, кто в ней работал.
      //
      // Демо прожило 3 дня (DemoGate) — поверх всего экран сброса: он
      // открывает новое демо в исходном виде.
      // Оба экрана накрывают кассу, а не заменяют её: навигатор остаётся
      // на месте — под блокировкой недонабранный чек не теряется, а сброс
      // открывает вход в новое демо с чистого стека.
      builder: (context, child) => AdaptiveAppFrame(
        child: AppUpdateBanner(
          child: ValueListenableBuilder<bool>(
            valueListenable: DemoGate.expired,
            builder: (context, demoExpired, _) => ValueListenableBuilder<Employee?>(
              valueListenable: AppLock.instance.locked,
              builder: (context, lockedBy, _) {
                final covered = demoExpired || lockedBy != null;
                // Scaffold экранов блокировки и сброса непрозрачен для
                // касаний, а касса под ними ещё и выключена для фокуса и
                // диктора (TalkBack): иначе её кнопки нажимались бы из-под
                // блокировки. Обёртки не меняют дерево — состояние кассы
                // сохраняется.
                return Stack(children: [
                  ExcludeFocus(
                    excluding: covered,
                    child: ExcludeSemantics(
                      excluding: covered,
                      child: ValueListenableBuilder<bool>(
                        valueListenable: SubscriptionGate.blocked,
                        builder: (context, isBlocked, _) =>
                            isBlocked ? const SaasSubscriptionBlockedScreen() : (child ?? const SizedBox.shrink()),
                      ),
                    ),
                  ),
                  if (lockedBy != null)
                    Positioned.fill(
                      child: ExcludeSemantics(
                        excluding: demoExpired,
                        child: PinLockScreen(key: ValueKey(lockedBy.id), employee: lockedBy),
                      ),
                    ),
                  if (demoExpired) const Positioned.fill(child: DemoResetScreen()),
                ]);
              },
            ),
          ),
        ),
      ),
    );
  }
}
