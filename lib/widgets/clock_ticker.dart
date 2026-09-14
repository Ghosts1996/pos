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
  ClockTicker._() : super(DateTime.now()) {
    // Пока приложение не на экране, тикать бессмысленно: перерисовывать
    // нечего, а секундный таймер не даёт процессору уснуть и заметно ест
    // батарею — особенно на кассе, где приложение открыто всю смену и
    // часто лежит свёрнутым. При возвращении время обновляется сразу, до
    // первого тика, иначе таймеры столов на секунду показали бы старое.
    _lifecycle = AppLifecycleListener(
      onShow: _resume,
      onHide: _pause,
      onPause: _pause,
      onRestart: _resume,
    );
  }
  static final ClockTicker instance = ClockTicker._();

  Timer? _timer;
  late final AppLifecycleListener _lifecycle;
  bool _visible = true;

  void _start() {
    if (!_visible || !hasListeners) return;
    _timer ??= Timer.periodic(
      const Duration(seconds: 1),
      (_) => value = DateTime.now(),
    );
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
  }

  void _pause() {
    _visible = false;
    _stop();
  }

  void _resume() {
    _visible = true;
    value = DateTime.now();
    _start();
  }

  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    _start();
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (!hasListeners) _stop();
  }

  @override
  void dispose() {
    _stop();
    _lifecycle.dispose();
    super.dispose();
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
