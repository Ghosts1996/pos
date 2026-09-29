import 'dart:async';
import 'dart:io' show Platform;
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'venue_service.dart';
import '../models/employee.dart';
import '../utils/constants.dart';

/// Push-уведомления через FCM.
///
/// Ключ сервера в APK класть нельзя, поэтому приложение пишет задание в
/// `pushQueue`, а рассылает Cloud Function `sendQueuedPush` (functions/ в
/// корне, только сборка одного заведения на Blaze).
///
/// Топики персонала: `staff-{scope}-all` — общий канал (брони и т.п.),
/// `staff-{scope}-{position}` — специализация (waiter, hookah_master,
/// bartender) для вызовов гостя. `scope` — tenantId в SaaS или `default`,
/// чтобы вызовы одного заведения не будили персонал другого.
///
/// На «all» устройство подписывается при старте ([initStaff]), на
/// специализацию — после PIN-входа ([updateStaffPositionSubscription]).
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

  /// Переподписывает устройство на топики специализации после PIN-входа.
  /// Сначала отписывается от всех: после «Сменить сотрудника» вызовы
  /// прошлого не должны приходить следующему. Универсал и админ получают
  /// все специализации.
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

  /// Кладёт задание в `pushQueue`. Без Cloud Functions очередь никто не
  /// разбирает, поэтому пишем только при `cloudFunctionsEnabled` — иначе
  /// уведомления показывают сами приложения (касса — локальные, гость —
  /// KolibriNotifications).
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
