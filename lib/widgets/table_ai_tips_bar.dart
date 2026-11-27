import 'dart:async';

import 'package:flutter/material.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../services/ai/ai_settings.dart';
import '../services/ai/staff_brain.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
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

  /// Для тестов: готовые подсказки вместо подсчёта по продажам.
  @visibleForTesting
  static List<MenuItem>? debugTips;

  @override
  State<TableAiTipsBar> createState() => _TableAiTipsBarState();
}

class _TableAiTipsBarState extends State<TableAiTipsBar> {
  late final _fs = FirestoreService(); // лениво: только при «+»
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
    final fixed = TableAiTipsBar.debugTips;
    if (fixed != null) {
      _tips = fixed;
      return;
    }
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
    final b = AppColors.brass;
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border, width: 0.8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome, size: 15, color: b),
              const SizedBox(width: 8),
              Expanded(
                child: Text('К ЗАКАЗУ ПОДОЙДЁТ', style: AppFonts.overline.copyWith(color: AppColors.textMuted)),
              ),
              SizedBox(
                width: 32,
                height: 32,
                child: IconButton(
                  tooltip: 'Скрыть для этого счёта',
                  padding: EdgeInsets.zero,
                  iconSize: 16,
                  icon: Icon(Icons.close, color: AppColors.textMuted),
                  onPressed: () => setState(() => TableAiTipsBar.hidden.add(widget.session.id)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            // Переносом, а не лентой с прокруткой: подсказку видно целиком.
            child: LayoutBuilder(
              builder: (context, box) {
                // Названию — вся ширина строки, кроме цены и «+».
                final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
                final nameMax = (box.maxWidth - 40 - 90 * scale).clamp(80.0, box.maxWidth).toDouble();
                return Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final t in _tips) _TipPill(name: t.name, price: rub(t.price), nameMax: nameMax, onTap: () => _add(t)),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Одна подсказка: название, цена латунью и «+» в кружке.
class _TipPill extends StatelessWidget {
  final String name;
  final String price;
  final double nameMax;
  final VoidCallback onTap;
  const _TipPill({required this.name, required this.price, required this.nameMax, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final b = AppColors.brass;
    return Material(
      color: AppColors.background,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(22),
          side: BorderSide(color: AppColors.border, width: 0.8)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 7, 7, 7),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: nameMax),
              child: Text(name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
            ),
            const SizedBox(width: 8),
            Text(price, style: TextStyle(fontSize: 13, color: b, fontWeight: FontWeight.w600)),
            const SizedBox(width: 10),
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: b.withValues(alpha: AppColors.isLight ? 0.14 : 0.18)),
              child: Icon(Icons.add, size: 15, color: b),
            ),
          ]),
        ),
      ),
    );
  }
}
