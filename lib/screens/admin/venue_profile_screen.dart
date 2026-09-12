import 'package:flutter/material.dart';
import '../../models/venue_models.dart';
import '../../services/venue_service.dart';
import '../../theme/app_colors.dart';

/// Профиль заведения: часы, адрес, правила, FAQ и «счастливые часы».
///
/// Всё, что здесь записано, видит гость в приложении и используют
/// ИИ-агенты как базу знаний — консьерж перестаёт выдумывать режим работы.
class VenueProfileScreen extends StatefulWidget {
  const VenueProfileScreen({super.key});

  @override
  State<VenueProfileScreen> createState() => _VenueProfileScreenState();
}

class _VenueProfileScreenState extends State<VenueProfileScreen> {
  final _service = VenueService.instance;

  VenueProfile _profile = const VenueProfile();
  final _name = TextEditingController();
  final _address = TextEditingController();
  final _phone = TextEditingController();
  final _about = TextEditingController();
  final _rules = TextEditingController();
  final _hours = <int, TextEditingController>{};

  bool _loading = true;

  static const _days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await _service.load();
    _profile = p;
    _name.text = p.name;
    _address.text = p.address;
    _phone.text = p.phone;
    _about.text = p.about;
    _rules.text = p.rules;
    for (var i = 1; i <= 7; i++) {
      _hours[i] = TextEditingController(text: p.workingHours[i] ?? '');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    final updated = _profile.copyWith(
      name: _name.text.trim(),
      address: _address.text.trim(),
      phone: _phone.text.trim(),
      about: _about.text.trim(),
      rules: _rules.text.trim(),
      workingHours: {
        for (var i = 1; i <= 7; i++)
          if (_hours[i]!.text.trim().isNotEmpty) i: _hours[i]!.text.trim(),
      },
    );
    await _service.save(updated);
    _profile = updated;
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Профиль сохранён')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Профиль заведения'),
        actions: [IconButton(onPressed: _save, icon: const Icon(Icons.save))],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Название')),
          const SizedBox(height: 12),
          TextField(controller: _address, decoration: const InputDecoration(labelText: 'Адрес')),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Телефон'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _about,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'О заведении',
              helperText: 'Пара предложений для приложения гостя и для ИИ',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _rules,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Правила',
              helperText: 'Возраст, депозит, можно ли со своим, дресс-код',
            ),
          ),

          const Divider(height: 32),
          const Text('Часы работы', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          const Text('Формат 14:00-02:00, пусто — выходной',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          const SizedBox(height: 12),
          for (var i = 1; i <= 7; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  SizedBox(width: 40, child: Text(_days[i - 1])),
                  Expanded(
                    child: TextField(
                      controller: _hours[i],
                      decoration: const InputDecoration(isDense: true, hintText: '14:00-02:00'),
                    ),
                  ),
                ],
              ),
            ),

          const Divider(height: 32),
          Row(
            children: [
              const Expanded(
                child: Text('Частые вопросы',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
              TextButton.icon(
                onPressed: _addFaq,
                icon: const Icon(Icons.add),
                label: const Text('Вопрос'),
              ),
            ],
          ),
          if (_profile.faq.isEmpty)
            const Text('Пока пусто — ИИ-консьерж будет отвечать только по меню',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13))
          else
            ..._profile.faq.map((f) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(f.question),
                  subtitle: Text(f.answer, style: const TextStyle(fontSize: 13)),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline, color: AppColors.danger),
                    onPressed: () async {
                      final faq = List<VenueFaq>.from(_profile.faq)..remove(f);
                      _profile = _profile.copyWith(faq: faq);
                      await _service.save(_profile);
                      setState(() {});
                    },
                  ),
                )),

          const Divider(height: 32),
          Row(
            children: [
              const Expanded(
                child: Text('Счастливые часы',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
              TextButton.icon(
                onPressed: _addHappyHour,
                icon: const Icon(Icons.add),
                label: const Text('Акция'),
              ),
            ],
          ),
          const Text('Скидка действует автоматически при открытии чека в это время',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          const SizedBox(height: 8),
          StreamBuilder<List<HappyHour>>(
            stream: _service.happyHoursStream(),
            builder: (context, snap) {
              final list = snap.data ?? const <HappyHour>[];
              if (list.isEmpty) {
                return const Text('Акций нет',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13));
              }
              return Column(
                children: list
                    .map((h) => ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(Icons.local_offer,
                              color: h.active ? AppColors.success : AppColors.disabled),
                          title: Text('${h.title} · −${h.discountPercent.toStringAsFixed(0)}%'),
                          subtitle: Text(
                            '${h.window} · ${h.weekdays.map((d) => _days[d - 1]).join(', ')}',
                            style: const TextStyle(fontSize: 12),
                          ),
                          trailing: IconButton(
                            icon: const Icon(Icons.delete_outline, color: AppColors.danger),
                            onPressed: () => _service.deleteHappyHour(h.id),
                          ),
                        ))
                    .toList(),
              );
            },
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Future<void> _addFaq() async {
    final q = TextEditingController();
    final a = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Вопрос и ответ'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: q, decoration: const InputDecoration(labelText: 'Вопрос')),
            TextField(
              controller: a,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Ответ'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Добавить')),
        ],
      ),
    );
    if (ok != true || q.text.trim().isEmpty) return;

    final faq = List<VenueFaq>.from(_profile.faq)
      ..add(VenueFaq(q.text.trim(), a.text.trim()));
    _profile = _profile.copyWith(faq: faq);
    await _service.save(_profile);
    setState(() {});
  }

  Future<void> _addHappyHour() async {
    final title = TextEditingController(text: 'Счастливые часы');
    final percent = TextEditingController(text: '20');
    var from = const TimeOfDay(hour: 14, minute: 0);
    var to = const TimeOfDay(hour: 18, minute: 0);
    final weekdays = <int>{1, 2, 3, 4};

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Новая акция'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: title, decoration: const InputDecoration(labelText: 'Название')),
                TextField(
                  controller: percent,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Скидка, %'),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextButton(
                        onPressed: () async {
                          final t = await showTimePicker(context: ctx, initialTime: from);
                          if (t != null) setLocal(() => from = t);
                        },
                        child: Text('с ${from.format(ctx)}'),
                      ),
                    ),
                    Expanded(
                      child: TextButton(
                        onPressed: () async {
                          final t = await showTimePicker(context: ctx, initialTime: to);
                          if (t != null) setLocal(() => to = t);
                        },
                        child: Text('до ${to.format(ctx)}'),
                      ),
                    ),
                  ],
                ),
                Wrap(
                  spacing: 6,
                  children: [
                    for (var i = 1; i <= 7; i++)
                      FilterChip(
                        label: Text(_days[i - 1]),
                        selected: weekdays.contains(i),
                        onSelected: (v) =>
                            setLocal(() => v ? weekdays.add(i) : weekdays.remove(i)),
                      ),
                  ],
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Создать')),
          ],
        ),
      ),
    );
    if (ok != true) return;

    await _service.saveHappyHour(HappyHour(
      id: '',
      title: title.text.trim(),
      weekdays: weekdays.toList()..sort(),
      fromMinutes: from.hour * 60 + from.minute,
      toMinutes: to.hour * 60 + to.minute,
      discountPercent: double.tryParse(percent.text.replaceAll(',', '.')) ?? 0,
    ));
  }
}
