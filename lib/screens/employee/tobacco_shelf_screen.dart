import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../services/app_lock.dart';
import '../../services/hookah/flavors.dart';
import '../../services/hookah/brand_profiles.dart';
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

  /// Та же просьба ещё раз — другие миксы.
  final _mixes = MixSession();
  List<TobaccoCan> _shelf = const [];

  static const _quick = ['Кислое', 'Сладкое', 'Свежее', 'Ягодное', 'Тропическое', 'Десертное', 'Для новичка', 'Необычное', 'Напиток'];

  @override
  void dispose() {
    _ask.dispose();
    super.dispose();
  }

  void _pick({bool more = false}) {
    final text = [..._chips, _ask.text, if (more) 'ещё'].join(', ');
    final engine = MixEngine(_shelf);
    setState(() => _answer = _mixes.answer(engine, text, fallback: 'для новичка, сладкий'));
  }

  /// Банку прочитали неверно — исправить марку, название, вкусы или удалить.
  Future<void> _editCan(TobaccoCan c) async {
    final brand = TextEditingController(text: c.brand);
    final name = TextEditingController(text: c.name);
    final words = TextEditingController(text: c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', '));
    final res = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Банка табака'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: brand, decoration: const InputDecoration(labelText: 'Марка')),
            const SizedBox(height: 8),
            TextField(controller: name, decoration: const InputDecoration(labelText: 'Название, как на банке')),
            const SizedBox(height: 8),
            TextField(
              controller: words,
              decoration: const InputDecoration(labelText: 'Вкусы словами', hintText: 'Например: мята, лёд'),
            ),
          ]),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'delete'),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('Удалить'),
          ),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, 'save'), child: const Text('Сохранить')),
        ],
      ),
    );
    if (!mounted || res == null) return;
    try {
      if (res == 'delete') {
        await TobaccoShelf.remove(c.id);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Удалено: ${c.label}')));
        return;
      }
      if (name.text.trim().isEmpty) return;
      final saved = await TobaccoShelf.edit(c, brand: brand.text, name: name.text, flavorWords: words.text);
      if (saved.flavors.isEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Вкус не узнан — допишите его словами, например «малина, мята».')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    }
  }

  /// Снимки для распознавания: из галереи — до 4 сразу; камерой — после
  /// каждого кадра «Снять ещё сторону?» (название бывает на крышке, а марка
  /// и «аромат …» — сбоку), до 4 кадров одной банки или полки.
  Future<List<XFile>> _takePhotos(ImageSource source) async {
    final picker = ImagePicker();
    if (source == ImageSource.gallery) {
      final many = await AppLock.instance
          .whileAway(() => picker.pickMultiImage(maxWidth: 2400, maxHeight: 2400, imageQuality: 92, limit: 4));
      return many.take(4).toList();
    }
    final shots = <XFile>[];
    while (shots.length < 4) {
      // Берём крупно и почти без сжатия: осветление тёмного снимка и подгонка
      // под лимит сервера — на кассе (photo_prep.dart).
      final photo = await AppLock.instance.whileAway(
          () => picker.pickImage(source: source, maxWidth: 2400, maxHeight: 2400, imageQuality: 92));
      if (photo == null) break;
      shots.add(photo);
      if (shots.length >= 4 || !mounted) break;
      final more = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('Снимков: ${shots.length}'),
          content: const Text('Если часть надписи на крышке или сбоку — снимите эту же банку с другой стороны. '
              'Все снимки распознаются вместе, банка запишется один раз.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Снять ещё сторону')),
            FilledButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Распознать')),
          ],
        ),
      );
      if (more != true) break;
    }
    return shots;
  }

  Future<void> _scan(ImageSource source) async {
    final photos = await _takePhotos(source);
    if (photos.isEmpty || !mounted) return;
    setState(() => _scanning = true);
    try {
      final cans = await TobaccoShelf.scan(photos);
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
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: () => _pick(more: true),
                        icon: const Icon(Icons.refresh),
                        label: const Text('Другие варианты'),
                      ),
                    ),
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
                    'Название на крышке, а марка сбоку — снимите банку с двух сторон, это одна позиция. '
                    'Закончилась банка — выключите её, и она пропадёт из подбора. '
                    'Прочитано неверно — нажмите на банку: исправить или удалить.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                const SizedBox(height: 8),
                if (_shelf.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: Text('Банок пока нет', style: TextStyle(color: AppColors.textMuted))),
                  ),
                for (final e in byBrand.entries) ...[
                  _BrandHeader(brand: e.key),
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
                        title: InkWell(onTap: () => _editCan(c), child: Text(c.line.isEmpty ? c.name : '${c.name} · ${c.line}')),
                        subtitle: InkWell(
                          onTap: () => _editCan(c),
                          child: Text(
                            c.flavors.isEmpty
                                ? 'вкус не узнан — нажмите, чтобы исправить'
                                : c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', '),
                            style: TextStyle(fontSize: 12, color: c.flavors.isEmpty ? AppColors.warning : AppColors.textMuted),
                          ),
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
  late final List<TobaccoCan> _cans = List.of(widget.cans);
  late final Set<String> _on = {for (final c in widget.cans) c.id};

  String _flavorText(TobaccoCan c) => c.flavors.map((f) => kFlavorByKey[f]?.name ?? f).join(', ');

  /// Банка, собранная заново из исправленных полей.
  TobaccoCan _rebuild(String brand, String name, String words) => TobaccoShelf.fromScan({
        'brand': brand,
        'name': name,
        'flavors': [for (final w in words.split(',')) if (w.trim().isNotEmpty) w.trim()],
      });

  void _replace(TobaccoCan old, TobaccoCan now) {
    final i = _cans.indexOf(old);
    if (i < 0) return;
    final wasOn = _on.remove(old.id);
    _cans[i] = now;
    if (wasOn) _on.add(now.id);
  }

  /// Исправить банку до сохранения: марку, название, вкусы.
  Future<void> _edit(TobaccoCan c) async {
    final brand = TextEditingController(text: c.brand);
    final name = TextEditingController(text: c.name);
    final words = TextEditingController(text: _flavorText(c));
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Исправить банку'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: brand, decoration: const InputDecoration(labelText: 'Марка')),
            const SizedBox(height: 8),
            TextField(controller: name, decoration: const InputDecoration(labelText: 'Название, как на банке')),
            const SizedBox(height: 8),
            TextField(controller: words, decoration: const InputDecoration(labelText: 'Вкусы словами', hintText: 'Например: мята, лёд')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Готово')),
        ],
      ),
    );
    if (ok != true || name.text.trim().isEmpty || !mounted) return;
    setState(() => _replace(c, _rebuild(brand.text, name.text, words.text)));
  }

  /// Одна марка сразу всем отмеченным банкам без марки.
  Future<void> _brandForUnbranded() async {
    final seen = {for (final c in _cans) if (c.brand.isNotEmpty) c.brand};
    final brand = TextEditingController();
    final picked = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Марка для банок без марки'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            TextField(controller: brand, autofocus: true, decoration: const InputDecoration(labelText: 'Марка')),
            if (seen.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final b in seen) ActionChip(label: Text(b), onPressed: () => Navigator.pop(ctx, b)),
              ]),
            ],
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, brand.text), child: const Text('Поставить')),
        ],
      ),
    );
    if (picked == null || picked.trim().isEmpty || !mounted) return;
    setState(() {
      for (final c in List.of(_cans)) {
        if (c.brand.isEmpty && _on.contains(c.id)) _replace(c, _rebuild(picked, c.name, _flavorText(c)));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final unbranded = _cans.where((c) => c.brand.isEmpty && _on.contains(c.id)).length;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text('Найдено банок: ${_cans.length}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text('Нажмите на банку, чтобы исправить марку, название или вкус. Лишнее — снимите галочку.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
            ),
            if (unbranded > 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: OutlinedButton.icon(
                  onPressed: _brandForUnbranded,
                  icon: const Icon(Icons.sell_outlined, size: 18),
                  label: Text('Указать марку для банок без марки ($unbranded)'),
                ),
              ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final c in _cans)
                    ListTile(
                      onTap: () => _edit(c),
                      title: Text(c.brand.isEmpty ? '«${c.name}» · марка не видна' : c.label),
                      subtitle: Text(
                        c.flavors.isEmpty ? 'вкус не узнан — нажмите, чтобы исправить' : _flavorText(c),
                        style: TextStyle(color: c.flavors.isEmpty || c.brand.isEmpty ? AppColors.warning : AppColors.textMuted),
                      ),
                      trailing: Checkbox(
                        value: _on.contains(c.id),
                        onChanged: (v) => setState(() => v == true ? _on.add(c.id) : _on.remove(c.id)),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: FilledButton(
                onPressed: _on.isEmpty ? null : () => Navigator.pop(context, [for (final c in _cans) if (_on.contains(c.id)) c]),
                child: Text('Сохранить на полку (${_on.length})'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Заголовок марки на полке: лист, крепость, жар, забивка — по справочнику.
/// Нажатие — полная карточка (угли, граммы, прогрев, совет).
class _BrandHeader extends StatelessWidget {
  final String brand;
  const _BrandHeader({required this.brand});

  @override
  Widget build(BuildContext context) {
    final p = profileOf(brand);
    final title = Text(brand, style: TextStyle(color: AppColors.textMuted, fontWeight: FontWeight.w600));
    if (p == null) return Padding(padding: const EdgeInsets.only(top: 12, bottom: 4), child: title);
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (_) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Text(p.card(), style: const TextStyle(fontSize: 15, height: 1.45)),
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          title,
          const SizedBox(height: 2),
          Text(
            '${p.leafLabel} · крепость ${p.strength}/10 · жар ${p.heat}/5 · '
            '${p.pack == Pack.edges ? 'внакидку' : (p.pack == Pack.overpack ? 'с горкой' : 'пушисто')}'
            '${p.mixable ? '' : ' · в миксы не идёт'}',
            style: TextStyle(color: AppColors.textMuted, fontSize: 12),
          ),
        ]),
      ),
    );
  }
}
