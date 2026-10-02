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
import '../services/ai/tooken_client.dart';
import '../services/app_scope.dart';
import '../services/app_update_service.dart';
import '../services/plan_capabilities.dart';
import '../services/saas_device_join_service.dart';
import '../services/venue_service.dart';
import '../utils/adaptive.dart';
import '../utils/release_error_widget.dart';
import '../widgets/app_update_banner.dart';
import 'screens/kolibri_shell.dart';
import 'screens/kolibri_demo_entry_screen.dart';
import 'screens/kolibri_venue_picker_screen.dart';
import 'services/chain_venue_switch.dart';
import 'services/kolibri_auth_service.dart';
import 'theme/kolibri_theme.dart';

/// Точка входа приложения гостя: тот же Firebase, модели и сервисы, что у
/// кассы, свой main (`flutter build apk -t lib/client/kolibri_main.dart`).
///
/// В SaaS сборка личная: код заведения зашит в неё (kSaasPresetSlug), и
/// заведение определяется один раз при старте, с кэшем для офлайн-запуска.
/// У приложения сети (kSaasPresetChainSlug) гость сначала выбирает точку —
/// это отдельный путь запуска, см. _KolibriChainBootstrap.
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  installReleaseErrorWidget();
  // Цвета заведения с прошлого запуска — экран загрузки сразу в них.
  await KolibriColors.restoreCachedBranding();
  // Гость в SaaS-сборке не видит ключей ИИ (meta/aiSecrets читает только
  // персонал) — ИИ-консьерж ходит к модели через saas-gateway, который
  // подставляет ключ заведения и ограничивает число запросов гостя.
  if (kSaasMode && kSaasGatewayUrl.isNotEmpty) {
    TookenClient.instance.useGatewayProxy(kSaasGatewayUrl);
  }

  // Демо приложения гостя с сайта: заведения в сборке нет — код демо-сети
  // вводят на первом экране (или открывают новое демо).
  if (kSaasMode && kSaasGuestDemo && kSaasPresetChainSlug.isEmpty) {
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
    runApp(const _GuestDemoBootstrap());
    return;
  }

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
    runApp(const _KolibriChainBootstrap(chainSlug: kSaasPresetChainSlug));
    return;
  }

  String? startupError;
  var ready = false;
  var guestAppOff = false;
  var appTitle = 'ZalPOS';

  if (DefaultFirebaseOptions.isConfigured) {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

      if (kSaasMode) {
        final resolved = await _resolveSaasTenantId();
        if (resolved == null) {
          startupError = 'Это приложение не привязано ни к одному заведению — обратитесь к администратору заведения.';
        } else {
          AppScope.enterTenant(resolved.tenantId, chainId: resolved.chainId);
          // Приложения гостя нет в тарифе заведения — база гостя не пустит,
          // говорим об этом сразу, а не ошибками на каждом экране.
          guestAppOff = !(await PlanCapabilitiesService.fetch(resolved.tenantId)).guestApp;
        }
      }

      if (startupError == null && !guestAppOff) {
        await KolibriAuthService().ensureGuest();
        // Бренд заведения (имя, лого, цвета — раздел «Брендинг» в личном
        // кабинете) применяется ДО первого runApp(), чтобы первый же кадр
        // уже был в цветах заведения, а не мигал дефолтной палитрой
        // "ZalPOS". Требует ensureGuest() до себя: правило
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

  // Обновления изнутри — только у сборок из «Собрать APK» (см. AppUpdateService).
  if (ready) AppUpdateService.start(app: 'guest');

  runApp(KolibriApp(ready: ready, startupError: startupError, title: appTitle, guestAppOff: guestAppOff));
}

/// kSaasPresetSlug превращается в tenantId один раз и сохраняется на диск:
/// дальше меню открывается и без сети, а заведение у сборки не меняется.
///
/// chainId кэшируется там же: точка может войти в сеть уже после выпуска
/// её APK, и без chainId лояльность ушла бы в документы точки, а не сети.
Future<({String tenantId, String? chainId})?> _resolveSaasTenantId() async {
  const tenantCacheKey = 'saas_kolibri_tenant_id_v1';
  const chainCacheKey = 'saas_kolibri_tenant_chain_id_v1';
  const slugCacheKey = 'saas_kolibri_tenant_slug_v1';
  final prefs = await SharedPreferences.getInstance();
  final cached = prefs.getString(tenantCacheKey);
  // Кэш другого заведения (приложение поставили поверх чужого) не берём.
  final cachedSlug = prefs.getString(slugCacheKey);
  if (cached != null && cached.isNotEmpty && (cachedSlug == null || cachedSlug == kSaasPresetSlug)) {
    if (cachedSlug == null && kSaasPresetSlug.isNotEmpty) await prefs.setString(slugCacheKey, kSaasPresetSlug);
    return (tenantId: cached, chainId: prefs.getString(chainCacheKey));
  }

  if (kSaasPresetSlug.isEmpty) {
    // Универсальная сборка без привязки к заведению (например, собранная
    // для теста без createBuildJob) — у гостевого приложения, в отличие от
    // POS, нет экрана "ввести код заведения вручную": оно всегда личное.
    return null;
  }
  try {
    final resolved = await SaasDeviceJoinService().resolveTenantIdBySlug(kSaasPresetSlug);
    await prefs.setString(tenantCacheKey, resolved.tenantId);
    await prefs.setString(slugCacheKey, kSaasPresetSlug);
    await prefs.remove(chainCacheKey);
    if (resolved.chainId != null && resolved.chainId!.isNotEmpty) {
      await prefs.setString(chainCacheKey, resolved.chainId!);
    }
    return resolved;
  } catch (_) {
    return null;
  }
}

/// Подтягивает branding/config текущего заведения (см. AppScope.enterTenant
/// выше) и накладывает его на [KolibriColors] — см. её же docstring и
/// [KolibriColors.applyBranding]. Нет сети/документа — гость просто видит
/// палитру по умолчанию, а не ошибку (возвращает null):
/// свежий брендинг подтянется при следующем удачном запуске.
Future<BrandingConfig?> _applyTenantBranding() async {
  try {
    final doc = await AppScope.col('branding').doc('config').get();
    final branding = BrandingConfig.fromMap(doc.data());
    KolibriColors.applyBranding(branding);
    unawaited(KolibriColors.cacheBranding(branding));
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
    unawaited(KolibriColors.cacheBranding(branding));
    return branding;
  } catch (_) {
    return null;
  }
}

enum _ChainBootPhase { loading, picking, ready, error, off }

/// Точка входа гостевой сборки для СЕТИ заведений (kSaasPresetChainSlug) —
/// см. её докстринг у [main] выше. В отличие от одиночной сборки, здесь
/// нужен настоящий (интерактивный) UI ДО того, как известен tenantId: гость
/// сам выбирает, в какое заведение сети он пришёл или где хочет
/// забронировать стол.
///
/// При каждом запуске, если в сети две точки и больше, — выбор заведения
/// (последнее отмечено); точка одна — сразу она. Нет сети — последнее
/// выбранное из кэша. Сменить заведение можно и на ходу (ChainVenueSwitch):
/// из профиля и из бронирования, без перезапуска.
class _KolibriChainBootstrap extends StatefulWidget {
  const _KolibriChainBootstrap({super.key, required this.chainSlug, this.onChainMissing});

  final String chainSlug;

  /// Сети с этим кодом больше нет (демо сбросилось) — демо-сборка снова
  /// спрашивает код.
  final VoidCallback? onChainMissing;

  @override
  State<_KolibriChainBootstrap> createState() => _KolibriChainBootstrapState();
}

class _KolibriChainBootstrapState extends State<_KolibriChainBootstrap> {
  _ChainBootPhase _phase = _ChainBootPhase.loading;
  String? _error;
  ChainDirectory? _directory;
  String _appTitle = 'ZalPOS';
  bool _picking = false;
  String? _lastTenantId;
  int _openTab = ChainVenueSwitch.homeTab;

  @override
  void initState() {
    super.initState();
    ChainVenueSwitch.request.addListener(_onSwitchRequest);
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    ChainVenueSwitch.request.removeListener(_onSwitchRequest);
    super.dispose();
  }

  void _onSwitchRequest() {
    final tab = ChainVenueSwitch.request.value;
    if (tab == null || _phase == _ChainBootPhase.loading) return;
    _openTab = tab;
    setState(() => _phase = _ChainBootPhase.loading);
    unawaited(_bootstrap(forcePick: true));
  }

  Future<void> _bootstrap({bool forcePick = false}) async {
    final prefs = await SharedPreferences.getInstance();
    // Выбор заведения сохранён для другой сети (приложение поставили поверх
    // демо или другой сети) — не берём его.
    final sameChain = prefs.getString(kChainSlugCacheKey) == widget.chainSlug;
    final cachedTenantId = sameChain ? prefs.getString(kChainLocationCacheKey) : null;
    final cachedChainId = sameChain ? prefs.getString(kChainIdCacheKey) : null;
    _lastTenantId = (cachedTenantId ?? '').isEmpty ? null : cachedTenantId;
    try {
      final directory =
          await SaasDeviceJoinService().resolveChainBySlug(widget.chainSlug).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      final live = directory.locations.where((l) => l.status != 'suspended' && l.status != 'deleted').toList();
      if (live.length == 1 && !forcePick) {
        _picking = true;
        await _remember(live.single.tenantId, directory.chainId);
        await _enterLocation(live.single.tenantId, directory.chainId);
        return;
      }
      // Выбор заведения — уже в цветах сети (брендинг сети читается без
      // входа), а не в нейтральных.
      final branding = await _applyChainBranding(directory.chainId);
      if (!mounted) return;
      if (branding != null && branding.appName.isNotEmpty) _appTitle = branding.appName;
      setState(() {
        _directory = directory;
        _phase = _ChainBootPhase.picking;
        _picking = false;
      });
    } catch (e) {
      if (e is GatewayNotFound && widget.onChainMissing != null) {
        widget.onChainMissing!();
        return;
      }
      // Нет сети — последнее заведение из кэша: меню и профиль работают
      // и без неё.
      if (!forcePick && _lastTenantId != null && (cachedChainId ?? '').isNotEmpty) {
        await _enterLocation(_lastTenantId!, cachedChainId!);
        return;
      }
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _phase = _ChainBootPhase.error;
      });
    }
  }

  Future<void> _remember(String tenantId, String chainId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kChainLocationCacheKey, tenantId);
    await prefs.setString(kChainIdCacheKey, chainId);
    await prefs.setString(kChainSlugCacheKey, widget.chainSlug);
  }

  Future<void> _onVenuePicked(ChainLocation location) async {
    // _phase меняется на loading только на СЛЕДУЮЩЕМ кадре — до него экран
    // выбора точки ещё на экране и технически может принять второй тап (по
    // той же или другой карточке) прежде, чем он с него уйдёт. Явный флаг,
    // а не просто проверка _phase, — не полагается на то, когда именно
    // Flutter перерисует кадр.
    if (_picking) return;
    _picking = true;
    final directory = _directory!;
    setState(() => _phase = _ChainBootPhase.loading);
    await _remember(location.tenantId, directory.chainId);
    await _enterLocation(location.tenantId, directory.chainId);
  }

  Future<void> _enterLocation(String tenantId, String chainId) async {
    try {
      AppScope.enterTenant(tenantId, chainId: chainId);
      if (!(await PlanCapabilitiesService.fetch(tenantId)).guestApp) {
        if (!mounted) return;
        setState(() => _phase = _ChainBootPhase.off);
        return;
      }
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
    } finally {
      _picking = false;
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
        home = KolibriVenuePickerScreen(
          chain: _directory!,
          onSelected: _onVenuePicked,
          lastTenantId: _lastTenantId,
          forBooking: _openTab == ChainVenueSwitch.bookingTab,
        );
        break;
      case _ChainBootPhase.ready:
        // Ключ — заведение: при смене точки оболочка собирается заново и
        // не держит подписок прежней.
        home = KolibriShell(key: ValueKey(AppScope.tenantId), initialIndex: _openTab);
        break;
      case _ChainBootPhase.error:
        home = _StartupError(details: _error);
        break;
      case _ChainBootPhase.off:
        home = const _GuestAppOff();
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
      builder: (context, child) => AdaptiveAppFrame(child: child ?? const SizedBox.shrink()),
    );
  }
}

