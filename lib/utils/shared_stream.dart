import 'dart:async';

/// Общие подписки: один ключ (стол, чек, список вызовов) отдаёт один и тот
/// же Stream, пока на него подписаны. StreamBuilder сравнивает стримы по
/// ссылке, и стрим, созданный в build, переподписывался бы на каждой
/// перерисовке. Заодно несколько виджетов делят одну подписку.
///
/// Новый подписчик сразу получает последнее значение — как снапшот
/// Firestore из кэша.
class SharedStreams<T> {
  /// Сколько ключ живёт в кэше без подписчиков: касса работает сутками,
  /// чеков за смену — сотни, ненужные ключи не должны копиться.
  static const idleTtl = Duration(seconds: 30);

  final _cache = <String, Stream<T>>{};

  Stream<T> get(String key, Stream<T> Function() create) {
    final existing = _cache[key];
    if (existing != null) return existing;

    StreamSubscription<T>? source;
    late final StreamController<T> hub;
    late final Stream<T> shared;
    T? last;
    var hasLast = false;

    hub = StreamController<T>.broadcast(
      onListen: () {
        source = create().listen(
          (v) {
            last = v;
            hasLast = true;
            hub.add(v);
          },
          onError: (Object e, StackTrace st) {
            // Ошибка (нет доступа, нет сети при старте) — текущие
            // подписчики её увидят, а следующий вызов get() получит новую
            // подписку, а не этот «сломанный» стрим навсегда.
            if (identical(_cache[key], shared)) _cache.remove(key);
            hub.addError(e, st);
          },
          onDone: () {
            if (identical(_cache[key], shared)) _cache.remove(key);
          },
        );
      },
      onCancel: () {
        // Последний подписчик ушёл — отпускаем подписку на базу. Если на
        // этот же объект подпишутся снова, onListen откроет её заново.
        source?.cancel();
        source = null;
        hasLast = false;
        last = null;
        Timer(idleTtl, () {
          if (!hub.hasListener && identical(_cache[key], shared)) _cache.remove(key);
        });
      },
    );

    shared = Stream<T>.multi((listener) {
      if (hasLast) listener.add(last as T);
      final sub = hub.stream.listen(listener.add, onError: listener.addError, onDone: listener.close);
      listener.onCancel = sub.cancel;
    }, isBroadcast: true);

    _cache[key] = shared;
    return shared;
  }

  /// Сброс — при смене заведения (другой tenantId, другие данные).
  void clear() => _cache.clear();

  /// Сколько ключей сейчас в кэше — для тестов.
  int get length => _cache.length;
}
