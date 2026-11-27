import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../services/app_lock.dart';
import '../../services/hookah/flavors.dart';
import '../../services/hookah/mix_engine.dart';
import '../../services/hookah/tobacco_shelf.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';
import '../../widgets/ai_rich_text.dart';

/// «Табак и миксы» (кальянная, только SaaS): полка табака заведения и
/// подбор миксов под просьбу гостя — из того, что реально есть, без ИИ.
/// Полку кальянщик фотографирует: ИИ читает банки, кальянщик проверяет
/// список и сохраняет.
class TobaccoShelfScreen extends StatefulWidget {
  const TobaccoShelfScreen({super.key});

  @override
  State<TobaccoShelfScreen> createState() => _TobaccoShelfScreenState();
}

class _TobaccoShelfScreenState extends State<TobaccoShelfScreen> {
  final _ask = TextEditingController();
  final Set<String> _chips = {};
  String? _answer;
  bool _scanning = false;
  List<TobaccoCan> _shelf = const [];

  static const _quick = ['Кислое', 'Сладкое', 'Свежее', 'Ягодное', 'Тропическое', 'Десертное', 'Для новичка', 'Необычное', 'Напиток'];

  @override
  void dispose() {
    _ask.dispose();
    super.dispose();
  }

  void _pick() {
    final text = [..._chips, _ask.text].join(', ');
    final engine = MixEngine(_shelf);
    final req = MixRequest.parse(text);
    final picks = engine.pick(req.isEmpty ? MixRequest.parse('для новичка, сладкий') : req);
    setState(() => _answer = engine.render(picks));
  }

