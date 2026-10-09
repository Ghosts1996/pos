import 'dart:async';

/// Последние значения двух потоков вместе: первое событие — когда оба
/// прислали хотя бы по одному значению, дальше — на каждое новое.
Stream<R> combineLatest2<A, B, R>(Stream<A> a, Stream<B> b, R Function(A, B) combine) {
  late StreamController<R> out;
  StreamSubscription<A>? subA;
  StreamSubscription<B>? subB;
  A? lastA;
  B? lastB;
  var hasA = false, hasB = false;
  void emit() {
    if (hasA && hasB) out.add(combine(lastA as A, lastB as B));
  }

  out = StreamController<R>(
    onListen: () {
      subA = a.listen((v) {
        lastA = v;
        hasA = true;
        emit();
      }, onError: out.addError);
      subB = b.listen((v) {
        lastB = v;
        hasB = true;
        emit();
      }, onError: out.addError);
    },
    onCancel: () async {
      await subA?.cancel();
      await subB?.cancel();
    },
  );
  return out.stream;
}
