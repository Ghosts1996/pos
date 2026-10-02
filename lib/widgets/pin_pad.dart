import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

/// Фирменные цвета ZalPOS для экранов входа — те же, что у лендинга и
/// кабинета (saas/console/console.css): тёплый графит, медь и латунь.
class BrandPalette {
  BrandPalette._();
  static const Color ink = AppColors.background;
  static const Color copper = AppColors.primary;
  static const Color brass = AppColors.brass;
  static const Color muted = AppColors.textMuted;
  static const Color ivory = AppColors.textPrimary;
  static const Color error = Color(0xFFE0715E);
  static const Color hairline = Color(0x1FF2EADF);

  /// Почти ровная медь — градиент лишь снимает «пластиковость» заливки.
  static const LinearGradient accent = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFFBC6536), copper],
  );
}

/// Фон экранов входа и блокировки: ровный графит и тонкая двойная рамка
/// по краю, как у карты меню, — без свечений и узоров.
class BrandBackdrop extends StatelessWidget {
  const BrandBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: BrandPalette.ink,
      child: Stack(fit: StackFit.expand, children: [
        const IgnorePointer(child: CustomPaint(painter: _FramePainter())),
        child,
      ]),
    );
  }
}

class _FramePainter extends CustomPainter {
  const _FramePainter();

  @override
  void paint(Canvas canvas, Size size) {
    // На узком телефоне рамка съедает место — только на планшете и шире.
    if (size.shortestSide < 520) return;
    final outer = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = const Color(0x33CFA567);
    final inner = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = const Color(0x17CFA567);
    canvas.drawRect(Rect.fromLTWH(18, 18, size.width - 36, size.height - 36), outer);
    canvas.drawRect(Rect.fromLTWH(24, 24, size.width - 48, size.height - 48), inner);
  }

  @override
  bool shouldRepaint(covariant _FramePainter oldDelegate) => false;
}

/// Знак ZalPOS — набран антиквой, как на лендинге: «Zal» прямым,
/// «POS» курсивом в меди. Под ним — заведение капителью между линиями.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.caption});

  /// Строка под названием (заведение) — заглавными.
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final text = caption?.trim() ?? '';
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Text.rich(
        TextSpan(children: [
          const TextSpan(text: 'Zal'),
          TextSpan(text: 'POS', style: AppFonts.display(44, color: BrandPalette.copper, style: FontStyle.italic)),
        ]),
        textAlign: TextAlign.center,
        style: AppFonts.display(44, color: BrandPalette.ivory),
      ),
      if (text.isNotEmpty) ...[
        const SizedBox(height: 10),
        Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 22, height: 1, color: const Color(0x55CFA567)),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              text.toUpperCase(),
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppFonts.overline.copyWith(color: BrandPalette.brass, letterSpacing: 2.4),
            ),
          ),
          const SizedBox(width: 10),
          Container(width: 22, height: 1, color: const Color(0x55CFA567)),
        ]),
      ],
    ]);
  }
}

/// Точки набранного PIN. [errorTick] меняется при неверном PIN — точки
/// вздрагивают, как в системном экране блокировки.
class PinDots extends StatelessWidget {
  const PinDots({super.key, required this.length, required this.filled, this.errorTick = 0, this.error = false});

  final int length;
  final int filled;
  final int errorTick;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      key: ValueKey(errorTick),
      tween: Tween(begin: errorTick == 0 ? 1 : 0, end: 1),
      duration: const Duration(milliseconds: 420),
      builder: (context, t, child) => Transform.translate(
        offset: Offset(math.sin(t * math.pi * 6) * 9 * (1 - t), 0),
        child: child,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(length, (i) {
          final on = i < filled;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            margin: const EdgeInsets.symmetric(horizontal: 7),
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: error ? BrandPalette.error : (on ? BrandPalette.brass : Colors.transparent),
              border: on || error ? null : Border.all(color: const Color(0x66A39A8E), width: 1.2),
            ),
          );
        }),
      ),
    );
  }
}

/// Цифровая клавиатура: круглые клавиши тонкой линией, медный отклик
/// нажатия.
class PinKeypad extends StatelessWidget {
  const PinKeypad({super.key, required this.width, required this.onDigit, required this.onBackspace});

  final double width;
  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;

  @override
  Widget build(BuildContext context) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return SizedBox(
      width: width,
      child: GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: keys.map((k) {
          if (k.isEmpty) return const SizedBox.shrink();
          final back = k == '⌫';
          return Padding(
            padding: EdgeInsets.all(width >= 260 ? 7 : 5),
            child: _Key(
              label: k,
              back: back,
              big: width >= 260,
              onTap: () {
                HapticFeedback.selectionClick();
                back ? onBackspace() : onDigit(k);
              },
            ),
          );
        }).toList(),
      ),
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({required this.label, required this.back, required this.big, required this.onTap});

  final String label;
  final bool back;
  final bool big;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        shape: CircleBorder(side: BorderSide(color: back ? Colors.transparent : BrandPalette.hairline)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          customBorder: const CircleBorder(),
          splashColor: const Color(0x40B35C30),
          highlightColor: const Color(0x26B35C30),
          onTap: onTap,
          child: Center(
            child: back
                ? Icon(Icons.backspace_outlined, color: BrandPalette.muted, size: big ? 23 : 20)
                : Text(label,
                    style: TextStyle(
                        fontFamily: AppFonts.sans,
                        color: BrandPalette.ivory,
                        fontSize: big ? 27 : 23,
                        fontWeight: FontWeight.w400,
                        height: 1)),
          ),
        ),
      ),
    );
  }
}

/// Переключатель «Сотрудник / Администратор» — капсула тонкой линией,
/// выбранный вариант залит медью.
class RoleSwitch extends StatelessWidget {
  const RoleSwitch({super.key, required this.admin, required this.onChanged, this.enabled = true});

  final bool admin;
  final ValueChanged<bool> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    Widget seg(String text, bool value) {
      final on = admin == value;
      return Semantics(
        button: true,
        selected: on,
        label: text,
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: enabled ? () => onChanged(value) : null,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              color: on ? BrandPalette.copper : null,
            ),
            child: Text(text,
                style: TextStyle(
                    fontFamily: AppFonts.sans,
                    color: on ? BrandPalette.ivory : BrandPalette.muted,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600)),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: BrandPalette.hairline),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [seg('Сотрудник', false), seg('Администратор', true)]),
    );
  }
}

/// Ширина клавиатуры под экран: квадратные клавиши в три колонки, на
/// невысоком широком экране — сбоку от шапки.
double pinKeypadWidth(BoxConstraints box, {required bool side, double headerHeight = 290}) {
  final maxKeypad = math.max(160.0, math.min(300.0, box.maxWidth - 32));
  return side
      ? ((box.maxHeight - 32) * 3 / 4).clamp(math.min(180.0, maxKeypad), maxKeypad).toDouble()
      : ((box.maxHeight - headerHeight) * 3 / 4).clamp(math.min(210.0, maxKeypad), maxKeypad).toDouble();
}