  Future<void> _scan(ImageSource source) async {
    // Берём крупно и почти без сжатия: осветление тёмного снимка и подгонка
    // под лимит сервера — на кассе (photo_prep.dart).
    final photo = await AppLock.instance.whileAway(
        () => ImagePicker().pickImage(source: source, maxWidth: 2400, maxHeight: 2400, imageQuality: 92));
    if (photo == null || !mounted) return;
    setState(() => _scanning = true);
    try {
      final cans = await TobaccoShelf.scan(photo);
      if (!mounted) return;
      final chosen = await showModalBottomSheet<List<TobaccoCan>>(
        context: context,
        isScrollControlled: true,
        builder: (_) => _ScanReview(cans: cans),
      );
      if (chosen != null && chosen.isNotEmpty) {
        await TobaccoShelf.saveAll(chosen);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('На полку добавлено: ${chosen.length}')));
        }
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _addManual() async {
    final brand = TextEditingController();
    final name = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Добавить банку'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: brand, decoration: const InputDecoration(labelText: 'Марка', hintText: 'Например, Black Burn')),
          const SizedBox(height: 8),
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Вкус, как на банке', hintText: 'Например, Спелая малина')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Добавить')),
        ],
      ),
    );
    if (ok != true || name.text.trim().isEmpty) return;
    final can = TobaccoShelf.fromScan({'brand': brand.text, 'name': name.text});
    try {
      await TobaccoShelf.saveAll([can]);
      if (can.flavors.isEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Вкус по названию не узнан — эта банка не попадёт в подбор миксов. Допишите вкус словами, например «малина».')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    }
  }

  Future<void> _fresh() async {
    try {
      final list = await TobaccoShelf.fresh();
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        builder: (_) => SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text('Новинки вкусов', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('Банки, которые впервые появились на полках заведений за последние 60 дней.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
              const SizedBox(height: 12),
              if (list.isEmpty) Text('Пока новинок нет.', style: TextStyle(color: AppColors.textMuted)),
              for (final c in list)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(c.label),
                  subtitle: Text(c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', ')),
                ),
            ],
          ),
        ),
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    }
  }

  Widget _card(Widget child) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: child,
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Табак и миксы'),
        actions: [IconButton(tooltip: 'Новинки вкусов', icon: const Icon(Icons.new_releases_outlined), onPressed: _fresh)],
      ),
      body: StreamBuilder<List<TobaccoCan>>(
        stream: TobaccoShelf.stream(),
        builder: (context, snap) {
          _shelf = snap.data ?? _shelf;
          final inStock = _shelf.where((c) => c.inStock).length;
          final byBrand = <String, List<TobaccoCan>>{};
          for (final c in _shelf) {
            byBrand.putIfAbsent(c.brand.isEmpty ? 'Без марки' : c.brand, () => []).add(c);
          }
          return CenteredBody(
            maxWidth: Breakpoints.form,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Icon(Icons.auto_awesome, color: AppColors.primary, size: 20),
                    const SizedBox(width: 8),
                    const Expanded(child: Text('Подобрать микс', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                  ]),
                  const SizedBox(height: 4),
                  Text(inStock == 0
                      ? 'Полка пустая — подберу из общей базы миксов.'
                      : 'Из того, что есть на полке ($inStock), без расхода токенов.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
                  const SizedBox(height: 10),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    for (final q in _quick)
                      FilterChip(
                        label: Text(q),
                        selected: _chips.contains(q),
                        onSelected: (v) => setState(() => v ? _chips.add(q) : _chips.remove(q)),
                      ),
                  ]),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _ask,
                    textInputAction: TextInputAction.search,
                    onSubmitted: (_) => _pick(),
                    decoration: const InputDecoration(
                      labelText: 'Что хочет гость',
                      hintText: 'Например: что-то с малиной, без мяты',
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(onPressed: _pick, icon: const Icon(Icons.local_fire_department_outlined), label: const Text('Подобрать')),
                  ),
                  if (_answer != null) ...[
                    const SizedBox(height: 14),
                    AiRichText(_answer!, style: TextStyle(color: AppColors.textPrimary, fontSize: 14)),
                  ],
                ])),
                const SizedBox(height: 16),
                Row(children: [
                  Expanded(
                    child: Text('На полке · $inStock из ${_shelf.length}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                  IconButton(tooltip: 'Добавить вручную', icon: const Icon(Icons.add), onPressed: _addManual),
                ]),
                const SizedBox(height: 6),
                Row(children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _scanning ? null : () => _scan(ImageSource.camera),
                      icon: _scanning
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.photo_camera_outlined),
                      label: Text(_scanning ? 'Читаю банки… до минуты' : 'Сфотографировать полку'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _scanning ? null : () => _scan(ImageSource.gallery),
                    child: const Icon(Icons.photo_library_outlined),
                  ),
                ]),
                const SizedBox(height: 6),
                Text('Снимайте одну-две полки за раз, при хорошем свете, чтобы надписи читались. '
                    'Закончилась банка — выключите её, и она пропадёт из подбора.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                const SizedBox(height: 8),
                if (_shelf.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('Банок пока нет', style: TextStyle(color: AppColors.textMuted))),
                  ),
                for (final e in byBrand.entries) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 12, bottom: 4),
                    child: Text(e.key, style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600)),
                  ),
                  for (final c in e.value)
                    Dismissible(
                      key: ValueKey(c.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: 16),
                        color: AppColors.danger.withValues(alpha: 0.15),
                        child: Icon(Icons.delete_outline, color: AppColors.danger),
                      ),
                      onDismissed: (_) => TobaccoShelf.remove(c.id),
                      child: SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(c.name),
                        subtitle: Text(
                          c.flavors.isEmpty ? 'вкус не узнан' : c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', '),
                          style: TextStyle(fontSize: 12, color: c.flavors.isEmpty ? AppColors.warning : AppColors.textMuted),
                        ),
                        value: c.inStock,
                        onChanged: (v) => TobaccoShelf.setInStock(c.id, v),
                      ),
                    ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Проверка распознанного: галочки, «Сохранить на полку».
class _ScanReview extends StatefulWidget {
  final List<TobaccoCan> cans;
  const _ScanReview({required this.cans});

  @override
  State<_ScanReview> createState() => _ScanReviewState();
}

class _ScanReviewState extends State<_ScanReview> {
  late final Set<String> _on = {for (final c in widget.cans) c.id};

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text('Найдено банок: ${widget.cans.length}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text('Снимите галочку с того, что прочитано неверно.', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final c in widget.cans)
                    CheckboxListTile(
                      value: _on.contains(c.id),
                      onChanged: (v) => setState(() => v == true ? _on.add(c.id) : _on.remove(c.id)),
                      title: Text(c.label),
                      subtitle: Text(c.flavors.isEmpty ? 'вкус не узнан' : c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', ')),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: FilledButton(
                onPressed: _on.isEmpty ? null : () => Navigator.pop(context, [for (final c in widget.cans) if (_on.contains(c.id)) c]),
                child: Text('Сохранить на полку (${_on.length})'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
