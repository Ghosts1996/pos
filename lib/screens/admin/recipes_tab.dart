import 'package:flutter/material.dart';

import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/money.dart';
import '../../utils/recipe_math.dart';
import '../../utils/table_label.dart';
import '../../widgets/recipe_editor.dart';

/// Склад → «Рецепты»: каждое блюдо меню и что оно списывает со склада при
/// продаже. Видно себестоимость и фудкост, сколько порций хватит по
/// остаткам и ошибки настройки (продукт удалён, единицы не совпадают).
/// Тап — редактор рецепта.
class RecipesTab extends StatefulWidget {
  const RecipesTab({super.key});

  @override
  State<RecipesTab> createState() => _RecipesTabState();
}

enum _Filter { all, missing, problems }

class _RecipesTabState extends State<RecipesTab> {
  final _fs = FirestoreService();
  late final Stream<List<MenuCategory>> _cats = _fs.categoriesStream();
  late final Stream<List<MenuItem>> _menu = _fs.menuItemsStream();
  late final Stream<List<InventoryItem>> _stock = _fs.inventoryItemsStream();
  var _filter = _Filter.all;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<MenuCategory>>(
      stream: _cats,
      builder: (context, catSnap) => StreamBuilder<List<MenuItem>>(
        stream: _menu,
        builder: (context, menuSnap) => StreamBuilder<List<InventoryItem>>(
          stream: _stock,
          builder: (context, stockSnap) {
            if (!menuSnap.hasData || !stockSnap.hasData) return const Center(child: CircularProgressIndicator());
            final cats = catSnap.data ?? const <MenuCategory>[];
            final items = menuSnap.data!;
            final stock = {for (final i in stockSnap.data!) i.id: i};
            if (items.isEmpty) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text('В меню пока нет позиций. Добавьте их в Админ → «Меню», и здесь появятся их рецепты.',
                      textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
                ),
              );
            }
            final withRecipe = items.where((m) => m.hasAnyInventoryLink).length;
            final broken = items.where((m) => recipeProblems(m.perPortion, stock).isNotEmpty).length;
            bool show(MenuItem m) => switch (_filter) {
                  _Filter.all => true,
                  _Filter.missing => !m.hasAnyInventoryLink,
                  _Filter.problems => recipeProblems(m.perPortion, stock).isNotEmpty,
                };
            final catName = {for (final c in cats) c.id: c.name};
            final order = [for (final c in cats) c.id, ...items.map((m) => m.categoryId).where((id) => !catName.containsKey(id)).toSet()];
            return ListView(
              padding: const EdgeInsets.only(bottom: 32),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(
                    'Рецепт — из чего состоит блюдо. При оплате чека продукты спишутся со склада сами: '
                    'по рецепту, с отходом при обработке, вместе с модификаторами и блюдами комбо.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
                  child: Wrap(
                    spacing: 8,
                    children: [
                      ChoiceChip(
                        label: Text('Все · ${items.length}'),
                        selected: _filter == _Filter.all,
                        onSelected: (_) => setState(() => _filter = _Filter.all),
                      ),
                      ChoiceChip(
                        label: Text('Без рецепта · ${items.length - withRecipe}'),
                        selected: _filter == _Filter.missing,
                        onSelected: (_) => setState(() => _filter = _Filter.missing),
                      ),
                      if (broken > 0)
                        ChoiceChip(
                          label: Text('С ошибками · $broken'),
                          selected: _filter == _Filter.problems,
                          onSelected: (_) => setState(() => _filter = _Filter.problems),
                        ),
                    ],
                  ),
                ),
                for (final catId in order)
                  if (items.any((m) => m.categoryId == catId && show(m))) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                      child: Text(catName[catId] ?? 'Без категории',
                          style: TextStyle(color: AppColors.textMuted, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
                    ),
                    for (final m in items.where((m) => m.categoryId == catId && show(m))) _tile(m, stock),
                  ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _tile(MenuItem m, Map<String, InventoryItem> stock) {
    final lines = m.perPortion;
    final problems = recipeProblems(lines, stock);
    final cost = m.costPrice(stock);
    final fc = m.foodCostPercent(stock);
    final n = portionsAvailable(m, stock);
    final String what;
    if (m.isComposite) {
      final k = m.components.length;
      what = '$k ${pluralRu(k, 'продукт', 'продукта', 'продуктов')}${m.recipePortions > 1 ? ' · на ${m.recipePortions} ${pluralRu(m.recipePortions, 'порцию', 'порции', 'порций')}' : ''}';
    } else if (m.hasInventoryLink) {
      final inv = stock[m.inventoryItemId];
      what = '${inv?.name ?? '—'} ${m.weightUnit.formatWithLabel(m.weight)}';
    } else {
      what = 'Не списывает склад — добавьте рецепт';
    }
    return ListTile(
      leading: Icon(
        problems.isNotEmpty
            ? Icons.error_outline
            : m.hasAnyInventoryLink
                ? Icons.receipt_long_outlined
                : Icons.remove_circle_outline,
        color: problems.isNotEmpty ? AppColors.danger : (m.hasAnyInventoryLink ? AppColors.primary : AppColors.textMuted),
      ),
      title: Text(m.name),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text([
            what,
            if (cost != null) 'себест. ${rub(cost)}',
            if (fc != null) 'фудкост ${fc.toStringAsFixed(0)} %',
          ].join(' · ')),
          if (n != null)
            Text(n > 0 ? 'Хватит на $n ${pluralRu(n, 'порцию', 'порции', 'порций')}' : 'Не хватает продуктов на порцию',
                style: TextStyle(fontSize: 12, color: n > 0 ? AppColors.textMuted : AppColors.warning)),
          for (final p in problems) Text(p, style: TextStyle(fontSize: 12, color: AppColors.danger)),
        ],
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => _edit(m),
    );
  }

  Future<void> _edit(MenuItem m) async {
    final r = await openRecipeEditor(
      context,
      title: 'Рецепт: ${m.name}',
      lines: m.isComposite ? m.components : m.perPortion,
      portions: m.isComposite ? m.recipePortions : 1,
      price: m.price,
    );
    if (r == null) return;
    await _fs.updateMenuItemRecipe(m.id, r.lines, r.portions);
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(r.lines.isEmpty ? '«${m.name}» больше не списывает склад' : 'Рецепт «${m.name}» сохранён')));
    }
  }
}
