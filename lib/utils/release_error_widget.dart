import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// В релизной сборке виджет, упавший при построении, Flutter заменяет серым
/// прямоугольником на всю доступную высоту — на экране администратора так
/// пропадали плитки. Гостю и сотруднику этот прямоугольник ничего не
/// говорит: прячем место ошибки, а сама ошибка по-прежнему уходит в
/// FlutterError.onError (журнал устройства). В отладке остаётся красный
/// экран с текстом — так ошибку видно сразу.
void installReleaseErrorWidget() {
  if (!kReleaseMode) return;
  ErrorWidget.builder = (details) => const SizedBox.shrink();
}
