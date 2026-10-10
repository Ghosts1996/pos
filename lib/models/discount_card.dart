import 'package:cloud_firestore/cloud_firestore.dart';
import '../services/people_directory.dart';

class DiscountCard {
  final String id;
  final String cardNumber;
  final String _guestName;
  String get guestName => Pd.name('card', id, _guestName);
  final double discountPercent;
  final String _notes;
  String get notes => Pd.extra('card', id, 'notes', _notes);
  final bool active;

  DiscountCard({
    required this.id,
    required this.cardNumber,
    required String guestName,
    required this.discountPercent,
    String notes = '',
    this.active = true,
  }) : _guestName = guestName, _notes = notes;

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
        if (Pd.mirror) 'guestName': guestName,
        'discountPercent': discountPercent,
        if (Pd.mirror) 'notes': notes,
        'active': active,
      };
}
