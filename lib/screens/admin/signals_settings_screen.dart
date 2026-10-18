import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../services/background_reliability.dart';

import '../../services/app_scope.dart';
import '../../services/notification_service.dart';
import '../../services/printer_service.dart';
import '../../services/signals/lan_signals.dart';
import '../../services/signals/relay_client.dart';
import '../../services/signals/signal_settings.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';

/// «Звонки и сигналы»: громкий сигнал кухни, вибрация официанту и на
/// часы, Wi‑Fi реле со звонком или лампой, зуммер принтера и сигналы
/// между планшетами без интернета.
class SignalsSettingsScreen extends StatefulWidget {
  const SignalsSettingsScreen({super.key});

  @override
  State<SignalsSettingsScreen> createState() => _SignalsSettingsScreenState();
}

class _SignalsSettingsScreenState extends State<SignalsSettingsScreen> {
  final _doc = AppScope.col('settings').doc('integrations');
  late SignalSettings _s = signalSettings;
  bool _loading = true;
  bool _dirty = false;
  bool _saving = false;
  String? _lanResult;
  bool _lanChecking = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = (await _doc.get()).data();
      if (mounted) setState(() => _s = SignalSettings.fromMap(data));
    } catch (e) {
      _snack('Не удалось загрузить: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _edit(SignalSettings next) => setState(() {
        _s = next;
        _dirty = true;
      });

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await _doc.set(_s.toMap(), SetOptions(merge: true));
      applySignalSettings(_s.toMap());
      if (mounted) {
        setState(() => _dirty = false);
        _snack('Сохранено — работает на всех устройствах заведения');
      }
    } catch (e) {
      _snack('Не удалось сохранить: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _snack(String t) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Изменения не сохранены'),
            content: const Text('Выйти без сохранения?'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Выйти')),
              FilledButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Остаться')),
            ],
          ),
        );
        if (leave == true && context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Звонки и сигналы')),
        floatingActionButton: _dirty
            ? FloatingActionButton.extended(
                onPressed: _saving ? null : _save,
                icon: _saving
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.save_outlined),
                label: const Text('Сохранить'),
              )
            : null,
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
                children: [
                  _kitchen(),
                  _waiter(),
                  _relays(),
                  _printer(),
                  _lan(),
                ],
              ),
      ),
    );
  }

  // ---------------------------------------------------------------- кухня

  Widget _kitchen() => _Section(
        icon: Icons.restaurant,
        title: 'Сигнал нового заказа на кухне',
        children: [
          const _Hint('Работает сам на экране «Кухня и бар». Новый заказ звучит громкостью будильника и '
              'повторяется каждые 4 секунды, пока повар не нажмёт «Принял». Не приняли за 45 секунд — '
              'ещё раз звонит реле на раздаче (если оно настроено ниже). Выключить звук можно колокольчиком '
              'справа вверху на экране кухни.'),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () async {
              final id = NotificationService.idFor('kitchen_alarm_test');
              await NotificationService.instance
                  .showAlarm(id: id, title: 'Проверка сигнала кухни', body: 'Стол 5: Цезарь ×2, Лимонад');
              Timer(const Duration(seconds: 8), () => NotificationService.instance.cancel(id));
              _snack('Сигнал звучит 8 секунд. Не слышно — прибавьте громкость будильника на планшете');
            },
            icon: const Icon(Icons.volume_up_outlined),
            label: const Text('Проверить сигнал на этом планшете'),
          ),
        ],
      );

  // ------------------------------------------------------------- официант

  Widget _waiter() => _Section(
        icon: Icons.watch_outlined,
        title: 'Официанту: вибрация и часы',
        children: [
          const _Hint('Каждое событие — отдельное уведомление с длинной вибрацией, и в заголовке сразу видно, '
              'что случилось: «✅ Готово · Стол 5», «🔥 Зовут кальянщика», «🙋 Зовут официанта», «🧾 Просят счёт», '
              '«📱 Заказ из приложения», «📅 Новая бронь», «🔥 Пора менять угли». Любые часы и браслеты, которые '
              'показывают уведомления телефона, повторят их на руке: Huawei, Honor, Xiaomi, Amazfit, Samsung, '
              'Garmin и другие. Для этого в приложении часов на телефоне включите уведомления для ZalPOS.'),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: () async {
                  await NotificationService.instance.showUrgent(
                    id: NotificationService.idFor('ready_test_${DateTime.now().millisecondsSinceEpoch}'),
                    title: '✅ Готово · Стол 5',
                    body: 'Можно выносить: Цезарь ×2, Лимонад',
                  );
                  _snack('Уведомление отправлено — проверьте вибрацию телефона');
                },
                icon: const Icon(Icons.vibration),
                label: const Text('Проверить вибрацию'),
              ),
              OutlinedButton.icon(
                onPressed: _testWatch,
                icon: const Icon(Icons.watch_outlined),
                label: const Text('Проверить часы'),
              ),
            ],
          ),
          const SizedBox(height: 6),
          const _Hint('Часы Huawei и Honor получают уведомления, только когда экран телефона выключен. '
              '«Проверить часы» пришлёт три уведомления через 10 секунд — заблокируйте телефон и смотрите на часы.'),
          const SizedBox(height: 10),
          const _BackgroundCheck(),
        ],
      );

  /// Три разных уведомления с паузой: успеть заблокировать телефон, а
  /// на часах — увидеть, что каждое подписано по-своему.
  Future<void> _testWatch() async {
    _snack('Заблокируйте телефон — через 10 секунд придут три уведомления');
    const tests = [
      ('🔥 Зовут кальянщика · Стол 3', 'Гость ждёт за столом'),
      ('🧾 Просят счёт · Диван 8', 'Гость ждёт счёт'),
      ('✅ Готово · Стол 5', 'Можно выносить: Цезарь ×2, Лимонад'),
    ];
    await Future<void>.delayed(const Duration(seconds: 10));
    for (final (title, body) in tests) {
      await NotificationService.instance.showUrgent(
        id: NotificationService.idFor('watch_test_$title'),
        title: title,
        body: body,
      );
      await Future<void>.delayed(const Duration(seconds: 4));
    }
  }

  // ----------------------------------------------------------------- реле

  Widget _relays() => _Section(
        icon: Icons.electrical_services,
        title: 'Wi‑Fi реле: звонок, лампа, пейджер',
        children: [
          const _Hint('Реле Shelly или Sonoff включает обычный звонок, лампу или кнопку системы вызова '
              'официанта (часы-пейджеры). Работает внутри Wi‑Fi заведения — интернет не нужен.'),
          const SizedBox(height: 8),
          for (final r in _s.relays) _relayTile(r),
          const SizedBox(height: 4),
          OutlinedButton.icon(
            onPressed: () => _editRelay(null),
            icon: const Icon(Icons.add),
            label: const Text('Добавить реле'),
          ),
        ],
      );

  Widget _relayTile(RelayDevice r) => Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ListTile(
          leading: Icon(r.enabled ? Icons.power : Icons.power_off, color: r.enabled ? AppColors.success : AppColors.textMuted),
          title: Text(r.name.isEmpty ? 'Реле' : r.name),
          subtitle: Text(
            '${RelayKind.label(r.kind).split(' (').first} · ${r.address}\n'
            '${r.events.isEmpty ? 'события не выбраны' : r.events.map(SignalEvent.label).join('; ')}',
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          isThreeLine: true,
          onTap: () => _editRelay(r),
          trailing: IconButton(
            tooltip: 'Проверить',
            icon: const Icon(Icons.play_circle_outline),
            onPressed: () => _testRelay(r),
          ),
        ),
      );

  Future<void> _testRelay(RelayDevice r) async {
    _snack('Включаю «${r.name}» на ${r.pulseSeconds} с…');
    final err = await RelayClient().pulse(r, vars: const {'event': 'test', 'table': 'Стол 5', 'text': 'проверка'});
    _snack(err == null ? 'Реле ответило — должно было щёлкнуть' : 'Не получилось: $err');
  }

  Future<void> _editRelay(RelayDevice? r) async {
    final res = await showDialog<_RelayEdit>(context: context, builder: (_) => _RelayDialog(initial: r));
    if (res == null) return;
    final list = [..._s.relays];
    if (res.delete) {
      list.removeWhere((x) => x.id == r?.id);
    } else {
      final i = list.indexWhere((x) => x.id == res.device.id);
      if (i >= 0) {
        list[i] = res.device;
      } else {
        list.add(res.device);
      }
    }
    _edit(_s.copyWith(relays: list));
  }

  // -------------------------------------------------------------- принтер

  Widget _printer() => _Section(
        icon: Icons.print_outlined,
        title: 'Зуммер кухонного принтера',
        children: [
          const _Hint('Принтер пищит, когда печатает бегунок. «Встроенный» — у Xprinter, Gprinter, Rongta, '
              'HPRT, Sunmi и Epson с зуммером. «Через разъём ящика» — если своего зуммера нет: в разъём '
              'денежного ящика (RJ-11) подключают звонок или лампу на 12–24 В.'),
          const SizedBox(height: 10),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: PrinterBeep.off, label: Text('Выкл.')),
              ButtonSegment(value: PrinterBeep.builtIn, label: Text('Встроенный')),
              ButtonSegment(value: PrinterBeep.drawer, label: Text('Через ящик')),
            ],
            selected: {_s.printerBeep},
            onSelectionChanged: (v) => _edit(_s.copyWith(printerBeep: v.first)),
          ),
          if (_s.printerBeep != PrinterBeep.off) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                const Text('Сколько раз'),
                Expanded(
                  child: Slider(
                    value: _s.printerBeepTimes.toDouble(),
                    min: 1,
                    max: 9,
                    divisions: 8,
                    label: '${_s.printerBeepTimes}',
                    onChanged: (v) => _edit(_s.copyWith(printerBeepTimes: v.round())),
                  ),
                ),
                Text('${_s.printerBeepTimes}'),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Пищать на каждый новый заказ'),
              subtitle: const Text('Даже если бегунки не печатают — повар услышит, что пора смотреть на экран'),
              value: _s.printerBeepOnOrder,
              onChanged: (v) => _edit(_s.copyWith(printerBeepOnOrder: v)),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final st in const ['kitchen', 'bar'])
                  OutlinedButton.icon(
                    onPressed: () async {
                      final err = await beepStationPrinter(st, mode: _s.printerBeep, times: _s.printerBeepTimes);
                      _snack(err == null ? 'Команда отправлена — принтер должен пискнуть' : 'Не получилось: $err');
                    },
                    icon: const Icon(Icons.notifications_outlined),
                    label: Text(st == 'kitchen' ? 'Проверить кухонный' : 'Проверить барный'),
                  ),
              ],
            ),
          ],
        ],
      );

  // ---------------------------------------------------------------- сеть

  Widget _lan() => _Section(
        icon: Icons.wifi_tethering,
        title: 'Без интернета: сигналы по Wi‑Fi заведения',
        children: [
          const _Hint('Пропал интернет — касса продолжает работать: заказы и оплаты сохраняются на планшете и '
              'уйдут в облако, когда связь вернётся. Чтобы кухня и официанты при этом слышали друг друга, '
              'планшеты передают «новый заказ» и «готово» напрямую по Wi‑Fi заведения. Роутер должен '
              'работать, интернет — не обязательно. Бегунки на сетевые принтеры и реле тоже идут по Wi‑Fi.'),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Сигналы между планшетами по Wi‑Fi'),
            value: _s.lanEnabled,
            onChanged: (v) => _edit(_s.copyWith(lanEnabled: v)),
          ),
          if (_s.lanEnabled) ...[
            Text(
              _s.lanKey.isEmpty
                  ? 'Ключ заведения ещё не создан — создастся сам при подключении к интернету.'
                  : !LanSignals.instance.supported
                      ? 'В браузере сигналы по Wi‑Fi не работают — только в приложении для Android и Windows.'
                      : 'Ключ заведения создан: чужие устройства в той же сети сигнал не подделают.',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _lanChecking || _s.lanKey.isEmpty
                  ? null
                  : () async {
                      setState(() {
                        _lanChecking = true;
                        _lanResult = null;
                      });
                      final found = await LanSignals.instance.ping();
                      if (!mounted) return;
                      setState(() {
                        _lanChecking = false;
                        _lanResult = found.isEmpty
                            ? 'Никто не ответил. Проверьте, что планшеты в одной Wi‑Fi сети (не гостевой) '
                                'и на них открыто приложение. На Windows разрешите ZalPOS в брандмауэре для частной сети.'
                            : 'На связи: ${found.join(', ')}';
                      });
                    },
              icon: _lanChecking
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.radar),
              label: const Text('Проверить, кто на связи'),
            ),
            if (_lanResult != null)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text(_lanResult!, style: const TextStyle(fontSize: 13.5))),
          ],
        ],
      );
}

