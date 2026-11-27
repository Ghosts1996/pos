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
import 'signals_settings_screen.dart';
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
import 'time_cafe_settings_screen.dart';
import 'service_charge_settings_screen.dart';
import '../../build_info.dart';
import '../login_screen.dart';
import '../employee/receipts_history_screen.dart';
import 'z_report_screen.dart';
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
        _AdminTile('Отчёты', hint: 'Выручка, продажи, сотрудники', Icons.bar_chart, (ctx) => const ReportsScreen()),
        _AdminTile('Чеки', hint: 'Все чеки и возвраты', Icons.receipt_long, (ctx) => ReceiptsHistoryScreen(employee: employee, admin: true)),
        _AdminTile('Z-отчёт', hint: 'Закрытие кассовой смены', Icons.summarize_outlined, (ctx) => ZReportScreen(employee: employee)),
        _AdminTile('Карта зала', hint: 'Столы, зоны и стены', Icons.table_bar, (ctx) => const FloorPlanEditorScreen()),
        _AdminTile('Длительность сеанса', hint: 'Время гостя за столом', Icons.schedule, (ctx) => const SessionSettingsScreen()),
        _AdminTile('Тайм-кафе', hint: 'Оплата по минутам', Icons.hourglass_bottom_rounded, (ctx) => const TimeCafeSettingsScreen()),
        if (kSaasMode)
          _AdminTile('Обслуживание', hint: 'Процент к счёту', Icons.percent_rounded, (ctx) => const ServiceChargeSettingsScreen()),
        _AdminTile('Меню', hint: 'Позиции, цены, техкарты', Icons.restaurant_menu, (ctx) => const MenuEditorScreen()),
        _AdminTile('Склад', hint: 'Остатки, приход, списания', Icons.inventory_2_outlined,
            (ctx) => InventoryScreen(employee: employee)),
        _AdminTile('Сотрудники', hint: 'Доступ и PIN-коды', Icons.people, (ctx) => EmployeesScreen(employee: employee)),
        _AdminTile('Смены сотрудников', hint: 'Кто и сколько работал', Icons.timer_outlined, (ctx) => StaffShiftsScreen(employee: employee)),
        _AdminTile('Зарплата', hint: 'Ставки и выплаты', Icons.payments_outlined, (ctx) => PayrollScreen(actor: employee)),
      ],
      'Гости и лояльность': [
        _AdminTile('Гости', hint: 'База гостей и визиты', Icons.people_alt, (ctx) => const GuestsScreen()),
        _AdminTile('Программа лояльности', hint: 'Бонусы и уровни', Icons.loyalty, (ctx) => const LoyaltySettingsScreen()),
        _AdminTile('Скидочные карты', hint: 'Карты и проценты', Icons.credit_card, (ctx) => const DiscountCardsScreen()),
        _AdminTile('Сертификаты', hint: 'Подарочные сертификаты', Icons.card_giftcard,
            (ctx) => GiftCardsScreen(employee: employee)),
        _AdminTile('Отзывы', hint: 'Оценки гостей', Icons.reviews_outlined, (ctx) => const ReviewsScreen()),
        _AdminTile('Лента для гостей', hint: 'Новости в приложении', Icons.dynamic_feed, (ctx) => const StoriesEditorScreen()),
        _AdminTile('QR-коды столов', hint: 'Наклейки на столы', Icons.qr_code_2, (ctx) => const TableQrScreen(), needs: _Needs.guestApp),
        _AdminTile('Профиль заведения', hint: 'Адрес, часы, функции', Icons.storefront, (ctx) => const VenueProfileScreen()),
      ],
      'Искусственный интеллект': [
        _AdminTile('ИИ-разборы', hint: 'Советы по продажам и смене', Icons.insights, (ctx) => const AiInsightsScreen(), needs: _Needs.ai),
        _AdminTile('Активность и журнал', hint: 'Кто и что менял', Icons.fact_check, (ctx) => const ActivityLogScreen()),
        _AdminTile('Настройки ИИ', hint: 'Ключ и помощники', Icons.auto_awesome, (ctx) => const AiSettingsScreen(), needs: _Needs.ai),
      ],
      'Настройки': [
        _AdminTile('Интеграции', hint: 'Онлайн-касса, принтеры, весы', Icons.settings_input_antenna,
            (ctx) => const IntegrationsSettingsScreen()),
        _AdminTile('Звонки и сигналы', hint: 'Уведомления персоналу', Icons.notifications_active_outlined,
            (ctx) => const SignalsSettingsScreen()),
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
        title: kSaasMode ? null : Text('Админ · ${employee.name}'),
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
      body: kSaasMode ? _saasAdminBody(context, employee, groups) : ListView(
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
                                    style: locked ? TextStyle(color: AppColors.textMuted) : null),
                              ),
                            ],
                          ),
                        ),
                        if (locked)
                          Positioned(
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

/// Админка SaaS — как настройки дорогого приложения: крупный заголовок
/// антиквой, группы — карточками-списками с тонкими разделителями, у пункта
/// значок латунью, название и короткая подсказка. Без стрелок и цветной
/// пестроты. На планшете группы встают в две-три колонки.
Widget _saasAdminBody(BuildContext context, Employee employee, Map<String, List<_AdminTile>> all) {
  // Длинную «Работу заведения» делим по смыслу — по 3–6 пунктов в группе.
  const daily = {'Отчёты', 'Чеки', 'Z-отчёт'};
  const team = {'Сотрудники', 'Смены сотрудников', 'Зарплата'};
  final groups = <String, List<_AdminTile>>{};
  for (final e in all.entries) {
    if (e.key != 'Работа заведения') {
      groups[e.key] = e.value;
      continue;
    }
    groups['Каждый день'] = e.value.where((t) => daily.contains(t.title)).toList();
    groups['Зал и меню'] = e.value.where((t) => !daily.contains(t.title) && !team.contains(t.title)).toList();
    groups['Команда'] = e.value.where((t) => team.contains(t.title)).toList();
  }
  groups.removeWhere((_, v) => v.isEmpty);
  return ValueListenableBuilder<PlanCapabilities>(
    valueListenable: PlanCapabilitiesService.current,
    builder: (context, caps, _) => LayoutBuilder(builder: (context, box) {
      final cols = box.maxWidth >= 1100 ? 3 : (box.maxWidth >= 720 ? 2 : 1);
      const gap = 20.0;
      final pad = box.maxWidth >= 720 ? 28.0 : 16.0;
      final cardW = (box.maxWidth - pad * 2 - gap * (cols - 1)) / cols;
      final cards = [
        for (final e in groups.entries)
          SizedBox(
            width: cardW,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                child: Text(e.key.toUpperCase(), style: AppFonts.overline.copyWith(color: AppColors.textMuted)),
              ),
              _AdminGroupCard(
                tiles: e.value,
                caps: caps,
                onOpen: (t, locked) => locked
                    ? showPlanUpsell(context, title: t.title, text: t.lockedText)
                    : Navigator.of(context).push(MaterialPageRoute(builder: t.builder)),
              ),
            ]),
          ),
      ];
      return ListView(
        padding: EdgeInsets.fromLTRB(pad, 4, pad, 32),
        children: [
          Text('Управление', style: AppFonts.display(34)),
          const SizedBox(height: 4),
          Text('${employee.name} · администратор', style: TextStyle(fontSize: 14, color: AppColors.textMuted)),
          const SizedBox(height: 20),
          StreamBuilder<bool>(
            stream: TableKeyService.instance.reprintNeededStream(),
            builder: (context, snap) => snap.data == true && caps.guestApp
                ? const _ReprintBanner()
                : const SizedBox.shrink(),
          ),
          Wrap(spacing: gap, runSpacing: 28, children: cards),
        ],
      );
    }),
  );
}

