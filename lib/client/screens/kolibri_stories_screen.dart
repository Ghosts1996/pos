import 'package:cached_network_image/cached_network_image.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import '../../utils/shared_stream.dart';
import 'package:flutter/material.dart';
import '../../build_info.dart';
import '../../models/story_model.dart';
import '../../utils/linkify_utils.dart';
import '../theme/kolibri_theme.dart';

/// Лента заведения: миксы, ивенты, акции. Бесконечного индикатора нет —
/// пока данных нет или ошибка, блок просто схлопывается.
class KolibriStoriesScreen extends StatelessWidget {
  final void Function(int tabIndex)? onOpenTab;

  const KolibriStoriesScreen({super.key, this.onOpenTab});

  /// Одна подписка на ленту на всё приложение: экран без состояния и
  /// строится заново вместе с главной — без общей ссылки лента каждый раз
  /// переподписывалась на базу.
  static final _stories = SharedStreams<QuerySnapshot>();

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot>(
      // orderBy убран сознательно: связка where + orderBy требует составного
      // индекса, без которого запрос падает с ошибкой — и лента «висела».
      // Карточек в ленте единицы, поэтому сортируем на устройстве.
      stream: _stories.get(AppScope.tenantId ?? '-',
          () => AppScope.col('stories').where('published', isEqualTo: true).limit(30).snapshots()),
      builder: (context, snap) {
        if (snap.hasError || !snap.hasData) return const SizedBox.shrink();

        final stories = snap.data!.docs.map(StoryCard.fromDoc).where((s) => s.isLive).toList()
          ..sort((a, b) {
            final byOrder = a.order.compareTo(b.order);
            return byOrder != 0 ? byOrder : b.createdAt.compareTo(a.createdAt);
          });
        if (stories.isEmpty) return const SizedBox.shrink();

        if (!kSaasMode) return _classicList(context, stories);
        return LayoutBuilder(builder: (context, box) {
          // Одна карточка — во всю ширину; несколько — лента, где видно
          // край следующей (понятно, что листается).
          final single = stories.length == 1;
          final w = single ? box.maxWidth : (box.maxWidth * 0.82).clamp(240.0, 340.0);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: KolibriSectionLabel('Афиша'),
              ),
              SizedBox(
                height: 228,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  // Листается по одной карточке: карточка встаёт к краю
                  // целиком, а не обрезанной на полуслове.
                  physics: single
                      ? const NeverScrollableScrollPhysics()
                      : _SnapPhysics(itemExtent: w + 12, parent: const BouncingScrollPhysics()),
                  itemCount: stories.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 12),
                  itemBuilder: (_, i) => _card(context, stories[i], w),
                ),
              ),
            ],
          );
        });
      },
    );
  }

  static IconData _iconOf(StoryCard s) => switch (s.action) {
        'booking' => Icons.event_seat_outlined,
        'menu' => Icons.restaurant_menu_outlined,
        _ => Icons.auto_awesome_outlined,
      };

  /// Карточка афиши: фото из меню на всю карточку с тёмной вуалью снизу,
  /// заголовок антиквой, кнопка-пилюля. Без фото — мягкий градиент цвета
  /// заведения с крупным значком: карточка не выглядит пустой.
  Widget _card(BuildContext context, StoryCard s, double width) {
    final photo = s.imageUrl.isNotEmpty;
    const onPhoto = Colors.white;
    final titleColor = photo ? onPhoto : KolibriColors.textPrimary;
    final textColor = photo ? onPhoto.withValues(alpha: 0.86) : KolibriColors.textMuted;
    final tappable = s.action == 'menu' || s.action == 'booking';
    // Нажатие на карточку — карточка целиком: в ленте помещается только
    // начало текста, а гостю нужно прочитать всё и открыть ссылки.
    return Semantics(
      button: true,
      label: s.title,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(22),
          onTap: () => _openStory(context, s),
          child: Ink(
            width: width,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(22),
              border: Border.all(color: KolibriColors.border.withValues(alpha: photo ? 0 : 1)),
              gradient: photo
                  ? null
                  : LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        Color.lerp(KolibriColors.surface, KolibriColors.primary, 0.22)!,
                        KolibriColors.surface,
                      ],
                    ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(22),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (photo)
                    CachedNetworkImage(
                      imageUrl: s.imageUrl,
                      fit: BoxFit.cover,
                      memCacheWidth: (width * MediaQuery.of(context).devicePixelRatio).round(),
                      placeholder: (_, __) => ColoredBox(color: KolibriColors.surfaceElevated),
                      errorWidget: (_, __, ___) => ColoredBox(color: KolibriColors.surfaceElevated),
                    )
                  else
                    Positioned(
                      right: -18,
                      top: -14,
                      child: Icon(_iconOf(s), size: 132, color: KolibriColors.primary.withValues(alpha: 0.13)),
                    ),
                  if (photo)
                    const DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          stops: [0.25, 1],
                          colors: [Color(0x00000000), Color(0xCC000000)],
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        // Крупный шрифт телефона: текст ужимается по месту
                        // (Flexible), а не вылезает за карточку.
                        Flexible(
                          child: Text(s.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: KolibriFonts.display(25, color: titleColor).copyWith(height: 1.05)),
                        ),
                        const SizedBox(height: 6),
                        Flexible(
                          child: Text.rich(
                            TextSpan(
                              children: linkifySpans(
                                s.text,
                                style: TextStyle(color: textColor, fontSize: 13.5, height: 1.3),
                              ),
                            ),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        ...[
                          const SizedBox(height: 12),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                            decoration: BoxDecoration(
                              color: KolibriColors.primary,
                              borderRadius: BorderRadius.circular(40),
                            ),
                            child: Row(mainAxisSize: MainAxisSize.min, children: [
                              Flexible(
                                child: Text(tappable && s.actionLabel.isNotEmpty ? s.actionLabel : 'Подробнее',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                        color: KolibriColors.onPrimary, fontWeight: FontWeight.w700, fontSize: 13)),
                              ),
                              const SizedBox(width: 6),
                              Icon(Icons.arrow_forward_rounded, size: 16, color: KolibriColors.onPrimary),
                            ]),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _go(StoryCard s) {
    if (s.action == 'menu') onOpenTab?.call(1);
    if (s.action == 'booking') onOpenTab?.call(2);
  }

  /// Карточка целиком — в нижнем листе.
  void _openStory(BuildContext context, StoryCard s) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: KolibriColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => StoryDetailSheet(story: s, onGo: () => _go(s)),
    );
  }

  /// hookah-pos — прежняя лента.
  Widget _classicList(BuildContext context, List<StoryCard> stories) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: KolibriSectionLabel('Афиша'),
        ),
        SizedBox(
          height: 180,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: stories.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (_, i) => _classicCard(context, stories[i]),
          ),
        ),
      ],
    );
  }

  Widget _classicCard(BuildContext context, StoryCard s) {
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
                // Карточка 260pt — декодируем под неё, а не исходник целиком.
                memCacheWidth: (260 * MediaQuery.of(context).devicePixelRatio).round(),
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
                    Text(s.actionLabel, style: TextStyle(color: KolibriColors.primary, fontWeight: FontWeight.w600)),
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

/// Карточка афиши целиком: фото, заголовок, весь текст с рабочими ссылками
/// и кнопка перехода (меню/бронь).
class StoryDetailSheet extends StatelessWidget {
  final StoryCard story;
  final VoidCallback onGo;
  const StoryDetailSheet({super.key, required this.story, required this.onGo});

  @override
  Widget build(BuildContext ctx) {
    final s = story;
    final tappable = s.action == 'menu' || s.action == 'booking';
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.88),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(color: KolibriColors.border, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            if (s.imageUrl.isNotEmpty) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: AspectRatio(
                  aspectRatio: 16 / 10,
                  child: CachedNetworkImage(
                    imageUrl: s.imageUrl,
                    fit: BoxFit.cover,
                    placeholder: (_, __) => ColoredBox(color: KolibriColors.surfaceElevated),
                    errorWidget: (_, __, ___) => ColoredBox(color: KolibriColors.surfaceElevated),
                  ),
                ),
              ),
              const SizedBox(height: 14),
            ],
            Text(s.title, style: KolibriFonts.display(28, color: KolibriColors.textPrimary).copyWith(height: 1.1)),
            const SizedBox(height: 10),
            Text.rich(TextSpan(
              children: linkifySpans(
                s.text,
                style: TextStyle(color: KolibriColors.textPrimary, fontSize: 16, height: 1.5),
                linkStyle: TextStyle(
                  color: KolibriColors.primary,
                  fontSize: 16,
                  height: 1.5,
                  fontWeight: FontWeight.w600,
                  decoration: TextDecoration.underline,
                  decorationColor: KolibriColors.primary,
                ),
              ),
            )),
            if (tappable) ...[
              const SizedBox(height: 18),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: KolibriColors.primary,
                  foregroundColor: KolibriColors.onPrimary,
                  minimumSize: const Size.fromHeight(50),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(40)),
                ),
                onPressed: () {
                  Navigator.pop(ctx);
                  onGo();
                },
                child: Text(s.actionLabel.isNotEmpty
                    ? s.actionLabel
                    : (s.action == 'menu' ? 'Смотреть меню' : 'Забронировать')),
              ),
            ],
            const SizedBox(height: 6),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Закрыть')),
          ],
        ),
      ),
    );
  }
}

