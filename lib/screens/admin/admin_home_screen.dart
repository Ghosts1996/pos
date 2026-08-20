import 'package:flutter/material.dart';
import '../../models/employee.dart';
import 'floor_plan_editor_screen.dart';
import 'menu_editor_screen.dart';
import 'discount_cards_screen.dart';
import 'employees_screen.dart';
import 'reports_screen.dart';
import '../login_screen.dart';

class AdminHomeScreen extends StatelessWidget {
  final Employee employee;
  const AdminHomeScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    final tiles = [
      _AdminTile('Отчёты', Icons.bar_chart, (ctx) => const ReportsScreen()),
      _AdminTile('Карта зала', Icons.table_bar, (ctx) => const FloorPlanEditorScreen()),
      _AdminTile('Меню', Icons.restaurant_menu, (ctx) => const MenuEditorScreen()),
      _AdminTile('Скидочные карты', Icons.card_giftcard, (ctx) => const DiscountCardsScreen()),
      _AdminTile('Сотрудники', Icons.people, (ctx) => const EmployeesScreen()),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text('Админ · ${employee.name}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false),
          ),
        ],
      ),
      body: GridView.count(
        padding: const EdgeInsets.all(16),
        crossAxisCount: 2,
        crossAxisSpacing: 12,
        mainAxisSpacing: 12,
        children: tiles
            .map((t) => Card(
                  child: InkWell(
                    onTap: () =>
                        Navigator.of(context).push(MaterialPageRoute(builder: t.builder)),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(t.icon, size: 40),
                        const SizedBox(height: 8),
                        Text(t.title),
                      ],
                    ),
                  ),
                ))
            .toList(),
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
