import 'dart:ui' show Offset;

import 'package:cloud_firestore/cloud_firestore.dart';

import '../utils/hall_layout.dart';
import '../utils/parse.dart';

/// Подпись на схеме зала: «Вход», «Кухня», «WC» или заметка («Курящая
/// зона»). Рисуется как на чертеже — заглавными с разрядкой, приглушённым
/// цветом (см. HallWallsPainter). У каждой зоны свои подписи.
///
/// Коллекция hallLabels: зона, текст и центр подписи на холсте [kHallCanvas].
class HallLabel {
  final String id;
  final String zone;
  final String text;

  /// Центр подписи на холсте.
  final Offset at;

  static const int maxLength = 40;

  const HallLabel({required this.id, required this.zone, required this.text, required this.at});

  factory HallLabel.fromMap(String id, Map<String, dynamic> d) {
    var text = asText(d['text']).trim().replaceAll(RegExp(r'\s+'), ' ');
    if (text.length > maxLength) text = text.substring(0, maxLength);
    final x = asNum(d['x'])?.toDouble() ?? 0, y = asNum(d['y'])?.toDouble() ?? 0;
    return HallLabel(
      id: id,
      zone: asText(d['zone']).trim(),
      text: text,
      at: Offset(
        x.isFinite ? x.clamp(0.0, kHallCanvas.width) : 0,
        y.isFinite ? y.clamp(0.0, kHallCanvas.height) : 0,
      ),
    );
  }

  factory HallLabel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) => HallLabel.fromMap(doc.id, doc.data() ?? const {});

  bool get isValid => text.isNotEmpty;

  Map<String, dynamic> toMap() => {
        'zone': zone,
        'text': text,
        'x': (at.dx * 10).roundToDouble() / 10,
        'y': (at.dy * 10).roundToDouble() / 10,
      };

  HallLabel copyWith({String? text, Offset? at, String? zone}) =>
      HallLabel(id: id, zone: zone ?? this.zone, text: text ?? this.text, at: at ?? this.at);
}

/// Кегль подписи на холсте (плитка стола — [kHallTile]).
const double kHallLabelFontSize = 18;

/// Готовые подписи в редакторе.
const kHallLabelSuggestions = [
  'Вход', 'Выход', 'Бар', 'Кухня', 'WC', 'Гардероб', 'VIP-зал', 'Сцена', 'Касса', 'Терраса', 'Курящая зона',
];
