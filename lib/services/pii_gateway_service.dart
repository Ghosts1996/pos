import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../build_info.dart';
import 'app_scope.dart';

/// Первичная запись персональных данных гостя (имя, телефон) — не в
/// Firestore (Google Cloud, без региона в РФ), а в собственный сервис на
/// инфраструктуре в России, см. `yandex-pii-gateway/`.
///
/// ПОЧЕМУ это отдельный сервис, а не просто ещё один Firestore-вызов.
/// По ст. 18 ч.5 152-ФЗ запись, накопление и хранение персональных данных
/// граждан РФ должны ПЕРВИЧНО вестись на базах данных, физически
/// находящихся в РФ — и не удовлетворяются наличием более поздней копии
/// где-либо ещё (см. раздел 7 политики конфиденциальности на сайте
/// платформы, `saas/console/console.js`). Этот сервис и есть та самая
/// первичная запись: он сам создаёт/обновляет `clients/{uid}` в Firestore
/// уже ПОСЛЕ того, как сохранил имя и телефон у себя — то есть Firestore
/// в этой части становится вторичной репликой для быстрого чтения на
/// кассе, а не местом первого приземления данных.
///
/// ЧТО ЭТИМ НЕ ЗАКРЫТО (сознательно, см. обсуждение с владельцем
/// платформы): поиск гостя по телефону/сессии при списании бонусов
/// (`GuestLinkService.findByPhone/findBySession`), поиск дисконтной карты
/// и правка телефона гостя прямо на кассе (`bonus_redeem_panel.dart`)
/// продолжают идти напрямую в Firestore — это офлайн-критичные операции
/// в разгар смены (поиск по столу/оплате не может ждать сеть), ломать их
/// ради формального соответствия было бы несоразмерно. Так же не тронуты
/// `reservations`/`discountCards`/`waitlist` — у них СВОИ независимые
/// копии имени/телефона гостя, это отдельный, более крупный рефакторинг
/// (вынести ссылку на профиль вместо копии текста), не часть этого шага.
class PiiGatewayService {
  final http.Client _http;
  final String baseUrl;

  PiiGatewayService({http.Client? client, this.baseUrl = kPiiGatewayUrl})
      : _http = client ?? http.Client();

  /// Первичная регистрация/обновление имени и телефона гостя.
  ///
  /// `null` в [name] или [phone] означает «не трогать это поле» (ключ не
  /// попадает в запрос вообще) — так раньше вело себя
  /// `updateProfile(uid, {...})`, когда ключ просто не передавался
  /// (`kolibri_auth_service.dart`/`kolibri_booking_screen.dart`, где имя
  /// гостя на момент звонка часто ещё не введено). Пустая строка `''` —
  /// это ЯВНАЯ команда очистить поле (`kolibri_profile_screen.dart`, где
  /// гость мог стереть имя из своего профиля намеренно). Разница между
  /// «не трогать» и «очистить» важна и намеренно сохранена такой же, какой
  /// была до переезда на этот шлюз.
  ///
  /// Бросает [PiiGatewayException] при отсутствии сети, неверном ответе
  /// сервиса или отсутствии `PII_GATEWAY_URL` в сборке — вызывающий код
  /// (экраны профиля/брони гостя) уже требует сеть на этом шаге (SMS-код,
  /// отправка формы), поэтому дополнительная сетевая зависимость здесь не
  /// снижает надёжность самого приложения.
  Future<void> registerGuestProfile({
    required String uid,
    String? name,
    String? phone,
  }) async {
    if (baseUrl.isEmpty) {
      throw PiiGatewayException(
        'PII_GATEWAY_URL не задан в сборке — данные гостя не могут быть '
        'сохранены первично на инфраструктуре в РФ. Соберите приложение с '
        '--dart-define=PII_GATEWAY_URL=... (см. yandex-pii-gateway/README.md).',
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
            // baseUrl — это уже полный адрес вызова функции целиком (см.
            // PII_GATEWAY_URL и yandex-pii-gateway/README.md): у Yandex
            // Cloud Functions нет отдельного роутинга по пути внутри одной
            // функции, поэтому лишний путь тут не добавляем — база данных
            // в Phase 1 обслуживает ровно одну операцию.
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
        'Сервис первичной записи данных ответил ошибкой (${resp.statusCode}): '
        '${resp.body}',
      );
    }
  }
}

class PiiGatewayException implements Exception {
  final String message;
  PiiGatewayException(this.message);
  @override
  String toString() => message;
}
