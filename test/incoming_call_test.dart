import 'dart:io';
import 'dart:ui' as ui;

import 'package:cloud_firestore/cloud_firestore.dart' show Timestamp;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/widgets/incoming_call_banner.dart';

void main() {
  test('звонок: постоянный гость, новый номер, проверочный', () {
    final now = DateTime(2026, 11, 22, 19, 30);
    final g = IncomingCall.fromMap('c1', {
      'at': Timestamp.fromDate(now.subtract(const Duration(seconds: 20))),
      'phone': '79001234567',
      'tail': '4567',
      'guest': {'uid': 'g1', 'visits': 5, 'bonus': 320, 'lastVisitAt': Timestamp.fromDate(DateTime(2026, 11, 12))},
    });
    expect(g.shownPhone, '+7 (900) 123-45-67');
    expect(g.who, contains('5 визитов'));
    expect(g.who, contains('320 бонусов'));
    expect(g.who, contains('был 12.11'));
    final n = IncomingCall.fromMap('c2', {'at': Timestamp.fromDate(now), 'tail': '3344'});
    expect(n.shownPhone, '… 3344', reason: 'номер ещё не пришёл из справочника — хвост');
    expect(n.who, startsWith('Новый номер'));
    expect(IncomingCall.fromMap('c3', {'at': Timestamp.fromDate(now), 'test': true}).who, contains('Проверочный'));
    expect(IncomingCall.fromMap('c4', {'at': Timestamp.fromDate(now), 'guest': {'uid': 'g', 'visits': 1}}).who, contains('1 визит'));
    expect(IncomingCall.fromMap('c5', {'at': Timestamp.fromDate(now), 'guest': {'uid': 'g', 'visits': 3}}).who, contains('3 визита'));
  });

  test('на кассе висят только свежие звонки, новые — сверху', () {
    final now = DateTime(2026, 11, 22, 19, 30);
    IncomingCall c(String id, int sec) => IncomingCall(id: id, at: now.subtract(Duration(seconds: sec)));
    final list = ringingCalls([c('old', 400), c('a', 100), c('b', 10)], now);
    expect(list.map((x) => x.id), ['b', 'a']);
  });

  group('карточка звонка на кассе', () {
    setUpAll(() async {
      final l = FontLoader('Onest');
      for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
        l.addFont(Future.value(ByteData.sublistView(File('assets/fonts/Onest-$w.ttf').readAsBytesSync())));
      }
      await l.load();
    });
    for (final (w, scale) in [(412.0, 1.0), (412.0, 1.6), (1024.0, 1.0)]) {
      testWidgets('без переполнения: ширина $w, шрифт ×$scale', (t) async {
        await t.binding.setSurfaceSize(Size(w, 360));
        addTearDown(() => t.binding.setSurfaceSize(null));
        var taps = <String>[];
        final key = GlobalKey();
        await t.pumpWidget(MaterialApp(
          theme: ThemeData(fontFamily: 'Onest'),
          home: MediaQuery(
            data: MediaQueryData(size: Size(w, 360), textScaler: TextScaler.linear(scale)),
            child: Scaffold(
              body: RepaintBoundary(
                key: key,
                child: Column(children: [
                  IncomingCallCard(
                    animate: false,
                    call: IncomingCall(id: 'c1', at: DateTime.now(), phone: '79001234567', guestUid: 'g1', visits: 5, bonus: 320,
                        lastVisitAt: DateTime(2026, 11, 12), tier: 'Золото'),
                    more: 1,
                    onDelivery: () => taps.add('d'),
                    onTakeaway: () => taps.add('t'),
                    onDismiss: () => taps.add('x'),
                  ),
                ]),
              ),
            ),
          ),
        ));
        await t.pump();
        expect(t.takeException(), isNull);
        final dir = Platform.environment['SHOT_DIR'];
        if (dir != null) {
          await t.pump();
          await t.runAsync(() async {
            final img = await (key.currentContext!.findRenderObject() as RenderRepaintBoundary).toImage(pixelRatio: 2);
            final png = await img.toByteData(format: ui.ImageByteFormat.png);
            File('$dir/call-${w.toInt()}-$scale.png').writeAsBytesSync(png!.buffer.asUint8List());
          });
        }

        expect(find.text('+7 (900) 123-45-67'), findsOneWidget);
        expect(find.text('  ещё 1 на линии'), findsOneWidget);
        await t.tap(find.text('Доставка'));
        await t.tap(find.text('С собой'));
        await t.tap(find.byTooltip('Скрыть'));
        expect(taps, ['d', 't', 'x']);
      });
    }
  });
}
