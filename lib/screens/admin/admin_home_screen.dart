import 'package:flutter/material.dart';
import '../../widgets/about_app_dialog.dart';
import '../../widgets/plan_upsell.dart';
import '../../services/plan_capabilities.dart';
import '../../services/staff_session_store.dart';
import '../../services/table_key_service.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_theme.dart';
import '../../models/employee.dart';
import 'floor_plan_editor_screen.dart';
import 'menu_editor_screen.dart';
import 'discount_cards_screen.dart';
import 'employees_screen.dart';
import 'staff_shifts_screen.dart';
import 'payroll_screen.dart';
import 'reports_screen.dart';
import 'inventory_screen.dart';
import 'integrations_settings_screen.dart';
import 'ai_settings_screen.dart';
import 'ai_insights_screen.dart';
import 'activity_log_screen.dart';
import 'stories_editor_screen.dart';
import 'reviews_screen.dart';
import 'table_qr_screen.dart';
import 'venue_profile_screen.dart';
import 'gift_cards_screen.dart';
import 'guests_screen.dart';
import 'loyalty_settings_screen.dart';
import 'session_settings_screen.dart';
import '../login_screen.dart';
import '../../utils/adaptive.dart';

/// Главный экран администратора. Плитки сгруппированы по смыслу: сначала
/// ежедневная работа (отчёты, меню, склад), затем ИИ, затем настройки —
/// иначе на 14 плитках владелец каждый раз ищет нужную заново.
class AdminHomeScreen extends StatelessWidget {
  final Employee employee;
  const AdminHomeScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<_AdminTile>>{
      'Работа заведения': [
        _AdminTile('Отчёты', Icons.bar_chart, (ctx) => const ReportsScreen()),
        _AdminTile('Карта зала', Icons.table_bar, (ctx) => const FloorPlanEditorScreen()),
        _AdminTile('Длительность сеанса', Icons.schedule, (ctx) => const SessionSettingsScreen()),
        _AdminTile('Меню', Icons.restaurant_menu, (ctx) => const MenuEditorScreen()),
        _AdminTile('Склад', Icons.inventory_2_outlined,
            (ctx) => InventoryScreen(employee: employee)),
        _AdminTile('Сотрудники', Icons.people, (ctx) => EmployeesScreen(employee: employee)),
        _AdminTile('Смены сотрудников', Icons.timer_outlined, (ctx) => StaffShiftsScreen(employee: employee)),
        _AdminTile('Зарплата', Icons.payments_outlined, (ctx) => const PayrollScreen()),
      ],
      'Гости и лояльность': [
        _AdminTile('Гости', Icons.people_alt, (ctx) => const GuestsScreen()),
        _AdminTile('Программа лояльности', Icons.loyalty, (ctx) => const LoyaltySettingsScreen()),
        _AdminTile('Скидочные карты', Icons.credit_card, (ctx) => const DiscountCardsScreen()),
        _AdminTile('Сертификаты', Icons.card_giftcard,
            (ctx) => GiftCardsScreen(employee: employee)),
        _AdminTile('Отзывы', Icons.reviews_outlined, (ctx) => const ReviewsScreen()),
        _AdminTile('Лента для гостей', Icons.dynamic_feed, (ctx) => const StoriesEditorScreen()),
        _AdminTile('QR-коды столов', Icons.qr_code_2, (ctx) => const TableQrScreen(), needs: _Needs.guestApp),
        _AdminTile('Профиль заведения', Icons.storefront, (ctx) => const VenueProfileScreen()),
      ],
      'Искусственный интеллект': [
        _AdminTile('ИИ-разборы', Icons.insights, (ctx) => const AiInsightsScreen(), needs: _Needs.ai),
        _AdminTile('Активность и журнал', Icons.fact_check, (ctx) => const ActivityLogScreen()),
        _AdminTile('Настройки ИИ', Icons.auto_awesome, (ctx) => const AiSettingsScreen(), needs: _Needs.ai),
      ],
      'Настройки': [
        _AdminTile('Интеграции', Icons.settings_input_antenna,
            (ctx) => const IntegrationsSettingsScreen()),
      ],
    };

