import 'package:flutter/material.dart';

import '../models/session_model.dart';
import '../models/table_model.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/money.dart';
import '../utils/table_label.dart';
import 'timer_display.dart';

/// Меню открытых чеков стола: какой открыть или завести новый. Показывается
/// при нажатии на стол с несколькими чеками и из экрана стола («Чеки»).
class TableChecksSheet extends StatelessWidget {
  /// Результат «Открыть новый чек».
  static const newCheck = '__new__';

  final TableModel table;

  /// Чек, который сейчас открыт на экране стола, — отмечается.
  final String? currentId;

  const TableChecksSheet({super.key, required this.table, this.currentId});

  /// id выбранного чека, [newCheck] или null, если меню закрыли.
  static Future<String?> show(BuildContext context, {required TableModel table, String? currentId}) =>
      showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) => TableChecksSheet(table: table, currentId: currentId),
      );

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.sizeOf(context).height * 0.8;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: StreamBuilder<List<SessionModel>>(
          stream: FirestoreService().activeSessionsStream(table.id),
          builder: (context, snap) {
            final sessions = snap.data ?? const <SessionModel>[];
            final canAdd = snap.hasData && sessions.length < table.maxOpenSessions;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(tableLabel(table.name),
                          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text(
                        snap.hasData
                            ? 'Открыто чеков: ${sessions.length} из ${table.maxOpenSessions} · выберите чек'
                            : 'Загружаем чеки…',
                        style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                      ),
                    ],
                  ),
                ),
                if (snap.hasError)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(20, 8, 20, 24),
                    child: Text('Не удалось загрузить чеки — проверьте интернет.',
                        style: TextStyle(color: AppColors.danger)),
                  )
                else if (!snap.hasData)
                  const Padding(
                    padding: EdgeInsets.all(28),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else
                  Flexible(
                    child: ListView.separated(
                      shrinkWrap: true,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemCount: sessions.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 10),
                      itemBuilder: (context, i) => _CheckCard(
                        number: i + 1,
                        session: sessions[i],
                        current: sessions[i].id == currentId,
                        onTap: () => Navigator.pop(context, sessions[i].id),
                      ),
                    ),
                  ),
                if (snap.hasData)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                    child: canAdd
                        ? SizedBox(
                            height: 50,
                            child: OutlinedButton.icon(
                              icon: const Icon(Icons.add),
                              label: const Text('Открыть новый чек'),
                              onPressed: () => Navigator.pop(context, newCheck),
                            ),
                          )
                        : Text(
                            'На этом столе уже максимум чеков — ${table.maxOpenSessions}.',
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5),
                          ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _CheckCard extends StatelessWidget {
  final int number;
  final SessionModel session;
  final bool current;
  final VoidCallback onTap;

  const _CheckCard({required this.number, required this.session, required this.current, required this.onTap});

  static String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final s = session;
    final guest = s.guestTag.trim();
    final items = s.orderItems.fold<int>(0, (n, i) => n + i.qty);
    final details = [
      if (s.employeeName.trim().isNotEmpty) s.employeeName.trim(),
      'с ${_hhmm(s.startTime)}',
      items == 0 ? 'пока без заказа' : '$items ${pluralRu(items, 'позиция', 'позиции', 'позиций')}',
    ].join(' · ');
    return Material(
      color: current ? AppColors.selection : AppColors.surfaceElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: current ? AppColors.primary : AppColors.border, width: current ? 1.5 : 1),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: current ? 1 : 0.18),
                  shape: BoxShape.circle,
                ),
                child: Text('$number',
                    style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Flexible(
                        child: Text(
                          guest.isEmpty ? 'Чек $number' : guest,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                        ),
                      ),
                      if (current) ...[
                        const SizedBox(width: 8),
                        const Text('сейчас открыт',
                            style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                      ],
                    ]),
                    const SizedBox(height: 3),
                    Text(details,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(rub(s.totalWithDiscount),
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  TimerDisplay(plannedEnd: s.plannedEnd, startTime: s.startTime, fontSize: 13),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
