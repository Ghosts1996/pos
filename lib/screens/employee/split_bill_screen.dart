import 'package:flutter/material.dart';

import '../../models/employee.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/bill_split.dart';
import '../../utils/table_label.dart';

/// «Разделить счёт» — компания платит не одним чеком.
///
/// Два способа, как это бывает в зале:
///  • «Поровну» — сколько с каждого, если делят на N человек (с честным
///    распределением остатка, чтобы доли сходились со счётом до копейки);
///  • «По позициям» — выбранные позиции уходят в отдельный чек за тем же
///    столом, и его закрывают своей оплатой.
///
/// Возвращает id нового чека, если позиции перенесли.
class SplitBillScreen extends StatefulWidget {
  final SessionModel session;
  final TableModel table;
  final Employee employee;
  const SplitBillScreen({super.key, required this.session, required this.table, required this.employee});

  @override
  State<SplitBillScreen> createState() => _SplitBillScreenState();
}

class _SplitBillScreenState extends State<SplitBillScreen> {
  final _fs = FirestoreService();
  bool _byItems = false;
  int _people = 2;

  /// Сколько штук каждой строки переносим в новый чек (по индексу строки).
  final Map<int, int> _move = {};
  final _tag = TextEditingController();
  bool _busy = false;

  SessionModel get s => widget.session;
  double get _k => 1 - s.discountPercent / 100;

