import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../build_info.dart';

/// Присоединение планшета кассы к заведению по коду приглашения (вместо
/// общего staffSecret сборки одного заведения).
///
/// Работает до того, как известен tenantId, поэтому пишет в Firestore по
/// явному пути, а не через [AppScope]. Поиск заведения по коду и демо —
/// через saas-gateway; сам joinAsDevice пишет напрямую, код проверяют
/// правила tenants/{tenantId}/devices.
class SaasDeviceJoinService {
  final http.Client _http;

  SaasDeviceJoinService({http.Client? client}) : _http = client ?? http.Client();

  /// Находит tenantId заведения по человекочитаемому коду (тому, что
  /// владелец видит в личном кабинете и диктует по телефону/пишет в чат).
  /// Бросает исключение, если заведение не найдено или заблокировано —
  /// сообщение исключения уже на русском и годится для показа в UI.
  ///
  /// chainId — заведение может состоять в сети (см. её docstring в
  /// saas/firestore.rules); без него вызывающий код не смог бы отличить
  /// точку сети от одиночного заведения и передал бы AppScope.enterTenant
  /// без chainId — тогда общая лояльность сети (chains/{chainId}/clients и
  /// соседние коллекции) тихо подменилась бы на пустые tenant-скоуп
  /// документы этой конкретной точки.
  Future<({String tenantId, String? chainId})> resolveTenantIdBySlug(String slug) async {
    final json = await _callGateway('resolveTenantBySlug', {'slug': slug.trim()}, requireAuth: false);
    final tenantId = json['tenantId'] as String?;
    if (tenantId == null || tenantId.isEmpty) {
      throw StateError('Сервис не вернул tenantId для этого заведения');
    }
    return (tenantId: tenantId, chainId: json['chainId'] as String?);
  }

  /// Находит сеть заведений по её человекочитаемому коду и отдаёт список
  /// живых точек — нужен гостевой сборке Kolibri для сети (см.
  /// kSaasPresetChainSlug), чтобы построить экран выбора заведения ДО того,
  /// как известен tenantId конкретной точки. Бросает исключение, если сеть
  /// не найдена или удалена — сообщение уже на русском и годится для UI.
  Future<ChainDirectory> resolveChainBySlug(String slug) async {
    final json = await _callGateway('resolveChainBySlug', {'slug': slug.trim()}, requireAuth: false);
    final chainId = json['chainId'] as String?;
    if (chainId == null || chainId.isEmpty) {
      throw StateError('Сервис не вернул chainId для этой сети');
    }
    final rawLocations = (json['locations'] as List?) ?? const [];
    final locations = rawLocations
        .map((e) => Map<String, dynamic>.from(e as Map))
        .map((e) => ChainLocation(
              tenantId: e['tenantId'] as String? ?? '',
              name: e['name'] as String? ?? '',
              slug: e['slug'] as String? ?? '',
              status: e['status'] as String? ?? 'active',
            ))
        .where((l) => l.tenantId.isNotEmpty)
        .toList();
    return ChainDirectory(
      chainId: chainId,
      name: json['name'] as String? ?? '',
      locations: locations,
    );
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
      // Касса собирается и под Windows — владелец видит платформу в кабинете.
      'platform': kIsWeb ? 'web' : defaultTargetPlatform.name,
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

  /// Зеркало членства в сети (chainMembers) для планшета точки сети: по
  /// нему правила пускают к общей лояльности сети — гостям, бонусам,
  /// визитам. Присоединение идёт без сервера, и раньше планшет, подключённый
  /// к точке уже созданной сети, получал permission-denied на всех гостях.
  /// Вызывается на каждом старте: так чинятся и планшеты, присоединённые до
  /// исправления. Запись уже есть (в том числе отключённая владельцем) —
  /// ничего не делаем. Ошибки не пробрасывает: попробуем при следующем
  /// запуске.
  static Future<void> ensureChainMembership({
    required String chainId,
    required String tenantId,
    required String uid,
  }) async {
    if (chainId.isEmpty || tenantId.isEmpty || uid.isEmpty) return;
    final ref = FirebaseFirestore.instance.collection('chainMembers').doc('${chainId}_$uid');
    try {
      if ((await ref.get()).exists) return;
    } on FirebaseException catch (e) {
      // Несуществующий документ правила не отдают — это и есть «записи нет».
      if (e.code != 'permission-denied') return;
    } catch (_) {
      return;
    }
    try {
      await ref.set({
        'chainId': chainId,
        'userId': uid,
        'tenantId': tenantId,
        'role': 'employee',
        'status': 'active',
        'createdAt': FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }
}

/// Одна точка сети — то, что нужно показать гостю в списке выбора
/// заведения (см. [SaasDeviceJoinService.resolveChainBySlug]).
class ChainLocation {
  final String tenantId;
  final String name;
  final String slug;
  final String status;

  const ChainLocation({
    required this.tenantId,
    required this.name,
    required this.slug,
    required this.status,
  });
}

/// Сеть заведений с её живыми точками — результат
/// [SaasDeviceJoinService.resolveChainBySlug].
class ChainDirectory {
  final String chainId;
  final String name;
  final List<ChainLocation> locations;

  const ChainDirectory({required this.chainId, required this.name, required this.locations});
}
