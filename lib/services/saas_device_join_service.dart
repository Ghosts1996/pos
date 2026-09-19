import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import '../build_info.dart';

/// Присоединение POS-планшета к заведению SaaS-платформы — замена общего
/// на всю платформу `staffSecret` из одно-арендной версии индивидуальным
/// кодом приглашения конкретного заведения (см. saas/firestore.rules,
/// tenants/{tenantId}/devices и saas/README.md).
///
/// Работает ДО того, как известен tenantId устройства, поэтому не может
/// идти через [AppScope] (который как раз и определяется результатом этого
/// сервиса) — использует Firestore напрямую по явному пути.
///
/// [resolveTenantIdBySlug] и [createDemoTenant] раньше были Cloud Functions
/// (`resolveTenantBySlug`/`createDemoTenant` в saas/functions/index.js) —
/// перенесены на свой сервис (см. saas-gateway/README.md), потому что Cloud
/// Functions не работают без тарифа Blaze у проекта saas-3bdc8, а он сейчас
/// недоступен. `joinAsDevice` этой проблемы не имеет и продолжает писать в
/// Firestore напрямую — Firestore Security Rules это уже разрешают
/// (проверка кода приглашения — часть самих правил, см. их комментарий у
/// tenants/{tenantId}/devices).
class SaasDeviceJoinService {
  final http.Client _http;

  SaasDeviceJoinService({http.Client? client}) : _http = client ?? http.Client();

  /// Находит tenantId заведения по человекочитаемому коду (тому, что
  /// владелец видит в личном кабинете и диктует по телефону/пишет в чат).
  /// Бросает исключение, если заведение не найдено или заблокировано —
  /// сообщение исключения уже на русском и годится для показа в UI.
  Future<String> resolveTenantIdBySlug(String slug) async {
    final json = await _callGateway('resolveTenantBySlug', {'slug': slug.trim()}, requireAuth: false);
    final tenantId = json['tenantId'] as String?;
    if (tenantId == null || tenantId.isEmpty) {
      throw StateError('Сервис не вернул tenantId для этого заведения');
    }
    return tenantId;
  }

  /// Создаёт одноразовое демо-заведение (без email/пароля, само стирается
  /// через несколько часов) и сразу возвращает всё нужное для
  /// присоединения — см. docstring [handleCreateDemoTenant] на сервере.
  Future<({String tenantId, String inviteCode})> createDemoTenant() async {
    final json = await _callGateway('createDemoTenant', {}, requireAuth: false);
    final tenantId = json['tenantId'] as String?;
    final inviteCode = json['inviteCode'] as String?;
    if (tenantId == null || tenantId.isEmpty || inviteCode == null || inviteCode.isEmpty) {
      throw StateError('Сервис не вернул данные демо-заведения');
    }
    return (tenantId: tenantId, inviteCode: inviteCode);
  }

  Future<Map<String, dynamic>> _callGateway(
    String path,
    Map<String, dynamic> body, {
    required bool requireAuth,
  }) async {
    if (kSaasGatewayUrl.isEmpty) {
      throw StateError(
        'SAAS_GATEWAY_URL не задан в сборке — соберите с '
        '--dart-define=SAAS_GATEWAY_URL=... (см. saas-gateway/README.md).',
      );
    }
    String? idToken;
    if (requireAuth) {
      idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
      if (idToken == null || idToken.isEmpty) {
        throw StateError('Нет активной сессии — перезапустите приложение');
      }
    }
    http.Response resp;
    try {
      resp = await _http
          .post(
            Uri.parse('$kSaasGatewayUrl/$path'),
            headers: {
              'Content-Type': 'application/json',
              if (idToken != null) 'Authorization': 'Bearer $idToken',
            },
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      throw StateError('Проверьте интернет и попробуйте снова: $e');
    }
    Map<String, dynamic> json;
    try {
      json = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {
      json = const {};
    }
    if (resp.statusCode != 200) {
      throw StateError((json['error'] as String?) ?? 'Сервис ответил ошибкой (${resp.statusCode})');
    }
    return json;
  }

  /// Регистрирует устройство в заведении [tenantId] по коду приглашения.
  /// Двухшаговая запись строго в этом порядке — правила Firestore разрешают
  /// создать tenantMembers с ролью employee только ПОСЛЕ того, как документ
  /// в devices/{uid} уже существует (см. комментарий в saas/firestore.rules
  /// у правила tenantMembers.create): так код приглашения проверяется один
  /// раз, а не хранится ещё и в самом членстве.
  Future<void> joinAsDevice({
    required String tenantId,
    required String inviteCode,
    required String uid,
    String deviceName = '',
  }) async {
    final db = FirebaseFirestore.instance;

    await db.collection('tenants/$tenantId/devices').doc(uid).set({
      'inviteCode': inviteCode.trim(),
      'deviceName': deviceName,
      'deviceType': 'pos',
      'platform': 'android',
      'userId': uid,
      'createdAt': FieldValue.serverTimestamp(),
      'lastSeenAt': FieldValue.serverTimestamp(),
      'status': 'active',
    });

    await db.collection('tenantMembers').doc('${tenantId}_$uid').set({
      'tenantId': tenantId,
      'userId': uid,
      'role': 'employee',
      'status': 'active',
      'createdAt': FieldValue.serverTimestamp(),
    });
  }
}