class KolibriApp extends StatelessWidget {
  final bool ready;
  final String? startupError;
  final String title;
  final bool guestAppOff;

  const KolibriApp({
    super.key,
    required this.ready,
    this.startupError,
    this.title = 'ZalPOS',
    this.guestAppOff = false,
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
      home: guestAppOff
          ? const _GuestAppOff()
          : ready
              ? const KolibriShell()
              : _StartupError(details: startupError),
      // Плашка «Вышла новая версия» поверх любого экрана гостя.
      builder: (context, child) =>
          AdaptiveAppFrame(child: AppUpdateBanner(child: child ?? const SizedBox.shrink())),
    );
  }
}

/// Заведение не подключило приложение для гостей (нет в тарифе).
class _GuestAppOff extends StatelessWidget {
  const _GuestAppOff();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.storefront_outlined, size: 48, color: KolibriColors.textMuted),
              const SizedBox(height: 16),
              const Text(
                'Приложение заведения пока не работает',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                'Заведение не подключило приложение для гостей. Меню, заказ и бронь — у персонала заведения.',
                textAlign: TextAlign.center,
                style: TextStyle(color: KolibriColors.textMuted),
              ),
            ],
          ),
        ),
      ),
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
              Icon(Icons.wifi_off, size: 48, color: KolibriColors.textMuted),
              const SizedBox(height: 16),
              const Text(
                'Не удалось подключиться',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                'Проверьте интернет и перезапустите приложение.',
                textAlign: TextAlign.center,
                style: TextStyle(color: KolibriColors.textMuted),
              ),
              if (details != null) ...[
                const SizedBox(height: 16),
                Text(details!,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: KolibriColors.textMuted, fontSize: 11)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Демо приложения гостя (kSaasGuestDemo): экран входа по коду демо-сети,
/// дальше — обычное приложение сети. Код запоминается; демо сбросилось
/// (через 3 дня) или гость нажал «Другой код демо» — снова экран входа.
class _GuestDemoBootstrap extends StatefulWidget {
  const _GuestDemoBootstrap();

  @override
  State<_GuestDemoBootstrap> createState() => _GuestDemoBootstrapState();
}

class _GuestDemoBootstrapState extends State<_GuestDemoBootstrap> {
  static const _slugKey = 'saas_guest_demo_chain_slug_v1';
  bool _loaded = false;
  String? _slug;
  String? _notice;

  @override
  void initState() {
    super.initState();
    ChainVenueSwitch.leaveDemo.addListener(_leave);
    SharedPreferences.getInstance().then((prefs) {
      if (!mounted) return;
      setState(() {
        _slug = prefs.getString(_slugKey);
        _loaded = true;
      });
    });
  }

  @override
  void dispose() {
    ChainVenueSwitch.leaveDemo.removeListener(_leave);
    super.dispose();
  }

  Future<void> _open(String slug) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_slugKey, slug);
    if (!mounted) return;
    setState(() {
      _slug = slug;
      _notice = null;
    });
  }

  Future<void> _forget(String? notice) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_slugKey);
    await prefs.remove(kChainLocationCacheKey);
    await prefs.remove(kChainIdCacheKey);
    await prefs.remove(kChainSlugCacheKey);
    AppScope.reset();
    if (!mounted) return;
    setState(() {
      _slug = null;
      _notice = notice;
    });
  }

  void _leave() => unawaited(_forget(null));

  @override
  Widget build(BuildContext context) {
    final slug = _slug;
    if (_loaded && slug != null) {
      return _KolibriChainBootstrap(
        key: ValueKey(slug),
        chainSlug: slug,
        onChainMissing: () => unawaited(_forget('Это демо уже сбросилось — введите новый код или откройте новое демо.')),
      );
    }
    return MaterialApp(
      title: 'ZalPOS — демо для гостя',
      debugShowCheckedModeBanner: false,
      theme: KolibriTheme.dark,
      darkTheme: KolibriTheme.dark,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('ru', 'RU')],
      locale: const Locale('ru', 'RU'),
      home: !_loaded
          ? Scaffold(
              backgroundColor: KolibriColors.background,
              body: Center(child: CircularProgressIndicator(color: KolibriColors.primary)),
            )
          : KolibriDemoEntryScreen(onOpen: _open, notice: _notice),
    );
  }
}
