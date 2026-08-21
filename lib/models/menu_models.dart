import 'package:cloud_firestore/cloud_firestore.dart';

class MenuCategory {
  final String id;
  final String name;
  final int order;

  /// Публичная ссылка (Firebase Storage download URL) на фото-плитку
  /// категории — как на плитках "Бургеры" / "Барная карта" в Restik POS.
  /// Пусто, если фото ещё не загружено — тогда плитка рисуется заглушкой.
  final String imageUrl;

  MenuCategory({
    required this.id,
    required this.name,
    this.order = 0,
    this.imageUrl = '',
  });

  factory MenuCategory.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuCategory(
      id: doc.id,
      name: data['name'] ?? '',
      order: (data['order'] as num?)?.toInt() ?? 0,
      imageUrl: data['imageUrl'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {'name': name, 'order': order, 'imageUrl': imageUrl};

  MenuCategory copyWith({String? name, int? order, String? imageUrl}) => MenuCategory(
        id: id,
        name: name ?? this.name,
        order: order ?? this.order,
        imageUrl: imageUrl ?? this.imageUrl,
      );
}

class MenuItem {
  final String id;
  final String categoryId;
  final String name;
  final double price;
  final bool available;

  /// Фото блюда/позиции — используется в карточке позиции меню и, при
  /// желании, как фото по умолчанию для категории.
  final String imageUrl;

  MenuItem({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.price,
    this.available = true,
    this.imageUrl = '',
  });

  factory MenuItem.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuItem(
      id: doc.id,
      categoryId: data['categoryId'] ?? '',
      name: data['name'] ?? '',
      price: (data['price'] ?? 0).toDouble(),
      available: data['available'] ?? true,
      imageUrl: data['imageUrl'] ?? '',
    );
  }

  Map<String, dynamic> toMap() => {
        'categoryId': categoryId,
        'name': name,
        'price': price,
        'available': available,
        'imageUrl': imageUrl,
      };

  MenuItem copyWith({
    String? categoryId,
    String? name,
    double? price,
    bool? available,
    String? imageUrl,
  }) =>
      MenuItem(
        id: id,
        categoryId: categoryId ?? this.categoryId,
        name: name ?? this.name,
        price: price ?? this.price,
        available: available ?? this.available,
        imageUrl: imageUrl ?? this.imageUrl,
      );
}