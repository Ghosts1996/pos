import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/reservation_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/widgets/table_tile.dart';

// Карточка стола в «Списке» зала: при крупном шрифте телефона ничего не
// вылезает за край, сумма счёта видна целиком (SaaS — уменьшается, а не
// режется многоточием), бронь показывает время.
void main() {
  // Настоящий шрифт: квадратный тестовый шрифт шире и даёт ложные «overflowed».
  setUpAll(() async {
    final l = FontLoader('Onest');
    for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      l.addFont(Future.value(ByteData.sublistView(File('assets/fonts/Onest-$w.ttf').readAsBytesSync())));
    }
    await l.load();
  });
  final now = DateTime.now();
  TableModel tb(String id, String n, {bool busy = false}) =>
      TableModel(id: id, name: n, x: 0, y: 0, activeSessionIds: busy ? ['s$id'] : const []);

  for (final scale in [1.0, 1.6]) {
    testWidgets('карточки стола без переполнения, шрифт ×$scale', (t) async {
      await t.binding.setSurfaceSize(const Size(412, 900));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(MaterialApp(
        theme: ThemeData(fontFamily: 'Onest'),
        home: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: Scaffold(
            body: GridView(
              gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 240, mainAxisExtent: 116 + 56 * (scale - 1), crossAxisSpacing: 10, mainAxisSpacing: 10),
              children: [
                TableCard(
                    table: tb('1', 'VIP 1', busy: true),
                    startTime: now.subtract(const Duration(minutes: 70)),
                    plannedEnd: now.add(const Duration(minutes: 50)),
                    billTotal: 12850,
                    guestTag: 'Анна'),
                TableCard(
                    table: tb('2', 'VIP 2'),
                    reservation: ReservationModel(
                        id: 'r', guestName: 'Игорь', phone: '', guestsCount: 6,
                        startTime: now.add(const Duration(minutes: 40)), createdAt: now)),
                TableCard(table: tb('3', 'Стол 3')),
                TableCard(
                    table: tb('4', 'Стол 4', busy: true),
                    startTime: now.subtract(const Duration(minutes: 130)),
                    plannedEnd: now.subtract(const Duration(minutes: 5)),
                    billTotal: 3100,
                    hasCall: true),
              ],
            ),
          ),
        ),
      ));
      await t.pump(const Duration(milliseconds: 50));
      expect(t.takeException(), isNull);
      expect(find.text('Свободен'), findsOneWidget);
      if (kSaasMode) {
        expect(find.textContaining('12 850'), findsOneWidget);
        expect(find.textContaining('Бронь · Игорь'), findsOneWidget);
      }
      await t.pumpWidget(const SizedBox());
    });
  }
}
