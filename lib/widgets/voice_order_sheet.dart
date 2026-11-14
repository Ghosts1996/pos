import 'package:flutter/material.dart';

import '../models/menu_models.dart';
import '../utils/money.dart';
import '../utils/voice_order.dart';

/// Проверка голосового заказа: что услышали, что нашлось в меню (количество
/// можно поправить, строку — снять), какие слова подходят к нескольким
/// позициям (выбрать), что не нашлось. В чек — только по кнопке.
class VoiceOrderSheet extends StatefulWidget {
  final String heard;
  final VoiceOrderResult<MenuItem> parsed;
  const VoiceOrderSheet({super.key, required this.heard, required this.parsed});

  @override
  State<VoiceOrderSheet> createState() => _VoiceOrderSheetState();
}

class _VoiceOrderSheetState extends State<VoiceOrderSheet> {
  late final List<VoiceOrderLine<MenuItem>> _lines = [
    for (final l in widget.parsed.lines) VoiceOrderLine<MenuItem>(l.item, l.qty),
  ];
  late final Set<int> _off = {};
  late final List<VoiceOrderChoice<MenuItem>> _choices = [...widget.parsed.choices];

  void _choose(VoiceOrderChoice<MenuItem> c, MenuItem item) {
    setState(() {
      _choices.remove(c);
      final same = _lines.indexWhere((l) => l.item.id == item.id);
      if (same >= 0) {
        _lines[same].qty = (_lines[same].qty + c.qty).clamp(1, kVoiceMaxQty);
      } else {
        _lines.add(VoiceOrderLine<MenuItem>(item, c.qty));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final chosen = [for (var i = 0; i < _lines.length; i++) if (!_off.contains(i)) _lines[i]];
    final count = chosen.fold<int>(0, (n, l) => n + l.qty);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Text('Заказ голосом', style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('Услышал: «${widget.heard}»', style: theme.textTheme.bodySmall),
            const SizedBox(height: 12),
            for (var i = 0; i < _lines.length; i++)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Row(children: [
                    Checkbox(
                      value: !_off.contains(i),
                      onChanged: (v) => setState(() => v == true ? _off.remove(i) : _off.add(i)),
                    ),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(_lines[i].item.name, maxLines: 2, overflow: TextOverflow.ellipsis),
                        Text(rub(_lines[i].item.price), style: theme.textTheme.bodySmall),
                        if (_lines[i].item.hasModifiers)
                          Text('Добавки выберете дальше', style: theme.textTheme.bodySmall),
                      ]),
                    ),
                    IconButton(
                      tooltip: 'Меньше',
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed: _lines[i].qty > 1 ? () => setState(() => _lines[i].qty--) : null,
                    ),
                    Text('${_lines[i].qty}', style: theme.textTheme.titleMedium),
                    IconButton(
                      tooltip: 'Больше',
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: _lines[i].qty < kVoiceMaxQty ? () => setState(() => _lines[i].qty++) : null,
                    ),
                  ]),
                ),
              ),
            for (final c in _choices) ...[
              const SizedBox(height: 4),
              Text('«${c.phrase}»${c.qty > 1 ? ' × ${c.qty}' : ''} — какую позицию?', style: theme.textTheme.titleSmall),
              const SizedBox(height: 6),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final o in c.options.take(8))
                  ActionChip(label: Text(o.name), onPressed: () => _choose(c, o)),
              ]),
              const SizedBox(height: 8),
            ],
            if (widget.parsed.unknown.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4, bottom: 8),
                child: Text('Не нашёл в меню: ${widget.parsed.unknown.join(', ')}',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
              ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Отмена'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: count == 0 ? null : () => Navigator.of(context).pop(chosen),
                  child: Text(count == 0 ? 'Добавить в чек' : 'Добавить в чек ($count)'),
                ),
              ),
            ]),
          ],
        ),
      ),
    );
  }
}
