import 'package:cloud_firestore/cloud_firestore.dart';

class DiscountCard {
  final String id;
  final String cardNumber;
  final String guestName;
  final double discountPercent;
  final String notes;
  final bool active;

  DiscountCard({
    required this.id,
    required this.cardNumber,
    required this.guestName,
    required this.discountPercent,
    this.notes = '',
    this.active = true,
  });

  factory DiscountCard.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return DiscountCard(
      id: doc.id,
      cardNumber: data['cardNumber'] ?? '',
      guestName: data['guestName'] ?? '',
      discountPercent: (data['discountPercent'] ?? 0).toDouble(),
      notes: data['notes'] ?? '',
      active: data['active'] ?? true,
    );
  }

  Map<String, dynamic> toMap() => {
        'cardNumber': cardNumber,
        'guestName': guestName,
        'discountPercent': discountPercent,
        'notes': notes,
        'active': active,
      };
}