class _Section extends StatelessWidget {
  final IconData icon;
  final String title;
  final List<Widget> children;
  const _Section({required this.icon, required this.title, required this.children});

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Icon(icon, color: AppColors.brass),
              const SizedBox(width: 10),
              Expanded(child: Text(title, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700))),
            ]),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(color: AppColors.textMuted, fontSize: 13.5, height: 1.4));
}

class _RelayEdit {
  final RelayDevice device;
  final bool delete;
  const _RelayEdit(this.device, {this.delete = false});
}

class _RelayDialog extends StatefulWidget {
  final RelayDevice? initial;
  const _RelayDialog({this.initial});

  @override
  State<_RelayDialog> createState() => _RelayDialogState();
}

class _RelayDialogState extends State<_RelayDialog> {
  late final _name = TextEditingController(text: widget.initial?.name ?? 'Звонок на раздаче');
  late final _address = TextEditingController(text: widget.initial?.address ?? '');
  late String _kind = widget.initial?.kind ?? RelayKind.shellyGen1;
  late int _channel = widget.initial?.channel ?? 0;
  late int _pulse = widget.initial?.pulseSeconds ?? 2;
  late final Set<String> _events = {...?widget.initial?.events};
  late bool _enabled = widget.initial?.enabled ?? true;
  String? _testResult;
  bool _testing = false;

