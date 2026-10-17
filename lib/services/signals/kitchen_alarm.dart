import 'dart:async';

import 'package:flutter/foundation.dart';

/// Заказ, который кухня ещё не приняла.
class KitchenCall {
  final String sessionId;
  final String tableName;

  /// Что пришло: «Цезарь ×2, Лимонад» — для баннера и уведомления.
  final String summary;
  final DateTime at;

  const KitchenCall({required this.sessionId, required this.tableName, required this.summary, required this.at});
}

/// Тревога кухни: новый заказ звенит, пока повар не нажмёт «Принял».
///
/// Разовый писк повар пропускает: руки заняты, вытяжка шумит. Поэтому
/// сигнал повторяется каждые [repeat], а через [escalateAfter] без ответа
/// вызывается [onEscalate] — звонок на раздаче, лампа (Wi‑Fi реле).
///
/// Сам звук делает [onRing]: экран кухни подставляет туда системный звук,
/// вибрацию и уведомление. Класс без Flutter-виджетов — его проверяют
/// тесты с поддельным временем.
class KitchenAlarm extends ChangeNotifier {
  KitchenAlarm({
    required this.onRing,
    this.onEscalate,
    this.onSilence,
    this.repeat = const Duration(seconds: 4),
    this.escalateAfter = const Duration(seconds: 45),
    DateTime Function()? clock,
  }) : _now = clock ?? DateTime.now;

  final void Function(KitchenCall latest, {required bool first}) onRing;
  final void Function(KitchenCall call)? onEscalate;

  /// Все заказы приняты — снять уведомление, остановить звук.
  final VoidCallback? onSilence;

  final Duration repeat;
  final Duration escalateAfter;
  final DateTime Function() _now;

  final _pending = <String, KitchenCall>{};
  final _escalated = <String>{};

  /// Недавно принятые: тот же заказ, пришедший вторым путём (по Wi‑Fi
  /// заведения и следом из облака), второй раз не звенит.
  final _accepted = <String, DateTime>{};
  static const _acceptedMemory = Duration(minutes: 3);

  Timer? _timer;
  bool _enabled = true;

  /// Звук выключен кнопкой на экране кухни: заказы копятся в баннере, но
  /// не звенят.
  bool get enabled => _enabled;
  set enabled(bool v) {
    if (_enabled == v) return;
    _enabled = v;
    if (!v) _stop();
    if (v && _pending.isNotEmpty) _start(first: false);
    notifyListeners();
  }

  List<KitchenCall> get pending => _pending.values.toList()..sort((a, b) => a.at.compareTo(b.at));
  bool get ringing => _timer != null;

  /// Новый заказ по чеку [sessionId]. Повтор по уже звенящему чеку
  /// обновляет текст, но не перезапускает отсчёт до эскалации.
  void raise(String sessionId, String tableName, String summary) {
    final acceptedAt = _accepted[sessionId];
    if (acceptedAt != null && _now().difference(acceptedAt) < const Duration(seconds: 20)) return;
    final was = _pending[sessionId];
    _pending[sessionId] = KitchenCall(
      sessionId: sessionId,
      tableName: tableName,
      summary: was == null || was.summary == summary ? summary : '${was.summary}, $summary',
      at: was?.at ?? _now(),
    );
    notifyListeners();
    if (!_enabled) return;
    if (_timer == null) {
      _start(first: true);
    } else {
      onRing(_pending[sessionId]!, first: true);
    }
  }

  /// «Принял» по одному чеку.
  void accept(String sessionId) {
    if (_pending.remove(sessionId) == null) return;
    _escalated.remove(sessionId);
    _accepted[sessionId] = _now();
    _forgetOld();
    if (_pending.isEmpty) _stop();
    notifyListeners();
  }

  /// «Принял» всё сразу.
  void acceptAll() {
    for (final id in _pending.keys.toList()) {
      accept(id);
    }
  }

  void _start({required bool first}) {
    _timer?.cancel();
    final latest = pending.last;
    onRing(latest, first: first);
    _timer = Timer.periodic(repeat, (_) => _tick());
  }

  void _tick() {
    if (_pending.isEmpty || !_enabled) {
      _stop();
      return;
    }
    final now = _now();
    for (final c in _pending.values) {
      if (!_escalated.contains(c.sessionId) && now.difference(c.at) >= escalateAfter) {
        _escalated.add(c.sessionId);
        onEscalate?.call(c);
      }
    }
    onRing(pending.last, first: false);
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
    onSilence?.call();
  }

  void _forgetOld() {
    final now = _now();
    _accepted.removeWhere((_, at) => now.difference(at) > _acceptedMemory);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
