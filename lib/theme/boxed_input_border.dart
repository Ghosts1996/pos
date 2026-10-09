import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

/// Рамка поля ввода, у которой подпись при вводе поднимается внутрь поля,
/// а не на линию рамки.
///
/// У обычного OutlineInputBorder поднятая подпись наполовину торчит над
/// полем и налезает на то, что стоит выше: на подсказку соседнего поля или
/// на текст раздела. При крупном шрифте в настройках телефона это особенно
/// заметно — «Продавец» ложился поверх описания, «ОГРН» — на «10 цифр у
/// организации». Рамка рисуется та же, скруглённая, просто без выреза под
/// подпись: для поля она «не контурная» (isOutline == false).
class BoxedInputBorder extends OutlineInputBorder {
  const BoxedInputBorder({
    super.borderSide,
    super.borderRadius,
    super.gapPadding,
  });

  @override
  bool get isOutline => false;

  @override
  BoxedInputBorder copyWith({BorderSide? borderSide, BorderRadius? borderRadius, double? gapPadding}) =>
      BoxedInputBorder(
        borderSide: borderSide ?? this.borderSide,
        borderRadius: borderRadius ?? this.borderRadius,
        gapPadding: gapPadding ?? this.gapPadding,
      );

  @override
  BoxedInputBorder scale(double t) => BoxedInputBorder(
        borderSide: borderSide.scale(t),
        borderRadius: borderRadius * t,
        gapPadding: gapPadding * t,
      );

  @override
  ShapeBorder? lerpFrom(ShapeBorder? a, double t) {
    if (a is BoxedInputBorder) {
      return BoxedInputBorder(
        borderSide: BorderSide.lerp(a.borderSide, borderSide, t),
        borderRadius: BorderRadius.lerp(a.borderRadius, borderRadius, t)!,
        gapPadding: lerpDouble(a.gapPadding, gapPadding, t)!,
      );
    }
    return super.lerpFrom(a, t);
  }

  @override
  ShapeBorder? lerpTo(ShapeBorder? b, double t) {
    if (b is BoxedInputBorder) {
      return BoxedInputBorder(
        borderSide: BorderSide.lerp(borderSide, b.borderSide, t),
        borderRadius: BorderRadius.lerp(borderRadius, b.borderRadius, t)!,
        gapPadding: lerpDouble(gapPadding, b.gapPadding, t)!,
      );
    }
    return super.lerpTo(b, t);
  }

  @override
  void paint(
    Canvas canvas,
    Rect rect, {
    double? gapStart,
    double gapExtent = 0.0,
    double gapPercentage = 0.0,
    TextDirection? textDirection,
  }) {
    // Вырез под подпись не нужен — подпись внутри поля.
    super.paint(canvas, rect, textDirection: textDirection);
  }
}
