import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../services/venue_service.dart';
import '../../models/venue_models.dart';
import '../services/kolibri_auth_service.dart';
import '../services/kolibri_deep_links.dart';
import '../services/kolibri_image_cache.dart';
import '../services/kolibri_notifications.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/check_picker_sheet.dart';
import '../widgets/kolibri_ai_chat.dart';
import 'kolibri_booking_screen.dart';
import 'kolibri_home_screen.dart';
import 'kolibri_menu_screen.dart';
import 'kolibri_profile_screen.dart';
import 'kolibri_visit_screen.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';

/// Корневой каркас «Colibri Lounge»: 5 вкладок + плавающая кнопка
/// ИИ-консьержа снизу справа, доступная с любого экрана.
class KolibriShell extends StatefulWidget {
  const KolibriShell({super.key});

  @override
  State<KolibriShell> createState() => _KolibriShellState();
}

class _KolibriShellState extends State<KolibriShell> {
  final _auth = KolibriAuthService();
  final _link = GuestLinkService();
  int _index = 0;

  /// Стрим профиля кэшируется и пересоздаётся только при смене аккаунта:
  /// StreamBuilder сравнивает стримы по ссылке, и новый стрим на каждом
  /// build() переподписывался бы при любом переключении вкладки.
  String _uid = '';
  Stream<ClientProfile?>? _profileStream;
  StreamSubscription? _authSub;

  @override
  void initState() {
    super.initState();
    // Фоном скачиваем все фото меню сразу при запуске: дальше меню
    // открывается мгновенно и работает даже без сети.
    KolibriImageCache.instance.warmUp();

    _syncAccount();
    // Вход по номеру телефона меняет uid (анонимный аккаунт связывается с
    // телефонным либо заменяется существующим). Без этой подписки оболочка
    // продолжала бы слушать профиль старого аккаунта, а уведомления
    // приходили бы не тому гостю.
    _authSub = _auth.authStateChanges().listen((user) {
      if (mounted) setState(_syncAccount);
      // Сессия пропала на ходу (аккаунт недоступен на сервере) — вернуть
      // прежний аккаунт по ключу восстановления или завести новый.
      if (user == null) unawaited(_auth.ensureGuest().then((_) {}, onError: (_) {}));
    });

    // QR со стола, отсканированный обычной камерой телефона, открывает
    // приложение и сразу привязывает стол.
    final links = KolibriDeepLinks.instance
      ..onTableBound = (_) {
        if (!mounted) return;
        setState(() => _index = 3);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Готово! Ваш счёт открыт')),
        );
      }
      ..onFailed = (message) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      }
      ..onNeedsPhone = () {
        if (!mounted) return;
        setState(() => _index = 4);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Укажите номер телефона в профиле, чтобы сесть за стол')),
        );
      }
      // За столом несколько счетов — спрашиваем, какой из них гостя.
      ..onChooseCheck = (tableId, tableName, checks) async {
        if (!mounted) return;
        final picked = await CheckPickerSheet.show(
          context,
          tableName: tableName,
          checks: checks,
        );
        if (picked == null || !mounted) return;
        try {
          await _link.bindToSession(_auth.uid, tableId, picked.id);
        } on SessionTakenException catch (e) {
          if (!mounted) return;
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(humanError(e))));
          return;
        }
        if (!mounted) return;
        setState(() => _index = 3);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Готово! Ваш счёт открыт')),
        );
      };
    links.start();
  }

  /// Переключает оболочку на текущий аккаунт: стрим профиля и адресата
  /// локальных уведомлений.
  void _syncAccount() {
    final uid = _auth.uid;
    if (uid == _uid && _profileStream != null) return;
    _uid = uid;
    _profileStream = uid.isEmpty ? null : _link.profileStream(uid);

    // Уведомления гостя без сервера: статус брони, готовность заказа,
    // бонусы и напоминание за час до брони (Cloud Functions нет).
    unawaited(KolibriNotifications.instance.start(uid));
  }

  @override
  void dispose() {
    unawaited(_authSub?.cancel());
    KolibriDeepLinks.instance.stop();
    unawaited(KolibriNotifications.instance.stop());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Профиль заведения (тип: кальянная/ресторан…) приходит асинхронно —
    // вкладки и главная перерисуются, когда он придёт.
    return ValueListenableBuilder<VenueProfile>(
      valueListenable: VenueService.instance.notifier,
      builder: (context, venue, _) => _shell(venue.terms.isHookah),
    );
  }

  Widget _shell(bool hookah) {
    return StreamBuilder<ClientProfile?>(
      stream: _profileStream,
      builder: (context, snap) {
        final profile = snap.data;
        final atTable = (profile?.activeSessionId ?? '').isNotEmpty;

        final pages = [
          KolibriHomeScreen(profile: profile, onOpenTab: (i) => setState(() => _index = i)),
          const KolibriMenuScreen(),
          const KolibriBookingScreen(),
          KolibriVisitScreen(profile: profile),
          KolibriProfileScreen(profile: profile),
        ];

        return Scaffold(
          // На планшете вкладки — колонкой по центру: карточки и меню,
          // растянутые на 1280 dp, читались хуже, чем на телефоне.
          body: SafeArea(bottom: false, child: CenteredBody(maxWidth: 760, child: pages[_index])),
          floatingActionButton: FloatingActionButton.small(
            backgroundColor: KolibriColors.primary,
            onPressed: () => KolibriAiChat.show(context, guestUid: _auth.uid),
            tooltip: 'ИИ-помощник',
            child: Icon(Icons.auto_awesome, color: KolibriColors.onPrimary, size: 18),
          ),
          // Штатное место кнопки — снизу справа, над панелью вкладок.
          // Было endTop: без AppBar эта позиция ставит кнопку центром ровно
          // на верхнюю границу экрана, поэтому она наезжала на заголовок
          // («Добрый вечер, …») и выглядела обрезанной. Внизу справа у всех
          // экранов оставлен пустой отступ (100–140 px), так что кнопка ничего
          // не перекрывает.
          floatingActionButtonLocation: FloatingActionButtonLocation.endFloat,
          bottomNavigationBar: NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (i) => setState(() => _index = i),
            destinations: [
              const NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home),
                label: 'Главная',
              ),
              const NavigationDestination(
                icon: Icon(Icons.restaurant_menu_outlined),
                selectedIcon: Icon(Icons.restaurant_menu),
                label: 'Меню',
              ),
              const NavigationDestination(
                icon: Icon(Icons.event_available_outlined),
                selectedIcon: Icon(Icons.event_available),
                label: 'Бронь',
              ),
              NavigationDestination(
                icon: Badge(
                  isLabelVisible: atTable,
                  backgroundColor: KolibriColors.accent,
                  child: Icon(hookah ? Icons.local_fire_department_outlined : Icons.table_restaurant_outlined),
                ),
                selectedIcon: Icon(hookah ? Icons.local_fire_department : Icons.table_restaurant),
                label: 'Мой стол',
              ),
              const NavigationDestination(
                icon: Icon(Icons.person_outline),
                selectedIcon: Icon(Icons.person),
                label: 'Профиль',
              ),
            ],
          ),
        );
      },
    );
  }
}
