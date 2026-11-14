import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/data/server_clock.dart';

void main() {
  tearDown(ServerClock.reset);

  test('без сверки с сервером времени нет', () {
    ServerClock.reset();
    expect(ServerClock.now(), isNull);
    expect(ServerClock.startTime(), isNull);
  });

  test('время идёт от сверки с сервером, а не от часов устройства', () async {
    // Часы планшета ушли на 3 часа вперёд: сервер говорит своё время.
    final server = DateTime.now().toUtc().subtract(const Duration(hours: 3));
    ServerClock.sync(server);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final now = ServerClock.now()!;
    expect(now.difference(server).inMilliseconds, inInclusiveRange(40, 2000));
    // Конец смены — по таймеру: перевод часов вперёд смену не удлиняет.
    expect(ServerClock.endTime()!.difference(server).inSeconds, lessThan(2));
  });

  test('заголовок Date ответа сервера', () {
    ServerClock.syncFromHeader('Sat, 14 Nov 2026 12:00:00 GMT');
    expect(ServerClock.now()!.toUtc().hour, 12);
    ServerClock.syncFromHeader('мусор');
    expect(ServerClock.synced, isTrue, reason: 'кривой заголовок прежнюю сверку не портит');
  });
}
