import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/client_models.dart';
import '../models/reservation_model.dart';
import '../models/session_model.dart';
import '../utils/constants.dart';
import '../utils/shift_crew.dart';
import 'notification_service.dart';
import 'signals/lan_signal_codec.dart';
import 'signals/lan_signals.dart';
import 'signals/ready_watch.dart';
import 'signals/signal_bootstrap.dart';
import 'signals/signal_hub.dart';
import 'signals/signal_settings.dart';
import 'signals/staff_alert_text.dart';
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
  StreamSubscription? _orders;
  StreamSubscription<LanMessage>? _lanReady;

  /// Сколько было готово по строкам чеков: sessionId → lineId → ready.
  /// Не сбрасывается при переподписке — иначе «готово», пришедшее в эту
  /// секунду, потерялось бы как «первый снимок».
  final _readySeen = <String, Map<String, int>>{};

  /// Уже прозвеневшие «готово» (чек|строка|сколько): одно и то же приходит
  /// по Wi‑Fi заведения и следом из облака.
  final _readyRung = <String>{};

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
  bool _firstOrderSnapshot = true;

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

    // Реле, часы официантов и сигналы по Wi‑Fi — те же настройки, что у
    // кассы; в изоляте службы их надо подтянуть самим.
    SignalBootstrap.start();
    _watchSessions();
    _watchReservations();
    _watchCalls();
    _watchOrders();
    _watchLanReady();
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
    await _orders?.cancel();
    await _lanReady?.cancel();
    _lanReady = null;
    _sessions = _reservations = _calls = _orders = null;
    _planned.clear();
    _firstReservationSnapshot = true;
    _firstCallSnapshot = true;
    _firstOrderSnapshot = true;
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
        _checkReady(s);

        final known = _planned[s.id];
        final firstSeen = known == null;
        final refilled = known != null && known.refills != s.refillCount;
        final moved = known != null && known.end != s.plannedEnd;
        if (!firstSeen && !refilled && !moved) continue;

        _planned[s.id] = (end: s.plannedEnd, refills: s.refillCount);
        unawaited(_scheduleFor(s, coalFrom: coalBase(s)));
      }

      _readySeen.removeWhere((id, _) => !alive.contains(id));
      // Чек закрыли или перенесли — снимаем его будильники.
      for (final id in _planned.keys.toList()) {
        if (alive.contains(id)) continue;
        _planned.remove(id);
        unawaited(_notify.cancel(NotificationService.idFor('coal_$id')));
        unawaited(_notify.cancel(NotificationService.idFor('end_$id')));
      }
    }, onError: (_) {});
  }

  // ---------- ГОТОВО С КУХНИ ----------

  /// Кухня отметила блюда готовыми — звеним официанту чека.
  void _checkReady(SessionModel s) {
    final before = _readySeen[s.id];
    _readySeen[s.id] = readyByLine(s.orderItems);
    final up = readyIncreases(before, s.orderItems);
    if (up.isEmpty) return;
    _ringReady(
      sessionId: s.id,
      tableName: s.tableName,
      waiterId: s.employeeId,
      lines: {for (final i in up) i.lineId: i.ready},
      summary: readySummary(up),
    );
  }

  /// То же «готово», но по Wi‑Fi заведения — доходит и без интернета.
  void _watchLanReady() {
    _lanReady = LanSignals.instance.messages.where((m) => m.kind == LanKind.dishReady).listen((m) {
      if (m.sessionId.isEmpty) return;
      _ringReady(
        sessionId: m.sessionId,
        tableName: m.tableName,
        waiterId: m.waiterId,
        lines: m.readyLines,
        summary: m.summary,
      );
    });
  }

  void _ringReady({
    required String sessionId,
    required String tableName,
    required String waiterId,
    required Map<String, int> lines,
    required String summary,
  }) {
    final keys = [for (final e in lines.entries) '$sessionId|${e.key}|${e.value}'];
    if (keys.isEmpty || keys.every(_readyRung.contains)) return;
    _readyRung.addAll(keys);
    if (_readyRung.length > 500) _readyRung.clear();
    if (!readyIsMine(
      checkWaiterId: waiterId,
      myId: _myEmployeeId,
      onShift: _onShift,
      mine: _mine,
      myPosition: _myPosition,
    )) {
      return;
    }
    final a = readyAlert(tableName, summary);
    // Своё уведомление на каждое «готово»: обновление прежнего часы не
    // показывают и не вибрируют.
    unawaited(_notify.showUrgent(
      id: NotificationService.idFor('ready_${sessionId}_${keys.join()}'),
      title: a.title,
      body: a.body,
    ).catchError((Object _) {}));
  }

  /// От чего считать угли: от последней перезабивки, а если её не было —
  /// от начала сеанса. Берём из самого чека: будильники переставляются и
  /// при сдвиге времени стола, и при смене сотрудника, и отсчёт после
  /// перезабивки не должен откатываться к началу сеанса (такое время уже
  /// в прошлом, и напоминание молча пропадало).
  static DateTime coalBase(SessionModel s) {
    var base = s.startTime;
    for (final r in s.refillHistory) {
      if (r.time.isAfter(base)) base = r.time;
    }
    return base;
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
      final a = coalAlert(s.tableName, minutes: coalAfter.inMinutes, afterRefill: s.refillCount > 0);
      await _notify.scheduleAt(id: coalId, when: coalFrom.add(coalAfter), title: a.title, body: a.body);
    }

    // Стол «без ограничений» не заканчивается — предупреждать не о чем.
    if (AppConstants.isUnlimitedRemaining(s.remaining)) return;
    final end = sessionEndAlert(s.tableName, minutes: warnBefore.inMinutes);
    await _notify.scheduleAt(id: endId, when: s.plannedEnd.subtract(warnBefore), title: end.title, body: end.body);
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

        final a = reservationAlert(guest: r.guestName, people: r.guestsCount, at: r.startTime, comment: r.comment);
        unawaited(_notify.showUrgent(id: NotificationService.idFor('res_${r.id}'), title: a.title, body: a.body));
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
        // Звонок на реле и пейджер официанта — одна касса на всё заведение.
        unawaited(SignalHub.instance
            .remote(SignalEvent.guestCall, change.doc.reference,
                table: c.tableName, text: c.comment.isEmpty ? c.type.label : '${c.type.label}: ${c.comment}')
            .catchError((Object _) {}));
        if (!_mine) continue; // на смене другой сотрудник — это его вызов
        // Специализация не совпадает — не моя часть вызовов (например,
        // официант не должен получать вызов кальянщика на угли, если он
        // явно назначен официантом, а не универсалом). Универсал видит всё.
        if (_myPosition != AppConstants.positionUniversal &&
            c.type.targetPosition != _myPosition) {
          continue;
        }

        final a = callAlert(c.type, c.tableName, comment: c.comment);
        unawaited(_notify.showUrgent(id: NotificationService.idFor('call_${c.id}'), title: a.title, body: a.body));
      }
    }, onError: (_) {});
  }

  // ---------- ЗАКАЗЫ ИЗ ПРИЛОЖЕНИЯ ГОСТЯ ----------

  /// Заказ гостя звенит у того, кому адресован: блюда и напитки — у
  /// официанта, кальян — у кальянщика (GuestOrder.targetPosition).
  /// Универсал слышит всё.
  void _watchOrders() {
    _orders = AppScope.col('guestOrders')
        .where('status', isEqualTo: 'new')
        .snapshots()
        .listen((snap) {
      if (_firstOrderSnapshot) {
        _firstOrderSnapshot = false;
        return;
      }
      for (final change in snap.docChanges) {
        if (change.type != DocumentChangeType.added) continue;
        final o = GuestOrder.fromDoc(change.doc);
        unawaited(SignalHub.instance
            .remote(SignalEvent.guestOrder, change.doc.reference, table: o.tableName,
                text: o.items.map((i) => '${i.displayName} ×${i.qty}').join(', '))
            .catchError((Object _) {}));
        // Заказ доставки/с собой из приложения — всем на смене: кто первым
        // свободен, тот и звонит гостю.
        if (o.orderType.isNotEmpty) {
          final a = takeawayAlert(
              delivery: o.orderType == 'delivery',
              guest: o.guestName,
              items: o.items.map((i) => '${i.displayName} ×${i.qty}').join(', '));
          unawaited(_notify.showUrgent(id: NotificationService.idFor('order_${o.id}'), title: a.title, body: a.body));
          continue;
        }
        if (!_mine) continue; // на смене другой сотрудник — это его заказ
        if (!o.isFor(_myPosition)) continue;

        final a = guestOrderAlert(o.tableName, o.items.map((i) => '${i.displayName} ×${i.qty}').join(', '));
        unawaited(_notify.showUrgent(id: NotificationService.idFor('order_${o.id}'), title: a.title, body: a.body));
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
