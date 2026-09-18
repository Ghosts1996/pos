import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'venue_service.dart';

/// Push-уведомления через Firebase Cloud Messaging.
///
/// Отправка идёт не с устройства (ключ сервера нельзя класть в APK), а через
/// очередь: приложение пишет документ в `pushQueue`, Cloud Function
/// `sendQueuedPush` его забирает и рассылает (см. functions/index.js).
///
/// Сотрудники подписаны на топик `staff` — им прилетают вызовы гостей и
/// новые брони. Гостю шлём адресно по его FCM-токену из clients/{uid}.
class PushService {
  PushService._();
  static final PushService instance = PushService._();

  final _fcm = FirebaseMessaging.instance;

  /// POS: подписка планшета на уведомления зала.
  Future<void> initStaff() async {
    await _requestPermission();
    await _fcm.subscribeToTopic('staff');
  }

  /// Клиентское приложение: сохраняем токен гостя, чтобы слать адресно.
  Future<void> initGuest(String uid) async {
    await _requestPermission();
    final token = await _fcm.getToken();
    if (token != null && uid.isNotEmpty) {
      await AppScope.col('clients').doc(uid).set({'pushToken': token}, SetOptions(merge: true));
    }
    _fcm.onTokenRefresh.listen((t) {
      if (uid.isEmpty) return;
      AppScope.col('clients').doc(uid).set({'pushToken': t}, SetOptions(merge: true));
    });
  }

  Future<void> _requestPermission() async {
    try {
      await _fcm.requestPermission(alert: true, badge: true, sound: true);
    } catch (_) {
      // Отказ в разрешении не должен ломать запуск приложения.
    }
  }

  /// Уведомление всей смене (топик staff).
  Future<void> notifyStaff({
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) =>
      enqueue(topic: 'staff', title: title, body: body, data: data);

  /// Уведомление конкретному гостю.
  Future<void> notifyGuest({
    required String clientUid,
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) async {
    final doc = await AppScope.col('clients').doc(clientUid).get();
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
