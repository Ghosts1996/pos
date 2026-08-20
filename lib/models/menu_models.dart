import 'package:cloud_firestore/cloud_firestore.dart';

class MenuCategory {
  final String id;
  final String name;
  final int order;

  MenuCategory({required this.id, required this.name, this.order = 0});

  factory MenuCategory.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuCategory(id: doc.id, name: data['name'] ?? '', order: data['order'] ?? 0);
  }

  Map<String, dynamic> toMap() => {'name': name, 'order': order};
}

class MenuItem {
  final String id;
  final String categoryId;
  final String name;
  final double price;
  final bool available;

  MenuItem({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.price,
    this.available = true,
  });

  factory MenuItem.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return MenuItem(
      id: doc.id,
      categoryId: data['categoryId'] ?? '',
      name: data['name'] ?? '',
      price: (data['price'] ?? 0).toDouble(),
      available: data['available'] ?? true,
    );
  }

  Map<String, dynamic> toMap() => {
        'categoryId': categoryId,
        'name': name,
        'price': price,
        'available': available,
      };
}