  @override
  void dispose() {
    _name.dispose();
    _address.dispose();
    super.dispose();
  }

  RelayDevice get _device => RelayDevice(
        id: widget.initial?.id ?? DateTime.now().microsecondsSinceEpoch.toRadixString(36),
        name: _name.text.trim(),
        kind: _kind,
        address: _address.text.trim(),
        channel: _channel,
        pulseSeconds: _pulse,
        events: _events,
        enabled: _enabled,
      );

  String get _addressHint => switch (_kind) {
        RelayKind.webhook => 'http://192.168.1.10:8123/api/webhook/zalpos?table={table}',
        RelayKind.sonoffDiy => '192.168.1.51 (порт 8081 подставится сам)',
        _ => '192.168.1.50',
      };

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      scrollable: true,
      title: Text(widget.initial == null ? 'Новое реле' : 'Реле'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'Название (для себя)')),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _kind,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Тип'),
              items: [
                for (final k in RelayKind.all)
                  DropdownMenuItem(value: k, child: Text(RelayKind.label(k), overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) => setState(() => _kind = v ?? _kind),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _address,
              keyboardType: TextInputType.url,
              decoration: InputDecoration(
                labelText: _kind == RelayKind.webhook ? 'Адрес' : 'IP-адрес реле в Wi‑Fi заведения',
                hintText: _addressHint,
              ),
            ),
            if (_kind != RelayKind.webhook) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  const Expanded(child: Text('Выход (канал)')),
                  DropdownButton<int>(
                    value: _channel,
                    items: [for (var i = 0; i < 4; i++) DropdownMenuItem(value: i, child: Text('${i + 1}'))],
                    onChanged: (v) => setState(() => _channel = v ?? 0),
                  ),
                ],
              ),
              Row(
                children: [
                  const Expanded(child: Text('Держать включённым')),
                  DropdownButton<int>(
                    value: const [1, 2, 3, 5, 10, 20, 30, 60].contains(_pulse) ? _pulse : 2,
                    items: [
                      for (final s in const [1, 2, 3, 5, 10, 20, 30, 60]) DropdownMenuItem(value: s, child: Text('$s с')),
                    ],
                    onChanged: (v) => setState(() => _pulse = v ?? 2),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            const Text('Когда включать', style: TextStyle(fontWeight: FontWeight.w600)),
            for (final e in SignalEvent.all)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: _events.contains(e),
                title: Text(SignalEvent.label(e)),
                onChanged: (v) => setState(() => v == true ? _events.add(e) : _events.remove(e)),
              ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Включено'),
              value: _enabled,
              onChanged: (v) => setState(() => _enabled = v),
            ),
            OutlinedButton.icon(
              onPressed: _testing || _address.text.trim().isEmpty
                  ? null
                  : () async {
                      setState(() {
                        _testing = true;
                        _testResult = null;
                      });
                      final err = await RelayClient()
                          .pulse(_device, vars: const {'event': 'test', 'table': 'Стол 5', 'text': 'проверка'});
                      if (!mounted) return;
                      setState(() {
                        _testing = false;
                        _testResult = err == null ? 'Реле ответило — должно было щёлкнуть' : 'Не получилось: $err';
                      });
                    },
              icon: const Icon(Icons.play_circle_outline),
              label: const Text('Проверить сейчас'),
            ),
            if (_testResult != null)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text(_testResult!, style: const TextStyle(fontSize: 13))),
          ],
        ),
      ),
      actions: [
        if (widget.initial != null)
          TextButton(
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(context, _RelayEdit(widget.initial!, delete: true)),
            child: const Text('Удалить'),
          ),
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
        FilledButton(
          onPressed: () {
            if (_address.text.trim().isEmpty) return;
            Navigator.pop(context, _RelayEdit(_device));
          },
          child: const Text('Готово'),
        ),
      ],
    );
  }
}

