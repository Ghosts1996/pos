import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Ширины, от которых меняется раскладка: до [tablet] — телефон (одна
/// колонка, списки на всю ширину), от [tablet] — планшет (две колонки,
/// формы по центру ограниченной ширины), от [wide] — большой планшет в
/// альбомной ориентации или окно Windows.
class Breakpoints {
  Breakpoints._();
  static const double tablet = 600;
  static const double wide = 900;

  /// Удобная ширина формы или списка на планшете: шире строки растягиваются
  /// на весь экран и читать их неудобно.
  static const double form = 720;

  /// Кратчайшая сторона экрана, начиная с которой устройство — планшет:
  /// ему можно поворачиваться как угодно, телефон держим вертикально.
  /// Ниже привычных 600 dp — у бюджетных 8-дюймовых планшетов бывает 530.
  static const double tabletShortestSide = 520;
}

/// Наибольший масштаб системного шрифта, который выдерживают экраны кассы:
/// «Крупный шрифт» Android (до ×1.3) — как в системе, дальше (до ×2 на
/// Android 14) — не крупнее ×1.3, иначе суммы и кнопки не помещаются даже
/// на планшете.
const double kMaxTextScale = 1.3;

extension AdaptiveContext on BuildContext {
  double get screenWidth => MediaQuery.sizeOf(this).width;

  /// Ширина планшета (или телефона в альбомной ориентации шире 600 dp).
  bool get isTabletWidth => screenWidth >= Breakpoints.tablet;

  /// Экран ниже 480 dp: телефон в альбомной ориентации или окно Windows —
  /// шапки и отступы нужно ужимать.
  bool get isShortScreen => MediaQuery.sizeOf(this).height < 480;

  /// [base] с поправкой на системный шрифт — для строк фиксированной высоты
  /// (сетки карточек, плитки): растёт только та часть, что занята текстом.
  double scaledExtent(double base, {required double textPart}) =>
      base + MediaQuery.textScalerOf(this).scale(textPart) - textPart;
}

/// Колонка ограниченной ширины по центру: на телефоне ничего не меняет, на
/// планшете форма или список не растягиваются на весь экран.
class CenteredBody extends StatelessWidget {
  final Widget child;
  final double maxWidth;
  const CenteredBody({super.key, required this.child, this.maxWidth = Breakpoints.form});

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, box) => Align(
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: math.min(maxWidth, box.maxWidth),
            height: box.maxHeight.isFinite ? box.maxHeight : null,
            child: child,
          ),
        ),
      );
}

/// Отступы по бокам, чтобы содержимое прокручиваемого списка на планшете
/// шло колонкой [maxWidth] по центру, а сам список (и полоса прокрутки)
/// оставался на всю ширину экрана.
EdgeInsets centeredListPadding(BuildContext context,
    {double maxWidth = Breakpoints.form, double horizontal = 12, double top = 8, double bottom = 24}) {
  final w = MediaQuery.sizeOf(context).width;
  final side = math.max(horizontal, (w - maxWidth) / 2);
  return EdgeInsets.fromLTRB(side, top, side, bottom);
}

/// Обёртка всего приложения (MaterialApp.builder):
/// * системный шрифт — не крупнее [kMaxTextScale];
/// * телефон держится вертикально (в альбомной ориентации клавиатура
///   закрывает почти весь экран, а у кассы и гостя — длинные списки),
///   планшет и раскладной телефон в раскрытом виде поворачиваются свободно.
///   Решает размер самого экрана, а не окна: в режиме «два окна» планшет
///   остаётся планшетом.
class AdaptiveAppFrame extends StatefulWidget {
  final Widget child;
  const AdaptiveAppFrame({super.key, required this.child});

  @override
  State<AdaptiveAppFrame> createState() => _AdaptiveAppFrameState();
}

class _AdaptiveAppFrameState extends State<AdaptiveAppFrame> with WidgetsBindingObserver {
  bool? _phoneLocked;

  static bool get _mobile =>
      !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

  @override
  void initState() {
    super.initState();
    if (_mobile) WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _applyOrientation();
  }

  @override
  void didChangeMetrics() => _applyOrientation();

  @override
  void dispose() {
    if (_mobile) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _applyOrientation() {
    if (!_mobile || !mounted) return;
    final view = View.maybeOf(context);
    if (view == null) return;
    final phone = isPhoneDisplay(view.display.size, view.display.devicePixelRatio);
    if (phone == null || phone == _phoneLocked) return;
    _phoneLocked = phone;
    SystemChrome.setPreferredOrientations(
      phone ? const [DeviceOrientation.portraitUp, DeviceOrientation.portraitDown] : const <DeviceOrientation>[],
    );
  }

  @override
  Widget build(BuildContext context) =>
      MediaQuery.withClampedTextScaling(maxScaleFactor: kMaxTextScale, child: widget.child);
}

/// true — экран телефона (кратчайшая сторона меньше
/// [Breakpoints.tabletShortestSide] dp), false — планшет, null — размер
/// экрана ещё неизвестен.
@visibleForTesting
bool? isPhoneDisplay(Size physicalSize, double devicePixelRatio) {
  if (physicalSize.isEmpty || devicePixelRatio <= 0) return null;
  return physicalSize.shortestSide / devicePixelRatio < Breakpoints.tabletShortestSide;
}
