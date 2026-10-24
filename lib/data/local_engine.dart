import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

// Движок собственного сервера данных: кэш документов на устройстве, очередь
// записей (переживает выключение и работу без интернета), запросы и живые
// подписки через saas-gateway (/db/*). Значения хранятся в «сетевом» виде,
// как их отдаёт сервер: метка времени — {"__ts": мс}, служебная операция
// записи — {"__op": ..., "value": ...}; запись с serverTimestamp, ещё не
// подтверждённая сервером, — {"__pts": мс} (приложению отдаётся null, как
// в Firestore).

const _plugin = 'cloud_firestore';

FirebaseException dbError(String code, [String? message]) =>
    FirebaseException(plugin: _plugin, code: code, message: message ?? code);

bool isTs(Object? v) => v is Map && v.length == 1 && v['__ts'] is num;
bool isPendingTs(Object? v) => v is Map && v.length == 1 && v['__pts'] is num;
bool isOp(Object? v) => v is Map && v['__op'] is String;
bool isPlainMap(Object? v) => v is Map && !isTs(v) && !isPendingTs(v) && !isOp(v);

String parentOf(String path) {
  final i = path.lastIndexOf('/');
  return i < 0 ? '' : path.substring(0, i);
}

String lastSegment(String path) => path.substring(path.lastIndexOf('/') + 1);

// ------------------------------------------------------------ значения

const _deleteField = Object();

bool sameValue(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  final ta = _tsMillis(a), tb = _tsMillis(b);
  if (ta != null || tb != null) return ta == tb;
  if (a is String || b is String || a is bool || b is bool || a == null || b == null) return a == b;
  return jsonEncode(a) == jsonEncode(b);
}

num? _tsMillis(Object? v) {
  if (isTs(v)) return (v as Map)['__ts'] as num;
  if (isPendingTs(v)) return (v as Map)['__pts'] as num;
  return null;
}

int _rank(Object? v) {
  if (v == null) return 0;
  if (v is bool) return 1;
  if (v is num) return 2;
  if (_tsMillis(v) != null) return 3;
  if (v is String) return 4;
  if (v is List) return 8;
  return 9;
}

/// Порядок значений как в Firestore: null, bool, число, время, строка, массив, словарь.
int compareValues(Object? a, Object? b) {
  final ra = _rank(a), rb = _rank(b);
  if (ra != rb) return ra - rb;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return (a == b) ? 0 : (a == false ? -1 : 1);
    case 2:
      return (a as num).compareTo(b as num);
    case 3:
      return _tsMillis(a)!.compareTo(_tsMillis(b)!);
    case 4:
      return (a as String).compareTo(b as String);
    case 8:
      final x = a as List, y = b as List;
      for (var i = 0; i < x.length && i < y.length; i++) {
        final c = compareValues(x[i], y[i]);
        if (c != 0) return c;
      }
      return x.length - y.length;
    default:
      return jsonEncode(a).compareTo(jsonEncode(b));
  }
}

Object? fieldOf(Object? data, String field) {
  Object? v = data;
  for (final p in field.split('.')) {
    if (v is! Map || isTs(v) || isPendingTs(v)) return null;
    if (!v.containsKey(p)) return _missing;
    v = v[p];
  }
  return v;
}

const _missing = _Missing();

class _Missing {
  const _Missing();
}

bool isMissing(Object? v) => identical(v, _missing);

Object? _applyValue(Object? cur, Object? v, bool merge, int now) {
  if (isOp(v)) {
    final m = v as Map;
    switch (m['__op']) {
      case 'delete':
        return _deleteField;
      case 'serverTimestamp':
        return {'__pts': now};
      case 'increment':
        final n = (m['value'] as num?) ?? 0;
        return (cur is num ? cur : 0) + n;
      case 'arrayUnion':
        final arr = cur is List ? List<Object?>.of(cur) : <Object?>[];
        for (final x in (m['value'] as List? ?? const [])) {
          if (!arr.any((y) => sameValue(x, y))) arr.add(x);
        }
        return arr;
      case 'arrayRemove':
        final items = m['value'] as List? ?? const [];
        return cur is List ? cur.where((y) => !items.any((x) => sameValue(x, y))).toList() : <Object?>[];
    }
    throw ArgumentError('Неизвестная операция ${m['__op']}');
  }
  if (merge && isPlainMap(v) && isPlainMap(cur)) {
    return _mergeInto(Map<String, Object?>.of((cur as Map).cast<String, Object?>()), v as Map, true, now);
  }
  if (isPlainMap(v)) return _mergeInto(<String, Object?>{}, v as Map, false, now);
  if (v is List) return v.map((x) => isOp(x) ? _applyValue(null, x, false, now) : x).toList();
  return v;
}

Map<String, Object?> _mergeInto(Map<String, Object?> target, Map data, bool merge, int now) {
  data.forEach((k, v) {
    final next = _applyValue(target[k], v, merge, now);
    if (identical(next, _deleteField)) {
      target.remove(k);
    } else {
      target[k as String] = next;
    }
  });
  return target;
}

