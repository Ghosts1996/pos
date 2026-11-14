import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../../data/app_db.dart';
import '../../services/app_scope.dart';
import '../../services/egais_service.dart';
import '../../utils/human_error.dart';

/// Накладные поставщиков из УТМ: принять целиком, принять с расхождениями
/// по количеству или отказать. Акт приёмки (WayBillAct_v4) подписывает и
/// отправляет в ЕГАИС сам УТМ; ответ ЕГАИС (квитанция Ticket) придёт во
/// входящие документы.
class EgaisWaybillsScreen extends StatefulWidget {
  const EgaisWaybillsScreen({super.key, required this.service, this.docs});

  final EgaisUtmService service;
  final List<EgaisIncomingDoc>? docs;

  @override
  State<EgaisWaybillsScreen> createState() => _EgaisWaybillsScreenState();
}

class _EgaisWaybillsScreenState extends State<EgaisWaybillsScreen> {
  List<EgaisWaybill>? _list;
  String? _error;
  final Set<String> _busy = {};
  final Map<String, String> _done = {};

  /// Ответы, уже отправленные по накладным (с любой кассы заведения):
  /// settings/egaisActs.acts[<номер справки>] = {kind, at}. Второй акт по той
  /// же накладной ЕГАИС отклонит, а кассир решит, что приёмка не прошла.
  DocumentReference<Map<String, dynamic>> get _actsRef => AppScope.col('settings').doc('egaisActs');
  Map<String, dynamic> _acts = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _list = null;
      _error = null;
    });
    try {
      final list = await widget.service.waybills(widget.docs);
      try {
        final d = await _actsRef.get();
        _acts = Map<String, dynamic>.from((d.data()?['acts'] as Map?) ?? const {});
      } catch (_) {}
      if (mounted) setState(() => _list = list);
    } catch (e) {
      if (mounted) setState(() => _error = humanError(e));
    }
  }

  Future<void> _send(EgaisWaybill wb, {required bool accept, Map<String, num> real = const {}}) async {
    final what = !accept
        ? 'Отказаться от накладной № ${wb.number}? Поставщик получит отказ, продукция к вам не поступит.'
        : real.isEmpty
            ? 'Принять накладную № ${wb.number} целиком? Продукция поступит на ваш склад в ЕГАИС.'
            : 'Отправить акт расхождений по накладной № ${wb.number}?';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Ответ в ЕГАИС'),
        content: Text('$what\n\nАкт подпишет УТМ ключом организации. Отменить его потом нельзя — только новым документом с поставщиком.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(accept ? 'Отправить' : 'Отказать')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy.add(wb.url));
    final kind = !accept ? 'rejected' : real.isEmpty ? 'accepted' : 'differences';
    // Занять накладную транзакцией: две кассы, нажавшие разом, не отправят два акта.
    String? taken;
    try {
      taken = await AppDb.instance.runTransaction<String?>((tx) async {
        final snap = await tx.get(_actsRef);
        final acts = (snap.data()?['acts'] as Map?) ?? const {};
        if (acts[wb.regId] != null) return 'Ответ по этой накладной уже отправлен с другой кассы — ждите квитанцию ЕГАИС во входящих.';
        tx.set(_actsRef, {'acts': {wb.regId: {'kind': kind, 'at': FieldValue.serverTimestamp(), 'number': wb.number}}}, SetOptions(merge: true));
        return null;
      });
    } catch (e) {
      taken = 'Нет связи с сервером — ответ не отправлен, попробуйте ещё раз.';
    }
    if (taken != null) {
      if (mounted) setState(() { _busy.remove(wb.url); _done[wb.url] = taken!; });
      return;
    }
    try {
      final reply = await widget.service.sendAct(wb, accept: accept, real: real);
      if (!mounted) return;
      setState(() => _done[wb.url] = !accept
          ? 'Отказ отправлен в УТМ${reply.isEmpty ? '' : ' (запрос $reply)'} — ждите квитанцию ЕГАИС во входящих.'
          : 'Акт отправлен в УТМ${reply.isEmpty ? '' : ' (запрос $reply)'} — ждите квитанцию ЕГАИС во входящих.');
    } catch (e) {
      // УТМ не принял — снимаем отметку, ответить можно снова.
      await _actsRef.set({'acts': {wb.regId: FieldValue.delete()}}, SetOptions(merge: true)).catchError((Object _) {});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    } finally {
      if (mounted) setState(() => _busy.remove(wb.url));
    }
  }

  Future<void> _differences(EgaisWaybill wb) async {
    final ctrls = {for (final p in wb.positions) p.identity: TextEditingController(text: _fmt(p.quantity))};
    final real = await showDialog<Map<String, num>>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Сколько пришло · № ${wb.number}'),
        content: SizedBox(
          width: 420,
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final p in wb.positions)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: TextField(
                    controller: ctrls[p.identity],
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: InputDecoration(labelText: p.name.isEmpty ? 'Позиция ${p.identity}' : p.name, helperText: 'В накладной: ${_fmt(p.quantity)}'),
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(
            onPressed: () {
              final out = <String, num>{};
              for (final p in wb.positions) {
                final v = num.tryParse(ctrls[p.identity]!.text.trim().replaceAll(',', '.'));
                if (v != null && v >= 0 && v != p.quantity) out[p.identity] = v;
              }
              Navigator.pop(ctx, out);
            },
            child: const Text('Дальше'),
          ),
        ],
      ),
    );
    for (final c in ctrls.values) {
      c.dispose();
    }
    if (real == null) return;
    if (real.isEmpty) {
      await _send(wb, accept: true);
    } else {
      await _send(wb, accept: true, real: real);
    }
  }

  static String _answeredText(Object? a) {
    final kind = a is Map ? a['kind'] : null;
    final what = kind == 'rejected' ? 'Отказ' : kind == 'differences' ? 'Акт расхождений' : 'Приёмка';
    return '$what уже отправлен(а) в УТМ — ждите квитанцию ЕГАИС во входящих.';
  }

  static String _fmt(num v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString().replaceAll('.', ',');

  @override
  Widget build(BuildContext context) {
    final list = _list;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Накладные ЕГАИС'),
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh), tooltip: 'Обновить')],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)))
          : list == null
              ? const Center(child: CircularProgressIndicator())
              : list.isEmpty
                  ? const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Новых накладных от поставщиков в УТМ нет', textAlign: TextAlign.center)))
                  : ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        for (final wb in list)
                          Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('№ ${wb.number} от ${wb.date}', style: Theme.of(context).textTheme.titleMedium),
                                  if (wb.shipper.isNotEmpty) Text(wb.shipper),
                                  const SizedBox(height: 6),
                                  for (final p in wb.positions.take(8)) Text('• ${p.name} — ${_fmt(p.quantity)}', style: const TextStyle(fontSize: 13)),
                                  if (wb.positions.length > 8) Text('… и ещё ${wb.positions.length - 8}', style: const TextStyle(fontSize: 13)),
                                  const SizedBox(height: 8),
                                  if (wb.regId.isEmpty)
                                    const Text('Справки к накладной ещё нет — ответить можно, когда она придёт в УТМ.',
                                        style: TextStyle(fontSize: 13))
                                  else if (_done[wb.url] != null)
                                    Text(_done[wb.url]!, style: const TextStyle(fontSize: 13))
                                  else if (_acts[wb.regId] != null)
                                    Text(_answeredText(_acts[wb.regId]), style: const TextStyle(fontSize: 13))
                                  else if (_busy.contains(wb.url))
                                    const LinearProgressIndicator()
                                  else
                                    Wrap(
                                      spacing: 8,
                                      runSpacing: 8,
                                      children: [
                                        FilledButton(onPressed: () => _send(wb, accept: true), child: const Text('Принять')),
                                        OutlinedButton(onPressed: () => _differences(wb), child: const Text('Расхождения')),
                                        TextButton(onPressed: () => _send(wb, accept: false), child: const Text('Отказать')),
                                      ],
                                    ),
                                ],
                              ),
                            ),
                          ),
                      ],
                    ),
    );
  }
}
