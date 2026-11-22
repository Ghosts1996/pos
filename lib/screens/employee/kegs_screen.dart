import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/employee.dart';
import '../../models/menu_models.dart';
import '../../services/chestny_znak_api_service.dart';
import '../../services/chestny_znak_service.dart';
import '../../services/firestore_service.dart';
import '../../services/keg_service.dart';
import '../../services/scanner_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';

/// Разливное пиво (SaaS): кеги на кране — остаток, какие позиции из какой
/// кеги, «Поставить кегу на кран» и «Кега закончилась».
class KegsScreen extends StatelessWidget {
  final Employee employee;
  const KegsScreen({super.key, required this.employee});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Кеги на кране')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ConnectKegScreen(employee: employee))),
        icon: const Icon(Icons.add),
        label: const Text('Поставить кегу'),
      ),
      body: StreamBuilder<List<Keg>>(
        stream: KegService.instance.onTapStream(),
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text(humanError(snap.error)));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final kegs = snap.data!;
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
            children: [
              Text(
                'Разливное пиво продаётся с кодом кеги: каждая порция уходит в чек с кодом и объёмом в литрах. '
                'Подключение кеги к крану нужно отметить и в личном кабинете «Честного знака» (документ подписывается электронной подписью) — '
                'в течение 3 рабочих дней.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
              ),
              const SizedBox(height: 14),
              if (kegs.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 32),
                  child: Text('На кранах пока нет кег', textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted)),
                ),
              for (final k in kegs) KegCard(keg: k, employee: employee),
            ],
          );
        },
      ),
    );
  }
}

/// Карточка кеги: остаток литров, полоска, код, отметка «Честного знака».
class KegCard extends StatelessWidget {
  final Keg keg;
  final Employee employee;
  const KegCard({super.key, required this.keg, required this.employee});

  String _l(double v) => '${v.toStringAsFixed(v == v.roundToDouble() ? 0 : 1).replaceAll('.', ',')} л';

  @override
  Widget build(BuildContext context) {
    final low = keg.leftShare < 0.15;
    final color = low ? AppColors.warning : AppColors.success;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.sports_bar_outlined, color: AppColors.primary),
                const SizedBox(width: 10),
                Expanded(child: Text(keg.name, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                Text('${_l(keg.leftL)} из ${_l(keg.volumeL)}', style: TextStyle(color: color, fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: LinearProgressIndicator(value: keg.leftShare, minHeight: 8, color: color, backgroundColor: color.withValues(alpha: 0.15)),
            ),
            const SizedBox(height: 8),
            Text('Код: …${keg.code.length > 12 ? keg.code.substring(keg.code.length - 12) : keg.code}',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontFamily: 'monospace')),
            const SizedBox(height: 6),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              value: keg.czNotified,
              onChanged: (v) => KegService.instance.setCzNotified(keg.id, v == true),
              title: const Text('Подключение отмечено в «Честном знаке»'),
              subtitle: keg.czNotified ? null : Text('Не забудьте — в течение 3 рабочих дней', style: TextStyle(color: AppColors.warning, fontSize: 12)),
            ),
            Wrap(spacing: 8, runSpacing: 8, children: [
              OutlinedButton.icon(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: keg.code));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Код кеги скопирован — вставьте его в ЛК «Честного знака»')));
                  }
                },
                icon: const Icon(Icons.copy, size: 18),
                label: const Text('Код для ЛК'),
              ),
              TextButton(
                onPressed: () async {
                  final ok = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: Text('«${keg.name}» закончилась?'),
                      content: const Text('Кега снимется с крана, порции из неё больше не будут уходить в чек с её кодом. '
                          'Поставьте следующую кегу, чтобы продолжить продажу.'),
                      actions: [
                        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
                        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Снять с крана')),
                      ],
                    ),
                  );
                  if (ok == true) await KegService.instance.disconnect(keg.id, employee.name);
                },
                child: const Text('Кега закончилась'),
              ),
            ]),
          ],
        ),
      ),
    );
  }
}

/// Поставить кегу на кран: код (сканер или камера), название, объём,
/// позиции меню и литры в порции. Код проверяется в «Честном знаке», если
/// подключена онлайн-проверка (токен или ТС ПИоТ).
class ConnectKegScreen extends StatefulWidget {
  final Employee employee;
  const ConnectKegScreen({super.key, required this.employee});

  @override
  State<ConnectKegScreen> createState() => _ConnectKegScreenState();
}