/// Лента листается по одной карточке: после жеста карточка встаёт к левому
/// краю целиком. Последняя — к правому краю (дальше листать некуда).
class _SnapPhysics extends ScrollPhysics {
  final double itemExtent;
  const _SnapPhysics({required this.itemExtent, super.parent});

  @override
  _SnapPhysics applyTo(ScrollPhysics? ancestor) => _SnapPhysics(itemExtent: itemExtent, parent: buildParent(ancestor));

  @override
  Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
    if ((velocity <= 0 && position.pixels <= position.minScrollExtent) ||
        (velocity >= 0 && position.pixels >= position.maxScrollExtent)) {
      return super.createBallisticSimulation(position, velocity);
    }
    final tolerance = toleranceFor(position);
    var page = position.pixels / itemExtent;
    if (velocity < -tolerance.velocity) {
      page = page.floorToDouble();
    } else if (velocity > tolerance.velocity) {
      page = page.ceilToDouble();
    } else {
      page = page.roundToDouble();
    }
    final target = (page * itemExtent).clamp(position.minScrollExtent, position.maxScrollExtent);
    if ((target - position.pixels).abs() < tolerance.distance) return null;
    return ScrollSpringSimulation(spring, position.pixels, target, velocity, tolerance: tolerance);
  }

  @override
  bool get allowImplicitScrolling => false;
}
