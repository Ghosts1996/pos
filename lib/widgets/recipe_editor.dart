import 'package:flutter/material.dart';

import '../models/inventory_models.dart';
import '../models/menu_models.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/money.dart';
import '../utils/table_label.dart';
import '../utils/recipe_math.dart';

/// Что вернул редактор рецепта: строки и на сколько порций (для блюда) или
/// сколько выходит (для заготовки, в её единицах).
class RecipeDraft {
  final List<MenuItemComponent> lines;
  final int portions;
  final double output;
  const RecipeDraft({required this.lines, this.portions = 1, this.output = 0});
}

/// Рецепт (техкарта) блюда или заготовки на весь экран: продукты склада,
/// нетто, отход, выход. Снизу — себестоимость, фудкост и сколько порций
/// хватит по остаткам. [prepared] — редактируем рецепт заготовки.
Future<RecipeDraft?> openRecipeEditor(
  BuildContext context, {
  required String title,
  required List<MenuItemComponent> lines,
  int portions = 1,
  double price = 0,
  InventoryItem? prepared,
}) =>
    Navigator.of(context).push<RecipeDraft>(MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => _RecipeEditor(title: title, lines: lines, portions: portions, price: price, prepared: prepared),
    ));

class _RecipeEditor extends StatefulWidget {
  final String title;
  final List<MenuItemComponent> lines;
  final int portions;
  final double price;
  final InventoryItem? prepared;
  const _RecipeEditor({required this.title, required this.lines, required this.portions, required this.price, this.prepared});

  @override
  State<_RecipeEditor> createState() => _RecipeEditorState();
}

class _RecipeEditorState extends State<_RecipeEditor> {
  final _fs = FirestoreService();
  late final Stream<List<InventoryItem>> _stockStream = _fs.inventoryItemsStream();
  late final List<MenuItemComponent> _lines = List.of(widget.lines);
  late final _yieldCtrl = TextEditingController(
      text: widget.prepared != null
          ? (widget.prepared!.recipeOutput > 0 ? widget.prepared!.unit.format(widget.prepared!.recipeOutput) : '')
          : '${widget.portions < 1 ? 1 : widget.portions}');

  bool get _isPrepared => widget.prepared != null;

  int get _portions => _isPrepared ? 1 : (int.tryParse(_yieldCtrl.text.trim()) ?? 1).clamp(1, 10000);
  double get _output => double.tryParse(_yieldCtrl.text.trim().replaceAll(',', '.')) ?? 0;

  @override
  void dispose() {
    _yieldCtrl.dispose();
    super.dispose();
  }

