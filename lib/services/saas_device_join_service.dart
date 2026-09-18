import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';

/// Присоединение POS-планшета к заведению SaaS-платформы — замена общего
/// на всю платформу `staffSecret` из одно-арендной версии индивидуальным
/// кодом приглашения конкретного заведения (см. saas/firestore.rules,
/// tenants/{tenantId}/devices и saas/README.md).
///
/// Работает ДО того, как известен tenantId устройства, поэтому не может
/// идти через [AppScope] (который как раз и определяется результатом этого
/// сервиса) — использует Firestore/Functions напрямую по явному пути.
class SaasDeviceJoinService {
  static const _region = 'europe-west1';

  /// Находит tenantId заведения по человекочитаемому коду (тому, что
  /// владелец видит в личном кабинете и диктует по телефону/пишет в чат).
  /// Бросает исключение, если заведение не найдено или заблокировано —
  /// сообщение исключения уже на русском и годится для показа в UI.
  Future<String> resolveTenantIdBySlug(String slug) async {
    final callable =
        FirebaseFunctions.instanceFor(region: _region).httpsCallable('resolveTenantBySlug');
    try {
      final result = await callable.call<Map<String, dynamic>>({'slug': slug.trim()});
      final tenantId = result.data['tenantId'] as String?;
      if (tenantId == null || tenantId.isEmpty) {
        throw StateError('Платформа не вернула tenantId для этого заведения');
      }
      return tenantId;
    } on FirebaseFunctionsException catch (e) {
      throw StateError(e.message ?? 'Заведение с таким кодом не найдено');
    }
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
