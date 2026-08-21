import 'package:flutter/material.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_theme.dart';
import '../../widgets/pos_action_button.dart';

/// РЕФЕРЕНСНЫЙ БЛЮПРИНТ layout'а экрана кассира.
///
/// Это НЕ замена table_detail_screen.dart — там уже есть логика сессий,
/// Firestore-стримы и таймеры, которую нельзя просто перезаписать вслепую.
/// Возьми отсюда структуру (Row -> [ReceiptPanel, MenuGrid]) и стили,
/// подставив свои реальные данные/стримы вместо моков ниже.
class CashierLayoutBlueprint extends StatelessWidget {
  const CashierLayoutBlueprint({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('Стол №5 · Зал')),
      body: Row(
        children: const [
          // ---- Левая часть: активный чек ------------------------------
          SizedBox(width: 380, child: _ReceiptPanel()),
          VerticalDivider(width: 1, color: AppColors.border),
          // ---- Правая часть: категории + сетка блюд --------------------
          Expanded(child: _MenuPanel()),
        ],
      ),
    );
  }
}

// =============================================================================
// Левая панель — чек
// =============================================================================

class _ReceiptPanel extends StatelessWidget {
  const _ReceiptPanel();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.background,
      child: Column(
        children: [
          // Шапка: номер стола, официант, длительность сеанса.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.screenPadding),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Стол №5', style: TextStyle(
                  color: AppColors.textPrimary, fontSize: 20, fontWeight: FontWeight.w700)),
                SizedBox(height: 4),
                Text('Официант: Мария · 00:42', style: TextStyle(
                  color: AppColors.textMuted, fontSize: 13)),
              ],
            ),
          ),

          // Список позиций чека — скроллится независимо от сетки меню.
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.screenPadding),
              itemCount: 4,
              separatorBuilder: (_, __) => const Divider(height: 24),
              itemBuilder: (context, i) => const _ReceiptLine(
                name: 'Кальян "Классик"',
                modifiers: 'Двойная чаша · Апельсин',
                qty: 1,
                price: '1 800 ₽',
              ),
            ),
          ),

          // Подвал: итог + основное действие. Всегда закреплён снизу —
          // кассир не должен скроллить, чтобы найти кнопку "Оплатить".
          Container(
            padding: const EdgeInsets.all(AppSpacing.screenPadding),
            decoration: const BoxDecoration(
              color: AppColors.surface,
              border: Border(top: BorderSide(color: AppColors.border)),
            ),
            child: Column(
              children: [
                const _TotalsRow(label: 'Подытог', value: '3 600 ₽', muted: true),
                const SizedBox(height: 6),
                const _TotalsRow(label: 'Скидка 10%', value: '−360 ₽', muted: true),
                const Divider(height: 20),
                const _TotalsRow(label: 'Итого', value: '3 240 ₽', emphasis: true),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: PosActionButton(
                        label: 'На кухню',
                        icon: Icons.local_fire_department_outlined,
                        onPressed: () {},
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: PosActionButton(
                        label: 'Оплатить',
                        icon: Icons.payments_outlined,
                        onPressed: () {},
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ReceiptLine extends StatelessWidget {
  final String name;
  final String modifiers;
  final int qty;
  final String price;

  const _ReceiptLine({
    required this.name,
    required this.modifiers,
    required this.qty,
    required this.price,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Степпер количества — компактный, но с тач-таргетом не меньше 36px.
        Container(
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadius.sm),
            border: Border.all(color: AppColors.border),
          ),
          child: Text('${qty}x', style: const TextStyle(
            color: AppColors.textMuted, fontSize: 12, fontWeight: FontWeight.w600))
              .let((t) => Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6), child: t)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: const TextStyle(
                color: AppColors.textPrimary, fontSize: 14.5, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(modifiers, style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
            ],
          ),
        ),
        Text(price, style: const TextStyle(
          color: AppColors.textPrimary, fontSize: 14.5, fontWeight: FontWeight.w700)),
      ],
    );
  }
}

class _TotalsRow extends StatelessWidget {
  final String label;
  final String value;
  final bool muted;
  final bool emphasis;

  const _TotalsRow({
    required this.label,
    required this.value,
    this.muted = false,
    this.emphasis = false,
  });

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      color: muted ? AppColors.textMuted : AppColors.textPrimary,
      fontSize: emphasis ? 20 : 14,
      fontWeight: emphasis ? FontWeight.w800 : FontWeight.w500,
    );
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [Text(label, style: style), Text(value, style: style)],
    );
  }
}

// =============================================================================
// Правая панель — категории + сетка блюд
// =============================================================================

class _MenuPanel extends StatelessWidget {
  const _MenuPanel();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Горизонтальная лента категорий — крупные пилюли, легко попасть
        // пальцем даже не глядя на экран (моторная память бариста/официанта).
        SizedBox(
          height: 56,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            children: [
              _CategoryChip(label: 'Кальяны', selected: true),
              _CategoryChip(label: 'Напитки'),
              _CategoryChip(label: 'Кухня'),
              _CategoryChip(label: 'Десерты'),
            ],
          ),
        ),
        const Divider(height: 1),
        // Сетка блюд — адаптивное число колонок, крупные touch-таргеты.
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.all(AppSpacing.screenPadding),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 190,
              mainAxisSpacing: AppSpacing.gridGap,
              crossAxisSpacing: AppSpacing.gridGap,
              childAspectRatio: 0.95,
            ),
            itemCount: 12,
            itemBuilder: (context, i) => const _MenuGridItemPlaceholder(),
          ),
        ),
      ],
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final String label;
  final bool selected;
  const _CategoryChip({required this.label, this.selected = false});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Material(
        color: selected ? AppColors.primary : AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: InkWell(
          onTap: () {},
          borderRadius: BorderRadius.circular(AppRadius.pill),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadius.pill),
              border: Border.all(color: selected ? AppColors.primary : AppColors.border),
            ),
            alignment: Alignment.center,
            child: Text(label, style: TextStyle(
              color: AppColors.textPrimary,
              fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
              fontSize: 14,
            )),
          ),
        ),
      ),
    );
  }
}

// Используй здесь PosMenuTile из widgets/pos_action_button.dart —
// оставлено как placeholder, чтобы файл компилировался изолированно.
class _MenuGridItemPlaceholder extends StatelessWidget {
  const _MenuGridItemPlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
    );
  }
}

extension _Let<T> on T {
  R let<R>(R Function(T) f) => f(this);
}