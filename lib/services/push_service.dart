import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

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

  final _db = FirebaseFirestore.instance;
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
      await _db.collection('clients').doc(uid).set({'pushToken': token}, SetOptions(merge: true));
    }
    _fcm.onTokenRefresh.listen((t) {
      if (uid.isEmpty) return;
      _db.collection('clients').doc(uid).set({'pushToken': t}, SetOptions(merge: true));
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
      _enqueue(topic: 'staff', title: title, body: body, data: data);

  /// Уведомление конкретному гостю.
  Future<void> notifyGuest({
    required String clientUid,
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) async {
    final doc = await _db.collection('clients').doc(clientUid).get();
    final token = doc.data()?['pushToken'] as String?;
    if (token == null || token.isEmpty) return;
    await _enqueue(token: token, title: title, body: body, data: data);
  }

  Future<void> _enqueue({
    String? topic,
    String? token,
    required String title,
    required String body,
    Map<String, String> data = const {},
  }) =>
      _db.collection('pushQueue').add({
        if (topic != null) 'topic': topic,
        if (token != null) 'token': token,
        'title': title,
        'body': body,
        'data': data,
        'status': 'new',
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });

  /// Сообщения, пришедшие при открытом приложении — можно показать
  /// всплывающей плашкой поверх интерфейса.
  Stream<RemoteMessage> onForegroundMessage() => FirebaseMessaging.onMessage;
}
