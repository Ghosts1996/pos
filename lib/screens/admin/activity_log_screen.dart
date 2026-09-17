import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_scheduler.dart';
import '../../services/audit_log_service.dart';
import '../../theme/app_colors.dart';

/// Три ленты в одном экране:
///  • «Сводки ИИ» — что фоновые агенты нашли и предложили;
///  • «Действия ИИ» — что агенты реально изменили в данных;
///  • «Журнал кассы» — удаления позиций, закрытия без оплаты, возвраты.
///
/// Отсюда же запускается ИИ-контролёр, который ищет аномалии в журнале.
class ActivityLogScreen extends StatelessWidget {
  const ActivityLogScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Активность и журнал'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Сводки ИИ'),
              Tab(text: 'Действия ИИ'),
              Tab(text: 'Журнал кассы'),
            ],
          ),
        ),
        body: const TabBarView(
          children: [_NotesTab(), _AiActionsTab(), _AuditTab()],
        ),
      ),
    );
  }
}

class _NotesTab extends StatelessWidget {
  const _NotesTab();

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: AiScheduler.instance.notesStream(),
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final docs = snap.data!.docs;
        if (docs.isEmpty) {
          return const Center(
            child: Text('Сводок пока нет — агенты работают по расписанию',
                style: TextStyle(color: AppColors.textMuted)),
          );
        }
        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: docs.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) {
            final d = docs[i].data();
            final warning = d['priority'] == 'warning';
            final ts = d['createdAt'];
            final date = ts is Timestamp ? ts.toDate() : DateTime.now();
            return Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                    color: warning ? AppColors.warning.withValues(alpha: 0.6) : AppColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(warning ? Icons.warning_amber : Icons.auto_awesome,
                          size: 18, color: warning ? AppColors.warning : AppColors.primary),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(d['title']?.toString() ?? 'Сводка',
                            style: const TextStyle(
                                color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
                      ),
                      Text(_fmt(date),
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  SelectableText(d['text']?.toString() ?? '',
                      style: const TextStyle(color: AppColors.textPrimary, height: 1.4)),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

class _AiActionsTab extends StatelessWidget {
  const _AiActionsTab();

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance
          .collection('aiActions')
          .orderBy('createdAt', descending: true)
          .limit(150)
          .snapshots(),
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final docs = snap.data!.docs;
        if (docs.isEmpty) {
          return const Center(
            child: Text('ИИ пока ничего не менял',
                style: TextStyle(color: AppColors.textMuted)),
          );
        }
        return ListView.builder(
          padding: const EdgeInsets.all(12),
          itemCount: docs.length,
          itemBuilder: (_, i) {
            final d = docs[i].data();
            final ts = d['createdAt'];
            final date = ts is Timestamp ? ts.toDate() : DateTime.now();
            return ListTile(
              leading: const Icon(Icons.smart_toy, color: AppColors.primary),
              title: Text(d['tool']?.toString() ?? '',
                  style: const TextStyle(color: AppColors.textPrimary)),
              subtitle: Text(
                '${d['scope'] == 'guest' ? 'гость' : d['employeeName'] ?? 'сотрудник'} · '
                '${_fmt(date)}\n${d['args'] ?? ''}',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              isThreeLine: true,
            );
          },
        );
      },
    );
  }
}

class _AuditTab extends StatefulWidget {
  const _AuditTab();

  @override
  State<_AuditTab> createState() => _AuditTabState();
}

class _AuditTabState extends State<_AuditTab> {
  String? _aiResult;
  bool _busy = false;

  static const _labels = {
    'order_item_removed': 'Удалена позиция',
    'closed_without_payment': 'Закрыт без оплаты',
    'discount_applied': 'Применена скидка',
    'refund': 'Возврат',
    'timer_changed': 'Изменён таймер',
    'inventory_adjusted': 'Правка склада',
  };

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _aiResult ?? 'ИИ-контролёр найдёт аномалии в журнале за неделю',
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton.icon(
                onPressed: _busy
                    ? null
                    : () async {
                        setState(() => _busy = true);
                        try {
                          final journal = await AuditLogService.instance.snapshotForAi();
                          final sales = await AiService.instance.auditContext();
                          final text = await AiService.instance.ask(
                            AiAgents.auditor,
                            'Проверь журнал кассы и продажи за неделю на аномалии.',
                            extraContext: 'ЖУРНАЛ КАССЫ:\n$journal\n\nПРОДАЖИ ЗА НЕДЕЛЮ:\n$sales',
                          );
                          if (mounted) setState(() => _aiResult = text);
                        } catch (e) {
                          if (mounted) setState(() => _aiResult = 'Ошибка: $e');
                        }
                        if (mounted) setState(() => _busy = false);
                      },
                icon: const Icon(Icons.auto_awesome, size: 18),
                label: const Text('Проверить'),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
            stream: AuditLogService.instance.stream(),
            builder: (context, snap) {
              if (!snap.hasData) return const Center(child: CircularProgressIndicator());
              final docs = snap.data!.docs;
              if (docs.isEmpty) {
                return const Center(
                  child: Text('Журнал пуст', style: TextStyle(color: AppColors.textMuted)),
                );
              }
              return ListView.builder(
                padding: const EdgeInsets.all(12),
                itemCount: docs.length,
                itemBuilder: (_, i) {
                  final d = docs[i].data();
                  final ts = d['createdAt'];
                  final date = ts is Timestamp ? ts.toDate() : DateTime.now();
                  final amount = (d['amount'] ?? 0).toDouble();
                  return ListTile(
                    dense: true,
                    leading: const Icon(Icons.receipt_long, color: AppColors.textMuted),
                    title: Text(
                      _labels[d['action']] ?? d['action']?.toString() ?? '',
                      style: const TextStyle(color: AppColors.textPrimary),
                    ),
                    subtitle: Text(
                      '${d['employeeName'] ?? ''} · ${_fmt(date)}'
                      '${d['tableName'] != null && d['tableName'].toString().isNotEmpty ? ' · ${d['tableName']}' : ''}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                    trailing: amount == 0
                        ? null
                        : Text('${amount.toStringAsFixed(0)} ₽',
                            style: const TextStyle(color: AppColors.textMuted)),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }
}

String _fmt(DateTime d) =>
    '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} '
    '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
