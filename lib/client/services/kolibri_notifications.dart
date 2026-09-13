import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../models/reservation_model.dart';
import '../../services/guest_link_service.dart';
import '../../services/notification_service.dart';
import '../../services/reservation_service.dart';
import '../../services/venue_service.dart';

/// Уведомления гостя без сервера.
///
/// Раньше всё, что видел гость на телефоне, слал FCM-push из Cloud
/// Functions: «бронь подтверждена», «заказ готов», «через час ждём вас»,
/// «начислено N бонусов». Но Cloud Functions есть только на платном тарифе
/// Firebase (Blaze) — на бесплатном Spark гость не получал ничего вообще,
/// а записи в очереди `pushQueue` просто копились мёртвым грузом.
///
/// Здесь то же самое делается локальными уведомлениями прямо на телефоне
/// гостя. Два механизма:
///
///  • **Реактивные** — приложение слушает свои же документы в Firestore
///    (бронь, заказ, баланс бонусов) и показывает уведомление в момент
///    изменения. Работает, пока приложение живо или висит в фоне.
///  • **Отложенные** — напоминание за час до брони планируется в системе
///    Android заранее. Оно сработает, даже если приложение закрыто и
///    интернета нет: это надёжнее, чем push, который зависит от сети.
///
/// Если заведение перешло на Blaze и развернуло функции, в профиле
/// включается флаг `cloudFunctionsEnabled` — сервис молчит, чтобы гость
/// не получил по два одинаковых уведомления.
class KolibriNotifications {
  KolibriNotifications._();
  static final KolibriNotifications instance = KolibriNotifications._();

  final _notify = NotificationService.instance;
  final _reservations = ReservationService();
  final _link = GuestLinkService();

  StreamSubscription? _resSub;
  StreamSubscription? _ordersSub;
  StreamSubscription? _profileSub;

  String _uid = '';
  bool _running = false;

  /// Отсечка по времени для заказов: свежесозданный заказ уведомлять
  /// осмысленно, вчерашний — нет.
  DateTime _startedAt = DateTime.now();

  /// Последний известный статус каждой брони и заказа и последний баланс
  /// бонусов. Нужны, чтобы отличить реальное изменение от повторной отдачи
  /// того же документа: Firestore присылает снапшот на любое поле, включая
  /// те, что гостю неинтересны.
  ///
  /// ВАЖНО: всё это переживает закрытие приложения (SharedPreferences).
  /// Раньше состояние жило только в памяти, и первый снапшот всегда
  /// считался «начальным» — то есть про бронь, подтверждённую, пока
  /// приложение было закрыто, гость не узнавал никогда. А закрыто оно
  /// почти всегда: держать соединение с Firestore круглосуточно телефон
  /// не станет. Теперь сравниваем с тем, что было в прошлый раз, и
  /// пропущенное приходит при первом же открытии.
  final _resStatus = <String, ReservationStatus>{};
  final _orderStatus = <String, String>{};
  double? _lastBonusBalance;

  SharedPreferences? _prefs;
  String get _resKey => 'notif_res_$_uid';
  String get _orderKey => 'notif_order_$_uid';
  String get _bonusKey => 'notif_bonus_$_uid';

  Future<void> start(String uid) async {
    if (_running && _uid == uid) return;
    await stop();
    if (uid.isEmpty) return;

    _uid = uid;
    _running = true;
    _startedAt = DateTime.now();
    await _notify.init();
    await _restore();

    _watchReservations();
    _watchOrders();
    _watchBonuses();
  }

  /// Поднимает из памяти телефона то, что видели в прошлый запуск.
  Future<void> _restore() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _prefs = prefs;

      final res = prefs.getString(_resKey);
      if (res != null) {
        final map = jsonDecode(res) as Map<String, dynamic>;
        for (final e in map.entries) {
          for (final status in ReservationStatus.values) {
            if (status.name == e.value) {
              _resStatus[e.key] = status;
              break;
            }
          }
        }
      }

      final orders = prefs.getString(_orderKey);
      if (orders != null) {
        final map = jsonDecode(orders) as Map<String, dynamic>;
        map.forEach((k, v) => _orderStatus[k] = '$v');
      }

