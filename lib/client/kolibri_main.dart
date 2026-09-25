import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../build_info.dart';
import '../firebase_options.dart';
import '../models/client_models.dart';
import '../models/tenant_models.dart';
import '../services/ai/ai_settings.dart';
import '../services/app_scope.dart';
import '../services/saas_device_join_service.dart';
import '../services/venue_service.dart';
import 'screens/kolibri_shell.dart';
import 'screens/kolibri_venue_picker_screen.dart';
import 'services/kolibri_auth_service.dart';
import 'theme/kolibri_theme.dart';

/// Точка входа клиентского приложения «Colibri Lounge».
///
/// Это второе приложение того же проекта: общий Firebase, общие модели и
/// сервисы, отдельный main. Сборка:
///   flutter build apk --release -t lib/client/kolibri_main.dart
///
/// За счёт общего Firestore всё работает в связке с POS в реальном времени:
/// меню и стоп-лист, брони, живой счёт за столом, вызовы кальянщика.
///
/// SaaS-режим (kSaasMode) — в отличие от POS, где планшет присоединяется
/// интерактивно кодом приглашения (SaasDevicePairingScreen), гостю вводить
/// нечего: эта сборка личная, заказана конкретным владельцем через
/// «Собрать APK» и уже содержит код ЕГО заведения (kSaasPresetSlug, см.
/// saas-on-demand-build.yml). Поэтому здесь тенант резолвится один раз при
/// старте (и кэшируется — дальше работает офлайн), а не показывается
/// экран выбора/присоединения. GuestLinkService/VenueService и весь
/// остальной код гостя уже ходят в Firestore через AppScope (см. его
/// docstring) — им не важно, откуда взялся tenantId, поэтому единственное,
/// что нужно было изменить здесь, — это ГДЕ он определяется.
///
/// Сборка для СЕТИ заведений (kSaasPresetChainSlug непуст, см. её docstring
/// в lib/build_info.dart) резолвится иначе: сети, в отличие от точки,
/// заранее неизвестно, за каким именно столом сети физически сидит гость —
/// это первое, что выбирает он сам на экране KolibriVenuePickerScreen,
/// поэтому тут нужен настоящий (интерактивный) экран ДО runApp, а не
/// разовый асинхронный резолв слага в фоне. См. _KolibriChainBootstrap
/// ниже — отдельный путь запуска, полностью в стороне от обычного, чтобы
/// поведение уже работающих одиночных сборок не изменилось ни на йоту.
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  if (kSaasMode && kSaasPresetChainSlug.isNotEmpty) {
    if (!DefaultFirebaseOptions.isConfigured) {
      runApp(const KolibriApp(ready: false, startupError: 'Firebase не настроен для этой сборки.'));
      return;
    }
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    } catch (e) {
      runApp(KolibriApp(ready: false, startupError: e.toString()));
      return;
    }
    runApp(const _KolibriChainBootstrap());
    return;
  }

  String? startupError;
  var ready = false;
  var appTitle = 'Colibri Lounge';

  if (DefaultFirebaseOptions.isConfigured) {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

      if (kSaasMode) {
        final tenantId = await _resolveSaasTenantId();
        if (tenantId == null) {
          startupError = 'Это приложение не привязано ни к одному заведению — обратитесь к администратору заведения.';
        } else {
          AppScope.enterTenant(tenantId);
        }
      }

      if (startupError == null) {
        await KolibriAuthService().ensureGuest();
        // Бренд заведения (имя, лого, цвета — раздел «Брендинг» в личном
        // кабинете) применяется ДО первого runApp(), чтобы первый же кадр
        // уже был в цветах заведения, а не мигал дефолтной палитрой
        // "Colibri Lounge". Требует ensureGuest() до себя: правило
        // isTenantGuest() в saas/firestore.rules пускает гостя к
        // branding/config только когда его профиль в clients/{tenantId}/{uid}
        // уже существует (см. её же комментарий там).
        if (kSaasMode) {
          final branding = await _applyTenantBranding();
          if (branding != null && branding.appName.isNotEmpty) {
            appTitle = branding.appName;
          }
        }
        ready = true;
        // Настройки ИИ подтягиваются в фоне — без них приложение просто
        // работает без ИИ-консьержа.
        unawaited(AiSettingsStore.instance.init());
        // Пороги/кешбек программы лояльности — тоже в фоне: до загрузки
        // профиль и прогресс-бар гостя работают по дефолтным цифрам (см.
        // ClientProfile.tiers), а не показывают пустой экран ради этого.
        unawaited(loadLoyaltyTierSettings());
        // Профиль заведения нужен не только для часов работы: из него
        // берётся флаг cloudFunctionsEnabled, по которому приложение решает,
        // показывать локальные уведомления самому или ждать push с сервера.
        VenueService.instance.watch();
      }
    } catch (e) {
      startupError = e.toString();
    }
  }

  runApp(KolibriApp(ready: ready, startupError: startupError, title: appTitle));
}

/// Слаг заведения (kSaasPresetSlug) резолвится в tenantId ОДИН раз и
/// сохраняется на диск — при следующих запусках гость открывает меню даже
/// без сети, а не упирается в экран ошибки только потому, что перед этим
/// не успел подключиться интернет. Сам tenantId для конкретной сборки
/// никогда не меняется (это не блуждающий планшет POS, который можно
/// переподключить к другому заведению), поэтому кэш не протухает.
Future<String?> _resolveSaasTenantId() async {
  const cacheKey = 'saas_kolibri_tenant_id_v1';
  final prefs = await SharedPreferences.getInstance();
  final cached = prefs.getString(cacheKey);
  if (cached != null && cached.isNotEmpty) return cached;

  if (kSaasPresetSlug.isEmpty) {
    // Универсальная сборка без привязки к заведению (например, собранная
    // для теста без createBuildJob) — у гостевого приложения, в отличие от
    // POS, нет экрана "ввести код заведения вручную": оно всегда личное.
    return null;
  }
  try {
    final tenantId = await SaasDeviceJoinService().resolveTenantIdBySlug(kSaasPresetSlug);
    await prefs.setString(cacheKey, tenantId);
    return tenantId;
  } catch (_) {
    return null;
  }
}

