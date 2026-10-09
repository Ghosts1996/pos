import 'package:flutter/material.dart';

import '../models/delivery_status.dart';
import '../models/employee.dart';
import '../models/session_model.dart';
import '../screens/employee/table_detail_screen.dart';
import '../services/app_scope.dart';
import '../services/firestore_service.dart';
import '../services/pii_gateway_service.dart';
import '../theme/app_colors.dart';
import '../utils/human_error.dart';
import '../utils/money.dart';

/// Кнопка «С собой и доставка» в шапке зала — со счётчиком открытых заказов.
class TakeawayButton extends StatelessWidget {
  final Employee employee;
  const TakeawayButton({super.key, required this.employee});

  @override
  Widget build(BuildContext context) => StreamBuilder<List<SessionModel>>(
        stream: FirestoreService().takeawaySessionsStream(),
        builder: (context, snap) {
          final n = snap.data?.length ?? 0;
          return IconButton(
            tooltip: 'С собой и доставка',
            onPressed: () => TakeawaySheet.show(context, employee),
            icon: Badge(
              isLabelVisible: n > 0,
              label: Text('$n'),
              child: const Icon(Icons.shopping_bag_outlined),
            ),
          );
        },
      );
}

/// Заказы с собой и доставка: открытые заказы и кнопки «новый». Каждый
/// заказ — отдельный чек служебного стола, поэтому меню, бегунки на кухню,
/// оплата и фискальный чек работают как за столом.
class TakeawaySheet extends StatelessWidget {
  final Employee employee;
  const TakeawaySheet({super.key, required this.employee});

  static Future<void> show(BuildContext context, Employee employee) => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => TakeawaySheet(employee: employee),
      );

  Future<void> _open(BuildContext context, String sessionId) async {
    final fs = FirestoreService();
    final table = await fs.ensureTakeawayTable();
    if (!context.mounted) return;
    final nav = Navigator.of(context);
    nav.pop();
    nav.push(MaterialPageRoute(
      builder: (_) => TableDetailScreen(table: table, employee: employee, sessionId: sessionId),
    ));
  }

  Future<void> _create(BuildContext context, {required bool delivery}) async {
    final data = await showDialog<_NewOrder>(context: context, builder: (_) => _NewOrderDialog(delivery: delivery));
    if (data == null || !context.mounted) return;
    final fs = FirestoreService();
    try {
      final table = await fs.ensureTakeawayTable();
      // Телефон и адрес — сначала в базу в РФ (ч. 5 ст. 18 152-ФЗ), потом
      // копия в чек. Без связи с сервером такой заказ не создаём.
      final sessionId = AppScope.col('sessions').doc().id;
      if (data.phone.isNotEmpty || data.address.isNotEmpty) {
        await PiiGatewayService()
            .recordContact(kind: 'delivery', id: sessionId, name: data.name, phone: data.phone, address: data.address);
      }
      final now = TimeOfDay.now();
      final who = data.name.isNotEmpty
          ? data.name
          : '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
      final id = await fs.openSession(
        table: table,
        employeeName: employee.name,
        employeeId: employee.id,
        guestTag: data.name,
        tableName: '${delivery ? 'Доставка' : 'С собой'} · $who',
        orderType: delivery ? 'delivery' : 'takeaway',
        customerPhone: data.phone,
        deliveryAddress: data.address,
        sessionId: sessionId,
      );
      if (context.mounted) await _open(context, id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось создать заказ: ${humanError(e, lower: true)}')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('С собой и доставка', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => _create(context, delivery: false),
                    icon: const Icon(Icons.shopping_bag_outlined),
                    label: const Text('С собой'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () => _create(context, delivery: true),
                    icon: const Icon(Icons.delivery_dining_rounded),
                    label: const Text('Доставка'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Flexible(
              child: StreamBuilder<List<SessionModel>>(
                stream: FirestoreService().takeawaySessionsStream(),
                builder: (context, snap) {
                  final list = snap.data ?? const <SessionModel>[];
                  if (!snap.hasData) {
                    return const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  if (list.isEmpty) {
                    return const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Text('Открытых заказов нет',
                          textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
                    );
                  }
                  return ListView.separated(
                    shrinkWrap: true,
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) {
                      final s = list[i];
                      final delivery = s.orderType == 'delivery';
                      final mins = DateTime.now().difference(s.startTime).inMinutes;
                      final sub = [
                        DeliveryFlow.label(s.orderType, s.deliveryStatus),
                        if (s.customerPhone.isNotEmpty) s.customerPhone,
                        if (s.deliveryAddress.isNotEmpty) s.deliveryAddress,
                        '$mins мин',
                      ].join(' · ');
                      return Card(
                        margin: EdgeInsets.zero,
                        child: ListTile(
                          leading: Icon(delivery ? Icons.delivery_dining_rounded : Icons.shopping_bag_outlined,
                              color: AppColors.primary),
                          title: Text(s.tableName, maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(sub, maxLines: 2, overflow: TextOverflow.ellipsis),
                          trailing: Text(rub(s.totalWithDiscount),
                              style: const TextStyle(fontWeight: FontWeight.w700)),
                          onTap: () => _open(context, s.id),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NewOrder {
  final String name;
  final String phone;
  final String address;
  const _NewOrder(this.name, this.phone, this.address);
}

class _NewOrderDialog extends StatefulWidget {
  final bool delivery;
  const _NewOrderDialog({required this.delivery});

  @override
  State<_NewOrderDialog> createState() => _NewOrderDialogState();
}

class _NewOrderDialogState extends State<_NewOrderDialog> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _address = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _address.dispose();
    super.dispose();
  }

  void _submit() {
    if (widget.delivery && _address.text.trim().isEmpty) {
      setState(() => _error = 'Укажите адрес доставки');
      return;
    }
    Navigator.pop(context, _NewOrder(_name.text.trim(), _phone.text.trim(), _address.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: Text(widget.delivery ? 'Новая доставка' : 'Заказ с собой'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Имя гостя или номер заказа (необязательно)'),
          ),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: InputDecoration(labelText: widget.delivery ? 'Телефон' : 'Телефон (необязательно)'),
          ),
          if (widget.delivery)
            TextField(
              controller: _address,
              minLines: 1,
              maxLines: 3,
              decoration: InputDecoration(labelText: 'Адрес доставки', errorText: _error),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(onPressed: _submit, child: const Text('Открыть заказ')),
      ],
    );
  }
}