  void _save() {
    if (_isPrepared && _lines.isNotEmpty && _output <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Укажите, сколько ${widget.prepared!.unit.label} выходит по рецепту')));
      return;
    }
    Navigator.of(context).pop(RecipeDraft(lines: List.of(_lines), portions: _portions, output: _output));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [TextButton(onPressed: _save, child: const Text('Сохранить'))],
      ),
      floatingActionButton: StreamBuilder<List<InventoryItem>>(
        stream: _stockStream,
        builder: (context, snap) => FloatingActionButton.extended(
          onPressed: () => _editLine(snap.data ?? const [], null),
          icon: const Icon(Icons.add),
          label: const Text('Продукт'),
        ),
      ),
      body: StreamBuilder<List<InventoryItem>>(
        stream: _stockStream,
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final all = snap.data!;
          final stock = {for (final i in all) i.id: i};
          return Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
                children: [
                  _yieldField(),
                  const SizedBox(height: 12),
                  if (_lines.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Text(
                        _isPrepared
                            ? 'Добавьте продукты, из которых готовите заготовку, — с количеством на весь выход.'
                            : 'Добавьте продукты, из которых состоит блюдо. При продаже они спишутся со склада.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: AppColors.textMuted),
                      ),
                    ),
                  for (var i = 0; i < _lines.length; i++) _lineTile(i, stock, all),
                  if (_lines.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    _summary(stock),
                  ],
                  const SizedBox(height: 16),
                  Text(
                    _isPrepared
                        ? 'Заготовку готовят заранее кнопкой «Приготовить» в её карточке: продукты спишутся, '
                            'заготовка придёт на склад. Блюда, в рецепте которых она есть, списывают уже её.'
                        : 'Нетто — сколько продукта идёт в блюдо. Отход — сколько теряется при очистке и разделке: '
                            'со склада спишется брутто. Не знаете отход — оставьте 0 и пишите вес брутто.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _yieldField() {
    final unit = widget.prepared?.unit;
    return TextField(
      controller: _yieldCtrl,
      keyboardType: TextInputType.numberWithOptions(decimal: _isPrepared),
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(
        labelText: _isPrepared ? 'Выход по рецепту, ${unit!.label}' : 'Рецепт на сколько порций',
        helperText: _isPrepared
            ? 'Сколько заготовки получается из продуктов ниже'
            : 'Техкарта на кастрюлю — укажите, сколько порций из неё выходит. На одну порцию — 1',
      ),
    );
  }

  Widget _lineTile(int i, Map<String, InventoryItem> stock, List<InventoryItem> all) {
    final c = _lines[i];
    final inv = stock[c.inventoryItemId];
    final problems = recipeProblems([c], stock);
    final parts = <String>[
      'нетто ${c.weightUnit.formatWithLabel(c.weight)}',
      if (c.lossPercent > 0) 'отход ${c.lossPercent.toStringAsFixed(c.lossPercent % 1 == 0 ? 0 : 1)} % → брутто ${c.weightUnit.formatWithLabel(c.grossWeight)}',
      if (!_isPrepared && _portions > 1) 'на порцию ${c.weightUnit.formatWithLabel(c.grossWeight / _portions)}',
      if (inv != null && inv.costPrice > 0) '≈ ${rub(inv.costOf(c.grossWeight, c.weightUnit) / (_isPrepared ? 1 : _portions))}${_isPrepared ? '' : ' за порцию'}',
    ];
    return Card(
      child: ListTile(
        title: Text(inv?.name ?? 'Продукт удалён со склада'),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(parts.join(' · ')),
            for (final p in problems) Text(p, style: TextStyle(color: AppColors.danger, fontSize: 12)),
          ],
        ),
        onTap: () => _editLine(all, i),
        trailing: IconButton(
          tooltip: 'Убрать из рецепта',
          icon: const Icon(Icons.delete_outline),
          onPressed: () => setState(() => _lines.removeAt(i)),
        ),
      ),
    );
  }

  Widget _summary(Map<String, InventoryItem> stock) {
    final rows = <String>[];
    final noCost = missingCosts(_lines, stock);
    if (_isPrepared) {
      final draft = widget.prepared!.copyWith(recipe: _lines, recipeOutput: _output);
      final cost = preparedCostPrice(draft, stock);
      if (cost != null) rows.add('Себестоимость: ${rub(cost)} за ${draft.unit.priceUnit.label}');
    } else {
      final dish = MenuItem(id: '', categoryId: '', name: '', price: widget.price, components: _lines, recipePortions: _portions);
      final cost = dish.costPrice(stock);
      if (cost != null) {
        final fc = widget.price > 0 ? cost / widget.price * 100 : null;
        rows.add('Себестоимость порции: ${rub(cost)}${fc == null ? '' : ' · фудкост ${fc.toStringAsFixed(0)} %'}');
      }
      final n = portionsAvailable(dish, stock);
      if (n != null) rows.add(n > 0 ? 'По остаткам склада хватит на $n ${pluralRu(n, 'порцию', 'порции', 'порций')}' : 'По остаткам склада не хватает на порцию');
    }
    if (noCost.isNotEmpty) rows.add('Нет цены закупки: ${noCost.join(', ')} — себестоимость не посчитать');
    if (rows.isEmpty) return const SizedBox.shrink();
    return Card(
      color: AppColors.surfaceElevated,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [for (final r in rows) Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Text(r))],
        ),
      ),
    );
  }

  /// Добавить или изменить строку рецепта.
  Future<void> _editLine(List<InventoryItem> all, int? index) async {
    final cur = index == null ? null : _lines[index];
    final picked = cur == null
        ? await _pickProduct(all)
        : all.where((i) => i.id == cur.inventoryItemId).firstOrNull ?? await _pickProduct(all);
    if (picked == null || !mounted) return;
    final line = await showDialog<MenuItemComponent>(
      context: context,
      builder: (_) => _LineDialog(item: picked, line: cur),
    );
    if (line == null) return;
    setState(() => index == null ? _lines.add(line) : _lines[index] = line);
  }

  /// Выбор продукта склада с поиском; можно сразу завести новый.
  Future<InventoryItem?> _pickProduct(List<InventoryItem> all) {
    final selfId = widget.prepared?.id ?? '';
    final used = {for (final c in _lines) c.inventoryItemId};
    final list = all.where((i) => i.active && i.id != selfId).toList()..sort((a, b) => a.name.compareTo(b.name));
    return showModalBottomSheet<InventoryItem>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _ProductPicker(items: list, used: used, onCreate: () => _createProduct(ctx)),
    );
  }

  Future<InventoryItem?> _createProduct(BuildContext ctx) async {
    final created = await showDialog<InventoryItem>(context: ctx, builder: (_) => const _NewProductDialog());
    if (created == null) return null;
    final id = await _fs.addInventoryItem(created);
    return created.copyWithId(id);
  }
}