      if (prefs.containsKey(_bonusKey)) {
        _lastBonusBalance = prefs.getDouble(_bonusKey);
      }
    } catch (_) {
      // Память недоступна — работаем как раньше, только в пределах сеанса.
    }
  }

  void _persistRes() {
    _prefs?.setString(
      _resKey,
      jsonEncode(_resStatus.map((k, v) => MapEntry(k, v.name))),
    );
  }

  void _persistOrders() {
    // Храним только последние 50 заказов, иначе список растёт вечно.
    final trimmed = Map.fromEntries(_orderStatus.entries.take(50));
    _prefs?.setString(_orderKey, jsonEncode(trimmed));
  }

  Future<void> stop() async {
    await _resSub?.cancel();
    await _ordersSub?.cancel();
    await _profileSub?.cancel();
    _resSub = _ordersSub = _profileSub = null;
    _resStatus.clear();
    _orderStatus.clear();
    _lastBonusBalance = null;
    _prefs = null;
    _running = false;
  }

  bool get _silenced => VenueService.instance.cached.cloudFunctionsEnabled;

  // ---------- БРОНИ ----------

  void _watchReservations() {
    _resSub = _reservations.clientStream(_uid).listen((list) {
      for (final r in list) {
        final known = _resStatus[r.id];
        _resStatus[r.id] = r.status;

        _syncReminder(r);

        // Бронь видим впервые — запоминаем и молчим: гость сам её только
        // что создал и смотрит на экран подтверждения.
        if (known == null) continue;
        if (known == r.status) continue;
        if (_silenced) continue;

        // Сюда попадают и изменения, случившиеся пока приложение было
        // закрыто: прошлый статус поднят из памяти телефона.
        final text = _reservationMessage(r);
        if (text == null) continue;
        unawaited(_notify.show(
          id: NotificationService.idFor('res_status_${r.id}_${r.status.name}'),
          title: text.$1,
          body: text.$2,
        ));
      }
      _persistRes();
    }, onError: (_) {});
  }

  (String, String)? _reservationMessage(ReservationModel r) {
    final time = _fmtDateTime(r.startTime);
    switch (r.status) {
      case ReservationStatus.confirmed:
        return (
          'Бронь подтверждена',
          'Ждём вас $time'
              '${r.tableName.isEmpty ? '' : ', стол ${r.tableName}'}. '
              'Стол закреплён за вами.'
        );
      case ReservationStatus.cancelled:
        return (
          'Бронь отменена',
          'Бронь на $time отменена. Если это ошибка — забронируйте заново в приложении.'
        );
      case ReservationStatus.seated:
        return ('Добро пожаловать', 'Ваш стол открыт — счёт виден в приложении.');
      case ReservationStatus.noShow:
        return (
          'Бронь снята',
          'Мы не дождались вас на $time и освободили стол. Заходите в другой раз.'
        );
      case ReservationStatus.newRequest:
        return null; // гость сам её только что создал — уведомлять не о чем
    }
  }

  /// Планирует (или снимает) напоминание за час до брони.
  ///
  /// Именно отложенное системное уведомление, а не push: оно сработает и
  /// при закрытом приложении, и без интернета — ровно то, что нужно, чтобы
  /// гость не забыл про вечер, пока едет по городу.
  void _syncReminder(ReservationModel r) {
    final id = NotificationService.idFor('res_soon_${r.id}');
    if (_silenced || !r.status.blocksTable) {
      unawaited(_notify.cancel(id));
      return;
    }
    unawaited(_notify.scheduleAt(
      id: id,
      when: r.startTime.subtract(const Duration(hours: 1)),
      title: 'Через час ждём вас',
      body: '${_fmtTime(r.startTime)}'
          '${r.tableName.isEmpty ? '' : ', стол ${r.tableName}'}'
          ' · ${r.guestsCount} чел.',
    ));
  }

  // ---------- ЗАКАЗЫ ЗА СТОЛОМ ----------

  void _watchOrders() {
    _ordersSub = _link.clientOrdersStream(_uid).listen((list) {
      for (final o in list) {
        final known = _orderStatus[o.id];
        _orderStatus[o.id] = o.status;
        if (known == null || known == o.status) continue;
        if (_silenced) continue;
        if (o.createdAt.isBefore(_startedAt.subtract(const Duration(hours: 6)))) continue;

        String? title;
        switch (o.status) {
          case 'ready':
            title = 'Заказ готов';
          case 'preparing':
            title = 'Заказ принят';
          case 'rejected':
            title = 'Заказ отклонён';
          default:
            title = null;
        }
        if (title == null) continue;

        unawaited(_notify.show(
          id: NotificationService.idFor('order_${o.id}_${o.status}'),
          title: title,
          body: o.status == 'rejected' && o.rejectReason.isNotEmpty
              ? o.rejectReason
              : o.items.map((i) => '${i.name} ×${i.qty}').join(', '),
        ));
      }
      _persistOrders();
    }, onError: (_) {});
  }

  // ---------- БОНУСЫ ----------

  /// Слушаем сам профиль, а не коллекцию bonusOperations: рост баланса
  /// покрывает все поводы разом — кешбэк за визит, реферальную награду и
  /// подарок ко дню рождения — и не требует ни отдельного запроса, ни
  /// составного индекса.
  void _watchBonuses() {
    _profileSub = _link.profileStream(_uid).listen((profile) {
      if (profile == null) return;
      final previous = _lastBonusBalance;
      _lastBonusBalance = profile.bonusBalance;
      _prefs?.setDouble(_bonusKey, profile.bonusBalance);

      // previous == null только в самый первый запуск после установки:
      // дальше баланс лежит в памяти телефона, и начисление, сделанное
      // кассой пока приложение было закрыто, приходит при открытии.
      if (previous == null) return;
      final gained = profile.bonusBalance - previous;
      if (gained < 1 || _silenced) return;

      unawaited(_notify.show(
        id: NotificationService.idFor('bonus_${DateTime.now().millisecondsSinceEpoch}'),
        title: 'Начислено ${gained.toStringAsFixed(0)} бонусов',
        body: 'Баланс: ${profile.bonusBalance.toStringAsFixed(0)} ₽. '
            'Списать можно на кассе при следующем визите.',
      ));
    }, onError: (_) {});
  }

  // ---------- ФОРМАТ ----------

  String _fmtTime(DateTime d) =>
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  String _fmtDateTime(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} '
      'в ${_fmtTime(d)}';
}
