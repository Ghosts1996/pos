import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../models/delivery_status.dart';
import '../../models/reservation_model.dart';
import '../../services/guest_link_service.dart';
import '../../services/notification_service.dart';
import '../../services/reservation_service.dart';
import '../../services/venue_service.dart';
import '../../utils/table_label.dart';
import '../../utils/money.dart';
import 'delivery_order_service.dart';

/// Уведомления гостя без сервера — Cloud Functions у проектов нет.
///
///  • Реактивные: приложение слушает свои документы (бронь, заказ, баланс)
///    и показывает уведомление при изменении — пока живо или в фоне.
///  • Отложенные: напоминание за час до брони планируется в Android заранее
///    и сработает даже без сети и при закрытом приложении.
///
/// При `cloudFunctionsEnabled` в профиле заведения сервис молчит, чтобы
/// гость не получил два одинаковых уведомления.
class KolibriNotifications {
  KolibriNotifications._();
  static final KolibriNotifications instance = KolibriNotifications._();

  final _notify = NotificationService.instance;
  final _reservations = ReservationService();
  final _link = GuestLinkService();

  StreamSubscription? _resSub;
  StreamSubscription? _ordersSub;
  StreamSubscription? _deliverySub;

  /// Статусы заказов доставки/с собой: null — первый снимок, от него
  /// отсчитываем изменения.
  Map<String, String>? _deliveryStatus;
  StreamSubscription? _profileSub;

  String _uid = '';
  bool _running = false;

  /// Отсечка по времени для заказов: свежесозданный заказ уведомлять
  /// осмысленно, вчерашний — нет.
  DateTime _startedAt = DateTime.now();

  /// Последние известные статусы броней и заказов и баланс — чтобы отличить
  /// настоящее изменение от повторного снапшота. Хранятся в
  /// SharedPreferences: приложение почти всегда закрыто, и изменения,
  /// случившиеся без него, должны прийти при следующем открытии.
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
    // Осечка в подготовке уведомлений не должна отменять сами подписки:
    // иначе приложение перестаёт замечать изменения броней и заказов.
    try {
      await _notify.init();
    } catch (_) {}
    await _restore();
    _notify.onAction = (actionId, payload) => unawaited(_handleAction(actionId, payload));

