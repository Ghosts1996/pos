import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_scheduler.dart';
import '../../services/ai/ai_settings.dart';
import '../../services/audit_log_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../utils/adaptive.dart';

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
        body: const CenteredBody(
          maxWidth: 900,
          child: TabBarView(
            children: [_NotesTab(), _AiActionsTab(), _AuditTab()],
          ),
        ),
      ),
    );
  }
}

class _NotesTab extends StatefulWidget {
  const _NotesTab();

  @override
  State<_NotesTab> createState() => _NotesTabState();
}

class _NotesTabState extends State<_NotesTab> {
  bool _busy = false;

  Future<void> _digestNow() async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final text = await AiScheduler.instance.digestNow();
      messenger.showSnackBar(SnackBar(
          content: Text(text == null
              ? 'За последние сутки не было ни одного чека — разбирать пока нечего'
              : 'Разбор готов — он первый в списке')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(humanError(e))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _header() {
    final ready = AiSettingsStore.instance.current.isReady;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: ready ? AppColors.border : AppColors.warning.withValues(alpha: 0.6)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            ready
                ? 'ИИ сам разбирает продажи, смены, журнал кассы, брони, отзывы, бонусы '
                    'и склад: каждое утро — сутки, по понедельникам — неделю. Имена '
                    'гостей, телефоны и адреса в ИИ не уходят, сотрудники — под номерами.'
                : 'ИИ не подключён, поэтому сводки не собираются. Добавьте ключ: '
                    'раздел «Настройки ИИ» в этом же меню.',
            style: const TextStyle(color: AppColors.textMuted, height: 1.4),
          ),
          if (ready) ...[
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _busy ? null : _digestNow,
              icon: _busy
                  ? const SizedBox(
                      width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.auto_awesome, size: 18),
              label: Text(_busy ? 'Собираю…' : 'Собрать разбор сейчас'),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: AiScheduler.instance.notesStream(),
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final docs = snap.data!.docs;
        if (docs.isEmpty) {
          return ListView(children: [
            _header(),
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Сводок пока нет',
                  textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
            ),
          ]);
        }
        return ListView.separated(
          padding: const EdgeInsets.only(bottom: 16),
          itemCount: docs.length + 1,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) {
            if (i == 0) return _header();
            final d = docs[i - 1].data();
            final warning = d['priority'] == 'warning';
            final ts = d['createdAt'];
            final date = ts is Timestamp ? ts.toDate() : DateTime.now();
            return Container(
              margin: const EdgeInsets.symmetric(horizontal: 16),
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
      stream: AppScope.col('aiActions')
          .orderBy('createdAt', descending: true)
          .limit(150)
          .snapshots(),
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final docs = snap.data!.docs;
        if (docs.isEmpty) {
          return const Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'Здесь появится то, что ИИ-помощник изменил по просьбе сотрудника: '
                'поставил позицию в стоп-лист, создал бронь, отправил уведомление.\n\n'
                'Сам по себе ИИ данные не меняет — он только собирает разборы '
                'во вкладке «Сводки ИИ». Пусто — значит, никто его об этом не просил.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textMuted, height: 1.4),
              ),
            ),
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
    'order_item_voided': 'Отменена позиция',
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
                          if (mounted) setState(() => _aiResult = 'Ошибка: ${humanError(e, lower: true)}');
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
                  final details = d['details'] is Map ? Map<String, dynamic>.from(d['details'] as Map) : const {};
                  // Отмена: что, почему и кто разрешил.
                  final voidInfo = d['action'] == 'order_item_voided'
                      ? '\n${details['item'] ?? ''} — ${details['reason'] ?? ''}'
                          '${details['approvedBy'] != null && details['approvedBy'] != d['employeeName'] ? ' (разрешил ${details['approvedBy']})' : ''}'
                      : '';
                  return ListTile(
                    dense: true,
                    leading: const Icon(Icons.receipt_long, color: AppColors.textMuted),
                    title: Text(
                      _labels[d['action']] ?? d['action']?.toString() ?? '',
                      style: const TextStyle(color: AppColors.textPrimary),
                    ),
                    subtitle: Text(
                      '${d['employeeName'] ?? ''} · ${_fmt(date)}'
                      '${d['tableName'] != null && d['tableName'].toString().isNotEmpty ? ' · ${d['tableName']}' : ''}'
                      '$voidInfo',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                    trailing: amount == 0
                        ? null
                        : Text(rub(amount),
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