Map<String, Object?> _applyUpdate(Map<String, Object?> target, Map data, int now) {
  data.forEach((key, v) {
    final parts = (key as String).split('.');
    var o = target;
    for (final p in parts.take(parts.length - 1)) {
      final cur = o[p];
      final next = isPlainMap(cur) ? Map<String, Object?>.of((cur as Map).cast<String, Object?>()) : <String, Object?>{};
      o[p] = next;
      o = next;
    }
    final last = parts.last;
    final next = _applyValue(o[last], v, false, now);
    if (identical(next, _deleteField)) {
      o.remove(last);
    } else {
      o[last] = next;
    }
  });
  return target;
}

/// Документ после записи — так же, как считает сервер (local-db computeNext).
Map<String, Object?> computeNext(Map? cur, Map data, {bool merge = false, bool update = false, int? now}) {
  final t = now ?? DateTime.now().millisecondsSinceEpoch;
  final base = cur == null ? <String, Object?>{} : Map<String, Object?>.of(cur.cast<String, Object?>());
  if (update) return _applyUpdate(base, data, t);
  if (merge) return _mergeInto(base, data, true, t);
  return _mergeInto(<String, Object?>{}, data, false, t);
}

// ------------------------------------------------------------ запросы

class QFilter {
  final String field;
  final String op;
  final Object? value;
  const QFilter(this.field, this.op, this.value);
}

class QSpec {
  final String col;
  final bool group;
  final List<QFilter> filters;
  final List<(String, bool)> orders; // поле, по убыванию
  final int? limit;
  final bool limitToLast;

  QSpec({required this.col, this.group = false, this.filters = const [], this.orders = const [], this.limit, this.limitToLast = false});

  QSpec copyWith({List<QFilter>? filters, List<(String, bool)>? orders, int? limit, bool? limitToLast}) => QSpec(
        col: col,
        group: group,
        filters: filters ?? this.filters,
        orders: orders ?? this.orders,
        limit: limit ?? this.limit,
        limitToLast: limitToLast ?? this.limitToLast,
      );

  Map<String, Object?> toWire() => {
        'col': col,
        if (group) 'group': true,
        if (filters.isNotEmpty) 'where': [for (final f in filters) [f.field, f.op, f.value]],
        if (orders.isNotEmpty) 'orderBy': [for (final o in orders) [o.$1, o.$2 ? 'desc' : 'asc']],
        if (limit != null) 'limit': limit,
        if (limitToLast) 'limitToLast': true,
      };

  late final String key = jsonEncode(toWire());

  bool inCollection(String docPath) {
    final parent = parentOf(docPath);
    return group ? lastSegment(parent) == col : parent == col;
  }

  static const _ineq = {'<', '<=', '>', '>=', '!=', 'not-in'};

  List<(String, bool)> get effectiveOrders {
    if (orders.isNotEmpty) return orders;
    for (final f in filters) {
      if (_ineq.contains(f.op)) return [(f.field, false)];
    }
    return const [];
  }

  Object? _val(String path, Map data, String field) => field == '__name__' ? lastSegment(path) : fieldOf(data, field);

  bool matches(String path, Map data) {
    for (final f in filters) {
      final raw = _val(path, data, f.field);
      final has = !isMissing(raw);
      final v = has ? raw : null;
      final ok = switch (f.op) {
        '==' => has && sameValue(v, f.value),
        '!=' => has && v != null && !sameValue(v, f.value),
        '<' => has && v != null && _rank(v) == _rank(f.value) && compareValues(v, f.value) < 0,
        '<=' => has && v != null && _rank(v) == _rank(f.value) && compareValues(v, f.value) <= 0,
        '>' => has && v != null && _rank(v) == _rank(f.value) && compareValues(v, f.value) > 0,
        '>=' => has && v != null && _rank(v) == _rank(f.value) && compareValues(v, f.value) >= 0,
        'in' => f.value is List && (f.value as List).any((x) => sameValue(v, x)),
        'not-in' => has && f.value is List && !(f.value as List).any((x) => sameValue(v, x)),
        'array-contains' => v is List && v.any((x) => sameValue(x, f.value)),
        'array-contains-any' => v is List && f.value is List && v.any((x) => (f.value as List).any((y) => sameValue(x, y))),
        _ => false,
      };
      if (!ok) return false;
    }
    for (final o in effectiveOrders) {
      if (o.$1 != '__name__' && isMissing(fieldOf(data, o.$1))) return false;
    }
    return true;
  }

  int compareDocs(String pa, Map a, String pb, Map b) {
    final orders = effectiveOrders;
    for (final o in orders) {
      var x = _val(pa, a, o.$1), y = _val(pb, b, o.$1);
      if (isMissing(x)) x = null;
      if (isMissing(y)) y = null;
      final c = compareValues(x, y);
      if (c != 0) return o.$2 ? -c : c;
    }
    if (orders.isEmpty) return 0;
    final c = lastSegment(pa).compareTo(lastSegment(pb));
    return orders.last.$2 ? -c : c;
  }

  List<String> applyLimit(List<String> list) {
    final l = limit;
    if (l == null || list.length <= l) return list;
    return limitToLast ? list.sublist(list.length - l) : list.sublist(0, l);
  }
}

// ------------------------------------------------------------ записи

class PendingWrite {
  final String op; // set | update | delete | check
  final String path;
  final Map<String, Object?>? data;
  final bool merge;
  final int? ver;
  const PendingWrite(this.op, this.path, {this.data, this.merge = false, this.ver});

  Map<String, Object?> toWire() => {
        'op': op,
        'path': path,
        if (data != null) 'data': data,
        if (merge) 'merge': true,
        if (op == 'update') 'exists': true,
        if (ver != null) 'ver': ver,
      };