extension on InventoryItem {
  InventoryItem copyWithId(String id) => InventoryItem(
        id: id,
        name: name,
        category: category,
        unit: unit,
        costPrice: costPrice,
      );
}

class _ProductPicker extends StatefulWidget {
  final List<InventoryItem> items;
  final Set<String> used;
  final Future<InventoryItem?> Function() onCreate;
  const _ProductPicker({required this.items, required this.used, required this.onCreate});

  @override
  State<_ProductPicker> createState() => _ProductPickerState();
}

class _ProductPickerState extends State<_ProductPicker> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.trim().toLowerCase();
    final shown = widget.items.where((i) => q.isEmpty || i.name.toLowerCase().contains(q) || i.category.toLowerCase().contains(q)).toList();
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.75,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: TextField(
                  autofocus: true,
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Найти продукт на складе'),
                  onChanged: (v) => setState(() => _q = v),
                ),
              ),
              ListTile(
                leading: Icon(Icons.add_circle_outline, color: AppColors.primary),
                title: const Text('Новый продукт на склад'),
                subtitle: const Text('Если продукта ещё нет — заведите его здесь'),
                onTap: () async {
                  final nav = Navigator.of(context);
                  final p = await widget.onCreate();
                  if (p != null) nav.pop(p);
                },
              ),
              const Divider(height: 1),
              Expanded(
                child: shown.isEmpty
                    ? Center(child: Text('Ничего не нашлось', style: TextStyle(color: AppColors.textMuted)))
                    : ListView.builder(
                        itemCount: shown.length,
                        itemBuilder: (_, i) {
                          final it = shown[i];
                          return ListTile(
                            title: Text(it.name),
                            subtitle: Text([
                              if (it.category.isNotEmpty) it.category,
                              'остаток ${it.unit.formatWithLabel(it.quantity)}',
                              if (it.isPrepared) 'заготовка',
                              if (widget.used.contains(it.id)) 'уже в рецепте',
                            ].join(' · ')),
                            onTap: () => Navigator.of(context).pop(it),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Количество продукта в рецепте: нетто, единица (только совместимые со
/// складом) и отход при обработке.
class _LineDialog extends StatefulWidget {
  final InventoryItem item;
  final MenuItemComponent? line;
  const _LineDialog({required this.item, this.line});

  @override
  State<_LineDialog> createState() => _LineDialogState();
}

class _LineDialogState extends State<_LineDialog> {
  late InventoryUnit _unit = _initialUnit();
  late final _amount = TextEditingController(text: widget.line == null ? '' : widget.line!.weightUnit.format(widget.line!.weight));
  late final _loss = TextEditingController(
      text: widget.line == null || widget.line!.lossPercent <= 0 ? '' : widget.line!.lossPercent.toStringAsFixed(widget.line!.lossPercent % 1 == 0 ? 0 : 1));
  String _error = '';

  InventoryUnit _initialUnit() {
    final l = widget.line;
    if (l != null && l.weightUnit.compatibleWith(widget.item.unit)) return l.weightUnit;
    // Склад в кг/л — граммовку удобнее писать в г/мл.
    return switch (widget.item.unit) {
      InventoryUnit.kg => InventoryUnit.g,
      InventoryUnit.l => InventoryUnit.ml,
      final u => u,
    };
  }

  @override
  void dispose() {
    _amount.dispose();
    _loss.dispose();
    super.dispose();
  }

  void _ok() {
    final w = double.tryParse(_amount.text.trim().replaceAll(',', '.')) ?? 0;
    final loss = double.tryParse(_loss.text.trim().replaceAll(',', '.')) ?? 0;
    if (w <= 0) return setState(() => _error = 'Укажите количество больше нуля');
    if (loss < 0 || loss > 95) return setState(() => _error = 'Отход — от 0 до 95 %');
    Navigator.of(context).pop(MenuItemComponent(inventoryItemId: widget.item.id, weight: w, weightUnit: _unit, lossPercent: loss));
  }

  @override
  Widget build(BuildContext context) {
    final w = double.tryParse(_amount.text.trim().replaceAll(',', '.')) ?? 0;
    final loss = double.tryParse(_loss.text.trim().replaceAll(',', '.')) ?? 0;
    final gross = MenuItemComponent(inventoryItemId: '', weight: w, weightUnit: _unit, lossPercent: loss).grossWeight;
    return AlertDialog(
      scrollable: true,
      title: Text(widget.item.name),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _amount,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Сколько идёт в блюдо (нетто)'),
                  onChanged: (_) => setState(() => _error = ''),
                ),
              ),
              const SizedBox(width: 12),
              DropdownButton<InventoryUnit>(
                value: _unit,
                items: [for (final u in widget.item.unit.compatibleUnits) DropdownMenuItem(value: u, child: Text(u.label))],
                onChanged: (u) => setState(() => _unit = u ?? _unit),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _loss,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Отход при обработке, % (необязательно)',
              helperText: 'Очистка, разделка, уварка. Пример: картофель ≈ 20–25 %',
            ),
            onChanged: (_) => setState(() => _error = ''),
          ),
          const SizedBox(height: 12),
          Text(
            w > 0
                ? 'Со склада спишется ${_unit.formatWithLabel(gross)}'
                    '${_unit != widget.item.unit ? ' (= ${widget.item.unit.formatWithLabel(_unit.convertTo(gross, widget.item.unit))})' : ''}'
                : 'На складе: ${widget.item.unit.formatWithLabel(widget.item.quantity)}',
            style: TextStyle(color: AppColors.textMuted, fontSize: 13),
          ),
          if (_error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error, style: TextStyle(color: AppColors.danger))),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(onPressed: _ok, child: Text(widget.line == null ? 'Добавить' : 'Готово')),
      ],
    );
  }
}

