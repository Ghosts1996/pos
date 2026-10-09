import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import '../build_info.dart';
import 'app_scope.dart';

/// Ошибка шлюза с текстом для человека (его пишет сам шлюз).
class GatewayException implements Exception {
  final String message;
  GatewayException(this.message);
  @override
  String toString() => message;
}

/// Запросы к saas-gateway от имени вошедшего пользователя (касса или гость):
/// токен Firebase в заголовке, номер заведения — в теле.
class GatewayApi {
  GatewayApi._();

  static Future<Map<String, dynamic>> post(String path, [Map<String, dynamic> body = const {}]) async {
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (kSaasGatewayUrl.isEmpty || token == null) {
      throw GatewayException('Сервер сейчас недоступен — проверьте интернет');
    }
    http.Response resp;
    try {
      resp = await http
          .post(
            Uri.parse('$kSaasGatewayUrl/$path'),
            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
            body: jsonEncode({'tenantId': AppScope.tenantId, ...body}),
          )
          .timeout(const Duration(seconds: 25));
    } catch (_) {
      throw GatewayException('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
    }
    Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw GatewayException('Сервер ответил ошибкой ${resp.statusCode}');
    }
    if (resp.statusCode != 200) {
      throw GatewayException((json['error'] ?? 'Сервер ответил ошибкой ${resp.statusCode}').toString());
    }
    return json;
  }
}