  static PendingWrite fromJson(Map j) => PendingWrite(j['op'] as String, j['path'] as String,
      data: (j['data'] as Map?)?.cast<String, Object?>(), merge: j['merge'] == true, ver: (j['ver'] as num?)?.toInt());
}

class PendingBatch {
  final int id;
  final List<PendingWrite> writes;
  final Completer<void> done = Completer<void>();
  PendingBatch(this.id, this.writes) {
    // Ошибку записи без ожидающего (unawaited) не роняем в зону приложения.
    done.future.catchError((_) {});
  }
}

class CachedDoc {
  final Map<String, Object?>? data; // null — документа нет (известно)
  final int ver;
  int seenAt;
  CachedDoc(this.data, this.ver, this.seenAt);
}

/// Вид документа с учётом своих неподтверждённых записей.
class DocView {
  final Map<String, Object?>? data;
  final bool known; // false — нет ни в кэше, ни в записях
  final bool pending;
  final String stamp;
  const DocView(this.data, this.known, this.pending, this.stamp);
  bool get exists => data != null;
}

class _Offline implements Exception {
  const _Offline();
}

// ------------------------------------------------------------ подписки

typedef SubListener = void Function();

class Sub {
  final String id;
  final String? docPath;
  final QSpec? spec;
  final Set<SubListener> listeners = {};
  List<String>? membership; // порядок документов по данным сервера
  bool synced = false;
  FirebaseException? error;
  Timer? dropTimer;
  bool sentToServer = false;
  Sub(this.id, {this.docPath, this.spec});
  String get key => docPath != null ? 'd:$docPath' : 'q:${spec!.key}';
  Map<String, Object?> toAdd() => docPath != null ? {'id': id, 'doc': docPath} : {'id': id, 'query': spec!.toWire()};
}

// ------------------------------------------------------------ движок

/// Вход пользователя для запросов к серверу (в тестах — подставной).
abstract class EngineAuth {
  String get uid;
  Future<String?> token({bool force = false});
  Stream<String> get uidChanges;
}

class FirebaseEngineAuth implements EngineAuth {
  const FirebaseEngineAuth();
  @override
  String get uid => FirebaseAuth.instance.currentUser?.uid ?? '';
  @override
  Future<String?> token({bool force = false}) async => FirebaseAuth.instance.currentUser?.getIdToken(force);
  @override
  Stream<String> get uidChanges => FirebaseAuth.instance.idTokenChanges().map((u) => u?.uid ?? '');
}

class LocalEngine {
  LocalEngine({required this.baseUrl, required this.storageDir, http.Client? client, this.auth = const FirebaseEngineAuth()})
      : _http = client ?? http.Client();

  final String baseUrl;
  final Directory? storageDir;
  final http.Client _http;
  final EngineAuth auth;

  final Map<String, CachedDoc> docs = {};
  final Map<String, Set<String>> _byCol = {};
  final List<PendingBatch> pending = [];
  final Map<String, Sub> _subs = {};
  final Map<String, Sub> _subsById = {};
  int _nextBatch = 1;
  int _nextSub = 1;

  /// Связь с сервером данных (поток подписок открыт).
  final ValueNotifier<bool> online = ValueNotifier(false);
  DateTime _lastFailure = DateTime.fromMillisecondsSinceEpoch(0);

  static const maxCachedDocs = 30000;

  int get _now => DateTime.now().millisecondsSinceEpoch;

  // ---------------------------------------------------------- диск

  File? _file(String name) => storageDir == null ? null : File('${storageDir!.path}/$name');

  Future<void> load() async {
    try {
      final f = _file('cache.json');
      if (f != null && await f.exists()) {
        final raw = await f.readAsString();
        final j = await compute(_decodeJson, raw);
        final m = (j as Map)['docs'] as Map? ?? const {};
        m.forEach((p, v) {
          final l = v as List;
          _putDoc(p as String, (l[0] as Map?)?.cast<String, Object?>(), (l[1] as num).toInt(), seenAt: (l[2] as num?)?.toInt() ?? 0, notify: false);
        });
      }
    } catch (e) {
      debugPrint('local-db: кэш не прочитан: $e');
    }
    try {
      final f = _file('pending.json');
      if (f != null && await f.exists()) {
        final j = jsonDecode(await f.readAsString()) as List;
        for (final b in j) {
          final writes = [for (final w in (b as Map)['writes'] as List) PendingWrite.fromJson(w as Map)];
          if (writes.isNotEmpty) pending.add(PendingBatch(_nextBatch++, writes));
        }
      }
    } catch (e) {
      debugPrint('local-db: очередь записей не прочитана: $e');
    }
  }

  static Object? _decodeJson(String s) => jsonDecode(s);

  Timer? _cacheSaveTimer;
  bool _pendingSaveQueued = false;

  void _scheduleCacheSave() {
    if (storageDir == null) return;
    _cacheSaveTimer ??= Timer(const Duration(seconds: 3), () {
      _cacheSaveTimer = null;
      unawaited(_saveCache());
    });
  }

  final Map<String, Future<void>> _writeChains = {};