  @override
  void dispose() {
    _tag.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Разделить счёт')),
      body: LayoutBuilder(builder: (context, box) {
        final side = box.maxWidth > 632 ? (box.maxWidth - 600) / 2 : 16.0;
        return Column(
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(side, 12, side, 4),
              child: SizedBox(
                width: double.infinity,
                child: SegmentedButton<bool>(
                  segments: const [
                    ButtonSegment(value: false, icon: Icon(Icons.groups_outlined), label: Text('Поровну')),
                    ButtonSegment(value: true, icon: Icon(Icons.checklist_rounded), label: Text('По позициям')),
                  ],
                  selected: {_byItems},
                  onSelectionChanged: (v) => setState(() => _byItems = v.first),
                ),
              ),
            ),
            Expanded(child: _byItems ? _itemsMode(side) : _evenMode(side)),
          ],
        );
      }),
    );
  }

  // ---------- ПОРОВНУ ----------

  Widget _evenMode(double side) {
    final totalK = (s.totalWithDiscount * 100).round();
    final shares = splitEvenlyKopecks(totalK, _people);
    final equal = shares.isEmpty || shares.every((x) => x == shares.first);
    return ListView(
      padding: EdgeInsets.fromLTRB(side, 16, side, 24),
      children: [
        _card(
          child: Column(
            children: [
              const Text('Сколько человек платят', style: TextStyle(color: AppColors.textMuted)),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _roundBtn(Icons.remove, _people > 2 ? () => setState(() => _people--) : null, 'Меньше'),
                  SizedBox(
                    width: 96,
                    child: Text('$_people',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 44, fontWeight: FontWeight.w700)),
                  ),
                  _roundBtn(Icons.add, _people < 30 ? () => setState(() => _people++) : null, 'Больше'),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        _card(
          child: Column(
            children: [
              Text(totalK <= 0 ? 'Счёт пока пустой' : 'С каждого',
                  style: const TextStyle(color: AppColors.textMuted)),
              const SizedBox(height: 4),
              if (totalK > 0)
                Text(
                  equal ? formatKopecks(shares.first) : '${formatKopecks(shares.last)} – ${formatKopecks(shares.first)}',
                  style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w700, color: AppColors.success),
                ),
              const SizedBox(height: 6),
              Text('Счёт ${formatKopecks(totalK)}${s.discountPercent > 0 ? ' (со скидкой ${s.discountPercent.toStringAsFixed(0)}%)' : ''}',
                  style: const TextStyle(color: AppColors.textMuted)),
              if (!equal) ...[
                const SizedBox(height: 10),
                Text(
                  'Поровну не делится: ${shares.where((x) => x == shares.first).length} '
                  '${pluralRu(shares.where((x) => x == shares.first).length, 'гость платит', 'гостя платят', 'гостей платят')} '
                  'по ${formatKopecks(shares.first)}, остальные — по ${formatKopecks(shares.last)}.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 13),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          'Оплату принимайте на экране «Закрыть стол» — по частям: наличными, '
          'картой, с терминала. Если каждый платит за своё, выберите «По позициям».',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13),
        ),
      ],
    );
  }

  // ---------- ПО ПОЗИЦИЯМ ----------

  Widget _itemsMode(double side) {
    final full = widget.table.activeSessionIds.length >= widget.table.maxOpenSessions;
    final items = s.orderItems;
    var movedSum = 0.0;
    var movedCount = 0;
    for (var i = 0; i < items.length; i++) {
      final m = _move[i] ?? 0;
      movedSum += items[i].price * m * _k;
      movedCount += m;
    }
    final leftSum = s.totalWithDiscount - movedSum;
    final everything = items.isNotEmpty && movedCount == items.fold<int>(0, (a, i) => a + i.qty);

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(side, 16, side, 16),
            children: [
              const Text('Отметьте, что уходит в отдельный чек',
                  style: TextStyle(color: AppColors.textMuted)),
              const SizedBox(height: 10),
              Container(
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppColors.border),
                ),
                child: Column(
                  children: [
                    for (var i = 0; i < items.length; i++) ...[
                      if (i > 0) const Divider(height: 1, color: AppColors.border),
                      _itemRow(i),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _tag,
                maxLength: 24,
                decoration: const InputDecoration(
                  labelText: 'Чей новый чек (необязательно)',
                  hintText: 'Например, Иван',
                ),
              ),
              if (full)
                Text(
                  'За столом уже ${widget.table.activeSessionIds.length} из ${widget.table.maxOpenSessions} чеков — '
                  'сначала закройте один или увеличьте лимит стола в «Карте зала».',
                  style: const TextStyle(color: AppColors.warning),
                ),
              if (everything)
                const Text(
                  'Все позиции уходят в новый чек — тогда проще не делить, а оплатить этот.',
                  style: TextStyle(color: AppColors.warning),
                ),
            ],
          ),
        ),
        Container(
          decoration: const BoxDecoration(
            color: AppColors.surfaceElevated,
            border: Border(top: BorderSide(color: AppColors.border)),
          ),
          padding: EdgeInsets.fromLTRB(side, 12, side, 12 + MediaQuery.of(context).padding.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(child: _sum('Новый чек', movedSum, AppColors.success)),
                  Expanded(child: _sum('Останется здесь', leftSum, AppColors.textPrimary)),
                ],
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: FilledButton.icon(
                  onPressed: _busy || full || movedCount == 0 || everything ? null : _split,
                  icon: _busy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.call_split_rounded),
                  label: Text(movedCount == 0
                      ? 'Выберите позиции'
                      : 'Перенести в новый чек · $movedCount ${pluralRu(movedCount, 'позиция', 'позиции', 'позиций')}'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _itemRow(int i) {
    final item = s.orderItems[i];
    final m = _move[i] ?? 0;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: m > 0 ? AppColors.success : AppColors.textPrimary)),
                Text('${item.price.toStringAsFixed(0)} ₽ · в чеке ${item.qty}',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
              ],
            ),
          ),
          _roundBtn(Icons.remove, m > 0 ? () => setState(() => _move[i] = m - 1) : null, 'Меньше', small: true),
          SizedBox(
            width: 34,
            child: Text('$m',
                textAlign: TextAlign.center,
                style: TextStyle(fontWeight: FontWeight.w700, color: m > 0 ? AppColors.success : AppColors.textMuted)),
          ),
          _roundBtn(Icons.add, m < item.qty ? () => setState(() => _move[i] = m + 1) : null, 'Больше', small: true),
        ],
      ),
    );
  }

  Future<void> _split() async {
    final moveQty = <String, int>{};
    for (final e in _move.entries) {
      if (e.value <= 0) continue;
      final key = FirestoreService.splitKey(s.orderItems[e.key]);
      moveQty[key] = (moveQty[key] ?? 0) + e.value;
    }
    setState(() => _busy = true);
    try {
      final id = await _fs.splitOffItems(
        sessionId: s.id,
        tableId: s.tableId,
        moveQty: moveQty,
        employeeName: widget.employee.name,
        employeeId: widget.employee.id,
        guestTag: _tag.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(id);
    } on TableFullException catch (e) {
      _snack(e.toString());
    } on StateError catch (e) {
      _snack(e.message);
    } catch (_) {
      _snack('Не удалось разделить счёт — проверьте интернет');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---------- ОБЩЕЕ ----------

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Widget _card({required Widget child}) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppColors.border),
        ),
        child: child,
      );

  Widget _sum(String label, double v, Color color) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
          Text(formatKopecks((v * 100).round()),
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: color)),
        ],
      );

  Widget _roundBtn(IconData icon, VoidCallback? onTap, String tip, {bool small = false}) => SizedBox(
        width: small ? 40 : 56,
        height: small ? 40 : 56,
        child: IconButton.filledTonal(
          tooltip: tip,
          onPressed: onTap,
          iconSize: small ? 18 : 26,
          icon: Icon(icon),
        ),
      );
}