/// Новый продукт склада прямо из рецепта: название, единица, цена закупки.
class _NewProductDialog extends StatefulWidget {
  const _NewProductDialog();

  @override
  State<_NewProductDialog> createState() => _NewProductDialogState();
}

class _NewProductDialogState extends State<_NewProductDialog> {
  final _name = TextEditingController();
  final _category = TextEditingController(text: 'Продукты');
  final _cost = TextEditingController();
  var _unit = InventoryUnit.kg;

  @override
  void dispose() {
    _name.dispose();
    _category.dispose();
    _cost.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: const Text('Новый продукт на склад'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _name, autofocus: true, decoration: const InputDecoration(labelText: 'Название', hintText: 'Картофель')),
          const SizedBox(height: 12),
          TextField(controller: _category, decoration: const InputDecoration(labelText: 'Категория')),
          const SizedBox(height: 12),
          DropdownButtonFormField<InventoryUnit>(
            initialValue: _unit,
            decoration: const InputDecoration(labelText: 'В чём ведём остаток'),
            items: [for (final u in InventoryUnit.values) DropdownMenuItem(value: u, child: Text(u.fullLabel))],
            onChanged: (u) => setState(() => _unit = u ?? _unit),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _cost,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: 'Цена закупки, ₽ за ${_unit.priceUnit.label} (необязательно)',
              helperText: 'Нужна для себестоимости и фудкоста',
            ),
          ),
          const SizedBox(height: 8),
          Text('Остаток — нулевой. Оприходуйте поставку в карточке продукта на складе.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(
          onPressed: () {
            if (_name.text.trim().isEmpty) return;
            final cost = double.tryParse(_cost.text.trim().replaceAll(',', '.')) ?? 0;
            Navigator.pop(
                context,
                InventoryItem(
                  id: '',
                  name: _name.text.trim(),
                  category: _category.text.trim(),
                  unit: _unit,
                  costPrice: cost < 0 ? 0 : cost,
                ));
          },
          child: const Text('Создать'),
        ),
      ],
    );
  }
}
