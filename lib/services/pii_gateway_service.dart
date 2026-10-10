import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../build_info.dart';
import 'app_scope.dart';

/// Первичная запись имени и телефона гостя — в базу в России
/// (`pii-gateway/`), а не сразу в Firestore: ч. 5 ст. 18 152-ФЗ требует
/// первичной записи в РФ. Сервер сам обновляет `clients/{uid}` в Firestore
/// после сохранения, и Firestore остаётся копией для быстрого чтения.
///
/// Напрямую в Firestore по-прежнему идут офлайн-критичные операции кассы:
/// поиск гостя по телефону при списании бонусов, поиск дисконтной карты,
/// правка телефона на кассе (`bonus_redeem_panel.dart`). У броней, карт и
/// очереди свои копии имени и телефона.
class PiiGatewayService {
  final http.Client _http;
  final String baseUrl;

  PiiGatewayService({http.Client? client, this.baseUrl = kPiiGatewayUrl})
      : _http = client ?? http.Client();

  /// Записывает имя и телефон гостя. `null` — не трогать поле (ключ не
  /// уходит в запрос), `''` — очистить.
  ///
  /// [PiiGatewayException] — нет сети, ошибка сервиса или в сборке нет
  /// `PII_GATEWAY_URL`. На экранах профиля и брони сеть и так нужна.
  Future<void> registerGuestProfile({
    required String uid,
    String? name,
    String? phone,
  }) async {
    if (baseUrl.isEmpty) {
      throw PiiGatewayException(
        'PII_GATEWAY_URL не задан в сборке — данные гостя не могут быть '
        'сохранены первично на инфраструктуре в РФ. Соберите приложение с '
        '--dart-define=PII_GATEWAY_URL=... (см. pii-gateway/README.md).',
      );
    }
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      throw PiiGatewayException('Нет активной сессии гостя — сначала войдите.');
    }
    final idToken = await user.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw PiiGatewayException('Не удалось получить токен сессии — попробуйте снова.');
    }

    http.Response resp;
    try {
      resp = await _http
          .post(
            // baseUrl — это уже полный адрес сервиса целиком (см.
            // PII_GATEWAY_URL и pii-gateway/README.md) — сервис в Phase 1
            // обслуживает ровно одну операцию, лишний путь не добавляем.
            Uri.parse(baseUrl),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $idToken',
            },
            body: jsonEncode({
              'tenantId': AppScope.tenantId ?? '',
              'uid': uid,
              if (name != null) 'name': name,
              if (phone != null) 'phone': phone,
            }),
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      throw PiiGatewayException('Проверьте интернет и попробуйте снова: $e');
    }

    if (resp.statusCode != 200) {
      throw PiiGatewayException(
          'Не удалось сохранить данные (${resp.statusCode})${_serverReason(resp)} — попробуйте ещё раз.');
    }
  }
}

/// Причина отказа из ответа сервера ({"error": "..."}), без сырого тела:
/// гость не должен видеть JSON или страницу прокси.
String _serverReason(http.Response resp) {
  try {
    final data = jsonDecode(resp.body);
    final error = data is Map ? data['error'] : null;
    if (error is String && error.trim().isNotEmpty) return ': ${error.trim()}';
  } catch (_) {}
  return '';
}

