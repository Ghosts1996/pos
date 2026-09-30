import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../models/employee.dart';

/// PIN после закрытия и сворачивания кассы.
///
/// Закрыли (смахнули из недавних, «Назад» с экрана входа) или система сама
/// выгрузила кассу — при запуске открывается ввод PIN: LoginScreen больше
/// не входит сам под прошлым сотрудником. Свернули на телефоне или
/// планшете — при возвращении поверх того же экрана PinLockScreen: вернуть
/// кассу может только PIN того, кто работал, остальные входят через
/// «Сменить сотрудника». Экран под блокировкой не пересоздаётся —
/// недонабранный чек остаётся на месте.
///
/// Свои выходы из кассы — выбор фото, звонок гостю, установка обновления —
/// оборачиваются в [whileAway] и не блокируют.
class AppLock with WidgetsBindingObserver {
  AppLock._();
  static final AppLock instance = AppLock._();

  /// Сотрудник, чей PIN вернёт кассу; null — касса не заблокирована.
  final ValueNotifier<Employee?> locked = ValueNotifier<Employee?>(null);

  Employee? _employee;
  bool _started = false;

  /// Сколько своих выходов из кассы сейчас идёт ([whileAway]).
  int _away = 0;

  /// Касса ушла с экрана во время своего выхода.
  bool _outside = false;

  /// Свои выходы, закончившиеся, пока касса была не на экране: отпускаем
  /// при возвращении.
  int _releaseOnReturn = 0;

  /// Кто сейчас работает в кассе (null — открыт экран входа).
  Employee? get employee => _employee;

  /// Следить за сворачиванием. Только телефон и планшет: окно кассы на
  /// Windows сворачивают, чтобы открыть рядом другую программу, — там PIN
  /// спрашивается при запуске.
  void start() {
    if (_started || kIsWeb) return;
    if (defaultTargetPlatform != TargetPlatform.android && defaultTargetPlatform != TargetPlatform.iOS) return;
    _started = true;
    WidgetsBinding.instance.addObserver(this);
  }

  /// Сотрудник вошёл по PIN (или вернул кассу своим PIN).
  void signedIn(Employee employee) {
    _employee = employee;
    locked.value = null;
  }

  /// Открыт экран входа — в кассе никто не работает, блокировать нечего.
  void signedOut() {
    _employee = null;
    locked.value = null;
  }

  /// Выход из кассы по делу самой кассы (галерея, звонок, установщик):
  /// вернувшись, сотрудник продолжает без PIN.
  Future<T> whileAway<T>(Future<T> Function() action) async {
    _away++;
    try {
      return await action();
    } finally {
      // Звонок, ссылка, установщик возвращаются, едва открыв другое
      // приложение, — сам уход из кассы ещё впереди. Отпускаем с запасом,
      // а если касса уже не на экране — когда вернутся.
      Timer(const Duration(seconds: 3), _release);
    }
  }

  void _release() {
    if (_outside) {
      _releaseOnReturn++;
    } else if (_away > 0) {
      _away--;
    }
  }

  // Экран блокировки лежит поверх навигатора, а не в нём: системное
  // «Назад» ушло бы навигатору и закрывало экраны кассы под блокировкой.
  // Этот наблюдатель подписан раньше навигатора (start() — до runApp) и
  // забирает «Назад», пока касса заблокирована.
  @override
  Future<bool> didPopRoute() => Future<bool>.value(locked.value != null);

  @override
  bool handleStartBackGesture(PredictiveBackEvent backEvent) => locked.value != null;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // paused — касса ушла с экрана совсем (домой, в другое приложение, в
    // список недавних). Шторка уведомлений и системные окна разрешений
    // дают только inactive — из-за них не блокируем. Блокируем сразу, ещё
    // в фоне: первый же кадр после возвращения — ввод PIN, а не касса.
    if (state == AppLifecycleState.paused) {
      if (_away > 0) {
        _outside = true;
      } else if (_employee != null) {
        locked.value = _employee;
      }
    } else if (state == AppLifecycleState.resumed && _outside) {
      _outside = false;
      _away = (_away - _releaseOnReturn).clamp(0, _away);
      _releaseOnReturn = 0;
    }
  }
}
