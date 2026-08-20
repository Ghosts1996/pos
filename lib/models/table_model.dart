import 'package:cloud_firestore/cloud_firestore.dart';

/// Модель стола на карте зала
class TableModel {
  final String id;
  final String name;       // Название/номер стола, напр. "Стол 3"
  final double x;          // Позиция X на карте (0..1, относительно ширины)
  final double y;          // Позиция Y на карте (0..1, относительно высоты)
  final int seats;         // Количество мест
  final String shape;      // 'rect' или 'circle'
  final String status;     // 'free' | 'occupied'
  final String? currentSessionId;

  TableModel({
    required this.id,
    required this.name,
    required this.x,
    required this.y,
    this.seats = 4,
    this.shape = 'rect',
    this.status = 'free',
    this.currentSessionId,
  });

  factory TableModel.fromDoc(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>? ?? {};
    return TableModel(
      id: doc.id,
      name: data['name'] ?? '',
      x: (data['x'] ?? 0.1).toDouble(),
      y: (data['y'] ?? 0.1).toDouble(),
      seats: data['seats'] ?? 4,
      shape: data['shape'] ?? 'rect',
      status: data['status'] ?? 'free',
      currentSessionId: data['currentSessionId'],
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'name': name,
      'x': x,
      'y': y,
      'seats': seats,
      'shape': shape,
      'status': status,
      'currentSessionId': currentSessionId,
    };
  }

  TableModel copyWith({
    String? name,
    double? x,
    double? y,
    int? seats,
    String? shape,
    String? status,
    String? currentSessionId,
    bool clearSession = false,
  }) {
    return TableModel(
      id: id,
      name: name ?? this.name,
      x: x ?? this.x,
      y: y ?? this.y,
      seats: seats ?? this.seats,
      shape: shape ?? this.shape,
      status: status ?? this.status,
      currentSessionId: clearSession ? null : (currentSessionId ?? this.currentSessionId),
    );
  }
}
