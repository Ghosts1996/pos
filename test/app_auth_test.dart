import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hookah_pos/services/app_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Токен как у сервера своего входа: заголовок.данные.подпись.
String jwt(String uid, {required int expSec, String? email}) {
  String b64(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  return '${b64({'alg': 'HS256', 'kid': 'zalpos-1'})}.${b64({'uid': uid, 'exp': expSec, if (email != null) 'email': email})}.sig';
}

http.Response res(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

int inSec(Duration d) => DateTime.now().add(d).millisecondsSinceEpoch ~/ 1000;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<String> calls;
  late int refreshes;
  late String refreshMode; // ok | revoked | offline

  MockClient server() => MockClient((req) async {
        calls.add(req.url.path);
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        switch (req.url.path) {
          case '/auth/anonymous':
            return res({'uid': 'dev1', 'idToken': jwt('dev1', expSec: inSec(const Duration(hours: 1))), 'refreshToken': 'r1'}, 200);
          case '/auth/custom':
            if (body['token'] != 'zct.good') return res({'error': 'нет', 'code': 'auth/invalid-action-code'}, 400);
            return res({'uid': 'guest7', 'idToken': jwt('guest7', expSec: inSec(const Duration(hours: 1))), 'refreshToken': 'rg'}, 200);
          case '/auth/refresh':
            refreshes++;
            if (refreshMode == 'offline') throw http.ClientException('нет сети');
            if (refreshMode == 'revoked') return res({'error': 'Сеанс завершён', 'code': 'auth/user-token-expired'}, 400);
            return res({'uid': 'dev1', 'idToken': jwt('dev1', expSec: inSec(const Duration(hours: 1))), 'refreshToken': 'r$refreshes+'}, 200);
          case '/auth/logout':
            return res({'ok': true}, 200);
        }
        return res({'error': 'нет'}, 404);
      });

  setUp(() {
    calls = [];
    refreshes = 0;
    refreshMode = 'ok';
    SharedPreferences.setMockInitialValues({});
  });

  test('анонимный вход устройства: события, токен, сохранение', () async {
    final prefs = await SharedPreferences.getInstance();
    final a = AppAuth.debugOwn(client: server(), baseUrl: 'https://gw', prefs: prefs);
    expect(a.currentUser, isNull);
    expect(await a.authStateChanges().first, isNull);
    final uids = <String>[];
    final sub = a.uidChanges.listen(uids.add);
    await a.signInAnonymously();
    expect(a.currentUser!.uid, 'dev1');
    expect(a.currentUser!.isAnonymous, isTrue);
    expect(await a.currentUser!.getIdToken(), isNotEmpty);
    expect(refreshes, 0, reason: 'токен ещё действует');
    await Future<void>.delayed(Duration.zero);
    expect(uids, ['dev1']);
    // Перезапуск приложения — вход поднимается с диска.
    final b = AppAuth.debugOwn(client: server(), baseUrl: 'https://gw', prefs: prefs);
    expect(b.currentUser!.uid, 'dev1');
    await sub.cancel();
  });

  test('истёкший токен обновляется один раз на все запросы', () async {
    SharedPreferences.setMockInitialValues({
      'own_auth_session_v1': jsonEncode({'uid': 'dev1', 'idToken': jwt('dev1', expSec: inSec(const Duration(seconds: -5))), 'refreshToken': 'r0', 'exp': 0}),
    });
    final a = AppAuth.debugOwn(client: server(), baseUrl: 'https://gw', prefs: await SharedPreferences.getInstance());
    final t = await Future.wait<String?>([a.currentUser!.getIdToken(), a.currentUser!.getIdToken(), a.currentUser!.getIdToken()]);
    expect(refreshes, 1);
    expect(t.toSet().length, 1);
    await a.currentUser!.getIdToken(true);
    expect(refreshes, 2);
  });

  test('без сети вход остаётся, отозванный — выход с кодом Firebase', () async {
    SharedPreferences.setMockInitialValues({
      'own_auth_session_v1': jsonEncode({'uid': 'dev1', 'idToken': jwt('dev1', expSec: 1), 'refreshToken': 'r0', 'exp': 0}),
    });
    final a = AppAuth.debugOwn(client: server(), baseUrl: 'https://gw', prefs: await SharedPreferences.getInstance());
    refreshMode = 'offline';
    await expectLater(a.currentUser!.getIdToken(), throwsA(isA<FirebaseAuthException>().having((e) => e.code, 'code', 'network-request-failed')));
    expect(a.currentUser, isNotNull, reason: 'касса работает без интернета на прежнем входе');
    refreshMode = 'revoked';
    final states = <String?>[];
    final sub = a.authStateChanges().listen((u) => states.add(u?.uid));
    await expectLater(a.currentUser!.getIdToken(), throwsA(isA<FirebaseAuthException>().having((e) => e.code, 'code', 'user-token-expired')));
    expect(a.currentUser, isNull);
    await Future<void>.delayed(Duration.zero);
    expect(states, ['dev1', null]);
    await sub.cancel();
  });

  test('восстановление гостя по ключу и выход', () async {
    final a = AppAuth.debugOwn(client: server(), baseUrl: 'https://gw', prefs: await SharedPreferences.getInstance());
    await expectLater(a.signInWithCustomToken('zct.bad'), throwsA(isA<FirebaseAuthException>().having((e) => e.code, 'code', 'invalid-action-code')));
    await a.signInWithCustomToken('zct.good');
    expect(a.currentUser!.uid, 'guest7');
    await a.signOut();
    expect(a.currentUser, isNull);
    await Future<void>.delayed(Duration.zero);
    expect(calls, contains('/auth/logout'));
  });
}
