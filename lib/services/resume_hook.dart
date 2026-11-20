import 'dart:async';

import 'package:flutter/widgets.dart';

/// Зовёт [onResume], когда приложение снова на экране. Нужен фоновым
/// службам: Android 15+ останавливает службу «синхронизация данных» после
/// 6 часов в фоне за сутки, а на экране лимит не расходуется — значит,
/// при возвращении службу можно поднять заново.
class ResumeHook with WidgetsBindingObserver {
  ResumeHook(this.onResume);

  final Future<void> Function() onResume;
  bool _attached = false;

  void attach() {
    if (_attached) return;
    _attached = true;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(onResume());
  }
}
