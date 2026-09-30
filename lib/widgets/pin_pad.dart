import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Фирменные цвета ZalPOS для экранов входа — те же, что у лендинга и
/// кабинета (saas/console/console.css): глубокий тёмно-синий фон, синий
/// градиент акцента и мягкое свечение.
class BrandPalette {
  BrandPalette._();
  static const Color night = Color(0xFF03060D);
  static const Color navy = Color(0xFF070F20);
  static const Color blue = Color(0xFF2F6FED);
  static const Color sky = Color(0xFF59A6FF);
  static const Color muted = Color(0xFF8DA0C7);
  static const LinearGradient accent = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [blue, sky],
  );
}

/// Фон экранов входа и блокировки: ночь с синим свечением сверху и
/// тонкой сеткой точек, как схема зала на лендинге.
class BrandBackdrop extends StatelessWidget {
  const BrandBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [BrandPalette.navy, BrandPalette.night],
        ),
      ),
      child: Stack(fit: StackFit.expand, children: [
        const IgnorePointer(child: CustomPaint(painter: _DotsPainter())),
        const IgnorePointer(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: Alignment(0, -1.05),
                radius: 1.1,
                colors: [Color(0x552F6FED), Color(0x00070F20)],
              ),
            ),
          ),
        ),
        const IgnorePointer(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: Alignment(1.1, 1.1),
                radius: 0.9,
                colors: [Color(0x2259A6FF), Color(0x0003060D)],
              ),
            ),
          ),
        ),
        child,
      ]),
    );
  }
}

class _DotsPainter extends CustomPainter {
  const _DotsPainter();

  @override
  void paint(Canvas canvas, Size size) {
    const step = 26.0;
    final paint = Paint()..color = const Color(0x14FFFFFF);
    for (var y = step / 2; y < size.height; y += step) {
      for (var x = step / 2; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 0.9, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DotsPainter oldDelegate) => false;
}

/// Знак ZalPOS со свечением и надпись.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.caption});

  /// Строка под названием (заведение) — заглавными, как подписи на схеме.
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final text = caption?.trim() ?? '';
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          boxShadow: const [BoxShadow(color: Color(0x662F6FED), blurRadius: 32, spreadRadius: -4)],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: Image.asset('assets/icon/icon.png', fit: BoxFit.cover),
        ),
      ),
      const SizedBox(height: 14),
      const Text(
        'ZalPOS',
        textAlign: TextAlign.center,
        style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: 0.4),
      ),
      if (text.isNotEmpty) ...[
        const SizedBox(height: 6),
        Text(
          text.toUpperCase(),
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
              color: BrandPalette.muted, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 2.2),
        ),
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
            width: on ? 15 : 13,
            height: on ? 15 : 13,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: on && !error ? BrandPalette.accent : null,
              color: error ? const Color(0xFFFF5C6C) : (on ? null : Colors.transparent),
              border: on || error ? null : Border.all(color: Colors.white30, width: 1.4),
              boxShadow: on && !error
                  ? const [BoxShadow(color: Color(0x992F6FED), blurRadius: 12, spreadRadius: -2)]
                  : null,
            ),
          );
        }),
      ),
    );
  }
}

/// Цифровая клавиатура: стеклянные круглые клавиши с тонкой рамкой и
/// синим откликом нажатия.
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
        color: back ? Colors.transparent : const Color(0x0FFFFFFF),
        shape: CircleBorder(side: BorderSide(color: back ? Colors.transparent : const Color(0x1FFFFFFF))),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          customBorder: const CircleBorder(),
          splashColor: const Color(0x552F6FED),
          highlightColor: const Color(0x332F6FED),
          onTap: onTap,
          child: Center(
            child: back
                ? Icon(Icons.backspace_outlined, color: BrandPalette.muted, size: big ? 24 : 21)
                : Text(label,
                    style: TextStyle(
                        color: Colors.white, fontSize: big ? 28 : 24, fontWeight: FontWeight.w300, height: 1)),
          ),
        ),
      ),
    );
  }
}

/// Переключатель «Сотрудник / Администратор» — капсула с синим
/// градиентом под выбранным вариантом.
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
              gradient: on ? BrandPalette.accent : null,
              boxShadow: on ? const [BoxShadow(color: Color(0x662F6FED), blurRadius: 16, spreadRadius: -4)] : null,
            ),
            child: Text(text,
                style: TextStyle(
                    color: on ? Colors.white : BrandPalette.muted, fontSize: 13.5, fontWeight: FontWeight.w700)),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: const Color(0x0DFFFFFF),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0x1FFFFFFF)),
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
