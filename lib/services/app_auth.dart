import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../build_info.dart';
import '../data/app_db.dart';

/// Вход приложения: Firebase Authentication или свой вход платформы
/// (saas-gateway, /auth/*, сервер в РФ). Какой сейчас, говорит сервер
/// (GET /db/status → auth) — переключение без новой сборки. Сборка одного
/// заведения всегда на Firebase.
///
/// Свой вход включается только вместе с собственным сервером данных
/// ([AppDb.isLocal]): Firestore пускает лишь по входу Firebase. Прежний вход
/// Firebase один раз меняется на свой с тем же uid — регистрация устройства,
/// бонусы и история гостя остаются.
///
/// Ошибки — [FirebaseAuthException] с теми же кодами, что у Firebase
/// (user-token-expired, network-request-failed…): вызывающий код не меняется.
class AppAuth {
  AppAuth._();
  static final AppAuth instance = AppAuth._();

  static const _prefBackend = 'auth_backend_v1';
  static const _prefSession = 'own_auth_session_v1';

  bool _own = false;
  _OwnSession? _session;
  AppUser? _user;
  SharedPreferences? _prefs;
  final _changes = StreamController<AppUser?>.broadcast();
  final _uids = StreamController<String>.broadcast();
  StreamSubscription<User?>? _fbForward;
  Future<String>? _refreshing;
  http.Client _http = http.Client();
  String _base = kSaasGatewayUrl;

  /// Свой вход платформы (а не Firebase).
  bool get isOwn => _own;

  FirebaseAuth get _fb => FirebaseAuth.instance;

  /// Тесты: свой вход против подставного сервера.
  @visibleForTesting
  static AppAuth debugOwn({required http.Client client, required String baseUrl, SharedPreferences? prefs}) {
    final a = AppAuth._()
      .._own = true
      .._http = client
      .._base = baseUrl
      .._prefs = prefs;
    a._session = a._readSession();
    a._user = a._session == null ? null : AppUser._own(a, a._session!);
    return a;
  }

  /// Сразу после [AppDb.init] и до первого входа.
  Future<void> init() async {
    if (!kSaasMode || kSaasGatewayUrl.isEmpty || kIsWeb) return;
    try {
      _prefs = await SharedPreferences.getInstance();
    } catch (_) {}
    final cached = _prefs?.getString(_prefBackend);
    var backend = cached ?? 'firebase';
    final fresh = await _fetchBackend(cached == null ? const Duration(seconds: 4) : const Duration(milliseconds: 1500));
    if (fresh != null) {
      backend = fresh;
      try {
        await _prefs?.setString(_prefBackend, fresh);
      } catch (_) {}
    }
    if (backend != 'own' || !AppDb.isLocal) return;
    _session = _readSession();
    if (_session != null) {
      _own = true;
      _user = AppUser._own(this, _session!);
      return;
    }
    // Своего входа ещё нет — меняем прежний вход Firebase на свой (тот же uid).
    final fbUser = _fb.currentUser ?? await _fb.authStateChanges().first.timeout(const Duration(seconds: 8), onTimeout: () => null);
    if (fbUser == null) {
      _own = true;
      return;
    }
    String? fbToken;
    try {
      fbToken = await fbUser.getIdToken();
    } on FirebaseAuthException catch (e) {
      // Вход Firebase мёртв — менять нечего, дальше свой вход с нуля.
      if (e.code != 'network-request-failed') {
        _own = true;
        await _fb.signOut().catchError((Object _) {});
        return;
      }
    } catch (_) {}
    if (fbToken == null) return; // нет связи — этот запуск на прежнем входе
    try {
      final r = await _post('/auth/exchange', {'idToken': fbToken});
      _own = true;
      await _signedIn(r);
      await _fb.signOut().catchError((Object _) {});
    } on FirebaseAuthException catch (e) {
      if (e.code == 'network-request-failed' || e.code == 'too-many-requests' || e.code == 'internal-error') return;
      _own = true;
      await _fb.signOut().catchError((Object _) {});
    }
  }

