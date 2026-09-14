import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/client_models.dart';
import '../models/reservation_model.dart';
import '../models/session_model.dart';
import 'notification_service.dart';
import 'staff_session_store.dart';

/// Следит за залом и ставит уведомления кальянщику.
///
/// Работает на POS-планшете, пока открыто приложение (и в фоне — заранее
/// запланированные уведомления сработают даже если приложение свернули).
///
/// Что уведомляет:
///  • новая бронь из «Colibri Lounge» — сразу;
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

  /// Кто вошёл на этом устройстве и кто открыл текущую смену.
  ///
  /// Уведомления о вызовах гостей и новых бронях должны приходить тому,
  /// кто сейчас работает, а не на все планшеты и телефоны разом. Раньше
  /// их получал каждый, где приложение просто было запущено: и админ
  /// дома, и сменщик, который придёт вечером.
  ///
  /// Сравниваем по id, а не по имени: тёзки в заведении не редкость, а
  /// имя сотрудник может и переименовать.
  String _myEmployeeId = '';
  String _shiftEmployeeId = '';
  String _shiftEmployeeName = '';
  StreamSubscription? _shift;

  /// Показывать ли уведомления на этом устройстве.
  ///
  /// Молчим только когда точно известно, что смену открыл КТО-ТО ДРУГОЙ.
  /// Во всех остальных случаях — смена не открыта, старая запись без id,
  /// вход не сохранён — уведомляем: потерянный вызов гостя хуже лишнего
  /// уведомления.
  bool get _mine =>
      _shiftEmployeeId.isEmpty || _myEmployeeId.isEmpty || _shiftEmployeeId == _myEmployeeId;

  /// Имя того, кто сейчас на смене, — для экранов кассы.
  String get shiftEmployeeName => _shiftEmployeeName;

  StreamSubscription? _sessions;
  StreamSubscription? _reservations;
  StreamSubscription? _calls;

  /// Что уже запланировано: sessionId → (конец сеанса, число перезабивок).
  /// Нужно, чтобы не переставлять будильники на каждое чтение стрима —
  /// Firestore присылает снапшот при любом изменении чека, в том числе
  /// при добавлении позиции.
  final _planned = <String, ({DateTime end, int refills})>{};

  bool _running = false;

  /// Первый снапшот Firestore отдаёт всё существующее как «added» — по нему
  /// уведомлять нельзя, иначе при каждом запуске планшета сыплется десяток
  /// старых броней. Раньше это отсекалось сравнением createdAt с моментом
  /// запуска, но createdAt в брони проставляет ТЕЛЕФОН ГОСТЯ: стоит его
  /// часам отстать на пару минут — и свежая бронь считалась старой, а
  /// уведомление не приходило вовсе. Теперь просто пропускаем самый первый
  /// снапшот каждого стрима, ничего не зная о чужих часах.
  bool _firstReservationSnapshot = true;
  bool _firstCallSnapshot = true;

  Future<void> start() async {
    if (_running) return;
    _running = true;
    // Подписки на зал важнее уведомлений: не смогли подготовить
    // уведомления — экран всё равно должен показывать вызовы и брони.
    try {
      await _notify.init();
    } catch (_) {}

    // Кто вошёл на этом устройстве. Читается из памяти телефона, поэтому
    // доступно и в изоляте фоновой службы, где нет ни экранов, ни
    // вошедшего сотрудника в памяти процесса.
    _myEmployeeId = await StaffSessionStore.instance.savedEmployeeId();
    _watchShift();

    _watchSessions();
    _watchReservations();
    _watchCalls();
  }

  void _watchShift() {
    // Без limit(1) и без orderBy: сортировка вместе с фильтром по статусу
    // потребовала бы составного индекса, а без него запрос молча падает и
    // смену не видит никто. Открытых смен всё равно единицы — выбрать
    // самую свежую проще на месте.
    _shift = _db
        .collection('shifts')
        .where('status', isEqualTo: 'open')
        .snapshots()
        .listen((snap) {
      final wasId = _shiftEmployeeId;

      if (snap.docs.isEmpty) {
        _shiftEmployeeId = '';
        _shiftEmployeeName = '';
      } else {
        // Если вчерашнюю смену забыли закрыть, открытых окажется две.
        // Работает та, которую открыли последней.
        final docs = snap.docs.toList()
          ..sort((a, b) {
            final x = a.data()['openedAt'];
            final y = b.data()['openedAt'];
            if (x is! Timestamp || y is! Timestamp) return 0;
            return y.compareTo(x);
          });
        final data = docs.first.data();
        _shiftEmployeeId = (data['openedById'] as String?) ?? '';
        _shiftEmployeeName = (data['openedBy'] as String?) ?? '';
      }

      // Смену принял другой сотрудник — напоминания по уже открытым столам
      // надо переставить. Без этого кальянщик, вышедший в середине вечера,
      // не получал уведомлений об углях по столам, открытым до него: они
      // были запланированы один раз и больше не пересматривались.
      if (wasId != _shiftEmployeeId) unawaited(_replanSessions());
    }, onError: (_) {});
  }

  /// Перепланировать напоминания по всем живым чекам.
  ///
  /// Проще всего переподписаться: первый снапшот отдаст все открытые чеки
  /// как новые, и каждый получит свои будильники заново — уже с учётом
  /// того, кто теперь на смене.
  Future<void> _replanSessions() async {
    // До первой подписки переставлять нечего: start() сам подпишется и
    // запланирует всё с нуля. Иначе получили бы две подписки на чеки — и
    // по два уведомления на каждый стол.
    if (_sessions == null) return;
    await _sessions?.cancel();
    _sessions = null;
    _planned.clear();
    _watchSessions();
  }

  Future<void> stop() async {
    await _shift?.cancel();
    _shift = null;
    await _sessions?.cancel();
    await _reservations?.cancel();
    await _calls?.cancel();
    _sessions = _reservations = _calls = null;
    _planned.clear();
    _firstReservationSnapshot = true;
    _firstCallSnapshot = true;
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

    // Напоминания об углях и конце сеанса — тоже дело того, кто на смене.
    // Отменили выше в любом случае: если сменщик ушёл, его будильники не
    // должны сработать на уже чужом столе.
    if (!_mine) return;

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
      if (_firstReservationSnapshot) {
        _firstReservationSnapshot = false;
        return;
      }
      for (final change in snap.docChanges) {
        if (change.type != DocumentChangeType.added) continue;

        final r = ReservationModel.fromDoc(change.doc);
        if (r.source != 'kolibri') continue;
        if (!_mine) continue; // на смене другой сотрудник — это его вызов

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
      if (_firstCallSnapshot) {
        _firstCallSnapshot = false;
        return;
      }
      for (final change in snap.docChanges) {
        if (change.type != DocumentChangeType.added) continue;

        final c = WaiterCall.fromDoc(change.doc);
        if (!_mine) continue; // на смене другой сотрудник — это его вызов

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
