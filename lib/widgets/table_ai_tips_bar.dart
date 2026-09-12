import 'package:flutter/material.dart';
import '../models/menu_models.dart';
import '../models/session_model.dart';
import '../services/ai/ai_agents.dart';
import '../services/ai/ai_settings.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';

/// Полоса ИИ-подсказок над меню на экране стола.
///
/// Агент допродаж смотрит на чек, время за столом и остатки и предлагает
/// до трёх уместных позиций. Нажатие добавляет позицию в чек — кассиру не
/// нужно искать её в меню.
///
/// Подсказки обновляются не чаще раза в 3 минуты и только когда чек
/// меняется: иначе каждое нажатие «+1» стоило бы запроса к модели.
class TableAiTipsBar extends StatefulWidget {
  final SessionModel session;
  const TableAiTipsBar({super.key, required this.session});

  @override
  State<TableAiTipsBar> createState() => _TableAiTipsBarState();
}

class _TableAiTipsBarState extends State<TableAiTipsBar> {
  final _fs = FirestoreService();

  List<UpsellSuggestion> _tips = const [];
  DateTime _lastLoad = DateTime(2000);
  int _lastItemCount = -1;
  bool _busy = false;
  bool _dismissed = false;

  @override
  void initState() {
    super.initState();
    _maybeLoad();
  }

  @override
  void didUpdateWidget(covariant TableAiTipsBar old) {
    super.didUpdateWidget(old);
    _maybeLoad();
  }

  Future<void> _maybeLoad() async {
    if (_busy || _dismissed) return;
    if (!AiSettingsStore.instance.current.isReady) return;
    if (!AiAgents.upsell.enabled) return;

    final items = widget.session.orderItems.length;
    final fresh = DateTime.now().difference(_lastLoad) < const Duration(minutes: 3);
    if (fresh && items == _lastItemCount) return;

    _busy = true;
    final tips = await AiService.instance.upsellFor(widget.session);
    _lastLoad = DateTime.now();
    _lastItemCount = items;
    _busy = false;
    if (mounted) setState(() => _tips = tips);
  }

  Future<void> _add(UpsellSuggestion tip) async {
    if (tip.menuItemId.isEmpty) return;
    try {
      final items = await _fs.menuItemsStream().first;
      final item = items.where((i) => i.id == tip.menuItemId).cast<MenuItem?>().firstOrNull;
      if (item == null) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Позиция больше недоступна')),
          );
        }
        return;
      }
      await _fs.addOrderItem(widget.session.id, item);
      if (mounted) {
        setState(() => _tips = _tips.where((t) => t.menuItemId != tip.menuItemId).toList());
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('${item.name} добавлено в чек')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_tips.isEmpty || _dismissed) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
      decoration: BoxDecoration(
        color: AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          const Icon(Icons.auto_awesome, size: 18, color: AppColors.primary),
          const SizedBox(width: 10),
          Expanded(
            child: SizedBox(
              height: 38,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _tips.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final t = _tips[i];
                  return ActionChip(
                    backgroundColor: AppColors.selection,
                    side: const BorderSide(color: AppColors.border),
                    onPressed: () => _add(t),
                    label: Text(
                      '${t.name}${t.price > 0 ? ' · ${t.price.toStringAsFixed(0)} ₽' : ''}'
                      '${t.reason.isEmpty ? '' : ' — ${t.reason}'}',
                      style: const TextStyle(color: AppColors.textPrimary, fontSize: 12),
                    ),
                  );
                },
              ),
            ),
          ),
          IconButton(
            tooltip: 'Скрыть подсказки',
            icon: const Icon(Icons.close, size: 18, color: AppColors.textMuted),
            onPressed: () => setState(() => _dismissed = true),
          ),
        ],
      ),
    );
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
