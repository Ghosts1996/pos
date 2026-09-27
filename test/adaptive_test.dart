import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/adaptive.dart';

/// Размер виджета [key] после раскладки в окне [size] с масштабом шрифта [scale].
Future<Size> _layout(WidgetTester tester, Widget child, {Size size = const Size(360, 800), double scale = 1}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MediaQuery(
    data: MediaQueryData(size: size, textScaler: TextScaler.linear(scale)),
    child: Directionality(textDirection: TextDirection.ltr, child: child),
  ));
  return tester.getSize(find.byKey(const Key('probe')));
}

void main() {
  group('isPhoneDisplay', () {
    test('телефоны — вертикально, планшеты — как угодно', () {
      // 1080×2400 при 2.75 — обычный телефон (≈393 dp).
      expect(isPhoneDisplay(const Size(1080, 2400), 2.75), isTrue);
      // Бюджетный 8-дюймовый планшет 800×1280 при 1.5 — 533 dp.
      expect(isPhoneDisplay(const Size(800, 1280), 1.5), isFalse);
      // 10-дюймовый планшет в альбомной ориентации.
      expect(isPhoneDisplay(const Size(2560, 1600), 2), isFalse);
      // Раскладной телефон: в сложенном виде — телефон, в раскрытом — планшет.
      expect(isPhoneDisplay(const Size(904, 2316), 2.625), isTrue);
      expect(isPhoneDisplay(const Size(1812, 2176), 2.625), isFalse);
    });

    test('неизвестный размер экрана — ничего не решаем', () {
      expect(isPhoneDisplay(Size.zero, 2), isNull);
      expect(isPhoneDisplay(const Size(1080, 2400), 0), isNull);
    });
  });

  testWidgets('scaledExtent растит только текстовую часть', (tester) async {
    late double normal, large, huge;
    Widget probe(void Function(double) out) => Builder(builder: (context) {
          out(context.scaledExtent(116, textPart: 56));
          return const SizedBox(key: Key('probe'));
        });
    await _layout(tester, probe((v) => normal = v));
    await _layout(tester, probe((v) => large = v), scale: 1.3);
    await _layout(tester, probe((v) => huge = v), scale: 2);
    expect(normal, 116);
    expect(large, closeTo(116 + 56 * 0.3, 0.001));
    expect(huge, 116 + 56);
  });

  testWidgets('CenteredBody: на телефоне во всю ширину, на планшете — колонка по центру', (tester) async {
    const body = CenteredBody(maxWidth: 720, child: SizedBox.expand(key: Key('probe')));
    expect(await _layout(tester, body), const Size(360, 800));
    expect(await _layout(tester, body, size: const Size(1280, 800)), const Size(720, 800));
    expect(tester.getTopLeft(find.byKey(const Key('probe'))).dx, (1280 - 720) / 2);
  });

  testWidgets('centeredListPadding: поля не уже заданных и центрируют колонку', (tester) async {
    late EdgeInsets phone, tablet;
    Widget probe(void Function(EdgeInsets) out) => Builder(builder: (context) {
          out(centeredListPadding(context, maxWidth: 680, horizontal: 20));
          return const SizedBox(key: Key('probe'));
        });
    await _layout(tester, probe((v) => phone = v));
    await _layout(tester, probe((v) => tablet = v), size: const Size(1280, 800));
    expect(phone.left, 20);
    expect(phone.right, 20);
    expect(tablet.left, (1280 - 680) / 2);
    expect(tablet.right, tablet.left);
  });

  testWidgets('AdaptiveAppFrame ограничивает системный шрифт', (tester) async {
    late double scale;
    await _layout(
      tester,
      AdaptiveAppFrame(
        child: Builder(builder: (context) {
          scale = MediaQuery.textScalerOf(context).scale(10) / 10;
          return const SizedBox(key: Key('probe'));
        }),
      ),
      scale: 2,
    );
    expect(scale, kMaxTextScale);

    await _layout(
      tester,
      AdaptiveAppFrame(
        child: Builder(builder: (context) {
          scale = MediaQuery.textScalerOf(context).scale(10) / 10;
          return const SizedBox(key: Key('probe'));
        }),
      ),
      scale: 1.15,
    );
    expect(scale, closeTo(1.15, 0.0001));
  });
}