    _watchReservations();
    _watchOrders();
    _watchDeliveries();
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
      // Хранилище недоступно — помним только в пределах сеанса.
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
    // Последние — это хвост: порядок вставки идёт от старых к новым, и
    // take(50) держал бы вечно самые старые, а новые не запоминались бы.
    final extra = _orderStatus.length - 50;
    if (extra > 0) {
      for (final k in _orderStatus.keys.take(extra).toList()) {
        _orderStatus.remove(k);
      }
    }
    _prefs?.setString(_orderKey, jsonEncode(_orderStatus));
  }

  Future<void> stop() async {
    await _resSub?.cancel();
    await _ordersSub?.cancel();
    await _profileSub?.cancel();
    await _deliverySub?.cancel();
    _resSub = _ordersSub = _profileSub = _deliverySub = null;
    _deliveryStatus = null;
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
              '${r.tableName.isEmpty ? '' : ', ${tableLabel(r.tableName)}'}. '
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

  /// Планирует (или снимает) напоминания о брони: за час и за 20 минут.
  ///
  /// Именно отложенные системные уведомления, а не push: они сработают и
  /// при закрытом приложении, и без интернета — ровно то, что нужно, чтобы
  /// гость не забыл про вечер, пока едет по городу.
  ///
  /// За 20 минут — с кнопками «Приду» и «Не приду». Это не вежливость, а
  /// рабочий инструмент: заведение узнаёт о неявке за двадцать минут до
  /// начала и успевает отдать стол, вместо того чтобы держать его пустым
  /// час и записывать бронь в «не пришёл» задним числом.
  void _syncReminder(ReservationModel r) {
    final hourId = NotificationService.idFor('res_soon_${r.id}');
    final soonId = NotificationService.idFor('res_20min_${r.id}');

    // Здесь намеренно НЕТ проверки _silenced. Флаг cloudFunctionsEnabled
    // отключает мгновенные уведомления, потому что вместо них приходит
    // push из облака. Но напоминание за час и за 20 минут — это будильник
    // в самом телефоне: он срабатывает при закрытом приложении и без
    // интернета, и облако такого не умеет. Отключать его «за компанию»
    // значило бы просто лишить гостя напоминания.
    if (!r.status.blocksTable) {
      unawaited(_notify.cancel(hourId));
      unawaited(_notify.cancel(soonId));
      return;
    }

    final where = r.tableName.isEmpty ? '' : ', ${tableLabel(r.tableName)}';

    unawaited(_notify.scheduleAt(
      id: hourId,
      when: r.startTime.subtract(const Duration(hours: 1)),
      title: 'Через час ждём вас',
      body: '${_fmtTime(r.startTime)}$where · ${r.guestsCount} чел.',
    ));

    // Гость уже ответил — второй раз не дёргаем.
    if (r.guestConfirmed) {
      unawaited(_notify.cancel(soonId));
      return;
    }

    unawaited(_notify.scheduleWithActions(
      id: soonId,
      when: r.startTime.subtract(const Duration(minutes: 20)),
      title: 'Бронь через 20 минут',
      body: '${_fmtTime(r.startTime)}$where · ${r.guestsCount} чел. '
          'Подтвердите, что придёте, — или освободите стол для других.',
      payload: 'res:${r.id}',
      actions: const [
        (id: 'res_coming', label: 'Приду'),
        (id: 'res_not_coming', label: 'Не приду'),
      ],
    ));
  }

  /// Разбирает нажатие по кнопке напоминания.
  ///
  /// Кнопки открывают приложение, а запись делается здесь: у фонового
  /// обработчика уведомлений свой изолят, где нет ни соединения с базой,
  /// ни входа гостя.
  Future<void> _handleAction(String actionId, String payload) async {
    if (!payload.startsWith('res:')) return;
    final id = payload.substring(4);
    if (id.isEmpty) return;
    try {
      if (actionId == 'res_coming') {
        await _reservations.guestConfirm(id);
        unawaited(_notify.show(
          id: NotificationService.idFor('res_ok_$id'),
          title: 'Ждём вас',
          body: 'Спасибо, стол за вами.',
        ));
      } else if (actionId == 'res_not_coming') {
        await _reservations.cancel(id, by: 'гость');
        unawaited(_notify.show(
          id: NotificationService.idFor('res_no_$id'),
          title: 'Бронь отменена',
          body: 'Спасибо, что предупредили. Ждём вас в другой раз.',
        ));
      }
    } catch (_) {
      // Нет связи — гость увидит бронь в приложении и ответит там.
    }
  }

  // ---------- ЗАКАЗЫ ЗА СТОЛОМ ----------

  void _watchOrders() {
    _ordersSub = _link.clientOrdersStream(_uid).listen((list) {
      for (final o in list) {
        final known = _orderStatus.remove(o.id);
        _orderStatus[o.id] = o.status; // в конец — как самый свежий
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
              : o.items.map((i) => '${i.displayName} ×${i.qty}').join(', '),
        ));
      }
      _persistOrders();
    }, onError: (_) {});
  }

  // ---------- ДОСТАВКА И С СОБОЙ ----------

  /// Статус заказа из приложения: принят — сообщает заказ (выше), дальше —
  /// готовим, курьер в пути, готов к выдаче, доставлен.
  void _watchDeliveries() {
    _deliveryStatus = null;
    _deliverySub = DeliveryOrderService.instance.myOrders(_uid).listen((list) {
      final known = _deliveryStatus;
      final now = {for (final o in list) o.id: DeliveryFlow.normalize(o.orderType, o.deliveryStatus)};
      _deliveryStatus = now;
      if (known == null || _silenced) return;
      for (final o in list) {
        final st = now[o.id]!;
        if (known[o.id] == st) continue;
        final delivery = o.orderType == 'delivery';
        final title = switch (st) {
          'cooking' => 'Готовим ваш заказ',
          'courier' => 'Курьер в пути',
          'ready' => 'Заказ готов — можно забирать',
          'done' => delivery ? 'Заказ доставлен' : 'Заказ выдан',
          _ => null,
        };
        if (title == null) continue;
        unawaited(_notify.show(
          id: NotificationService.idFor('delivery_${o.id}_$st'),
          title: title,
          body: '${delivery ? 'Доставка' : 'С собой'} №${orderNumber(o.id)}',
        ));
      }
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
        title: 'Начислено ${bonusesLabel(gained)}',
        body: 'Баланс: ${rub(profile.bonusBalance)}. '
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
