import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/client_models.dart';
import '../models/reservation_model.dart';
import '../models/session_model.dart';
import 'notification_service.dart';

/// Следит за залом и ставит уведомления кальянщику.
///
/// Работает на POS-планшете, пока открыто приложение (и в фоне — заранее
/// запланированные уведомления сработают даже если приложение свернули).
///
/// Что уведомляет:
///  • новая бронь из «Колибри Лаундж» — сразу;
///  • вызов гостя из-за стола — сразу;
///  • через [coalAfter] после открытия чека — «пора менять угли»;
///  • за [warnBefore] до конца сеанса — «сеанс заканчивается».
///
/// Напоминание об углях перезапускается при каждой перезабивке: счётчик
/// refillCount увеличился — значит угли только что поменяли, и следующее
/// напоминание нужно через 35 минут от этого момента.
class SessionAlertsService {
  SessionAlertsService._();
  static final SessionAlertsService instance = SessionAlertsService._();

  /// Через сколько после открытия стола (и после каждой перезабивки)
  /// напомнить про угли.
  static const coalAfter = Duration(minutes: 35);

  /// За сколько до конца сеанса предупредить.
  static const warnBefore = Duration(minutes: 10);

  final _db = FirebaseFirestore.instance;
  final _notify = NotificationService.instance;

  StreamSubscription? _sessions;
  StreamSubscription? _reservations;
  StreamSubscription? _calls;

  /// Что уже запланировано: sessionId → (конец сеанса, число перезабивок).
  /// Нужно, чтобы не переставлять будильники на каждое чтение стрима —
  /// Firestore присылает снапшот при любом изменении чека, в том числе
  /// при добавлении позиции.
  final _planned = <String, ({DateTime end, int refills})>{};

  DateTime _startedAt = DateTime.now();
  bool _running = false;

  Future<void> start() async {
    if (_running) return;
    _running = true;
    _startedAt = DateTime.now();
    await _notify.init();

    _watchSessions();
    _watchReservations();
    _watchCalls();
  }

  Future<void> stop() async {
    await _sessions?.cancel();
    await _reservations?.cancel();
    await _calls?.cancel();
    _sessions = _reservations = _calls = null;
    _planned.clear();
    _running = false;
  }

  // ---------- ТАЙМЕРЫ СТОЛОВ ----------

  void _watchSessions() {
    _sessions = _db
        .collection('sessions')
        .where('status', isEqualTo: 'active')
        .snapshots()
        .listen((snap) {
      final alive = <String>{};

      for (final doc in snap.docs) {
        final s = SessionModel.fromDoc(doc);
        alive.add(s.id);

        final known = _planned[s.id];
        final firstSeen = known == null;
        final refilled = known != null && known.refills != s.refillCount;
        final moved = known != null && known.end != s.plannedEnd;
        if (!firstSeen && !refilled && !moved) continue;

        _planned[s.id] = (end: s.plannedEnd, refills: s.refillCount);
        // Перезабивка только что произошла — отсчёт углей начинаем заново
        // от текущего момента. При первом появлении чека — от его начала.
        unawaited(_scheduleFor(s, coalFrom: refilled ? DateTime.now() : s.startTime));
      }

      // Чек закрыли или перенесли — снимаем его будильники.
      for (final id in _planned.keys.toList()) {
        if (alive.contains(id)) continue;
        _planned.remove(id);
        unawaited(_notify.cancel(NotificationService.idFor('coal_$id')));
        unawaited(_notify.cancel(NotificationService.idFor('end_$id')));
      }
    }, onError: (_) {});
  }

  Future<void> _scheduleFor(SessionModel s, {required DateTime coalFrom}) async {
    final coalId = NotificationService.idFor('coal_${s.id}');
    final endId = NotificationService.idFor('end_${s.id}');

    await _notify.cancel(coalId);
    await _notify.cancel(endId);

    await _notify.scheduleAt(
      id: coalId,
      when: coalFrom.add(coalAfter),
      title: 'Угли: ${s.tableName}',
      body: s.refillCount > 0
          ? 'Прошло 35 минут после перезабивки — проверьте угли'
          : 'Прошло 35 минут — пора поменять угли',
    );

    await _notify.scheduleAt(
      id: endId,
      when: s.plannedEnd.subtract(warnBefore),
      title: 'Сеанс заканчивается: ${s.tableName}',
      body: 'Через 10 минут конец сеанса — предложите продление или счёт',
    );
  }

  // ---------- БРОНИ ----------

  void _watchReservations() {
    _reservations = _db
        .collection('reservations')
        .where('status', isEqualTo: 'new')
        .snapshots()
        .listen((snap) {
      for (final change in snap.docChanges) {
        if (change.type != DocumentChangeType.added) continue;

        final r = ReservationModel.fromDoc(change.doc);
        // При первом подключении Firestore отдаёт все существующие брони
        // как «added» — уведомлять о них не нужно, иначе при каждом
        // запуске планшета посыплется десяток старых уведомлений.
        if (r.createdAt.isBefore(_startedAt)) continue;
        if (r.source != 'kolibri') continue;

        final t = r.startTime;
        unawaited(_notify.show(
          id: NotificationService.idFor('res_${r.id}'),
          title: 'Новая бронь',
          body: '${r.guestName}, ${r.guestsCount} чел. на '
              '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'
              '${r.comment.isEmpty ? '' : ' · «${r.comment}»'}',
        ));
      }
    }, onError: (_) {});
  }

  // ---------- ВЫЗОВЫ ГОСТЕЙ ----------

  void _watchCalls() {
    _calls = _db
        .collection('waiterCalls')
        .where('status', isEqualTo: 'new')
        .snapshots()
        .listen((snap) {
      for (final change in snap.docChanges) {
        if (change.type != DocumentChangeType.added) continue;

        final c = WaiterCall.fromDoc(change.doc);
        if (c.createdAt.isBefore(_startedAt)) continue;

        unawaited(_notify.show(
          id: NotificationService.idFor('call_${c.id}'),
          title: c.type.label,
          body: '${c.tableName.isEmpty ? 'Стол' : c.tableName}'
              '${c.comment.isEmpty ? '' : ' · «${c.comment}»'}',
        ));
      }
    }, onError: (_) {});
  }

  /// Ручная проверка из админки: «а работают ли вообще уведомления?».
  Future<void> testNotification() => _notify.show(
        id: 999001,
        title: 'Проверка уведомлений',
        body: 'Если вы это видите — уведомления работают.',
      );
}