  static Future<String?> _fetchBackend(Duration timeout) async {
    try {
      final r = await http.get(Uri.parse('$kSaasGatewayUrl/db/status')).timeout(timeout);
      if (r.statusCode != 200) return null;
      final a = (jsonDecode(r.body) as Map)['auth'];
      return a == 'own' || a == 'firebase' ? a as String : null;
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------------------ состояние

  AppUser? get currentUser {
    if (_own) return _user;
    final u = _fb.currentUser;
    return u == null ? null : AppUser._fb(u);
  }

  /// Как у Firebase: сначала текущее состояние, затем каждая смена входа.
  Stream<AppUser?> authStateChanges() {
    if (!_own) return _fb.authStateChanges().map((u) => u == null ? null : AppUser._fb(u));
    late StreamController<AppUser?> c;
    StreamSubscription<AppUser?>? sub;
    c = StreamController<AppUser?>(
      onListen: () {
        c.add(_user);
        sub = _changes.stream.listen(c.add);
      },
      onCancel: () => sub?.cancel(),
    );
    return c.stream;
  }

  /// uid текущего входа при каждой смене — одинаково до и после
  /// переключения на свой вход (на него подписан движок данных ещё до [init]).
  Stream<String> get uidChanges {
    if (!_own && _fbForward == null) {
      _fbForward = _fb.idTokenChanges().listen((u) {
        if (!_own) _uids.add(u?.uid ?? '');
      });
    }
    return _uids.stream;
  }

  Stream<AppUser?> idTokenChanges() {
    if (!_own) return _fb.idTokenChanges().map((u) => u == null ? null : AppUser._fb(u));
    return authStateChanges();
  }

  Future<void> signInAnonymously() async {
    if (!_own) {
      await _fb.signInAnonymously();
      return;
    }
    await _signedIn(await _post('/auth/anonymous', const {}));
  }

  Future<void> signInWithCustomToken(String token) async {
    if (!_own) {
      await _fb.signInWithCustomToken(token);
      return;
    }
    await _signedIn(await _post('/auth/custom', {'token': token}));
  }

  Future<void> signOut() async {
    if (!_own) {
      await _fb.signOut();
      return;
    }
    final s = _session;
    _setSession(null);
    if (s != null) unawaited(_post('/auth/logout', {'refreshToken': s.refreshToken}).then((_) {}, onError: (Object _) {}));
  }

  // ------------------------------------------------------------ свой вход

  _OwnSession? _readSession() {
    try {
      final raw = _prefs?.getString(_prefSession);
      if (raw == null) return null;
      return _OwnSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  void _setSession(_OwnSession? s) {
    final before = _session?.uid;
    _session = s;
    try {
      if (s == null) {
        unawaited(_prefs?.remove(_prefSession));
      } else {
        unawaited(_prefs?.setString(_prefSession, jsonEncode(s.toJson())));
      }
    } catch (_) {}
    if (s == null) {
      _user = null;
    } else if (_user == null || _user!.uid != s.uid) {
      _user = AppUser._own(this, s);
    } else {
      _user!._s = s;
    }
    if (before != s?.uid) {
      _changes.add(_user);
      _uids.add(s?.uid ?? '');
    }
  }

  Future<void> _signedIn(Map<String, dynamic> r) async {
    final s = _OwnSession.fromTokens(r);
    _session = null; // новый вход — всегда событие, даже с тем же uid
    _setSession(s);
  }

  static Map<String, dynamic> _payload(String jwt) {
    try {
      final parts = jwt.split('.');
      return jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))) as Map<String, dynamic>;
    } catch (_) {
      return const {};
    }
  }

  Future<Map<String, dynamic>> _post(String route, Map<String, Object?> body) async {
    http.Response resp;
    try {
      resp = await _http
          .post(Uri.parse('$_base$route'), headers: {'Content-Type': 'application/json'}, body: jsonEncode(body))
          .timeout(const Duration(seconds: 20));
    } catch (_) {
      throw FirebaseAuthException(code: 'network-request-failed', message: 'Нет связи с сервером');
    }
    Map<String, dynamic> j = const {};
    try {
      j = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (_) {}
    if (resp.statusCode == 200) return j;
    if (resp.statusCode == 429) throw FirebaseAuthException(code: 'too-many-requests', message: j['error'] as String?);
    if (resp.statusCode >= 500) throw FirebaseAuthException(code: 'internal-error', message: j['error'] as String?);
    final code = (j['code'] as String? ?? 'auth/user-token-expired').replaceFirst('auth/', '');
    throw FirebaseAuthException(code: code, message: j['error'] as String?);
  }

  Future<String> _token(bool force) async {
    final s = _session;
    if (s == null) throw FirebaseAuthException(code: 'no-current-user', message: 'Нужен вход');
    if (!force && s.exp.isAfter(DateTime.now().add(const Duration(minutes: 1)))) return s.idToken;
    return _refreshing ??= _refresh(s).whenComplete(() => _refreshing = null);
  }

  Future<String> _refresh(_OwnSession s) async {
    try {
      final r = await _post('/auth/refresh', {'refreshToken': s.refreshToken});
      final next = _OwnSession.fromTokens(r);
      if (_session?.uid == s.uid) _setSession(next);
      return next.idToken;
    } on FirebaseAuthException catch (e) {
      // Вход отозван, устарел или аккаунт удалён — выходим, как Firebase.
      if (e.code != 'network-request-failed' && e.code != 'too-many-requests' && e.code != 'internal-error') {
        if (_session?.uid == s.uid) _setSession(null);
        throw FirebaseAuthException(code: e.code == 'user-not-found' || e.code == 'user-disabled' ? e.code : 'user-token-expired', message: e.message);
      }
      rethrow;
    }
  }
}

/// Пользователь входа — одинаковый для своего входа и Firebase.
class AppUser {
  AppUser._fb(User u)
      : _fbUser = u,
        _auth = null,
        uid = u.uid;
  AppUser._own(AppAuth auth, _OwnSession s)
      : _fbUser = null,
        _auth = auth,
        _s = s,
        uid = s.uid;

  final User? _fbUser;
  final AppAuth? _auth;
  _OwnSession? _s;
  final String uid;

  String? get email {
    final fb = _fbUser;
    return fb != null ? fb.email : _s?.email;
  }

  bool get isAnonymous {
    final fb = _fbUser;
    if (fb != null) return fb.isAnonymous;
    final e = _s?.email;
    return e == null || e.isEmpty;
  }

  Future<String?> getIdToken([bool forceRefresh = false]) async {
    final fb = _fbUser;
    if (fb != null) return fb.getIdToken(forceRefresh);
    return _auth!._token(forceRefresh);
  }
}

class _OwnSession {
  _OwnSession({required this.uid, required this.idToken, required this.refreshToken, required this.exp, this.email});

  factory _OwnSession.fromTokens(Map<String, dynamic> r) {
    final idToken = r['idToken'] as String;
    final p = AppAuth._payload(idToken);
    final exp = (p['exp'] as num?)?.toInt() ?? 0;
    return _OwnSession(
      uid: r['uid'] as String,
      idToken: idToken,
      refreshToken: r['refreshToken'] as String,
      exp: DateTime.fromMillisecondsSinceEpoch(exp * 1000),
      email: p['email'] as String?,
    );
  }

  factory _OwnSession.fromJson(Map<String, dynamic> j) => _OwnSession(
        uid: j['uid'] as String,
        idToken: j['idToken'] as String,
        refreshToken: j['refreshToken'] as String,
        exp: DateTime.fromMillisecondsSinceEpoch((j['exp'] as num).toInt()),
        email: j['email'] as String?,
      );

  final String uid;
  final String idToken;
  final String refreshToken;
  final DateTime exp;
  final String? email;

  Map<String, Object?> toJson() => {
        'uid': uid,
        'idToken': idToken,
        'refreshToken': refreshToken,
        'exp': exp.millisecondsSinceEpoch,
        'email': email,
      };
}