  /// Запись файла целиком через временный; записи одного файла — по очереди.
  Future<void> _writeAtomic(String name, String Function() content) {
    final f = _file(name);
    if (f == null) return Future.value();
    final next = (_writeChains[name] ?? Future<void>.value()).then((_) async {
      await f.parent.create(recursive: true);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(content(), flush: true);
      await tmp.rename(f.path);
    });
    _writeChains[name] = next.catchError((_) {});
    return next;
  }

  Future<void> _saveCache() async {
    try {
      _evict();
      await _writeAtomic('cache.json', () {
        final out = <String, Object?>{};
        docs.forEach((p, d) => out[p] = [d.data, d.ver, d.seenAt]);
        return jsonEncode({'v': 1, 'docs': out});
      });
    } catch (e) {
      debugPrint('local-db: кэш не сохранён: $e');
    }
  }

  void _savePending() {
    if (storageDir == null || _pendingSaveQueued) return;
    _pendingSaveQueued = true;
    scheduleMicrotask(() async {
      _pendingSaveQueued = false;
      try {
        await _writeAtomic('pending.json', () => jsonEncode([
              for (final b in pending) {'writes': [for (final w in b.writes) w.toWire()]}
            ]));
      } catch (e) {
        debugPrint('local-db: очередь записей не сохранена: $e');
      }
    });
  }

  /// Сохранить всё сразу (приложение уходит в фон или закрывается).
  Future<void> flushToDisk() async {
    _cacheSaveTimer?.cancel();
    _cacheSaveTimer = null;
    await _saveCache();
  }

  void _evict() {
    if (docs.length <= maxCachedDocs) return;
    final keep = <String>{
      for (final b in pending) for (final w in b.writes) w.path,
      for (final s in _subs.values) ...?s.membership,
      for (final s in _subs.values) if (s.docPath != null) s.docPath!,
    };
    final list = docs.entries.where((e) => !keep.contains(e.key)).toList()..sort((a, b) => a.value.seenAt - b.value.seenAt);
    final drop = docs.length - (maxCachedDocs * 0.8).round();
    for (final e in list.take(max(0, drop))) {
      _dropDoc(e.key, notify: false);
    }
  }

  // ---------------------------------------------------------- кэш

  void _putDoc(String path, Map<String, Object?>? data, int ver, {int? seenAt, bool notify = true, bool force = false}) {
    final cur = docs[path];
    if (cur != null && !force && cur.ver > ver) return;
    docs[path] = CachedDoc(data, ver, seenAt ?? _now ~/ 1000);
    (_byCol[parentOf(path)] ??= <String>{}).add(path);
    if (notify) _changed(path);
    _scheduleCacheSave();
  }

  void _dropDoc(String path, {bool notify = true}) {
    if (docs.remove(path) == null) return;
    _byCol[parentOf(path)]?.remove(path);
    if (notify) _changed(path);
    _scheduleCacheSave();
  }

  bool _hasPending(String path) => pending.any((b) => b.writes.any((w) => w.path == path && w.op != 'check'));

  DocView view(String path) {
    final base = docs[path];
    var known = base != null;
    Map<String, Object?>? data = base?.data;
    var stamp = '${base?.ver ?? -1}';
    var hasPending = false;
    for (final b in pending) {
      for (final w in b.writes) {
        if (w.path != path || w.op == 'check') continue;
        hasPending = true;
        stamp = '$stamp+${b.id}';
        switch (w.op) {
          case 'delete':
            data = null;
            known = true;
          case 'set':
            data = computeNext(w.merge ? data : null, w.data ?? const {}, merge: w.merge);
            known = true;
          case 'update':
            if (known && data != null) data = computeNext(data, w.data ?? const {}, update: true);
        }
      }
    }
    return DocView(data, known, hasPending, stamp);
  }

  Iterable<String> _pendingPathsWhere(bool Function(String) test) sync* {
    final seen = <String>{};
    for (final b in pending) {
      for (final w in b.writes) {
        if (w.op != 'check' && test(w.path) && seen.add(w.path)) yield w.path;
      }
    }
  }

  Iterable<String> _cachedIn(QSpec q) sync* {
    if (!q.group) {
      yield* (_byCol[q.col] ?? const <String>{});
      return;
    }
    for (final e in _byCol.entries) {
      if (lastSegment(e.key) == q.col) yield* e.value;
    }
  }

  /// Документы запроса: по данным сервера (membership) или по кэшу, плюс
  /// свои неподтверждённые записи.
  List<String> evalQuery(QSpec q, List<String>? membership) {
    final pendingPaths = _pendingPathsWhere(q.inCollection).toSet();
    final out = <String>[];
    var touched = false;
    if (membership != null) {
      for (final p in membership) {
        if (pendingPaths.contains(p)) {
          touched = true;
          final v = view(p);
          if (v.data != null && q.matches(p, v.data!)) out.add(p);
        } else if (docs[p]?.data != null) {
          out.add(p);
        }
      }
      final inList = membership.toSet();
      for (final p in pendingPaths) {
        if (inList.contains(p)) continue;
        final v = view(p);
        if (v.data != null && q.matches(p, v.data!)) {
          out.add(p);
          touched = true;
        }
      }
      if (!touched) return out;
    } else {
      final all = <String>{..._cachedIn(q), ...pendingPaths};
      for (final p in all) {
        final v = view(p);
        if (v.data != null && q.matches(p, v.data!)) out.add(p);
      }
    }
    if (q.effectiveOrders.isNotEmpty) {
      final data = {for (final p in out) p: view(p).data!};
      final indexed = out.asMap().entries.toList()
        ..sort((a, b) {
          final c = q.compareDocs(a.value, data[a.value]!, b.value, data[b.value]!);
          return c != 0 ? c : a.key - b.key;
        });
      return q.applyLimit([for (final e in indexed) e.value]);
    }
    return q.applyLimit(out);
  }

