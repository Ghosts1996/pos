import 'package:flutter/material.dart';
import '../../services/staff_session_store.dart';
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
import '../login_screen.dart';

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
        _AdminTile('Меню', Icons.restaurant_menu, (ctx) => const MenuEditorScreen()),
        _AdminTile('Склад', Icons.inventory_2_outlined,
            (ctx) => InventoryScreen(employee: employee)),
        _AdminTile('Сотрудники', Icons.people, (ctx) => const EmployeesScreen()),
        _AdminTile('Смены сотрудников', Icons.timer_outlined, (ctx) => const StaffShiftsScreen()),
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
        _AdminTile('QR-коды столов', Icons.qr_code_2, (ctx) => const TableQrScreen()),
        _AdminTile('Профиль заведения', Icons.storefront, (ctx) => const VenueProfileScreen()),
      ],
      'Искусственный интеллект': [
        _AdminTile('ИИ-разборы', Icons.insights, (ctx) => const AiInsightsScreen()),
        _AdminTile('Активность и журнал', Icons.fact_check, (ctx) => const ActivityLogScreen()),
        _AdminTile('Настройки ИИ', Icons.auto_awesome, (ctx) => const AiSettingsScreen()),
      ],
      'Настройки': [
        _AdminTile('Интеграции', Icons.settings_input_antenna,
            (ctx) => const IntegrationsSettingsScreen()),
      ],
    };

    return Scaffold(
      appBar: AppBar(
        title: Text('Админ · ${employee.name}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            // Забываем сохранённый вход — иначе экран PIN тут же вернул
            // бы в приложение того же сотрудника.
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
          for (final entry in groups.entries) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 10, top: 6),
              child: Text(entry.key,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            ),
            GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: MediaQuery.of(context).size.width > 800 ? 4 : 2,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              childAspectRatio: 1.25,
              children: entry.value
                  .map((t) => Card(
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () => Navigator.of(context)
                              .push(MaterialPageRoute(builder: t.builder)),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(t.icon, size: 34),
                              const SizedBox(height: 8),
                              Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 8),
                                child: Text(t.title, textAlign: TextAlign.center),
                              ),
                            ],
                          ),
                        ),
                      ))
                  .toList(),
            ),
            const SizedBox(height: 20),
          ],
        ],
      ),
    );
  }
}

class _AdminTile {
  final String title;
  final IconData icon;
  final Widget Function(BuildContext) builder;
  _AdminTile(this.title, this.icon, this.builder);
}
