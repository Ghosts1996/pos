import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
import '../services/kolibri_deep_links.dart';
import '../services/kolibri_image_cache.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/kolibri_ai_chat.dart';
import 'kolibri_booking_screen.dart';
import 'kolibri_home_screen.dart';
import 'kolibri_menu_screen.dart';
import 'kolibri_profile_screen.dart';
import 'kolibri_visit_screen.dart';

/// Корневой каркас «Колибри Лаундж»: 4 вкладки + плавающая кнопка
/// ИИ-консьержа, доступная с любого экрана.
class KolibriShell extends StatefulWidget {
  const KolibriShell({super.key});

  @override
  State<KolibriShell> createState() => _KolibriShellState();
}

class _KolibriShellState extends State<KolibriShell> {
  final _auth = KolibriAuthService();
  final _link = GuestLinkService();
  int _index = 0;

  @override
  void initState() {
    super.initState();
    // Фоном скачиваем все фото меню сразу при запуске: дальше меню
    // открывается мгновенно и работает даже без сети.
    KolibriImageCache.instance.warmUp();

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
      };
    links.start();
  }

  @override
  void dispose() {
    KolibriDeepLinks.instance.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<ClientProfile?>(
      stream: _link.profileStream(_auth.uid),
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
          body: SafeArea(bottom: false, child: pages[_index]),
          floatingActionButton: FloatingActionButton.small(
            backgroundColor: KolibriColors.primary,
            onPressed: () => KolibriAiChat.show(context, guestUid: _auth.uid),
            tooltip: 'ИИ-консьерж',
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 18),
          ),
          floatingActionButtonLocation: FloatingActionButtonLocation.endTop,
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
                  child: const Icon(Icons.local_fire_department_outlined),
                ),
                selectedIcon: const Icon(Icons.local_fire_department),
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
