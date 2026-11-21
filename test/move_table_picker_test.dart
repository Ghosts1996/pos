import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/reservation_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/widgets/move_table_picker.dart';

// Пересадка гостя (SaaS): столы по группам, брони на столах, бронь, которая
// начнётся раньше, чем гость уйдёт, — только после подтверждения; при
// крупном шрифте ничего не вылезает за край.
void main() {
  setUpAll(() async {
    final l = FontLoader('Onest');
    for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      l.addFont(Future.value(ByteData.sublistView(File('assets/fonts/Onest-$w.ttf').readAsBytesSync())));
    }
    await l.load();
  });

  final now = DateTime(2026, 11, 22, 20, 0);
  TableModel tb(String id, String n, {int seats = 4, int busy = 0, int max = 2, String zone = ''}) => TableModel(
      id: id, name: n, x: 0, y: 0, seats: seats, zone: zone, maxOpenSessions: max,
      status: busy > 0 ? 'occupied' : 'free', activeSessionIds: [for (var i = 0; i < busy; i++) 's$id$i']);
  ReservationModel rv(String table, int inMin, String who, int n,
          {ReservationStatus st = ReservationStatus.confirmed}) =>
      ReservationModel(
          id: 'r$table$inMin', guestName: who, phone: '', guestsCount: n, tableId: table,
          startTime: now.add(Duration(minutes: inMin)), status: st, createdAt: now);

  final tables = [
    tb('cur', 'Стол 2'),
    tb('v1', 'VIP 1', seats: 8),
    tb('v2', 'VIP 2', seats: 8),
    tb('t3', 'Стол 3', busy: 1, max: 3),
    tb('t4', 'Стол 4', busy: 2, max: 2),
    tb('t10', 'Стол 10', seats: 2),
    tb('t5', 'Стол 5', seats: 2),
    tb('bar', 'бар'),
  ];
  final reservations = [
    rv('v1', 40, 'Игорь', 6),
    rv('v1', 300, 'Анна', 4),
    rv('t5', 180, 'Олег', 2),
    rv('v2', 30, 'Отменили', 2, st: ReservationStatus.cancelled),
  ];

  test('до какого времени гость и какие брони мешают', () {
    expect(moveStayUntil(now.add(const Duration(minutes: 70)), now), now.add(const Duration(minutes: 70)));
    expect(moveStayUntil(now.add(const Duration(days: 3650)), now), now.add(const Duration(hours: 2)), reason: 'без ограничения — 2 часа');
    expect(moveStayUntil(now.subtract(const Duration(minutes: 5)), now), now.add(const Duration(hours: 2)));
    final v1 = upcomingTableReservations(reservations, 'v1', now);
    expect(v1.map((r) => r.guestName), ['Игорь', 'Анна']);
    expect(upcomingTableReservations(reservations, 'v2', now), isEmpty, reason: 'отменённая не мешает');
    expect(moveClash(v1, now.add(const Duration(hours: 2)))?.guestName, 'Игорь');
    expect(moveClash(upcomingTableReservations(reservations, 't5', now), now.add(const Duration(hours: 2))), isNull,
        reason: 'бронь через 3 часа гостю с 2 часами не мешает');
  });

  for (final scale in [1.0, 1.6]) {
    testWidgets('экран пересадки: группы, брони, без переполнения, шрифт ×$scale', (t) async {
      await t.binding.setSurfaceSize(const Size(412, 1400));
      addTearDown(() => t.binding.setSurfaceSize(null));
      TableModel? picked;
      final key = GlobalKey();
      await t.pumpWidget(MaterialApp(
        theme: ThemeData(fontFamily: 'Onest', brightness: Brightness.dark),
        home: MediaQuery(
          data: MediaQueryData(size: const Size(412, 1400), textScaler: TextScaler.linear(scale)),
          child: RepaintBoundary(
            key: key,
            child: Scaffold(
              appBar: AppBar(title: const Text('Пересадить гостя')),
              body: MoveTablePicker(
                currentTable: tables.first,
                tables: tables,
                reservations: reservations,
                stayUntil: moveStayUntil(null, now),
                now: now,
                onPick: (x) => picked = x,
              ),
            ),
          ),
        ),
      ));
      await t.pump();
      expect(t.takeException(), isNull);
      expect(find.text('Стол 2'), findsNothing, reason: 'текущий стол в списке не нужен');
      expect(find.text('Свободны'), findsOneWidget);
      expect(find.text('Можно подсадить — ещё один чек'), findsOneWidget);
      expect(find.text('Заняты полностью'), findsOneWidget);
      expect(find.textContaining('Бронь 20:40 · Игорь · 6 чел.'), findsOneWidget);
      expect(find.textContaining('Бронь 01:00 · Анна'), findsOneWidget);

      // Порядок: свободные без брони на время гостя — первыми, «Стол 5» раньше «Стол 10».
      final y = (String s) => t.getTopLeft(find.text(s)).dy;
      expect(y('VIP 2') < y('VIP 1'), isTrue, reason: 'VIP 1 с бронью через 40 мин — ниже');
      expect(y('Стол 5') < y('Стол 10'), isTrue);

      if (scale == 1.0) {
        final out = Platform.environment['MOVE_SHOT'];
        if (out != null) {
          await t.runAsync(() async {
            final img = await (key.currentContext!.findRenderObject() as RenderRepaintBoundary).toImage(pixelRatio: 1.5);
            final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
            File(out).writeAsBytesSync(bytes!.buffer.asUint8List());
          });
        }
      }

      // Свободный стол без брони — сразу.
      await t.tap(find.text('VIP 2'));
      await t.pumpAndSettle();
      expect(picked?.id, 'v2');

      // Стол с бронью раньше ухода гостя — сначала вопрос.
      picked = null;
      await t.tap(find.text('VIP 1'));
      await t.pumpAndSettle();
      expect(find.text('На «VIP 1» бронь в 20:40'), findsOneWidget);
      expect(picked, isNull);
      await t.tap(find.text('Выбрать другой'));
      await t.pumpAndSettle();
      expect(picked, isNull);
      await t.tap(find.text('VIP 1'));
      await t.pumpAndSettle();
      await t.tap(find.text('Всё равно пересадить'));
      await t.pumpAndSettle();
      expect(picked?.id, 'v1');

      // Полностью занятый — не выбрать.
      picked = null;
      await t.tap(find.text('Стол 4'), warnIfMissed: false);
      await t.pumpAndSettle();
      expect(picked, isNull);
    });
  }
}