/// Первичная запись контакта брони или листа ожидания (имя, телефон) на
/// сервере в РФ — ДО создания документа в Firestore (ст. 18 ч. 5 152-ФЗ).
/// [kind] — 'reservation', 'waitlist' или 'delivery' (+ адрес), [id] — id
/// будущего документа.
/// Без PII_GATEWAY_URL (разработка, одно-арендная сборка) — ничего не
/// делает; ошибку сети пробрасывает: без первичной записи бронь не создаём.
extension PiiContactRecords on PiiGatewayService {
  Future<void> recordContact({
    required String kind,
    required String id,
    required String name,
    required String phone,
    String address = '',
  }) async {
    final tenant = AppScope.tenantId ?? '';
    if (baseUrl.isEmpty || tenant.isEmpty) return;
    if (name.trim().isEmpty && phone.trim().isEmpty && address.trim().isEmpty) return;
    final user = FirebaseAuth.instance.currentUser;
    final idToken = await user?.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw PiiGatewayException('Нет активной сессии — войдите заново.');
    }
    http.Response resp;
    try {
      resp = await _http
          .post(
            Uri.parse(baseUrl),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $idToken'},
            body: jsonEncode({
              'tenantId': tenant,
              'kind': kind,
              'id': id,
              'name': name,
              'phone': phone,
              if (address.isNotEmpty) 'address': address,
            }),
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      throw PiiGatewayException('Нет связи с сервером — проверьте интернет и попробуйте снова.');
    }
    if (resp.statusCode != 200) {
      throw PiiGatewayException('Сервер не сохранил контакт (${resp.statusCode}) — попробуйте ещё раз.');
    }
  }
}

/// Гость удаляет свои данные сам: стираем имя и телефон в первичной базе
/// в РФ (профиль и контакты броней/листа ожидания). Вызывать ДО
/// saas-gateway /deleteGuestData — тот удаляет анонимный аккаунт, и
/// токена потом уже не будет.
extension PiiGuestDeletion on PiiGatewayService {
  Future<void> deleteGuestData() async {
    final tenant = AppScope.tenantId ?? '';
    if (baseUrl.isEmpty || tenant.isEmpty) return;
    final idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw PiiGatewayException('Нет активной сессии — перезапустите приложение.');
    }
    http.Response resp;
    try {
      resp = await _http
          .post(
            Uri.parse(baseUrl),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $idToken'},
            body: jsonEncode({'tenantId': tenant, 'kind': 'guest_delete'}),
          )
          .timeout(const Duration(seconds: 20));
    } catch (e) {
      throw PiiGatewayException('Нет связи с сервером — проверьте интернет и попробуйте снова.');
    }
    if (resp.statusCode != 200) {
      // Текст ошибки сервера — чтобы по скриншоту было видно причину.
      var detail = '';
      try {
        final err = (jsonDecode(resp.body) as Map<String, dynamic>)['error'];
        if (err is String) detail = ': $err';
      } catch (_) {}
      throw PiiGatewayException('Сервер не удалил данные (${resp.statusCode}$detail) — попробуйте ещё раз.');
    }
  }
}

/// Согласия гостя (обработка ПД и трансграничная передача) — отметка с
/// датой, редакцией текста, IP и браузером записывается на сервер в РФ
/// и служит доказательством согласия (ст. 9 152-ФЗ).
extension PiiGuestConsent on PiiGatewayService {
  /// [crossBorder] — гость отметил и согласие на трансграничную передачу
  /// (нужно, пока заведение не переведено на хранение только в РФ).
  Future<void> recordGuestConsent(String edition, {bool crossBorder = true}) async {
    if (baseUrl.isEmpty) {
      throw PiiGatewayException('Сервер данных не настроен в этой сборке — согласие не сохранить.');
    }
    final idToken = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (idToken == null || idToken.isEmpty) {
      throw PiiGatewayException('Нет активной сессии — перезапустите приложение.');
    }
    http.Response resp;
    try {
      resp = await _http
          .post(
            Uri.parse(baseUrl),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $idToken'},
            body: jsonEncode({
              'tenantId': AppScope.tenantId ?? '',
              'kind': 'guest_consent',
              'edition': edition,
              'pd': true,
              'crossBorder': crossBorder,
            }),
          )
          .timeout(const Duration(seconds: 15));
    } catch (_) {
      throw PiiGatewayException('Нет связи с сервером — проверьте интернет и попробуйте снова.');
    }
    if (resp.statusCode != 200) {
      throw PiiGatewayException('Согласие не сохранилось (${resp.statusCode})${_serverReason(resp)} — попробуйте ещё раз.');
    }
  }
}

class PiiGatewayException implements Exception {
  final String message;
  PiiGatewayException(this.message);
  @override
  String toString() => message;
}
