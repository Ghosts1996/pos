import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import '../../models/story_model.dart';
import '../../services/ai/ai_agents.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/adaptive.dart';
import '../../utils/promo_policy.dart';
import '../../utils/remote_sale.dart';
import '../../models/menu_models.dart';
import '../../build_info.dart';
import '../../data/app_db.dart';

/// Лента заведения: карточки, которые видит гость в своём приложении.
///
/// Кнопка «Черновики от ИИ» просит агента-контент-редактора придумать
/// карточки под текущие продажи и меню. Черновики не публикуются сами —
/// администратор читает, правит и включает переключателем.
class StoriesEditorScreen extends StatefulWidget {
  const StoriesEditorScreen({super.key});

  @override
  State<StoriesEditorScreen> createState() => _StoriesEditorScreenState();
}

class _StoriesEditorScreenState extends State<StoriesEditorScreen> {
  final _db = AppDb.instance;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Лента для гостей'),
        actions: [
          IconButton(
            tooltip: 'Черновики от ИИ',
            icon: _busy
                ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.auto_awesome),
            onPressed: _busy ? null : _generateDrafts,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _edit(null),
        child: const Icon(Icons.add),
      ),
      body: CenteredBody(
        maxWidth: 760,
        child: StreamBuilder<QuerySnapshot>(
          stream: AppScope.col('stories').orderBy('createdAt', descending: true).snapshots(),
          builder: (context, snap) {
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            // Порядок ровно тот же, что видит гость в ленте: иначе
            // администратор переставляет карточки вслепую — у него они идут
            // по времени создания, а у гостя по полю order.
            final stories = snap.data!.docs.map(StoryCard.fromDoc).toList()
              ..sort((a, b) {
                final byOrder = a.order.compareTo(b.order);
                return byOrder != 0 ? byOrder : b.createdAt.compareTo(a.createdAt);
              });
            if (stories.isEmpty) {
              return Center(
                child: Text('Карточек нет — создайте вручную или попросите ИИ',
                    style: TextStyle(color: AppColors.textMuted)),
              );
            }
            return ListView.separated(
              // Снизу — место под кнопку «+», чтобы она не закрывала последнюю строку.
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
              itemCount: stories.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (_, i) => _tile(stories[i], i, stories),
            );
          },
        ),
      ),
    );
  }

  /// Переставляет карточку на одну позицию и переписывает order у всех
  /// карточек подряд — у старых там нули, и одна перестановка их не
  /// развела бы.
  Future<void> _move(List<StoryCard> list, int from, int to) async {
    if (to < 0 || to >= list.length) return;
    final reordered = [...list];
    final moved = reordered.removeAt(from);
    reordered.insert(to, moved);

    final batch = _db.batch();
    for (var i = 0; i < reordered.length; i++) {
      batch.update(AppScope.col('stories').doc(reordered[i].id), {'order': i});
    }
    await batch.commit();
  }

  Widget _tile(StoryCard s, int index, List<StoryCard> all) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: s.isLive ? AppColors.success.withValues(alpha: 0.5) : AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(s.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 16)),
                ),
                if (s.byAi)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Icon(Icons.auto_awesome, size: 16, color: AppColors.primary),
                  ),
                IconButton(
                  tooltip: 'Выше в ленте',
                  icon: const Icon(Icons.keyboard_arrow_up),
                  visualDensity: VisualDensity.compact,
                  onPressed: index == 0 ? null : () => _move(all, index, index - 1),
                ),
                IconButton(
                  tooltip: 'Ниже в ленте',
                  icon: const Icon(Icons.keyboard_arrow_down),
                  visualDensity: VisualDensity.compact,
                  onPressed: index == all.length - 1 ? null : () => _move(all, index, index + 1),
                ),
                Switch(
                  value: s.published,
                  onChanged: (v) => AppScope.col('stories').doc(s.id).update({'published': v}),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (kSaasMode && s.imageUrl.isNotEmpty) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: AspectRatio(
                  aspectRatio: 16 / 7,
                  child: CachedNetworkImage(
                    imageUrl: s.imageUrl,
                    fit: BoxFit.cover,
                    memCacheWidth: 900,
                    errorWidget: (_, __, ___) => Container(color: AppColors.surfaceElevated),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
            Text(s.text, maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(color: AppColors.textMuted)),
            if (s.actionLabel.isNotEmpty) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(
                    s.action == 'booking'
                        ? Icons.event_seat
                        : s.action == 'menu'
                            ? Icons.restaurant_menu
                            : Icons.link_off,
                    size: 15,
                    color: AppColors.primary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '${s.actionLabel} · '
                      '${s.action == 'booking' ? 'ведёт на бронь' : s.action == 'menu' ? 'ведёт в меню' : 'без перехода'}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppColors.primary, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: [
                TextButton(onPressed: () => _edit(s), child: const Text('Изменить')),
                if (kSaasMode && s.imageUrl.isEmpty)
                  TextButton.icon(
                    onPressed: () => _photoFromMenu(s),
                    icon: const Icon(Icons.image_outlined, size: 18),
                    label: const Text('Фото из меню'),
                  ),
                TextButton(
                  onPressed: () => AppScope.col('stories').doc(s.id).delete(),
                  child: Text('Удалить', style: TextStyle(color: AppColors.danger)),
                ),
              ],
            ),
          ],
        ),
      );

  Future<void> _generateDrafts() async {
    setState(() => _busy = true);
    try {
      // Агент отдаёт готовые поля: заголовок, текст, призыв и переход.
      // Черновик про кальян или табак — реклама табака (ст. 16 № 15-ФЗ),
      // такие не сохраняем, даже если модель нарушила инструкцию.
      // Черновик про кальян или табак — реклама табака (ст. 16 № 15-ФЗ),
      // такие не сохраняем, даже если модель нарушила инструкцию. В SaaS
      // storyDrafts ещё отсеивает алкоголь и подбирает фото из меню.
      final drafts = (await AiService.instance.storyDrafts(count: 3))
          .where((d) => !PromoPolicy.looksTobacco('${d.title} ${d.text} ${d.cta}'))
          .toList();
      for (final d in drafts) {
        await AppScope.col('stories').add(StoryCard(
          id: '',
          title: d.title,
          text: d.text,
          action: d.action,
          actionLabel: d.cta,
          imageUrl: d.imageUrl,
          menuItemId: d.menuItemId,
          byAi: true,
          published: false,
          createdAt: DateTime.now(),
        ).toMap());
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(drafts.isEmpty
                ? 'ИИ не вернул черновиков — попробуйте ещё раз'
                : 'Черновиков создано: ${drafts.length}. Проверьте и опубликуйте'),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  /// Позиции меню с фото (без табака и алкоголя) — для выбора фото карточки.
  Future<List<({MenuItem item, String category, String categoryImage})>> _menuWithPhotos() async {
    final menu = await AiService.instance.storyMenu();
    return [
      for (final m in menu)
        if (m.item.imageUrl.isNotEmpty || m.categoryImage.isNotEmpty) m
    ];
  }

  /// Выбор фото из меню: сначала — позиция, названная в карточке.
  Future<({String url, String itemId})?> _pickMenuPhoto(String hint) async {
    final list = await _menuWithPhotos();
    if (!mounted) return null;
    if (list.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('В меню нет фото. Добавьте фото позициям в «Меню» — и они появятся здесь')));
      return null;
    }
    final h = hint.toLowerCase();
    list.sort(
        (a, b) => (h.contains(b.item.name.toLowerCase()) ? 1 : 0) - (h.contains(a.item.name.toLowerCase()) ? 1 : 0));
    return showModalBottomSheet<({String url, String itemId})>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: SizedBox(
          height: MediaQuery.of(ctx).size.height * 0.7,
          child: Column(children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Фото из меню', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            ),
            Expanded(
              child: GridView.builder(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 180, mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 0.85),
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final m = list[i];
                  final url = m.item.imageUrl.isNotEmpty ? m.item.imageUrl : m.categoryImage;
                  return InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => Navigator.pop(ctx, (url: url, itemId: m.item.id)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(12),
                          child: CachedNetworkImage(imageUrl: url, fit: BoxFit.cover, memCacheWidth: 400),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(m.item.name,
                          maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                    ]),
                  );
                },
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _photoFromMenu(StoryCard s) async {
    try {
      final picked = await _pickMenuPhoto('${s.title} ${s.text}');
      if (picked == null) return;
      await AppScope.col('stories').doc(s.id).update({'imageUrl': picked.url, 'menuItemId': picked.itemId});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
    }
  }

  Future<void> _edit(StoryCard? story) async {
    final title = TextEditingController(text: story?.title ?? '');
    final body = TextEditingController(text: story?.text ?? '');
    final image = TextEditingController(text: story?.imageUrl ?? '');
    final label = TextEditingController(text: story?.actionLabel ?? '');
    var action = story?.action ?? 'none';
    var menuItemId = story?.menuItemId ?? '';

    // Подпись по умолчанию — та, что подходит выбранному переходу. Если
    // администратор ничего своего не написал, при смене перехода она
    // меняется вслед; как только написал — не трогаем.
    String defaultLabel(String a) => switch (a) {
          'menu' => 'Смотреть меню',
          'booking' => 'Забронировать',
          _ => '',
        };
    var labelIsDefault = label.text.isEmpty || label.text == defaultLabel(action);
    if (label.text.isEmpty) label.text = defaultLabel(action);

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(story == null ? 'Новая карточка' : 'Карточка'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: title, decoration: const InputDecoration(labelText: 'Заголовок')),
                const SizedBox(height: 12),
                TextField(
                  controller: body,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: 'Текст'),
                ),
                const SizedBox(height: 12),
                TextField(controller: image, decoration: const InputDecoration(labelText: 'Ссылка на фото')),
                if (kSaasMode)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () async {
                        final picked = await _pickMenuPhoto('${title.text} ${body.text}');
                        if (picked == null) return;
                        setLocal(() {
                          image.text = picked.url;
                          menuItemId = picked.itemId;
                        });
                      },
                      icon: const Icon(Icons.image_outlined, size: 18),
                      label: const Text('Выбрать фото из меню'),
                    ),
                  ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: action,
                  decoration: const InputDecoration(labelText: 'Кнопка ведёт'),
                  items: const [
                    DropdownMenuItem(value: 'none', child: Text('Без кнопки')),
                    DropdownMenuItem(value: 'menu', child: Text('В меню')),
                    DropdownMenuItem(value: 'booking', child: Text('К брони')),
                  ],
                  onChanged: (v) => setLocal(() {
                    action = v ?? 'none';
                    if (labelIsDefault) label.text = defaultLabel(action);
                  }),
                ),
                const SizedBox(height: 12),
                if (action != 'none')
                  TextField(
                    controller: label,
                    maxLength: 24,
                    onChanged: (v) => labelIsDefault = v.trim() == defaultLabel(action),
                    decoration: InputDecoration(
                      labelText: 'Надпись на кнопке',
                      hintText: defaultLabel(action),
                      helperText: 'Её видит гость в карточке',
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
          ],
        ),
      ),
    );

    if (ok != true) return;
    final adText = '${title.text} ${body.text} ${label.text}';
    if ((PromoPolicy.looksTobacco(adText) || (kSaasMode && RemoteSale.looksAlcohol(adText))) && mounted) {
      final keep = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Похоже на рекламу табака или алкоголя'),
          content: const Text('В карточке упоминаются кальян, табак, никотин или алкоголь. Реклама '
              'табака запрещена (ст. 16 закона № 15-ФЗ), реклама алкоголя в интернете ограничена '
              '(ст. 21 закона № 38-ФЗ) — за это штрафуют заведение. Лучше рассказать о кухне, '
              'безалкогольных напитках, атмосфере или событии.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Не сохранять')),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Всё равно сохранить')),
          ],
        ),
      );
      if (keep != true) return;
    }
    final data = {
      'title': title.text.trim(),
      'text': body.text.trim(),
      'imageUrl': image.text.trim(),
      'menuItemId': image.text.trim().isEmpty ? '' : menuItemId,
      'action': action,
      // Подпись кнопки по переходу — только если своей нет (например, от ИИ).
      'actionLabel': action == 'none' ? '' : (label.text.trim().isEmpty ? defaultLabel(action) : label.text.trim()),
    };
    if (story == null) {
      await AppScope.col('stories').add({
        ...data,
        'published': false,
        'byAi': false,
        'order': 0,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } else {
      await AppScope.col('stories').doc(story.id).update(data);
    }
  }
}
