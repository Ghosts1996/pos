import 'package:flutter/material.dart';

import '../models/session_model.dart';
import '../theme/app_colors.dart';
import '../utils/sale_kind.dart';

/// Частые пожелания по виду позиции — в одно нажатие. Свои слова
/// дописываются в поле ниже.
const Map<String, List<String>> orderNotePresets = {
  SaleKind.hookah: ['Лёгкий', 'Средний', 'Крепкий', 'С холодком', 'Без холодка'],
  SaleKind.bar: ['Без льда', 'Без сахара', 'Погорячее', 'На растительном молоке', 'С собой'],
  SaleKind.kitchen: ['Без лука', 'Не остро', 'Соус отдельно', 'Подать позже', 'С собой'],
};

/// Пожелание с быстрым вариантом [preset]: есть — убрать, нет — дописать
/// через запятую. Регистр не важен.
String toggleNotePreset(String note, String preset) {
  final parts = note.split(',').map((p) => p.trim()).where((p) => p.isNotEmpty).toList();
  final i = parts.indexWhere((p) => p.toLowerCase() == preset.toLowerCase());
  if (i >= 0) {
    parts.removeAt(i);
  } else {
    parts.add(parts.isEmpty ? preset : preset.toLowerCase());
  }
  return OrderItem.cleanNote(parts.join(', '));
}

/// Лист «Пожелание к позиции». Возвращает новое пожелание ('' — убрать)
/// или null, если закрыли без изменений.
Future<String?> showOrderNoteSheet(BuildContext context, OrderItem item) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: AppColors.surfaceElevated,
    builder: (ctx) => _OrderNoteSheet(item: item),
  );
}

class _OrderNoteSheet extends StatefulWidget {
  final OrderItem item;
  const _OrderNoteSheet({required this.item});

  @override
  State<_OrderNoteSheet> createState() => _OrderNoteSheetState();
}

class _OrderNoteSheetState extends State<_OrderNoteSheet> {
  late final TextEditingController _ctrl = TextEditingController(text: widget.item.note);

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _toggle(String preset) {
    final next = toggleNotePreset(_ctrl.text, preset);
    setState(() {
      _ctrl.text = next;
      _ctrl.selection = TextSelection.collapsed(offset: next.length);
    });
  }

  @override
  Widget build(BuildContext context) {
    final presets = orderNotePresets[widget.item.effectiveKind] ?? orderNotePresets[SaleKind.kitchen]!;
    final current = _ctrl.text.toLowerCase();
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Пожелание к позиции', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(
            widget.item.qty > 1 ? '${widget.item.name} × ${widget.item.qty} — для всех штук' : widget.item.name,
            style: const TextStyle(color: AppColors.textMuted),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final p in presets)
                FilterChip(
                  label: Text(p),
                  selected: current.split(',').map((x) => x.trim()).contains(p.toLowerCase()),
                  onSelected: (_) => _toggle(p),
                ),
            ],
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            maxLength: OrderItem.noteMaxLength,
            textCapitalization: TextCapitalization.sentences,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: 'Своими словами',
              hintText: widget.item.qty > 1 ? 'Например, один лёгкий, один крепкий' : 'Например, без льда',
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              if (widget.item.note.isNotEmpty)
                TextButton(
                  onPressed: () => Navigator.pop(context, ''),
                  child: const Text('Убрать пожелание', style: TextStyle(color: AppColors.danger)),
                ),
              const Spacer(),
              FilledButton(
                onPressed: () => Navigator.pop(context, OrderItem.cleanNote(_ctrl.text)),
                child: const Text('Сохранить'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
