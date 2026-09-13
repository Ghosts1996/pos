import 'dart:async';
import 'package:flutter/material.dart';

/// Один общий «секундомер» на всё приложение.
///
/// Зачем он нужен. Раньше каждый [TimerDisplay] заводил собственный
/// `Timer.periodic` и раз в секунду дёргал `setState`. На карте зала из
/// двадцати столов это двадцать независимых таймеров, просыпающихся
/// вразнобой, — заметные подтормаживания на слабых POS-планшетах.
///
/// Здесь тикает ровно один таймер на процесс, и только пока на него
/// кто-то подписан: [addListener] заводит его при первом слушателе,
/// [removeListener] гасит при последнем. Виджеты подписываются через
/// [TickerBuilder].
class ClockTicker extends ValueNotifier<DateTime> {
  ClockTicker._() : super(DateTime.now());
  static final ClockTicker instance = ClockTicker._();

  Timer? _timer;

  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    _timer ??= Timer.periodic(
      const Duration(seconds: 1),
      (_) => value = DateTime.now(),
    );
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (!hasListeners) {
      _timer?.cancel();
      _timer = null;
    }
  }
}

/// Перестраивает [builder] раз в секунду от общего тикера.
/// Ребилдится только само поддерево builder'а, а не весь экран.
class TickerBuilder extends StatelessWidget {
  final Widget Function(BuildContext context, DateTime now) builder;
  const TickerBuilder({super.key, required this.builder});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<DateTime>(
      valueListenable: ClockTicker.instance,
      builder: (context, now, _) => builder(context, now),
    );
  }
}
