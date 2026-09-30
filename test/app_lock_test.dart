import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/employee.dart';
import 'package:hookah_pos/screens/pin_lock_screen.dart';
import 'package:hookah_pos/services/app_lock.dart';
import 'package:hookah_pos/utils/constants.dart';

final _anya = Employee(
  id: 'e1',
  name: 'Аня',
  pinCode: '1111',
  role: AppConstants.roleEmployee,
  position: AppConstants.positionWaiter,
);

void main() {
  final lock = AppLock.instance;

  setUp(lock.signedOut);

  group('PIN после закрытия и сворачивания кассы', () {
    testWidgets('свернули кассу — при возвращении ввод PIN того, кто работал', (tester) async {
      lock.signedIn(_anya);
      lock.didChangeAppLifecycleState(AppLifecycleState.inactive);
      expect(lock.locked.value, isNull, reason: 'шторка уведомлений — не повод блокировать');
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(lock.locked.value?.id, 'e1');
      expect(await lock.didPopRoute(), isTrue, reason: '«Назад» не уводит из-под блокировки');

      lock.signedIn(_anya);
      expect(lock.locked.value, isNull);
      expect(await lock.didPopRoute(), isFalse);
    });

    testWidgets('на экране входа блокировать нечего', (tester) async {
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(lock.locked.value, isNull);
    });

    testWidgets('выбор фото не блокирует, следующий уход — блокирует', (tester) async {
      lock.signedIn(_anya);
      final picked = lock.whileAway(() async {
        lock.didChangeAppLifecycleState(AppLifecycleState.paused);
        lock.didChangeAppLifecycleState(AppLifecycleState.resumed);
        return 'photo.jpg';
      });
      expect(await picked, 'photo.jpg');
      expect(lock.locked.value, isNull);
      await tester.pump(const Duration(seconds: 4));
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(lock.locked.value?.id, 'e1');
    });

    testWidgets('звонок гостю: ушли уже после ответа launchUrl — тоже без PIN', (tester) async {
      lock.signedIn(_anya);
      await lock.whileAway(() async => true);
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      await tester.pump(const Duration(seconds: 10)); // идёт разговор
      lock.didChangeAppLifecycleState(AppLifecycleState.resumed);
      expect(lock.locked.value, isNull);
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(lock.locked.value?.id, 'e1');
    });

    testWidgets('экран блокировки: чужой PIN не пускает, свой — возвращает кассу', (tester) async {
      lock.signedIn(_anya);
      lock.didChangeAppLifecycleState(AppLifecycleState.paused);
      await tester.pumpWidget(MaterialApp(home: PinLockScreen(employee: _anya)));
      expect(find.text('Касса заблокирована'), findsOneWidget);
      expect(find.text('Аня'), findsOneWidget);

      for (final d in '2222'.split('')) {
        await tester.tap(find.bySemanticsLabel(d));
        await tester.pump();
      }
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Неверный PIN-код'), findsOneWidget);
      expect(lock.locked.value?.id, 'e1');

      for (final d in '1111'.split('')) {
        await tester.tap(find.bySemanticsLabel(d));
        await tester.pump();
      }
      expect(lock.locked.value, isNull);
    });
  });
}