/// Подтягивает branding/config текущего заведения (см. AppScope.enterTenant
/// выше) и накладывает его на [KolibriColors] — см. её же docstring и
/// [KolibriColors.applyBranding]. Нет сети/документа — гость просто видит
/// дефолтную палитру "Colibri Lounge", а не ошибку (возвращает null):
/// свежий брендинг подтянется при следующем удачном запуске.
Future<BrandingConfig?> _applyTenantBranding() async {
  try {
    final doc = await AppScope.col('branding').doc('config').get();
    final branding = BrandingConfig.fromMap(doc.data());
    KolibriColors.applyBranding(branding);
    return branding;
  } catch (_) {
    return null;
  }
}

/// То же самое, что и [_applyTenantBranding], но для сети целиком
/// (chains/{chainId}/branding/config, публично читаемо — см.
/// saas/firestore.rules) — единое приложение сети показывает брендинг
/// САМОЙ СЕТИ, а не отдельной точки: иначе тема мигала бы при каждом
/// переключении гостем заведения внутри одной сети (см. её же docstring).
Future<BrandingConfig?> _applyChainBranding(String chainId) async {
  try {
    final doc = await FirebaseFirestore.instance.collection('chains/$chainId/branding').doc('config').get();
    final branding = BrandingConfig.fromMap(doc.data());
    KolibriColors.applyBranding(branding);
    return branding;
  } catch (_) {
    return null;
  }
}

enum _ChainBootPhase { loading, picking, ready, error }

/// Точка входа гостевой сборки для СЕТИ заведений (kSaasPresetChainSlug) —
/// см. её докстринг у [main] выше. В отличие от одиночной сборки, здесь
/// нужен настоящий (интерактивный) UI ДО того, как известен tenantId: гость
/// сам выбирает, за каким столом какой точки сети он сидит.
///
/// Выбор кэшируется на диск (тот же принцип, что и у [_resolveSaasTenantId]
/// для одиночной сборки) — при следующих запусках приложение сразу
/// открывает ПОСЛЕДНЮЮ выбранную точку без сети и без повторного вопроса.
/// Сменить точку (гость пришёл в другое заведение той же сети) можно из
/// профиля — см. KolibriProfileScreen.
class _KolibriChainBootstrap extends StatefulWidget {
  const _KolibriChainBootstrap();

  @override
  State<_KolibriChainBootstrap> createState() => _KolibriChainBootstrapState();
}

class _KolibriChainBootstrapState extends State<_KolibriChainBootstrap> {
  _ChainBootPhase _phase = _ChainBootPhase.loading;
  String? _error;
  ChainDirectory? _directory;
  String _appTitle = 'Colibri Lounge';

  @override
  void initState() {
    super.initState();
    unawaited(_bootstrap());
  }

  Future<void> _bootstrap() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final cachedTenantId = prefs.getString(kChainLocationCacheKey);
      final cachedChainId = prefs.getString(kChainIdCacheKey);
      if (cachedTenantId != null && cachedTenantId.isNotEmpty && cachedChainId != null && cachedChainId.isNotEmpty) {
        await _enterLocation(cachedTenantId, cachedChainId);
        return;
      }
      final directory = await SaasDeviceJoinService().resolveChainBySlug(kSaasPresetChainSlug);
      if (!mounted) return;
      setState(() {
        _directory = directory;
        _phase = _ChainBootPhase.picking;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _phase = _ChainBootPhase.error;
      });
    }
  }

  Future<void> _onVenuePicked(ChainLocation location) async {
    final directory = _directory!;
    setState(() => _phase = _ChainBootPhase.loading);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kChainLocationCacheKey, location.tenantId);
    await prefs.setString(kChainIdCacheKey, directory.chainId);
    await _enterLocation(location.tenantId, directory.chainId);
  }

  Future<void> _enterLocation(String tenantId, String chainId) async {
    try {
      AppScope.enterTenant(tenantId, chainId: chainId);
      await KolibriAuthService().ensureGuest();
      final branding = await _applyChainBranding(chainId);
      if (!mounted) return;
      if (branding != null && branding.appName.isNotEmpty) {
        _appTitle = branding.appName;
      }
      setState(() => _phase = _ChainBootPhase.ready);
      unawaited(AiSettingsStore.instance.init());
      unawaited(loadLoyaltyTierSettings());
      VenueService.instance.watch();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _phase = _ChainBootPhase.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget home;
    switch (_phase) {
      case _ChainBootPhase.loading:
        home = Scaffold(
          backgroundColor: KolibriColors.background,
          body: Center(child: CircularProgressIndicator(color: KolibriColors.primary)),
        );
        break;
      case _ChainBootPhase.picking:
        home = KolibriVenuePickerScreen(chain: _directory!, onSelected: _onVenuePicked);
        break;
      case _ChainBootPhase.ready:
        home = const KolibriShell();
        break;
      case _ChainBootPhase.error:
        home = _StartupError(details: _error);
        break;
    }
    return MaterialApp(
      title: _appTitle,
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
      home: home,
    );
  }
}

class KolibriApp extends StatelessWidget {
  final bool ready;
  final String? startupError;
  final String title;

  const KolibriApp({
    super.key,
    required this.ready,
    this.startupError,
    this.title = 'Colibri Lounge',
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: title,
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
