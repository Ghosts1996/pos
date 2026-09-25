import 'dart:async';
import 'dart:io' show Platform;
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'venue_service.dart';
import '../models/employee.dart';
import '../utils/constants.dart';

/// Push-уведомления через Firebase Cloud Messaging.
///
/// Отправка идёт не с устройства (ключ сервера нельзя класть в APK), а через
/// очередь: приложение пишет документ в `pushQueue`, Cloud Function
/// `sendQueuedPush` его забирает и рассылает (см. functions/index.js).
///
/// Топики персонала — НЕ один голый `staff` (так было раньше — в SaaS это
/// вдобавок значило бы, что все заведения платформы сидят на одном топике,
/// а вызов гостя из одного заведения будил бы персонал другого). Схема:
///   `staff-{scope}-all` — общий канал (новая бронь и т.п., касается всех
///   независимо от специализации);
///   `staff-{scope}-{position}` — конкретная специализация
///   (waiter/hookah_master/bartender, см. AppConstants.position*) — на них
///   рассылаются вызовы гостя из-за стола (см. GuestCallTypeX.targetPosition
///   и onWaiterCall в functions/index.js).
/// `scope` — tenantId в SaaS-режиме (изоляция между заведениями платформы),
/// либо `default` в одно-арендном режиме.
///
/// Устройство подписывается на "all" сразу при старте ([initStaff]) — общий
/// канал не зависит от того, кто именно вошёл. На топики специализации
/// подписывает [updateStaffPositionSubscription] — вызывается ПОСЛЕ
/// PIN-входа, когда уже известно, кто на этом устройстве работает: до
/// входа неизвестно, кому какие вызовы показывать.
class PushService {
  PushService._();
  static final PushService instance = PushService._();

  final _fcm = FirebaseMessaging.instance;

  static const _allPositions = [
    AppConstants.positionWaiter,
    AppConstants.positionHookahMaster,
    AppConstants.positionBartender,
  ];

  String get _scope => AppScope.tenantId ?? 'default';
  String _positionTopic(String position) => 'staff-$_scope-$position';
  String get _allStaffTopic => 'staff-$_scope-all';

  /// POS: подписка планшета на общий канал (брони и т.п., не зависящие от
  /// специализации). Специализацию конкретного сотрудника подключает
  /// [updateStaffPositionSubscription] отдельно, после PIN-входа.
  ///
  /// На Windows firebase_messaging не имеет платформенной реализации вовсе
  /// (в отличие от большинства других Firebase-плагинов) — вызов любого её
  /// метода уходит в MissingPluginException. Ранний выход, а не try/catch
  /// вокруг каждого вызова: push для кассы на Windows в любом случае не
  /// доставится, оповещения зала на этой платформе идут только через
  /// SessionAlertsService (см. HallWatchService/app_bootstrap.dart).
  Future<void> initStaff() async {
    if (Platform.isWindows) return;
    await _requestPermission();
    await _fcm.subscribeToTopic(_allStaffTopic);
  }

  /// Переподписывает устройство на топики специализации ПОСЛЕ успешного
  /// PIN-входа сотрудника. Сначала отписывается от ВСЕХ — на общем
  /// планшете смена сотрудника ("Сменить сотрудника" в EmployeeDrawer) не
  /// должна оставлять вызовы прошлого сотрудника прилетать следующему.
  /// Универсал (значение по умолчанию, см. Employee.position) и админ
  /// получают вызовы всех специализаций — ровно как было устроено раньше,
  /// пока владелец никого не специализировал явно.
  Future<void> updateStaffPositionSubscription(Employee employee) async {
    if (Platform.isWindows) return;
    for (final p in _allPositions) {
      await _fcm.unsubscribeFromTopic(_positionTopic(p));
    }
    final position = AppConstants.normalizePosition(employee.position);
    final isUniversal =
        position == AppConstants.positionUniversal || employee.role == AppConstants.roleAdmin;
    final positions = isUniversal ? _allPositions : [position];
    for (final p in positions) {
      await _fcm.subscribeToTopic(_positionTopic(p));
    }
  }

  /// Клиентское приложение: сохраняем токен гостя, чтобы слать адресно.
  ///
  /// loyaltyCol, а не col — профиль гостя в сети заведений общий на все
  /// точки (chains/{chainId}/clients), а не свой на каждой точке.
  Future<void> initGuest(String uid) async {
    await _requestPermission();
    final token = await _fcm.getToken();
    if (token != null && uid.isNotEmpty) {
      await AppScope.loyaltyCol('clients').doc(uid).set({'pushToken': token}, SetOptions(merge: true));
    }
    _fcm.onTokenRefresh.listen((t) {
      if (uid.isEmpty) return;
      AppScope.loyaltyCol('clients').doc(uid).set({'pushToken': t}, SetOptions(merge: true));
    });
  }

  Future<void> _requestPermission() async {
    try {
      await _fcm.requestPermission(alert: true, badge: true, sound: true);
    } catch (_) {
      // Отказ в разрешении не должен ломать запуск приложения.
    }
  }

  /// Уведомление всей смене независимо от специализации (общий топик).
  Future<void> notifyStaff({
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) =>
      enqueue(topic: _allStaffTopic, title: title, body: body, data: data);

  /// Уведомление персоналу конкретной специализации (см.
  /// GuestCallTypeX.targetPosition) — а не всей смене разом.
  Future<void> notifyStaffPosition({
    required String position,
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) =>
      enqueue(topic: _positionTopic(position), title: title, body: body, data: data);

  /// Уведомление конкретному гостю.
  Future<void> notifyGuest({
    required String clientUid,
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) async {
    final doc = await AppScope.loyaltyCol('clients').doc(clientUid).get();
    final token = doc.data()?['pushToken'] as String?;
    if (token == null || token.isEmpty) return;
    await enqueue(token: token, title: title, body: body, data: data);
  }

  /// Кладёт задание в очередь `pushQueue`. Разбирает её Cloud Function
  /// `sendQueuedPush` — а она есть только на платном тарифе Blaze.
  ///
  /// Поэтому без функций мы в очередь НЕ пишем: раньше документы копились
  /// там мёртвым грузом (гость их всё равно не получал), впустую съедая
  /// лимит записей бесплатного тарифа. Уведомления в этом случае
  /// показывают сами приложения: POS — локальные уведомления зала, гость —
  /// KolibriNotifications.
  Future<void> enqueue({
    String? topic,
    String? token,
    String clientUid = '',
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) async {
    if (!VenueService.instance.cached.cloudFunctionsEnabled) return;
    await AppScope.col('pushQueue').add({
      if (topic != null) 'topic': topic,
      if (token != null) 'token': token,
      if (clientUid.isNotEmpty) 'clientUid': clientUid,
      'title': title,
      'body': body,
      'data': data,
      'status': 'new',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  /// Сообщения, пришедшие при открытом приложении — можно показать
  /// всплывающей плашкой поверх интерфейса.
  Stream<RemoteMessage> onForegroundMessage() => FirebaseMessaging.onMessage;
}
