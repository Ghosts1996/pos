import 'dart:async';

import 'package:flutter/material.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../services/ai/ai_settings.dart';
import '../services/ai/staff_brain.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/human_error.dart';
import '../utils/money.dart';

/// Подсказка допродаж на экране стола (только SaaS): тонкая строка
/// «К заказу подойдёт» под заказом, до трёх позиций, которые в заведении
/// чаще всего берут вместе с тем, что уже в чеке.
///
/// Без ИИ и без токенов — по продажам за 30 дней (StaffBrain.pairsFor).
/// Ничего не всплывает и не закрывает кнопки: одно касание добавляет
/// позицию в чек, «×» прячет подсказки для этого чека. Табак не
/// предлагается. Выключается в «Настройках ИИ» → «Агент допродаж».
class TableAiTipsBar extends StatefulWidget {
  final SessionModel session;
  const TableAiTipsBar({super.key, required this.session});

  /// Чеки, где подсказки спрятали (до перезапуска кассы).
  static final Set<String> hidden = {};

  static bool get enabled => AiSettingsStore.instance.current.agents['upsell'] ?? true;

  @override
  State<TableAiTipsBar> createState() => _TableAiTipsBarState();
}

class _TableAiTipsBarState extends State<TableAiTipsBar> {
  final _fs = FirestoreService();
  List<MenuItem> _tips = const [];
  String _key = '';
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(covariant TableAiTipsBar old) {
    super.didUpdateWidget(old);
    _schedule();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  /// Пересчёт — только когда меняется состав чека, и с паузой: пока кассир
  /// быстро добивает позиции, строка не дёргается.
  void _schedule() {
    if (!TableAiTipsBar.enabled || TableAiTipsBar.hidden.contains(widget.session.id)) return;
    final key = (widget.session.orderItems.map((i) => i.menuItemId).toSet().toList()..sort()).join(',');
    if (key == _key) return;
    _key = key;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 600), () async {
      final tips = await StaffBrain.instance.upsellFor(widget.session).catchError((Object _) => const <MenuItem>[]);
      if (mounted) setState(() => _tips = tips);
    });
  }

  Future<void> _add(MenuItem item) async {
    setState(() => _tips = _tips.where((t) => t.id != item.id).toList());
    try {
      await _fs.addOrderItem(widget.session.id, item);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('«${item.name}» добавлено в чек'), duration: const Duration(seconds: 2)));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_tips.isEmpty || !TableAiTipsBar.enabled || TableAiTipsBar.hidden.contains(widget.session.id)) {
      return const SizedBox.shrink();
    }
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 8, 2, 8),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(Icons.auto_awesome, size: 16, color: AppColors.primary),
          const SizedBox(width: 8),
          Text('К заказу подойдёт', style: TextStyle(color: AppColors.textMuted, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          Expanded(
            child: SizedBox(
              height: 36,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _tips.length,
                separatorBuilder: (_, __) => const SizedBox(width: 6),
                itemBuilder: (_, i) {
                  final t = _tips[i];
                  return ActionChip(
                    visualDensity: VisualDensity.compact,
                    avatar: Icon(Icons.add, size: 16, color: AppColors.primary),
                    backgroundColor: AppColors.surface,
                    side: BorderSide(color: AppColors.border),
                    onPressed: () => _add(t),
                    label: Text('${t.name} · ${rub(t.price)}', style: TextStyle(color: AppColors.textPrimary, fontSize: 12.5)),
                  );
                },
              ),
            ),
          ),
          IconButton(
            tooltip: 'Скрыть для этого счёта',
            visualDensity: VisualDensity.compact,
            icon: Icon(Icons.close, size: 16, color: AppColors.textMuted),
            onPressed: () => setState(() => TableAiTipsBar.hidden.add(widget.session.id)),
          ),
        ],
      ),
    );
  }
}