/// Работает ли касса в фоне без ограничений батареи. Без этого Android
/// через несколько минут после выключения экрана обрывает ей сеть, и
/// уведомления («Готово», вызовы гостей) перестают приходить на телефон и часы.
class _BackgroundCheck extends StatefulWidget {
  const _BackgroundCheck();

  @override
  State<_BackgroundCheck> createState() => _BackgroundCheckState();
}

class _BackgroundCheckState extends State<_BackgroundCheck> with WidgetsBindingObserver {
  bool? _restricted;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Вернулись из системных настроек — проверяем снова.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final r = await BackgroundReliability.isRestricted();
    if (mounted) setState(() => _restricted = r);
  }

  @override
  Widget build(BuildContext context) {
    if (!BackgroundReliability.supported || _restricted == null) return const SizedBox.shrink();
    final ok = _restricted == false;
    final color = ok ? AppColors.success : AppColors.warning;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(ok ? Icons.battery_charging_full : Icons.battery_alert_outlined, color: color, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(ok ? 'Работа в фоне без ограничений' : 'Телефон может усыплять кассу в фоне',
                    style: TextStyle(fontWeight: FontWeight.w700, color: color)),
              ),
            ],
          ),
          if (!ok) ...[
            const SizedBox(height: 6),
            const Text(
              'Из-за экономии батареи уведомления сначала приходят, а через несколько минут перестают — и часы молчат. '
              'Нажмите «Разрешить» и выберите для ZalPOS «Без ограничений» («Не оптимизировать»). На Huawei и Honor '
              'ещё: Настройки → Батарея → Запуск приложений → ZalPOS → вручную, включить все три переключателя.',
              style: TextStyle(fontSize: 13, color: AppColors.textMuted),
            ),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: BackgroundReliability.openSettings,
              icon: const Icon(Icons.settings_outlined, size: 18),
              label: const Text('Разрешить'),
            ),
          ],
        ],
      ),
    );
  }
}
