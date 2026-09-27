import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/shared_stream.dart';

void main() {
  group('Общие подписки', () {
    test('один ключ — одна ссылка и одна подписка на источник', () async {
      final s = SharedStreams<int>();
      var opened = 0;
      final src = StreamController<int>.broadcast();
      Stream<int> create() {
        opened++;
        return src.stream;
      }

      final a = s.get('t1', create);
      final b = s.get('t1', create);
      expect(identical(a, b), isTrue, reason: 'StreamBuilder не должен переподписываться');

      final got1 = <int>[], got2 = <int>[];
      final s1 = a.listen(got1.add);
      final s2 = b.listen(got2.add);
      src.add(5);
      await Future<void>.delayed(Duration.zero);
      expect(opened, 1);
      expect(got1, [5]);
      expect(got2, [5]);
      await s1.cancel();
      await s2.cancel();
    });

    test('новый подписчик сразу получает последнее значение', () async {
      final s = SharedStreams<String>();
      final src = StreamController<String>.broadcast();
      final st = s.get('k', () => src.stream);
      final first = st.listen((_) {});
      src.add('стол занят');
      await Future<void>.delayed(Duration.zero);
      expect(await st.first, 'стол занят');
      await first.cancel();
    });

    test('последний отписался — источник отпущен, повторная подписка открывает заново', () async {
      final s = SharedStreams<int>();
      var opened = 0, cancelled = 0;
      Stream<int> create() {
        opened++;
        final c = StreamController<int>(onCancel: () => cancelled++);
        return c.stream;
      }

      final st = s.get('k', create);
      final sub = st.listen((_) {});
      await sub.cancel();
      expect(cancelled, 1);
      final sub2 = st.listen((_) {});
      expect(opened, 2);
      await sub2.cancel();
    });

    test('после ошибки следующий вызов получает свежую подписку', () async {
      final s = SharedStreams<int>();
      final c1 = StreamController<int>();
      final st = s.get('k', () => c1.stream);
      final errors = <Object>[];
      final sub = st.listen((_) {}, onError: errors.add);
      c1.addError('permission-denied');
      await Future<void>.delayed(Duration.zero);
      expect(errors, ['permission-denied']);
      final fresh = s.get('k', () => const Stream<int>.empty());
      expect(identical(fresh, st), isFalse);
      await sub.cancel();
    });

    test('ненужный ключ через полминуты уходит из кэша', () {
      fakeAsync((fa) {
        final s = SharedStreams<int>();
        final st = s.get('чек-1', () => StreamController<int>().stream);
        final sub = st.listen((_) {});
        expect(s.length, 1);
        sub.cancel();
        fa.elapse(const Duration(seconds: 29));
        expect(s.length, 1);
        fa.elapse(const Duration(seconds: 2));
        expect(s.length, 0);
      });
    });
  });
}
