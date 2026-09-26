import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import '../../models/story_model.dart';
import '../../utils/linkify_utils.dart';
import '../theme/kolibri_theme.dart';

/// Лента заведения в приложении гостя: новые миксы, ивенты, акции.
///
/// Важное отличие от первой версии: лента НИКОГДА не показывает
/// бесконечный индикатор загрузки. Пока данных нет, ошибка доступа или
/// коллекция пуста — блок просто схлопывается, и главный экран выглядит
/// цельным. Спиннер посреди главной выглядел как зависшее приложение.
class KolibriStoriesScreen extends StatelessWidget {
  final void Function(int tabIndex)? onOpenTab;

  const KolibriStoriesScreen({super.key, this.onOpenTab});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot>(
      // orderBy убран сознательно: связка where + orderBy требует составного
      // индекса, без которого запрос падает с ошибкой — и лента «висела».
      // Карточек в ленте единицы, поэтому сортируем на устройстве.
      stream: AppScope.col('stories')
          .where('published', isEqualTo: true)
          .limit(30)
          .snapshots(),
      builder: (context, snap) {
        if (snap.hasError || !snap.hasData) return const SizedBox.shrink();

        final stories = snap.data!.docs.map(StoryCard.fromDoc).where((s) => s.isLive).toList()
          ..sort((a, b) {
            final byOrder = a.order.compareTo(b.order);
            return byOrder != 0 ? byOrder : b.createdAt.compareTo(a.createdAt);
          });
        if (stories.isEmpty) return const SizedBox.shrink();

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text('Афиша',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
            SizedBox(
              height: 180,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: stories.length,
                separatorBuilder: (_, __) => const SizedBox(width: 12),
                itemBuilder: (_, i) => _card(context, stories[i]),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _card(BuildContext context, StoryCard s) {
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: () {
        if (s.action == 'menu') onOpenTab?.call(1);
        if (s.action == 'booking') onOpenTab?.call(2);
      },
      child: Container(
        width: 260,
        decoration: BoxDecoration(
          color: KolibriColors.surface,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: KolibriColors.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (s.imageUrl.isNotEmpty)
              CachedNetworkImage(
                imageUrl: s.imageUrl,
                fit: BoxFit.cover,
                placeholder: (_, __) => const SizedBox.shrink(),
                errorWidget: (_, __, ___) => const SizedBox.shrink(),
              ),
            // Затемнение под текстом — цветом карточки, а не жёстко тёмным:
            // на светлой палитре заведения текст карточки тёмный, и на
            // тёмной подложке его было бы не прочесть.
            Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    KolibriColors.surface.withValues(alpha: 0),
                    KolibriColors.surface.withValues(alpha: 0.85),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text(s.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text.rich(
                    TextSpan(
                      children: linkifySpans(
                        s.text,
                        style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                      ),
                    ),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (s.actionLabel.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(s.actionLabel,
                        style: TextStyle(
                            color: KolibriColors.primary, fontWeight: FontWeight.w600)),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
