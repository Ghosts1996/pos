import 'package:cloud_firestore/cloud_firestore.dart';

/// Карточка ленты в приложении гостя: новый микс, ивент, акция.
/// Публикуется администратором вручную или создаётся ИИ-редактором
/// (агент storyteller) как черновик с published = false.
class StoryCard {
  final String id;
  final String title;
  final String text;
  final String imageUrl;

  /// Куда ведёт кнопка: 'menu' | 'booking' | 'none'.
  final String action;
  final String actionLabel;

  /// Если акция привязана к позиции меню — подсветим её в меню.
  final String menuItemId;

  final bool published;

  /// Черновик от ИИ — админ видит пометку и может отредактировать.
  final bool byAi;

  final DateTime createdAt;
  final DateTime? publishUntil;
  final int order;

  StoryCard({
    required this.id,
    required this.title,
    required this.text,
    this.imageUrl = '',
    this.action = 'none',
    this.actionLabel = '',
    this.menuItemId = '',
    this.published = false,
    this.byAi = false,
    required this.createdAt,
    this.publishUntil,
    this.order = 0,
  });

  bool get isLive =>
      published && (publishUntil == null || publishUntil!.isAfter(DateTime.now()));

  factory StoryCard.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    final created = data['createdAt'];
    final until = data['publishUntil'];
    return StoryCard(
      id: doc.id,
      title: data['title'] ?? '',
      text: data['text'] ?? '',
      imageUrl: data['imageUrl'] ?? '',
      action: data['action'] ?? 'none',
      actionLabel: data['actionLabel'] ?? '',
      menuItemId: data['menuItemId'] ?? '',
      published: data['published'] ?? false,
      byAi: data['byAi'] ?? false,
      createdAt: created is Timestamp ? created.toDate() : DateTime.now(),
      publishUntil: until is Timestamp ? until.toDate() : null,
      order: (data['order'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toMap() => {
        'title': title,
        'text': text,
        'imageUrl': imageUrl,
        'action': action,
        'actionLabel': actionLabel,
        'menuItemId': menuItemId,
        'published': published,
        'byAi': byAi,
        'createdAt': Timestamp.fromDate(createdAt),
        'publishUntil': publishUntil != null ? Timestamp.fromDate(publishUntil!) : null,
        'order': order,
      };
}
