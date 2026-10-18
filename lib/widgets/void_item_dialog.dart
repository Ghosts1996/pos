import 'package:flutter/material.dart';

import '../models/employee.dart';
import '../models/session_model.dart';
import '../services/audit_log_service.dart';
import '../services/firestore_service.dart';
import '../theme/app_colors.dart';
import '../utils/money.dart';
import '../services/people_directory.dart';

/// Штуку строки уже готовят: убрать её — это отмена, а не правка заказа.
/// Новое (не ушедшее бегунком и не готовое) убирается свободно.
bool voidNeedsApproval(OrderItem line) => line.qty - 1 < (line.sent > line.ready ? line.sent : line.ready);

/// Отмена позиции, которую уже готовят: причина обязательна, а если
/// убирает не администратор — нужен PIN администратора. Пишется в журнал
/// кассы («Отменена позиция»). Возвращает true, если отмену подтвердили.
Future<bool> confirmVoid(
  BuildContext context, {
  required Employee employee,
  required OrderItem line,
  required String sessionId,
  String tableName = '',
}) async {
  final approved = await showDialog<(String, String, bool)>(
    context: context,
    builder: (_) => _VoidDialog(employee: employee, line: line),
  );
  if (approved == null) return false;
  await AuditLogService.instance.log(
    action: 'order_item_voided',
    employeeName: employee.name,
    sessionId: sessionId,
    tableName: tableName,
    amount: line.price,
    details: {
      'item': line.displayName,
      'qty': 1,
      'reason': approved.$1,
      'approvedBy': Pd.who(approved.$2),
      if (approved.$3) 'stockWrittenOff': true,
    },
  );
  // Блюдо уже приготовили — продукты потрачены, списываем по рецепту:
  // иначе при оплате оно не спишется (его нет в чеке) и склад «поплывёт».
  if (approved.$3) {
    try {
      await FirestoreService().writeOffVoidedItem(line, why: approved.$1, employeeName: employee.name);
    } catch (_) {
      // Списание — учёт; отмену позиции оно не блокирует.
    }
  }
  return true;
}

class _VoidDialog extends StatefulWidget {
  final Employee employee;
  final OrderItem line;
  const _VoidDialog({required this.employee, required this.line});

  @override
  State<_VoidDialog> createState() => _VoidDialogState();
}

class _VoidDialogState extends State<_VoidDialog> {
  static const _reasons = ['Ошибка официанта', 'Гость отказался', 'Долго готовили', 'Брак / не понравилось'];
  String _reason = '';
  final _other = TextEditingController();
  final _pin = TextEditingController();
  String _error = '';
  bool _busy = false;
  // Уже начали готовить или приготовили — продукты, скорее всего, потрачены.
  late bool _writeOff = widget.line.ready > 0 || widget.line.accepted > 0;

  bool get _selfApproves => widget.employee.role == 'admin';

  String get _finalReason => _reason == 'Другое' ? _other.text.trim() : _reason;

  Future<void> _submit() async {
    if (_finalReason.isEmpty) {
      setState(() => _error = 'Укажите причину');
      return;
    }
    var approver = widget.employee.name;
    if (!_selfApproves) {
      setState(() {
        _busy = true;
        _error = '';
      });
      final admin = await FirestoreService().findByPin(_pin.text.trim()).catchError((_) => null);
      if (!mounted) return;
      if (admin == null || admin.role != 'admin') {
        setState(() {
          _busy = false;
          _error = 'Нужен PIN администратора';
        });
        return;
      }
      approver = admin.name;
    }
    if (mounted) Navigator.of(context).pop((_finalReason, approver, _writeOff));
  }

  @override
  void dispose() {
    _other.dispose();
    _pin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: const Text('Отменить позицию'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${widget.line.displayName} · ${rub(widget.line.price)}',
              style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text('Её уже готовят — отмена попадёт в журнал кассы.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final r in [..._reasons, 'Другое'])
                ChoiceChip(
                  label: Text(r),
                  selected: _reason == r,
                  onSelected: (_) => setState(() {
                    _reason = r;
                    _error = '';
                  }),
                ),
            ],
          ),
          if (_reason == 'Другое')
            TextField(
              controller: _other,
              maxLength: 80,
              decoration: const InputDecoration(labelText: 'Причина'),
            ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _writeOff,
            onChanged: (v) => setState(() => _writeOff = v),
            title: const Text('Продукты уже потрачены — списать со склада'),
            subtitle: const Text('По рецепту блюда. Выключите, если ещё не начали готовить',
                style: TextStyle(fontSize: 12)),
          ),
          if (!_selfApproves) ...[
            const SizedBox(height: 8),
            TextField(
              controller: _pin,
              obscureText: true,
              keyboardType: TextInputType.number,
              maxLength: 8,
              decoration: const InputDecoration(labelText: 'PIN администратора', counterText: ''),
              onSubmitted: (_) => _submit(),
            ),
          ],
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error, style: TextStyle(color: AppColors.danger)),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Не отменять')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
          onPressed: _busy ? null : _submit,
          child: const Text('Отменить позицию'),
        ),
      ],
    );
  }
}