  // ---------------------------------------------------------- уведомления

  final Set<Sub> _dirty = {};
  bool _flushQueued = false;

  void _changed(String path) {
    for (final s in _subs.values) {
      if (s.docPath != null ? s.docPath == path : s.spec!.inCollection(path)) _dirty.add(s);
    }
    _queueNotify();
  }

  void _queueNotify() {
    if (_flushQueued || _dirty.isEmpty) return;
    _flushQueued = true;
    scheduleMicrotask(() {
      _flushQueued = false;
      final list = _dirty.toList();
      _dirty.clear();
      for (final s in list) {
        for (final l in s.listeners.toList()) {
          l();
        }
      }
    });
  }

  void _notifySub(Sub s) {
    _dirty.add(s);
    _queueNotify();
  }

  // ---------------------------------------------------------- сеть

  Future<Map<String, String>> _headers({bool forceToken = false}) async {
    final h = {'Content-Type': 'application/json'};
    final token = await auth.token(force: forceToken);
    if (token != null) h['Authorization'] = 'Bearer $token';
    return h;
  }

  /// Недавно не было связи — не ждём таймаута (как Firestore без сети).
  bool get knownOffline => !online.value && DateTime.now().difference(_lastFailure) < const Duration(seconds: 20);

  Future<Map<String, dynamic>> post(String route, Map<String, Object?> body, {Duration timeout = const Duration(seconds: 20)}) async {
    http.Response resp;
    try {
      resp = await _http.post(Uri.parse('$baseUrl$route'), headers: await _headers(), body: jsonEncode(body)).timeout(timeout);
    } on FirebaseAuthException {
      _lastFailure = DateTime.now();
      throw const _Offline();
    } catch (e) {
      if (e is FirebaseException) rethrow;
      _lastFailure = DateTime.now();
      throw const _Offline();
    }
    Map<String, dynamic> j;
    try {
      j = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      if (resp.statusCode == 413) throw dbError('payload-too-large', 'Слишком большая пачка записей');
      if (resp.statusCode >= 500 || resp.statusCode == 0) {
        _lastFailure = DateTime.now();
        throw const _Offline();
      }
      throw dbError('internal', 'Сервер ответил ошибкой ${resp.statusCode}');
    }
    if (resp.statusCode == 200) return j;
    final code = (j['code'] ?? '').toString();
    final msg = (j['error'] ?? 'Сервер ответил ошибкой ${resp.statusCode}').toString();
    if (resp.statusCode == 401) throw dbError('unauthenticated', msg);
    if (resp.statusCode == 413) throw dbError('payload-too-large', msg);
    if (code.isNotEmpty && code != 'unavailable' && code != 'internal') throw dbError(code, msg);
    if (resp.statusCode >= 500 || code == 'unavailable') {
      _lastFailure = DateTime.now();
      throw const _Offline();
    }
    throw dbError(resp.statusCode == 403 ? 'permission-denied' : 'internal', msg);
  }

  void _absorbDocs(List docsJson) {
    for (final d in docsJson) {
      final m = d as Map;
      final path = m['path'] as String;
      final ver = (m['ver'] as num?)?.toInt() ?? 0;
      if (m['exists'] == true) {
        _putDoc(path, (m['data'] as Map).cast<String, Object?>(), ver);
      } else {
        _putDoc(path, null, ver);
      }
    }
  }

  // ---------------------------------------------------------- чтение

  Sub? _syncedDocSub(String path) {
    final s = _subs['d:$path'];
    return s != null && s.synced && s.error == null && online.value ? s : null;
  }

  /// Документ. source: 'default' | 'server' | 'cache'.
  Future<(DocView, bool fromCache)> getDoc(String path, String source) async {
    if (source == 'cache') return (_cachedDocOrThrow(path), true);
    if (source == 'default' && _syncedDocSub(path) != null) return (view(path), false);
    if (source == 'default' && knownOffline) return (_cachedDocOrThrow(path), true);
    try {
      final j = await post('/db/get', {'paths': [path]}, timeout: const Duration(seconds: 12));
      _absorbDocs(j['docs'] as List);
      return (view(path), false);
    } on _Offline {
      if (source == 'server') throw dbError('unavailable', 'Нет связи с сервером');
      return (_cachedDocOrThrow(path), true);
    }
  }

  DocView _cachedDocOrThrow(String path) {
    final v = view(path);
    if (!v.known) throw dbError('unavailable', 'Документа нет в памяти устройства, а связи с сервером нет');
    return v;
  }

  Future<(List<String>, bool fromCache)> getQuery(QSpec q, String source) async {
    if (source == 'cache') return (evalQuery(q, null), true);
    final live = _subs['q:${q.key}'];
    if (source == 'default' && live != null && live.synced && live.error == null && online.value) {
      return (evalQuery(q, live.membership), false);
    }
    if (source == 'default' && knownOffline) return (evalQuery(q, live?.membership), true);
    try {
      final j = await post('/db/query', {'query': q.toWire()});
      final list = j['docs'] as List;
      _absorbDocs(list);
      return (evalQuery(q, [for (final d in list) (d as Map)['path'] as String]), false);
    } on _Offline {
      if (source == 'server') throw dbError('unavailable', 'Нет связи с сервером');
      return (evalQuery(q, live?.membership), true);
    }
  }