class _ConnectKegScreenState extends State<ConnectKegScreen> {
  final _code = TextEditingController();
  final _name = TextEditingController();
  double _volume = 30;
  final Map<String, double> _portions = {};
  bool _cz = false;
  bool _saving = false;
  String? _error;
  String? _check;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final code = await showCameraScanner(context, title: 'Код на кеге');
    if (code != null && mounted) {
      _code.text = code;
      await _verify();
    }
  }

  Future<void> _verify() async {
    final cz = ChestnyZnakService();
    final m = cz.parse(_code.text);
    if (m == null) {
      setState(() => _check = 'Это не код маркировки «Честного знака»');
      return;
    }
    setState(() => _check = 'Проверяю код…');
    try {
      final r = await cz.checkOnlineStatus(m);
      if (!mounted) return;
      setState(() => _check = r == null
          ? 'Онлайн-проверка не подключена — код принят по формату'
          : !r.valid
              ? 'Честный знак: ${r.errorMessage ?? 'код не найден'} — такую кегу продавать нельзя'
              : r.alreadyRetired
                  ? 'Код уже выведен из оборота — продавать нельзя'
                  : '✓ Код в порядке');
    } on ChestnyZnakApiException catch (e) {
      if (mounted) setState(() => _check = 'Проверка недоступна: ${humanError(e, lower: true)}');
    }
  }

  Future<void> _save() async {
    if (_check != null && (_check!.contains('нельзя'))) {
      setState(() => _error = 'Эту кегу продавать нельзя — проверьте код');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await KegService.instance.connect(
        code: _code.text,
        name: _name.text,
        volumeL: _volume,
        portions: Map.of(_portions),
        employeeName: widget.employee.name,
        czNotified: _cz,
      );
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _error = e is StateError ? e.message : humanError(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Поставить кегу на кран')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          TextField(
            controller: _code,
            onSubmitted: (_) => _verify(),
            decoration: InputDecoration(
              labelText: 'Код маркировки на кеге',
              helperText: 'Отсканируйте сканером штрихкодов или камерой',
              suffixIcon: IconButton(onPressed: _scan, icon: const Icon(Icons.qr_code_scanner), tooltip: 'Камера'),
            ),
          ),
          if (_check != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(_check!,
                  style: TextStyle(
                      color: _check!.startsWith('✓') ? AppColors.success : _check!.contains('нельзя') ? AppColors.danger : AppColors.textMuted,
                      fontWeight: FontWeight.w600)),
            ),
          const SizedBox(height: 10),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Название', hintText: 'Светлое нефильтрованное')),
          const SizedBox(height: 14),
          Text('Объём кеги', style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final v in const [10.0, 20.0, 30.0, 50.0])
              ChoiceChip(label: Text('${v.toInt()} л'), selected: _volume == v, onSelected: (_) => setState(() => _volume = v)),
          ]),
          const SizedBox(height: 16),
          Text('Что наливаем из этой кеги', style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          StreamBuilder<List<MenuItem>>(
            stream: FirestoreService().menuItemsStream(),
            builder: (context, snap) {
              final all = (snap.data ?? const <MenuItem>[]).where((m) => m.available).toList()..sort((a, b) => a.name.compareTo(b.name));
              // Сначала — похожие на пиво и с объёмом в мл/л.
              bool beerish(MenuItem m) => portionLitersOf(m) > 0 || RegExp(r'пив|лагер|эль|стаут|сидр|beer', caseSensitive: false).hasMatch(m.name);
              final list = [...all.where(beerish), ...all.where((m) => !beerish(m))];
              if (!snap.hasData) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
              return Column(children: [
                for (final m in list.take(60))
                  _PortionRow(
                    item: m,
                    liters: _portions[m.id],
                    onChanged: (v) => setState(() => v == null ? _portions.remove(m.id) : _portions[m.id] = v),
                  ),
              ]);
            },
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _cz,
            onChanged: (v) => setState(() => _cz = v == true),
            title: const Text('Подключение уже отмечено в «Честном знаке»'),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_error!, style: TextStyle(color: AppColors.danger))),
          const SizedBox(height: 12),
          FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Сохраняю…' : 'Поставить на кран')),
        ],
      ),
    );
  }
}

class _PortionRow extends StatelessWidget {
  final MenuItem item;
  final double? liters;
  final ValueChanged<double?> onChanged;
  const _PortionRow({required this.item, required this.liters, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final on = liters != null;
    final def = portionLitersOf(item);
    return Row(children: [
      Checkbox(value: on, onChanged: (v) => onChanged(v == true ? (def > 0 ? def : 0.5) : null)),
      Expanded(child: Text(item.name)),
      if (on)
        DropdownButton<double>(
          value: liters,
          underline: const SizedBox.shrink(),
          items: [
            for (final v in {0.25, 0.3, 0.33, 0.4, 0.5, 1.0, if (def > 0) def, liters!}.toList()..sort())
              DropdownMenuItem(value: v, child: Text('${v.toString().replaceAll('.', ',')} л')),
          ],
          onChanged: (v) => onChanged(v),
        ),
    ]);
  }
}
