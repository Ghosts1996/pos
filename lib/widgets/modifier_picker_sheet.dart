import 'package:flutter/material.dart';

import '../models/menu_models.dart';
import '../utils/money.dart';

/// Выбор модификаторов позиции перед добавлением в счёт: молоко, сироп,
/// прожарка. Возвращает выбранные варианты (в порядке групп) или null,
/// если окно закрыли.
Future<List<String>?> showModifierPicker(BuildContext context, MenuItem item) =>
    showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      // Цвета из темы: тем же листом пользуются касса и приложение гостя.
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => ModifierPickerSheet(item: item),
    );

class ModifierPickerSheet extends StatefulWidget {
  final MenuItem item;
  const ModifierPickerSheet({super.key, required this.item});

  @override
  State<ModifierPickerSheet> createState() => _ModifierPickerSheetState();
}

class _ModifierPickerSheetState extends State<ModifierPickerSheet> {
  late final Set<String> _chosen = {
    // Обязательная группа с одним вариантом — выбрана сразу.
    for (final g in widget.item.modifierGroups)
      if (g.required && g.options.length == 1) g.options.first.name,
  };

  void _toggle(ModifierGroup g, ModifierOption o) {
    setState(() {
      if (_chosen.contains(o.name)) {
        // Обязательный единственный выбор не снимается — только меняется.
        if (!(g.single && g.required)) _chosen.remove(o.name);
        return;
      }
      if (g.single) {
        for (final other in g.options) {
          _chosen.remove(other.name);
        }
      } else if (g.max > 0 && g.options.where((x) => _chosen.contains(x.name)).length >= g.max) {
        return;
      }
      _chosen.add(o.name);
    });
  }

  String _hint(ModifierGroup g) {
    if (g.single) return g.required ? 'выберите одно' : 'по желанию, одно';
    if (g.required) return g.max > 0 ? 'от ${g.min} до ${g.max}' : 'не меньше ${g.min}';
    return g.max > 0 ? 'по желанию, до ${g.max}' : 'по желанию';
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final problem = item.checkModifiers(_chosen);
    final picked = [for (final o in item.optionsNamed(_chosen)) o.name];
    final price = item.priceWith(picked);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
              child: Text(item.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                children: [
                  for (final g in item.modifierGroups) ...[
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Text(g.name, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                        const SizedBox(width: 8),
                        Text(_hint(g), style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurfaceVariant)),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final o in g.options)
                          FilterChip(
                            selected: _chosen.contains(o.name),
                            showCheckmark: true,
                            label: Text(o.price > 0 ? '${o.name}  +${rub(o.price)}' : o.name),
                            onSelected: (_) => _toggle(g, o),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (problem.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(problem,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 13)),
                    ),
                  FilledButton(
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                    onPressed: problem.isEmpty ? () => Navigator.of(context).pop(picked) : null,
                    child: Text('Добавить · ${rub(price)}',
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