  // ---------------------------------------------------------- запись

  /// Пачка записей: сразу видна на устройстве, на сервер уходит по очереди.
  Future<void> enqueue(List<PendingWrite> writes) {
    if (writes.isEmpty) return Future.value();
    final b = PendingBatch(_nextBatch++, writes);
    pending.add(b);
    _savePending();
    for (final w in writes) {
      _changed(w.path);
    }
    _kickFlush();
    return b.done.future;
  }

  bool _flushing = false;
  Timer? _retryTimer;
  int _retryDelay = 1;

  void _kickFlush() {
    if (_flushing) return;
    _retryTimer?.cancel();
    _retryTimer = null;
    unawaited(_flush());
  }

  Future<void> _flush() async {
    if (_flushing) return;
    _flushing = true;
    try {
      while (pending.isNotEmpty) {
        final b = pending.first;
        try {
          final j = await post('/db/commit', {'writes': [for (final w in b.writes) w.toWire()]});
          _applyAck(b.writes, j['results'] as List? ?? const []);
          pending.remove(b);
          _savePending();
          for (final w in b.writes) {
            _changed(w.path);
          }
          _retryDelay = 1;
          if (!b.done.isCompleted) b.done.complete();
        } on _Offline {
          _retryTimer = Timer(Duration(seconds: _retryDelay), _kickFlush);
          _retryDelay = min(_retryDelay * 2, 15);
          return;
        } on FirebaseException catch (e) {
          if (e.code == 'unauthenticated') {
            // Токен обновится — попробуем ещё раз чуть позже.
            try {
              await _headers(forceToken: true);
            } catch (_) {}
            _retryTimer = Timer(Duration(seconds: _retryDelay), _kickFlush);
            _retryDelay = min(_retryDelay * 2, 30);
            return;
          }
          if (e.code == 'payload-too-large' && b.writes.length > 1) {
            // Пачка больше, чем пропускает сервер, — отправим двумя половинами.
            final half = b.writes.length ~/ 2;
            final b1 = PendingBatch(b.id, b.writes.sublist(0, half));
            final b2 = PendingBatch(b.id, b.writes.sublist(half));
            pending.replaceRange(0, 1, [b1, b2]);
            Future.wait([b1.done.future, b2.done.future]).then((_) {
              if (!b.done.isCompleted) b.done.complete();
            }, onError: (Object err) {
              if (!b.done.isCompleted) b.done.completeError(err);
            });
            _savePending();
            continue;
          }
          // Отказ сервера (права, нет документа): запись снимается, как в Firestore.
          debugPrint('local-db: запись отклонена: ${e.code} ${e.message}');
          pending.remove(b);
          _savePending();
          for (final w in b.writes) {
            _changed(w.path);
          }
          if (!b.done.isCompleted) b.done.completeError(e);
        }
      }
      _drainWaiters();
    } finally {
      _flushing = false;
    }
  }

  /// Подтверждённая запись — в кэш (подписка позже пришлёт точные данные).
  void _applyAck(List<PendingWrite> writes, List results) {
    final vers = <String, int>{for (final r in results) (r as Map)['path'] as String: (r['ver'] as num?)?.toInt() ?? 0};
    final now = _now;
    for (final w in writes) {
      if (w.op == 'check') continue;
      final ver = vers[w.path] ?? 0;
      final cur = docs[w.path];
      if (cur != null && cur.ver >= ver && ver != 0) continue;
      if (w.op == 'delete') {
        _putDoc(w.path, null, ver, notify: false, force: true);
      } else if (w.op == 'set' && !w.merge) {
        _putDoc(w.path, _resolvePts(computeNext(null, w.data!, now: now)), ver, notify: false, force: true);
      } else if (cur?.data != null) {
        _putDoc(w.path, _resolvePts(computeNext(cur!.data, w.data!, merge: w.merge, update: w.op == 'update', now: now)), ver,
            notify: false, force: true);
      } else if (w.op == 'set') {
        _putDoc(w.path, _resolvePts(computeNext(null, w.data!, merge: true, now: now)), ver, notify: false, force: true);
      } else {
        // Обновили документ, которого нет в памяти: пусть прочитается заново.
        _dropDoc(w.path, notify: false);
      }
    }
  }

  static Map<String, Object?> _resolvePts(Map<String, Object?> m) => (_resolvePtsValue(m) as Map).cast<String, Object?>();

  static Object? _resolvePtsValue(Object? v) {
    if (isPendingTs(v)) return {'__ts': (v as Map)['__pts']};
    if (v is List) return v.map(_resolvePtsValue).toList();
    if (v is Map) return v.map((k, x) => MapEntry(k, _resolvePtsValue(x)));
    return v;
  }

  final List<(int, Completer<void>)> _waiters = [];

  Future<void> waitForPendingWrites() {
    if (pending.isEmpty) return Future.value();
    final c = Completer<void>();
    _waiters.add((pending.last.id, c));
    return c.future;
  }

