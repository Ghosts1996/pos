// Палитра гостевого приложения (KolibriColors.applyBranding) на всех
// пресетах раздела «Брендинг» консоли (PREMIUM_PALETTES в
// saas/console/console.js) и на брендинге по умолчанию: всё, что гость
// должен прочитать, читается.
//
// Раньше сумма бонусов красилась во второстепенный цвет, а он во всех
// тёмных пресетах (и в BrandingConfig по умолчанию — #162A4A) тёмный: на
// тёмном фоне контраст ~1.2:1.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/client/theme/kolibri_theme.dart';
import 'package:hookah_pos/models/tenant_models.dart';

double _lum(Color c) {
  double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

double _contrast(Color a, Color b) {
  final la = _lum(a) + 0.05;
  final lb = _lum(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

const _presets = <String, BrandingConfig>{
  'midnight': BrandingConfig(primaryColor: '#0B5ED7', secondaryColor: '#162A4A', backgroundColor: '#02050B', textColor: '#F8FAFC'),
  'emerald': BrandingConfig(primaryColor: '#9C7A22', secondaryColor: '#0E2A20', backgroundColor: '#071510', textColor: '#F4EFDD'),
  'bordeaux': BrandingConfig(primaryColor: '#9C4A57', secondaryColor: '#3B0D14', backgroundColor: '#170406', textColor: '#F7E9E9'),
  'onyxgold': BrandingConfig(primaryColor: '#8C6B18', secondaryColor: '#1C1C1C', backgroundColor: '#0A0A0A', textColor: '#F5EFD6'),
  'amethyst': BrandingConfig(primaryColor: '#7A4FB0', secondaryColor: '#2A1B3D', backgroundColor: '#0D0714', textColor: '#F3EAFB'),
  'copper': BrandingConfig(primaryColor: '#B25C29', secondaryColor: '#2B1B14', backgroundColor: '#120B08', textColor: '#FBEDE1'),
  'graphite': BrandingConfig(primaryColor: '#5B6472', secondaryColor: '#1D2024', backgroundColor: '#0E0F11', textColor: '#F2F3F5'),
  'sandstone': BrandingConfig(primaryColor: '#B5652E', secondaryColor: '#E4D8C4', backgroundColor: '#F3ECE1', textColor: '#2B1D12'),
  'по умолчанию': BrandingConfig(),
};

void main() {
  for (final entry in _presets.entries) {
    test('палитра гостя читается: ${entry.key}', () {
      KolibriColors.applyBranding(entry.value);
      final surfaces = [KolibriColors.background, KolibriColors.surface, KolibriColors.surfaceElevated];
      for (final s in surfaces) {
        expect(_contrast(KolibriColors.gold, s), greaterThanOrEqualTo(3.0), reason: 'сумма бонусов');
        expect(_contrast(KolibriColors.textMuted, s), greaterThanOrEqualTo(4.5), reason: 'приглушённый текст');
        expect(_contrast(KolibriColors.textPrimary, s), greaterThanOrEqualTo(3.0), reason: 'основной текст');
      }
      // Рамка карточки отличима от фона.
      expect(_contrast(KolibriColors.border, KolibriColors.background), greaterThan(1.15));
      // Текст на кнопке — лучший из белого/тёмного.
      final onP = _contrast(KolibriColors.onPrimary, KolibriColors.primary);
      expect(onP, greaterThanOrEqualTo(_contrast(Colors.white, KolibriColors.primary) - 0.001));
      expect(onP, greaterThanOrEqualTo(_contrast(const Color(0xFF04140E), KolibriColors.primary) - 0.001));
    });
  }

  test('светлый фон → светлая тема, тёмный → тёмная', () {
    KolibriColors.applyBranding(_presets['sandstone']!);
    expect(KolibriColors.isLight, isTrue);
    expect(KolibriTheme.dark.brightness, Brightness.light);
    KolibriColors.applyBranding(_presets['midnight']!);
    expect(KolibriColors.isLight, isFalse);
    expect(KolibriTheme.dark.brightness, Brightness.dark);
  });

  test('читаемый второстепенный цвет остаётся «золотом» как есть', () {
    KolibriColors.applyBranding(const BrandingConfig(
        primaryColor: '#12B981', secondaryColor: '#E0B354', backgroundColor: '#07100D', textColor: '#F2F7F4'));
    expect(KolibriColors.gold, const Color(0xFFE0B354));
  });
}
