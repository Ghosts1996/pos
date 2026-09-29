import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/client_models.dart';
import '../models/reservation_model.dart';
import '../models/session_model.dart';
import '../utils/constants.dart';
import '../utils/shift_crew.dart';
import 'notification_service.dart';
import 'staff_session_store.dart';
import 'venue_service.dart';

/// Следит за залом и ставит уведомления персоналу на кассе (заранее
/// запланированные сработают и при свёрнутом приложении):
///  • новая бронь из приложения гостя и вызов из-за стола — сразу;
///  • через [coalAfter] после открытия чека — «пора менять угли»;
///  • за [warnBefore] до конца сеанса — «сеанс заканчивается».
///
/// Напоминание об углях перезапускается при каждой перезабивке
/// (refillCount вырос).
class SessionAlertsService {
  SessionAlertsService._();
  static final SessionAlertsService instance = SessionAlertsService._();

  /// Через сколько после открытия стола (и после каждой перезабивки)
  /// напомнить про угли.
  static const coalAfter = Duration(minutes: 35);

  /// За сколько до конца сеанса предупредить.
  static const warnBefore = Duration(minutes: 10);

  final _notify = NotificationService.instance;

  /// Кто вошёл на этом устройстве и кто открыл смену: уведомления получает
  /// тот, кто работает, а не все устройства с запущенным приложением.
  /// Сравниваем по id — тёзки не редкость.
  String _myEmployeeId = '';

  /// На кого с ЭТОГО устройства открыли смену. В заведении с одним
  /// планшетом смену нередко открывает админ на кальянщика — планшет всё
  /// равно стоит в зале, и вызовы гостей должны быть слышны именно тут.
  String _deviceShiftOwnerId = '';

  String _shiftEmployeeId = '';
  String _shiftEmployeeName = '';
  StreamSubscription? _shift;

  /// Кто сейчас отметил начало своей смены (открытые личные смены). Вызовы
  /// получают они — каждый по своей специализации; ушедший домой больше
  /// не получает, даже если смену заведения открывал он.
  Set<String> _onShift = const {};
  StreamSubscription? _crew;

  /// Специализация вошедшего на этом устройстве (Employee.position),
  /// читается при [start]. Универсал видит все вызовы.
  String _myPosition = AppConstants.positionUniversal;
  String _myRole = AppConstants.roleEmployee;

  /// Подписка на карточку вошедшего: админ поменял специализацию —
  /// напоминания про угли включаются или выключаются сразу, без
  /// перезапуска планшета.
  StreamSubscription? _me;

  /// Запасная проверка «кто вошёл на этом устройстве» — на случай, если
  /// сообщение о смене сотрудника до фоновой службы не дошло.
  Timer? _identityTimer;

  /// Угли — дело того, кто ведёт кальяны: см. AppConstants.handlesHookah.
  bool get _hookahDuty => AppConstants.handlesHookah(
        position: _myPosition,
        role: _myRole,
        hookahVenue: VenueService.instance.terms.isHookah,
      );

  /// Показывать ли уведомления на этом устройстве.
  ///
  /// Молчим только когда точно известно, что смену открыл КТО-ТО ДРУГОЙ.
  /// Во всех остальных случаях — смена не открыта, старая запись без id,
  /// вход не сохранён — уведомляем: потерянный вызов гостя хуже лишнего
  /// уведомления.
  bool get _mine => alertsForThisDevice(
        onShift: _onShift,
        myId: _myEmployeeId,
        deviceOwnerId: _deviceShiftOwnerId,
        shiftOpenerId: _shiftEmployeeId,
      );

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

  /// Первый снапшот отдаёт всё существующее как «added» — его пропускаем.
  /// Сравнивать createdAt с моментом запуска нельзя: его ставит телефон
  /// гостя, и отставшие часы съедали бы свежие брони.
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
    _deviceShiftOwnerId = await StaffSessionStore.instance.savedShiftOwnerId();
    if (_myEmployeeId.isNotEmpty) {
      try {
        final doc = await AppScope.col('employees').doc(_myEmployeeId).get();
        _applyMe(doc.data());
      } catch (_) {
        // Не удалось прочитать специализацию — считаем универсалом:
        // безопасный дефолт, при котором ничего не потеряется.
      }
    }
    _watchMe();
    _identityTimer = Timer.periodic(const Duration(minutes: 2), (_) => refreshIdentity());
    _watchShift();
    _watchCrew();

    // Тип заведения решает, нужны ли напоминания про угли: в ресторане их
    // быть не должно. Профиль читаем до подписки на столы, чтобы первые же
    // будильники поставились правильно (в изоляте службы кэша ещё нет).
    try {
      await VenueService.instance.load();
    } catch (_) {}
    VenueService.instance.watch();