  void _drainWaiters() {
    final minPending = pending.isEmpty ? 1 << 62 : pending.first.id;
    _waiters.removeWhere((w) {
      if (w.$1 < minPending) {
        if (!w.$2.isCompleted) w.$2.complete();
        return true;
      }
      return false;
    });
  }

  // ---------------------------------------------------------- транзакции

  /// Чтение внутри транзакции — всегда с сервера (с версией для сверки).
  Future<(DocView, int ver)> txGet(String path) async {
    if (knownOffline) throw dbError('unavailable', 'Нет связи с сервером');
    try {
      final j = await post('/db/get', {'paths': [path]}, timeout: const Duration(seconds: 10));
      final d = (j['docs'] as List).first as Map;
      _absorbDocs([d]);
      final ver = (d['ver'] as num?)?.toInt() ?? 0;
      final data = d['exists'] == true ? (d['data'] as Map).cast<String, Object?>() : null;
      return (DocView(data, true, false, '$ver'), d['exists'] == true ? ver : 0);
    } on _Offline {
      throw dbError('unavailable', 'Нет связи с сервером');
    }
  }

  /// Перед транзакцией — отправить свои записи из очереди (иначе транзакция
  /// прочитает данные без них).
  Future<void> drainBeforeTransaction() async {
    if (pending.isEmpty) return;
    if (knownOffline) throw dbError('unavailable', 'Нет связи с сервером');
    _kickFlush();
    await waitForPendingWrites().timeout(const Duration(seconds: 10), onTimeout: () {
      throw dbError('unavailable', 'Нет связи с сервером');
    });
  }

  Future<void> commitTransaction(List<PendingWrite> writes) async {
    try {
      final j = await post('/db/commit', {'writes': [for (final w in writes) w.toWire()]});
      _applyAck(writes, j['results'] as List? ?? const []);
      for (final w in writes) {
        _changed(w.path);
      }
    } on _Offline {
      throw dbError('unavailable', 'Нет связи с сервером');
    }
  }

  // ---------------------------------------------------------- подписки

  Sub listen({String? docPath, QSpec? spec, required SubListener onChange}) {
    final key = docPath != null ? 'd:$docPath' : 'q:${spec!.key}';
    var s = _subs[key];
    if (s == null) {
      s = Sub('s${_nextSub++}', docPath: docPath, spec: spec);
      _subs[key] = s;
      _subsById[s.id] = s;
      _sendSubs(add: [s]);
    }
    s.dropTimer?.cancel();
    s.dropTimer = null;
    s.listeners.add(onChange);
    _ensureStream();
    return s;
  }

  void unlisten(Sub s, SubListener l) {
    s.listeners.remove(l);
    if (s.listeners.isNotEmpty) return;
    // Экран перестроился — подписка вернётся через мгновение; не дёргаем сервер.
    s.dropTimer?.cancel();
    s.dropTimer = Timer(const Duration(seconds: 5), () {
      if (s.listeners.isNotEmpty) return;
      _subs.remove(s.key);
      _subsById.remove(s.id);
      if (s.sentToServer) _sendSubs(remove: [s.id]);
    });
  }

  String? _sid;
  String? _sidUid;
  http.Client? _streamClient;
  StreamSubscription<String>? _streamSub;
  bool _connecting = false;
  int _streamRetry = 1;
  Timer? _reconnectTimer;
  Timer? _watchdog;
  Timer? _refreshTimer;
  StreamSubscription<String>? _authSub;

  void start() {
    _authSub ??= auth.uidChanges.listen((uid) {
      if (_sidUid != null && uid != _sidUid) {
        // Другой вход — новая сессия с его правами.
        _sid = null;
        _restartStream();
      }
    });
    if (pending.isNotEmpty) _kickFlush();
  }

  void _ensureStream() {
    if (_streamSub != null || _connecting || _subs.isEmpty) return;
    unawaited(_connect());
  }

  void _restartStream() {
    _closeStream();
    online.value = false;
    for (final s in _subs.values) {
      s.sentToServer = false;
      s.synced = false;
    }
    _ensureStream();
  }

  void _closeStream() {
    _streamSub?.cancel();
    _streamSub = null;
    _streamClient?.close();
    _streamClient = null;
    _watchdog?.cancel();
  }

  Future<void> _openSession() async {
    final uid = auth.uid;
    final j = await post('/db/session', {if (_sid != null && _sidUid == uid) 'sid': _sid});
    final sid = j['sid'] as String;
    if (sid != _sid) {
      for (final s in _subs.values) {
        s.sentToServer = false;
      }
    }
    _sid = sid;
    _sidUid = uid;
    final exp = (j['expiresAt'] as num?)?.toInt();
    _refreshTimer?.cancel();
    if (exp != null) {
      final wait = Duration(milliseconds: max(60000, exp - _now - 4 * 60 * 1000));
      _refreshTimer = Timer(wait, () async {
        try {
          await _headers(forceToken: true);
          await _openSession();
        } catch (_) {
          _restartStream();
        }
      });
    }
  }