class _AdminGroupCard extends StatelessWidget {
  final List<_AdminTile> tiles;
  final PlanCapabilities caps;
  final void Function(_AdminTile tile, bool locked) onOpen;
  const _AdminGroupCard({required this.tiles, required this.caps, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < tiles.length; i++) {
      final t = tiles[i];
      final locked = !t.allowedBy(caps);
      if (i > 0) {
        rows.add(Padding(
          padding: const EdgeInsets.only(left: 66),
          child: Divider(height: 1, thickness: 0.6, color: AppColors.border),
        ));
      }
      rows.add(InkWell(
        onTap: () => onOpen(t, locked),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
          child: Row(children: [
            Container(
              width: 36,
              height: 36,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: (locked ? AppColors.textMuted : AppColors.brass).withValues(alpha: AppColors.isLight ? 0.10 : 0.13),
              ),
              child: Icon(t.icon, size: 19, color: locked ? AppColors.textMuted : AppColors.brass),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(t.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: locked ? AppColors.textMuted : AppColors.textPrimary,
                    )),
                if (t.hint.isNotEmpty || locked) ...[
                  const SizedBox(height: 2),
                  Text(locked ? 'Не входит в тариф' : t.hint,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, color: AppColors.textMuted, height: 1.25)),
                ],
              ]),
            ),
            if (locked) ...[
              const SizedBox(width: 8),
              Icon(Icons.lock_outline, size: 16, color: AppColors.textMuted),
            ],
          ]),
        ),
      ));
    }
    return Material(
      color: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: AppColors.border, width: 0.8),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: rows),
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
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 10, 14),
            child: Row(children: [
              Icon(Icons.qr_code_2, color: AppColors.warning, size: 28),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Распечатайте новые QR-коды столов',
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text('Старые наклейки больше не открывают счёт гостя: в новых есть секрет стола.',
                        style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              const Icon(Icons.chevron_right),
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
  final String hint;
  _AdminTile(this.title, this.icon, this.builder, {this.needs = _Needs.none, this.hint = ''});

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
