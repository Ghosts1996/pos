import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/resume_hook.dart';

void main() {
  // Android 15+ останавливает фоновую службу после 6 часов в фоне за сутки.
  // Когда приложение снова на экране, службу поднимаем заново — хук зовёт
  // проверку только при возвращении, и подключается один раз.
  testWidgets('возвращение на экран зовёт перезапуск службы', (tester) async {
    var calls = 0;
    final hook = ResumeHook(() async => calls++);
    hook.attach();
    hook.attach(); // повторное подключение не удваивает вызовы
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(calls, 0, reason: 'уход с экрана — не повод перезапускать');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(calls, 1);
  });
}