  Future<void> _connect() async {
    _connecting = true;
    try {
      await _openSession();
      final client = http.Client();
      final req = http.Request('GET', Uri.parse('$baseUrl/db/listen?sid=$_sid'))
        ..headers['Accept'] = 'text/event-stream'
        ..headers['Cache-Control'] = 'no-cache';
      final resp = await client.send(req).timeout(const Duration(seconds: 20));
      if (resp.statusCode != 200) {
        client.close();
        if (resp.statusCode == 404) _sid = null;
        throw const _Offline();
      }
      _streamClient = client;
      var buf = StringBuffer();
      _armWatchdog();
      _streamSub = resp.stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        _armWatchdog();
        if (line.isEmpty) {
          final s = buf.toString();
          buf = StringBuffer();
          if (s.isNotEmpty) _onEvent(s);
        } else if (line.startsWith('data:')) {
          buf.write(line.substring(5).trimLeft());
        }
      }, onError: (_) => _onStreamDown(), onDone: _onStreamDown, cancelOnError: true);
      online.value = true;
      _streamRetry = 1;
      final toAdd = _subs.values.where((s) => !s.sentToServer).toList();
      if (toAdd.isNotEmpty) _sendSubs(add: toAdd);
      _kickFlush();
    } catch (e) {
      _lastFailure = DateTime.now();
      online.value = false;
      _closeStream();
      _scheduleReconnect();
    } finally {
      _connecting = false;
    }
  }

  void _armWatchdog() {
    _watchdog?.cancel();
    _watchdog = Timer(const Duration(seconds: 50), _onStreamDown);
  }

  void _onStreamDown() {
    if (_streamSub == null) return;
    _closeStream();
    online.value = false;
    _lastFailure = DateTime.now();
    for (final s in _subs.values) {
      if (s.synced) {
        s.synced = false;
        _notifySub(s);
      }
    }
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    if (_subs.isEmpty) return;
    _reconnectTimer = Timer(Duration(seconds: _streamRetry), _ensureStream);
    _streamRetry = min(_streamRetry * 2, 15);
  }

  /// Приложение снова на экране / появилась сеть — подключиться сразу.
  void reconnectNow() {
    if (_streamSub != null) return;
    _streamRetry = 1;
    _reconnectTimer?.cancel();
    _ensureStream();
    if (pending.isNotEmpty) _kickFlush();
  }

  void _sendSubs({List<Sub> add = const [], List<String> remove = const []}) {
    if (_sid == null || _streamSub == null) return; // при подключении отправятся все
    final adding = add.where((s) => !s.sentToServer).toList();
    for (final s in adding) {
      s.sentToServer = true;
    }
    if (adding.isEmpty && remove.isEmpty) return;
    unawaited(() async {
      try {
        final j = await post('/db/listen', {'sid': _sid, 'add': [for (final s in adding) s.toAdd()], 'remove': remove});
        for (final e in (j['errors'] as List? ?? const [])) {
          final s = _subsById[(e as Map)['id']];
          if (s != null) _subError(s, (e['code'] ?? 'internal').toString(), (e['error'] ?? '').toString());
        }
      } on FirebaseException catch (e) {
        if (e.code == 'not-found') {
          _sid = null;
          _restartStream();
        } else {
          for (final s in adding) {
            _subError(s, e.code, e.message ?? '');
          }
        }
      } catch (_) {
        for (final s in adding) {
          s.sentToServer = false;
        }
        _onStreamDown();
      }
    }());
  }

  void _subError(Sub s, String code, String message) {
    if (code == 'unauthenticated') {
      // Истёк токен — обновить сессию и подписаться заново.
      s.sentToServer = false;
      unawaited(() async {
        try {
          await _headers(forceToken: true);
          await _openSession();
          _sendSubs(add: [s]);
        } catch (_) {
          _onStreamDown();
        }
      }());
      return;
    }
    s.error = dbError(code, message);
    _notifySub(s);
  }

  void _onEvent(String raw) {
    Map j;
    try {
      j = jsonDecode(raw) as Map;
    } catch (_) {
      return;
    }
    final s = _subsById[j['sub']];
    if (s == null) return;
    if (j['error'] != null) {
      s.sentToServer = false;
      _subError(s, (j['code'] ?? 'internal').toString(), j['error'].toString());
      return;
    }
    final list = j['docs'] as List? ?? const [];
    _absorbDocs(list);
    final removes = [for (final p in (j['removes'] as List? ?? const [])) p as String];
    if (s.docPath != null) {
      if (j['exists'] == false) _putDoc(s.docPath!, null, docs[s.docPath!]?.ver ?? 0, force: true);
    } else {
      final order = j['order'] as List?;
      if (order != null) {
        s.membership = [for (final p in order) p as String];
      } else if (removes.isNotEmpty) {
        s.membership = s.membership?.where((p) => !removes.contains(p)).toList();
      }
      // Ушёл из выборки — данные в памяти могли устареть: забываем документ
      // (если он не нужен другим подпискам).
      for (final p in removes) {
        final usedElsewhere = _subs.values.any((o) => o != s && (o.docPath == p || (o.membership?.contains(p) ?? false)));
        if (!usedElsewhere && !_hasPending(p)) _dropDoc(p);
      }
    }
    if (j['initial'] == true || !s.synced) s.synced = true;
    _notifySub(s);
  }

  void dispose() {
    _closeStream();
    _authSub?.cancel();
    _refreshTimer?.cancel();
    _reconnectTimer?.cancel();
    _retryTimer?.cancel();
  }

  static String autoId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    final r = Random.secure();
    return String.fromCharCodes(Iterable.generate(20, (_) => chars.codeUnitAt(r.nextInt(chars.length))));
  }
}
