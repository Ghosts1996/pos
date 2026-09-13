import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../models/story_model.dart';
import '../../services/ai/ai_agents.dart';
import '../../theme/app_colors.dart';

/// Лента заведения: карточки, которые видит гость в «Colibri Lounge».
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
  final _db = FirebaseFirestore.instance;
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
      body: StreamBuilder<QuerySnapshot>(
        stream: _db.collection('stories').orderBy('createdAt', descending: true).snapshots(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final stories = snap.data!.docs.map(StoryCard.fromDoc).toList();
          if (stories.isEmpty) {
            return const Center(
              child: Text('Карточек нет — создайте вручную или попросите ИИ',
                  style: TextStyle(color: AppColors.textMuted)),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: stories.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) => _tile(stories[i]),
          );
        },
      ),
    );
  }

  Widget _tile(StoryCard s) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: s.isLive ? AppColors.success.withValues(alpha: 0.5) : AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(s.title,
                      style: const TextStyle(
                          color: AppColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 16)),
                ),
                if (s.byAi)
                  const Padding(
                    padding: EdgeInsets.only(right: 8),
                    child: Icon(Icons.auto_awesome, size: 16, color: AppColors.primary),
                  ),
                Switch(
                  value: s.published,
                  onChanged: (v) =>
                      _db.collection('stories').doc(s.id).update({'published': v}),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(s.text, style: const TextStyle(color: AppColors.textMuted)),
            const SizedBox(height: 10),
            Row(
              children: [
                TextButton(onPressed: () => _edit(s), child: const Text('Изменить')),
                TextButton(
                  onPressed: () => _db.collection('stories').doc(s.id).delete(),
                  child: const Text('Удалить', style: TextStyle(color: AppColors.danger)),
                ),
              ],
            ),
          ],
        ),
      );

  Future<void> _generateDrafts() async {
    setState(() => _busy = true);
    try {
      final text = await AiService.instance.storyIdeas(count: 3);
      // Ответ агента режем на карточки по пустой строке: заголовок —
      // первая строка блока, остальное — текст.
      final blocks = text.split(RegExp(r'\n\s*\n')).where((b) => b.trim().isNotEmpty);
      for (final block in blocks.take(5)) {
        final lines = block.trim().split('\n');
        final title = lines.first.replaceAll(RegExp(r'^[\d\.\-\s#*]+'), '').trim();
        final body = lines.skip(1).join(' ').trim();
        if (title.isEmpty) continue;
        await _db.collection('stories').add(StoryCard(
              id: '',
              title: title.length > 60 ? title.substring(0, 60) : title,
              text: body,
              byAi: true,
              published: false,
              createdAt: DateTime.now(),
            ).toMap());
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Черновики созданы — проверьте и опубликуйте')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _edit(StoryCard? story) async {
    final title = TextEditingController(text: story?.title ?? '');
    final body = TextEditingController(text: story?.text ?? '');
    final image = TextEditingController(text: story?.imageUrl ?? '');
    var action = story?.action ?? 'none';

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
                TextField(
                  controller: body,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: 'Текст'),
                ),
                TextField(controller: image, decoration: const InputDecoration(labelText: 'Ссылка на фото')),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: action,
                  decoration: const InputDecoration(labelText: 'Кнопка ведёт'),
                  items: const [
                    DropdownMenuItem(value: 'none', child: Text('Без кнопки')),
                    DropdownMenuItem(value: 'menu', child: Text('В меню')),
                    DropdownMenuItem(value: 'booking', child: Text('К брони')),
                  ],
                  onChanged: (v) => setLocal(() => action = v ?? 'none'),
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
    final data = {
      'title': title.text.trim(),
      'text': body.text.trim(),
      'imageUrl': image.text.trim(),
      'action': action,
      'actionLabel': action == 'menu'
          ? 'Смотреть меню'
          : action == 'booking'
              ? 'Забронировать'
              : '',
    };
    if (story == null) {
      await _db.collection('stories').add({
        ...data,
        'published': false,
        'byAi': false,
        'order': 0,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } else {
      await _db.collection('stories').doc(story.id).update(data);
    }
  }
}
