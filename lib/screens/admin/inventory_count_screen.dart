import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/employee.dart';
import '../../models/inventory_models.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// Экран одного прохода инвентаризации: список позиций, зафиксированных на
/// момент старта, с полем для фактически посчитанного количества по
/// каждой. Каждое введённое значение сохраняется в Firestore сразу (с
/// небольшим дебаунсом), поэтому пересчёт можно спокойно прервать и
/// продолжить позже с того же места — даже с другого устройства.
///
/// В режиме [readOnly] (просмотр завершённой/отменённой инвентаризации из
/// истории) поля недоступны для редактирования, а кнопки завершения/отмены
/// скрыты.
class InventoryCountScreen extends StatefulWidget {
  final String countId;
  final Employee employee;
  final bool readOnly;

  const InventoryCountScreen({
    super.key,
    required this.countId,
    required this.employee,
    this.readOnly = false,
  });

  @override
  State<InventoryCountScreen> createState() => _InventoryCountScreenState();
}

class _InventoryCountScreenState extends State<InventoryCountScreen> {
  final _fs = FirestoreService();
  final Map<String, TextEditingController> _controllers = {};
  final Map<String, Timer> _debounce = {};
  InventoryCount? _count;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final count = await _fs.inventoryCountStream(widget.countId).first;
    if (!mounted) return;
    setState(() {
      _count = count;
      _loading = false;
      for (final e in count?.entries ?? <InventoryCountEntry>[]) {
        _controllers[e.itemId] =
            TextEditingController(text: e.countedQty == null ? '' : e.unit.format(e.countedQty!));
      }
    });
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    for (final t in _debounce.values) {
      t.cancel();
    }
    super.dispose();
  }

  void _onChanged(String itemId) {
    // Дебаунс, чтобы не писать в Firestore на каждое нажатие клавиши, а
    // только когда пользователь на мгновение остановился.
    _debounce[itemId]?.cancel();
    setState(() {}); // мгновенно обновляем расхождение/счётчики на экране
    _debounce[itemId] = Timer(const Duration(milliseconds: 500), () {
      final text = _controllers[itemId]!.text.trim().replaceAll(',', '.');
      final value = text.isEmpty ? null : double.tryParse(text);
      if (text.isNotEmpty && value == null) return; // не сохраняем мусор при вводе
      _fs.setInventoryCountValue(widget.countId, itemId, value);
    });
  }

  double? _localCounted(InventoryCountEntry e) {
    final text = _controllers[e.itemId]?.text.trim().replaceAll(',', '.') ?? '';
    if (text.isEmpty) return null;
    return double.tryParse(text);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final count = _count;
    if (count == null) {
      return const Scaffold(body: Center(child: Text('Инвентаризация не найдена')));
    }

    final entries = count.entries;
    final countedNow = entries.where((e) => _localCounted(e) != null).length;
    final discrepanciesNow =
        entries.where((e) => _localCounted(e) != null && (_localCounted(e)! - e.expectedQty).abs() > 0.0001).length;

    final categories = entries.map((e) => e.category).toSet().toList()..sort();

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.readOnly ? 'Инвентаризация · просмотр' : 'Инвентаризация'),
      ),
      bottomNavigationBar: widget.readOnly
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => _cancelCount(context),
                        child: const Text('Отменить'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        onPressed: countedNow == 0 ? null : () => _completeCount(context),
                        child: const Text('Завершить инвентаризацию'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _StatBlock(label: 'Посчитано', value: '$countedNow/${entries.length}'),
                  _StatBlock(
                    label: 'Расхождений',
                    value: '$discrepanciesNow',
                    color: discrepanciesNow > 0 ? AppColors.warning : AppColors.success,
                  ),
                  if (widget.readOnly)
                    _StatBlock(
                      label: 'Статус',
                      value: count.status == 'completed' ? 'Завершена' : 'Отменена',
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          for (final cat in categories) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 16, 4, 4),
              child: Text(
                cat.isEmpty ? 'Без категории' : cat,
                style: const TextStyle(
                  color: AppColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            ...entries.where((e) => e.category == cat).map((e) => _CountRow(
                  entry: e,
                  controller: _controllers[e.itemId]!,
                  readOnly: widget.readOnly,
                  onChanged: () => _onChanged(e.itemId),
                  localCounted: _localCounted(e),
                )),
          ],
        ],
      ),
    );
  }

  Future<void> _completeCount(BuildContext context) async {
    final entries = _count!.entries;
    final notCounted = entries.where((e) => _localCounted(e) == null).length;
    final message = notCounted > 0
        ? 'Позиции без введённого количества ($notCounted шт.) останутся без изменений в остатках. '
            'Продолжить и завершить инвентаризацию?'
        : 'Остатки посчитанных позиций будут обновлены в соответствии с введёнными значениями. Продолжить?';
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Завершить инвентаризацию?'),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Завершить')),
        ],
      ),
    );
    if (confirm != true) return;

    // На случай, если завершение нажали сразу после ввода последнего
    // значения — до срабатывания дебаунса: досылаем все ещё не
    // сохранённые изменения синхронно перед завершением.
    for (final t in _debounce.values) {
      t.cancel();
    }
    for (final e in entries) {
      final local = _localCounted(e);
      if (local != e.countedQty) {
        await _fs.setInventoryCountValue(widget.countId, e.itemId, local);
      }
    }
    await _fs.completeInventoryCount(widget.countId, widget.employee.name);
    if (context.mounted) Navigator.of(context).pop();
  }

  Future<void> _cancelCount(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Отменить инвентаризацию?'),
        content: const Text('Введённые значения не будут применены к остаткам склада.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Назад')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Отменить инвентаризацию'),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await _fs.cancelInventoryCount(widget.countId, widget.employee.name);
      if (context.mounted) Navigator.of(context).pop();
    }
  }
}

class _StatBlock extends StatelessWidget {
  final String label;
  final String value;
  final Color? color;
  const _StatBlock({required this.label, required this.value, this.color});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(value,
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: color ?? AppColors.textPrimary)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
      ],
    );
  }
}

class _CountRow extends StatelessWidget {
  final InventoryCountEntry entry;
  final TextEditingController controller;
  final bool readOnly;
  final VoidCallback onChanged;
  final double? localCounted;

  const _CountRow({
    required this.entry,
    required this.controller,
    required this.readOnly,
    required this.onChanged,
    required this.localCounted,
  });

  @override
  Widget build(BuildContext context) {
    final diff = localCounted == null ? null : localCounted! - entry.expectedQty;
    Color diffColor = AppColors.textMuted;
    String diffText = 'не посчитано';
    if (diff != null) {
      if (diff.abs() <= 0.0001) {
        diffColor = AppColors.success;
        diffText = 'совпадает';
      } else if (diff > 0) {
        diffColor = AppColors.warning;
        diffText = 'излишек +${entry.unit.formatWithLabel(diff)}';
      } else {
        diffColor = AppColors.danger;
        diffText = 'недостача ${entry.unit.formatWithLabel(diff.abs())}';
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Expanded(
              flex: 3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(entry.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text('по системе: ${entry.unit.formatWithLabel(entry.expectedQty)}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                  Text(diffText, style: TextStyle(color: diffColor, fontSize: 12, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 110,
              child: TextField(
                controller: controller,
                enabled: !readOnly,
                textAlign: TextAlign.center,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  isDense: true,
                  suffixText: entry.unit.label,
                  hintText: '—',
                ),
                onChanged: (_) => onChanged(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}