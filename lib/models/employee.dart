import 'package:cloud_firestore/cloud_firestore.dart';

class Employee {
  final String id;
  final String name;
  final String pinCode; // 4-значный пин для входа
  final String role;    // 'admin' | 'employee'

  Employee({
    required this.id,
    required this.name,
    required this.pinCode,
    required this.role,
  });

  factory Employee.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return Employee(
      id: doc.id,
      name: data['name'] ?? '',
      pinCode: data['pinCode'] ?? '',
      role: data['role'] ?? 'employee',
    );
  }

  Map<String, dynamic> toMap() => {'name': name, 'pinCode': pinCode, 'role': role};
}
