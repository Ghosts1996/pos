import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/hall_label.dart';
import 'package:hookah_pos/models/hall_wall.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/utils/hall_layout.dart';

/// Схема зала по фото (saas-gateway/hall-import.js): сервер считает
/// расстановку по тем же правилам, что касса (hall_layout.dart). Образец —
/// test/fixtures/hall_import_plan.json, его выдаёт planFromAi: здесь
/// проверяем, что касса видит столы на площадке и без наложений, а стены и
/// подписи читаются.
void main() {
  final plan = jsonDecode(File('test/fixtures/hall_import_plan.json').readAsStringSync()) as Map<String, dynamic>;
  final zone = (plan['zones'] as List).first as Map<String, dynamic>;

  test('стены и подписи из импорта читаются моделями кассы', () {
    final walls = [
      for (final (i, w) in (zone['walls'] as List).indexed)
        HallWall.fromMap('w$i', {...(w as Map<String, dynamic>), 'zone': zone['name']}),
    ];
    expect(walls, isNotEmpty);
    expect(walls.every((w) => w.isValid), isTrue);
    expect(walls.first.closed, isTrue);
    final labels = [
      for (final (i, l) in (zone['labels'] as List).indexed)
        HallLabel.fromMap('l$i', {...(l as Map<String, dynamic>), 'zone': zone['name']}),
    ];
    expect(labels.single.text, 'Вход');
  });

  test('столы из импорта — на площадке SaaS и не наезжают друг на друга', () {
    final tables = [
      for (final (i, t) in (zone['tables'] as List).indexed)
        TableModel(
          id: 't$i',
          name: (t as Map<String, dynamic>)['name'] as String,
          x: (t['x'] as num).toDouble(),
          y: (t['y'] as num).toDouble(),
          seats: t['seats'] as int,
          shape: t['shape'] as String,
          rotation: t['rotation'] as int,
          zone: zone['name'] as String,
        ),
    ];
    expect(tables.length, 12);
    expect(tables.map((t) => t.shape).toSet(), containsAll(['rect', 'circle', 'bar', 'corner', 'long', 'oval']));
    // Площадка импорта — SaaS (24×20 клеток); в hookah-pos импорта нет.
    if (!kSaasMode) return;
    for (final t in tables) {
      final o = hallTileOffset(t), s = hallTileSize(t);
      expect(o.left + s.width <= kHallCanvas.width && o.top + s.height <= kHallCanvas.height, isTrue, reason: t.name);
      // Сервер ставит столы по сетке: положение не уезжает при чтении.
      expect((o.left / kHallGridStep - (o.left / kHallGridStep).round()).abs() < 0.01, isTrue, reason: '${t.name}: ${o.left}');
    }
    for (var i = 0; i < tables.length; i++) {
      for (var j = i + 1; j < tables.length; j++) {
        expect(hallTablesOverlap(tables[i], tables[j]), isFalse, reason: '${tables[i].name} и ${tables[j].name}');
      }
    }
  });
}