    _watchSessions();
    _watchReservations();
    _watchCalls();
  }

  void _applyMe(Map<String, dynamic>? data) {
    _myPosition = AppConstants.normalizePosition(data?['position'] as String?);
    _myRole = (data?['role'] as String?) ?? AppConstants.roleEmployee;
  }

  void _watchMe() {
    _me?.cancel();
    _me = null;
    if (_myEmployeeId.isEmpty) return;
    _me = AppScope.col('employees').doc(_myEmployeeId).snapshots().listen((d) {
      final before = '$_myPosition/$_myRole';
      _applyMe(d.data());
      if (before != '$_myPosition/$_myRole') unawaited(_replanSessions());
    }, onError: (_) {});
  }

  /// На этом устройстве вошёл другой сотрудник («Сменить сотрудника»):
  /// вызовы и напоминания про угли теперь по его специализации. Зовут
  /// экран входа (сообщением в фоновую службу) и запасной таймер.
  Future<void> refreshIdentity() async {
    if (!_running) return;
    final id = await StaffSessionStore.instance.savedEmployeeId(fresh: true);
    if (id == _myEmployeeId) return;
    _myEmployeeId = id;
    if (id.isEmpty) {
      _applyMe(null);
    } else {
      try {
        _applyMe((await AppScope.col('employees').doc(id).get()).data());
      } catch (_) {}
    }
    _watchMe();
    await _replanSessions();
  }

  void _watchShift() {
    // Без limit(1) и без orderBy: сортировка вместе с фильтром по статусу
    // потребовала бы составного индекса, а без него запрос молча падает и
    // смену не видит никто. Открытых смен всё равно единицы — выбрать
    // самую свежую проще на месте.
    _shift = AppScope.col('shifts')
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
      if (wasId != _shiftEmployeeId) unawaited(_onShiftChanged());
    }, onError: (_) {});
  }

  void _watchCrew() {
    _crew = AppScope.col('staffShifts').where('status', isEqualTo: 'open').snapshots().listen((snap) {
      final was = _mine;
      // Забытую со вчера смену не считаем: тот сотрудник давно дома.
      _onShift = {
        for (final d in snap.docs)
          if ((d.data()['employeeId'] as String? ?? '').isNotEmpty &&
              d.data()['startedAt'] is Timestamp &&
              !isStaleShift((d.data()['startedAt'] as Timestamp).toDate()))
            d.data()['employeeId'] as String,
      };
      // Пришёл или ушёл тот, от кого зависит это устройство, — будильники
      // по углям переставляем, как при смене открывшего смену.
      if (was != _mine) unawaited(_replanSessions());
    }, onError: (_) {});
  }

  /// Смену открыл кто-то другой (или её только что открыли).
  Future<void> _onShiftChanged() async {
    // Смену могли открыть с этого же устройства прямо сейчас — перечитаем,
    // на кого именно. Иначе планшет в зале молчал бы до перезапуска
    // приложения, хотя смену открыли именно с него.
    try {
      _deviceShiftOwnerId = await StaffSessionStore.instance.savedShiftOwnerId();
    } catch (_) {
      // Память недоступна — останемся на прежнем значении.
    }
    await _replanSessions();
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
    await _crew?.cancel();
    _crew = null;
    _onShift = const {};
    await _me?.cancel();
    _me = null;
    _identityTimer?.cancel();
    _identityTimer = null;
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
    _sessions = AppScope.col('sessions')
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

    // Угли — только тому, кто ведёт кальяны: кальянщику, а в кальянной
    // ещё универсалу и админу. Официанту и бармену они ни к чему.
    if (_hookahDuty) {
      await _notify.scheduleAt(
        id: coalId,
        when: coalFrom.add(coalAfter),
        title: 'Угли: ${s.tableName}',
        body: s.refillCount > 0
            ? 'Прошло 35 минут после перезабивки — проверьте угли'
            : 'Прошло 35 минут — пора поменять угли',
      );
    }

    // Стол «без ограничений» не заканчивается — предупреждать не о чем.
    if (AppConstants.isUnlimitedRemaining(s.remaining)) return;
    await _notify.scheduleAt(
      id: endId,
      when: s.plannedEnd.subtract(warnBefore),
      title: 'Сеанс заканчивается: ${s.tableName}',
      body: 'Через 10 минут конец сеанса — предложите продление или счёт',
    );
  }

  // ---------- БРОНИ ----------

  void _watchReservations() {
    _reservations = AppScope.col('reservations')
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
    _calls = AppScope.col('waiterCalls')
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
        // Специализация не совпадает — не моя часть вызовов (например,
        // официант не должен получать вызов кальянщика на угли, если он
        // явно назначен официантом, а не универсалом). Универсал видит всё.
        if (_myPosition != AppConstants.positionUniversal &&
            c.type.targetPosition != _myPosition) {
          continue;
        }

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
