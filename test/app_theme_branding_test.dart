// Касса (AppTheme.branded) со светлым пресетом консоли остаётся тёмной:
// карточки/диалоги/поля ввода у неё из тёмной базы, и тёмный текст бренда
// на них не читался (контраст ~1.1:1). Тёмные пресеты применяются как есть.

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/tenant_models.dart';
import 'package:hookah_pos/theme/app_colors.dart';
import 'package:hookah_pos/theme/app_theme.dart';

void main() {
  test('светлый пресет: касса не берёт светлый фон и тёмный текст', () {
    final theme = AppTheme.branded(const BrandingConfig(
        primaryColor: '#B5652E', secondaryColor: '#E4D8C4', buttonColor: '#B5652E',
        backgroundColor: '#F3ECE1', textColor: '#2B1D12'));
    expect(theme.scaffoldBackgroundColor, AppColors.background);
    expect(theme.colorScheme.onSurface, AppColors.textPrimary);
    // Фирменный акцент при этом остаётся.
    expect(theme.colorScheme.primary.toARGB32(), 0xFFB5652E);
  });

  test('тёмный пресет применяется как есть', () {
    final theme = AppTheme.branded(const BrandingConfig(
        primaryColor: '#9C4A57', secondaryColor: '#3B0D14', buttonColor: '#9C4A57',
        backgroundColor: '#170406', textColor: '#F7E9E9'));
    expect(theme.scaffoldBackgroundColor.toARGB32(), 0xFF170406);
    expect(theme.colorScheme.onSurface.toARGB32(), 0xFFF7E9E9);
  });
}
