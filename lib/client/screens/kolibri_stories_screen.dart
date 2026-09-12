import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../models/story_model.dart';
import '../theme/kolibri_theme.dart';

/// Лента заведения в приложении гостя: новые миксы, ивенты, акции.
/// Показываются только опубликованные и не истёкшие карточки.
class KolibriStoriesScreen extends StatelessWidget {
  /// Переход на вкладку меню/брони по кнопке карточки.
  final void Function(int tabIndex)? onOpenTab;

  const KolibriStoriesScreen({super.key, this.onOpenTab});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot>(
      stream: FirebaseFirestore.instance
          .collection('stories')
          .where('published', isEqualTo: true)
          .orderBy('order')
          .limit(30)
          .snapshots(),
      builder: (context, snap) {
        if (!snap.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        final stories =
            snap.data!.docs.map(StoryCard.fromDoc).where((s) => s.isLive).toList();
        if (stories.isEmpty) return const SizedBox.shrink();

        return SizedBox(
          height: 190,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            itemCount: stories.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (_, i) => _card(context, stories[i]),
          ),
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
                errorWidget: (_, __, ___) => const SizedBox.shrink(),
              ),
            // Затемнение, чтобы текст читался на любой картинке.
            Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Colors.transparent, Color(0xCC07100D)],
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
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text(
                    s.text,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                  ),
                  if (s.actionLabel.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(s.actionLabel,
                        style: const TextStyle(
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