    // Под этим экраном в стеке только заставка запуска: стрелка «Назад»
    // (и системная кнопка) уводили на пустой экран с логотипом, откуда не
    // выйти. Выход — кнопкой справа, она возвращает на ввод PIN.
    return PopScope(
      canPop: false,
      child: _scaffold(context, groups),
    );
  }

  Widget _scaffold(BuildContext context, Map<String, List<_AdminTile>> groups) {
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: Text('Админ · ${employee.name}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.system_update_alt),
            tooltip: 'Обновления',
            onPressed: () => showAboutAppDialog(context),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Выйти',
            // Забываем сохранённый вход: вызовы гостей больше не адресуются
            // ушедшему сотруднику, а вход спросит PIN следующего.
            onPressed: () async {
              await StaffSessionStore.instance.forget();
              if (!context.mounted) return;
              Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false);
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Секреты столов выпущены, а наклейки ещё старые — старые коды
          // больше не открывают счёт гостя (см. TableKeyService).
          StreamBuilder<bool>(
            stream: TableKeyService.instance.reprintNeededStream(),
            builder: (context, snap) => snap.data == true && PlanCapabilitiesService.current.value.guestApp
                ? const _ReprintBanner()
                : const SizedBox.shrink(),
          ),
          for (final entry in groups.entries) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 10, top: 6),
              child: Text(entry.key,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            ),
            // Задаём ширину плитки, а не число колонок: на телефоне 2, на
            // планшете 5–6.
            // Что не входит в тариф — с замком: по нажатию объясняем, где
            // подключить (см. PlanCapabilitiesService).
            ValueListenableBuilder<PlanCapabilities>(
              valueListenable: PlanCapabilitiesService.current,
              builder: (context, caps, _) => GridView(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 220,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  // Две строки подписи с поправкой на системный шрифт.
                  mainAxisExtent: context.scaledExtent(112, textPart: 40),
                ),
                children: entry.value.map((t) {
                  final locked = !t.allowedBy(caps);
                  return Card(
                    child: InkWell(
                      borderRadius: BorderRadius.circular(12),
                      onTap: () => locked
                          ? showPlanUpsell(context, title: t.title, text: t.lockedText)
                          : Navigator.of(context).push(MaterialPageRoute(builder: t.builder)),
                      child: Stack(children: [
                        Positioned.fill(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(t.icon, size: 34, color: locked ? AppColors.textMuted : null),
                              const SizedBox(height: 8),
                              Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 8),
                                child: Text(t.title,
                                    textAlign: TextAlign.center,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: locked ? const TextStyle(color: AppColors.textMuted) : null),
                              ),
                            ],
                          ),
                        ),
                        if (locked)
                          const Positioned(
                            top: 8,
                            right: 8,
                            child: Icon(Icons.lock_outline, size: 16, color: AppColors.textMuted),
                          ),
                      ]),
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 20),
          ],
        ],
      ),
    );
  }
}

/// Напоминание распечатать QR-коды. Простые Row/Text вместо ListTile:
/// плашка переносит строки на любом шрифте и ширине экрана.
class _ReprintBanner extends StatelessWidget {
  const _ReprintBanner();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Material(
        color: Color.alphaBlend(AppColors.warning.withValues(alpha: 0.14), AppColors.surface),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          side: BorderSide(color: AppColors.warning.withValues(alpha: 0.45)),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const TableQrScreen())),
          child: const Padding(
            padding: EdgeInsets.fromLTRB(16, 14, 10, 14),
            child: Row(children: [
              Icon(Icons.qr_code_2, color: AppColors.warning, size: 28),
              SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Распечатайте новые QR-коды столов',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    SizedBox(height: 4),
                    Text('Старые наклейки больше не открывают счёт гостя: в новых есть секрет стола.',
                        style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                  ],
                ),
              ),
              SizedBox(width: 6),
              Icon(Icons.chevron_right),
            ]),
          ),
        ),
      ),
    );
  }
}

enum _Needs { none, guestApp, ai }

class _AdminTile {
  final String title;
  final IconData icon;
  final Widget Function(BuildContext) builder;
  final _Needs needs;
  _AdminTile(this.title, this.icon, this.builder, {this.needs = _Needs.none});

  bool allowedBy(PlanCapabilities caps) => switch (needs) {
        _Needs.none => true,
        _Needs.guestApp => caps.guestApp,
        _Needs.ai => caps.ai,
      };

  String get lockedText => switch (needs) {
        _Needs.guestApp => 'Меню по QR-коду стола и приложение гостя (заказ со стола, вызов персонала, '
            'бонусы) не входят в тариф заведения.',
        _Needs.ai => 'ИИ-помощник для гостей и ИИ-разборы смены не входят в тариф заведения.',
        _Needs.none => '',
      };
}
