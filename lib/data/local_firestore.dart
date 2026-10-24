// ignore_for_file: subtype_of_sealed_class

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart'
    show FieldValueFactoryPlatform, FieldValuePlatform;
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show debugPrint;

import 'local_engine.dart';

// Те же классы, что у cloud_firestore (FirebaseFirestore, DocumentReference,
// Query, снимки, пачки, транзакции), но данные — на своём сервере через
// [LocalEngine]. Код приложения не меняется: он получает эти объекты вместо
// объектов Firestore из AppDb.instance.

// ------------------------------------------------------------ FieldValue

/// Запоминает, что означает каждый FieldValue: сам объект Firestore наружу
/// не говорит, увеличение это или метка времени сервера.
class FieldValueRecorder extends FieldValueFactoryPlatform {
  FieldValueRecorder(this._orig);
  final FieldValueFactoryPlatform _orig;
  static final _ops = Expando<Map<String, Object?>>('fieldValueOp');
  static bool _installed = false;

  /// До первого FieldValue.* в приложении (вызывается из AppDb.init).
  static void install() {
    if (_installed) return;
    _installed = true;
    FieldValueFactoryPlatform.instance = FieldValueRecorder(FieldValueFactoryPlatform.instance);
  }

  static Map<String, Object?>? opOf(FieldValue v) {
    final d = FieldValuePlatform.getDelegate(v);
    return d == null ? null : _ops[d as Object];
  }

  dynamic _rec(dynamic d, Map<String, Object?> op) {
    _ops[d as Object] = op;
    return d;
  }

  @override
  dynamic arrayRemove(List<dynamic> elements) => _rec(_orig.arrayRemove(elements), {'__op': 'arrayRemove', 'value': elements});
  @override
  dynamic arrayUnion(List<dynamic> elements) => _rec(_orig.arrayUnion(elements), {'__op': 'arrayUnion', 'value': elements});
  @override
  dynamic delete() => _rec(_orig.delete(), {'__op': 'delete'});
  @override
  dynamic increment(num value) => _rec(_orig.increment(value), {'__op': 'increment', 'value': value});
  @override
  dynamic serverTimestamp() => _rec(_orig.serverTimestamp(), {'__op': 'serverTimestamp'});
}

/// Значение приложения → сетевой вид.
Object? toWire(Object? v) {
  if (v == null || v is String || v is bool || v is num) return v;
  if (v is Timestamp) return {'__ts': v.millisecondsSinceEpoch};
  if (v is DateTime) return {'__ts': v.millisecondsSinceEpoch};
  if (v is FieldValue) {
    final op = FieldValueRecorder.opOf(v);
    if (op == null) throw StateError('FieldValue создан до запуска хранилища (AppDb.init)');
    final value = op['value'];
    return {'__op': op['__op'], if (value != null) 'value': value is List ? value.map(toWire).toList() : value};
  }
  if (v is List) return v.map(toWire).toList();
  if (v is Map) return {for (final e in v.entries) e.key.toString(): toWire(e.value)};
  if (v is DocumentReference) return v.path;
  if (v is FieldPath) return v.components.join('.');
  // Вложенные значения внутри arrayUnion уже переведены Firestore в свой вид.
  if (v is FieldValuePlatform) throw ArgumentError('FieldValue внутри массива не поддерживается');
  throw ArgumentError('Значение ${v.runtimeType} не поддерживается хранилищем');
}

Map<String, Object?> _wireMap(Map data) => (toWire(data) as Map).cast<String, Object?>();

/// Сетевой вид → значение приложения (метки времени — Timestamp).
Object? fromWire(Object? v) {
  if (v is Map) {
    if (isTs(v)) return Timestamp.fromMillisecondsSinceEpoch(((v['__ts'] as num)).toInt());
    if (isPendingTs(v)) return null; // как Firestore: время сервера ещё неизвестно
    return <String, dynamic>{for (final e in v.entries) e.key as String: fromWire(e.value)};
  }
  if (v is List) return <dynamic>[for (final x in v) fromWire(x)];
  return v;
}

String _fieldName(Object field) {
  if (field is String) return field;
  if (field is FieldPath) return field.components.join('.');
  if (field == FieldPath.documentId) return '__name__';
  throw ArgumentError('Поле запроса: $field');
}

String _norm(String p) => p.replaceAll(RegExp(r'^/+|/+$'), '');

// ------------------------------------------------------------ база

class LocalFirestore implements FirebaseFirestore {
  LocalFirestore(this.engine);
  final LocalEngine engine;

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    final p = _norm(collectionPath);
    if (p.isEmpty || p.split('/').length.isEven) throw ArgumentError('Неверный путь коллекции: $collectionPath');
    return LocalCollectionRef(this, p);
  }

  @override
  DocumentReference<Map<String, dynamic>> doc(String documentPath) {
    final p = _norm(documentPath);
    if (p.isEmpty || p.split('/').length.isOdd) throw ArgumentError('Неверный путь документа: $documentPath');
    return LocalDocRef(this, p);
  }

  @override
  Query<Map<String, dynamic>> collectionGroup(String collectionPath) => LocalQuery(this, QSpec(col: collectionPath, group: true));

  @override
  WriteBatch batch() => LocalWriteBatch(this);

  @override
  Future<T> runTransaction<T>(TransactionHandler<T> transactionHandler,
      {Duration timeout = const Duration(seconds: 30), int maxAttempts = 5}) async {
    try {
      await engine.drainBeforeTransaction();
      return await _onlineAttempts(transactionHandler, timeout, maxAttempts);
    } on TxOfflineSignal {
      return _offline(transactionHandler, timeout, maxAttempts);
    } on _TxOffline {
      return _offline(transactionHandler, timeout, maxAttempts);
    }
  }

  /// Транзакция на сервере: чтения с версиями, запись со сверкой; кто-то
  /// успел изменить прочитанное — повтор. Связи нет ещё до записи — [_TxOffline].
  Future<T> _onlineAttempts<T>(TransactionHandler<T> handler, Duration timeout, int maxAttempts) async {
    FirebaseException? last;
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      final tx = LocalTransaction(this);
      final T result;
      try {
        result = await handler(tx).timeout(timeout);
      } on FirebaseException catch (e) {
        if (e.code == 'unavailable' && tx.offlineRead) throw const _TxOffline();
        rethrow;
      }
      final writes = tx.buildWrites();
      if (writes.isEmpty) return result;
      try {
        await engine.commitTransaction(writes);
        return result;
      } on FirebaseException catch (e) {
        if (e.code != 'aborted') rethrow;
        last = e;
        await Future<void>.delayed(Duration(milliseconds: 50 * (attempt + 1)));
      }
    }
    throw last ?? dbError('aborted', 'Транзакция не удалась');
  }

  /// Без интернета: транзакция по данным на устройстве, записи — в очередь
  /// со сверкой версий. Когда связь вернётся и окажется, что другое
  /// устройство успело изменить прочитанное, транзакция выполнится заново
  /// уже по данным сервера (пока приложение не перезапускали; после
  /// перезапуска — побеждает последняя запись).
  Future<T> _offline<T>(TransactionHandler<T> handler, Duration timeout, int maxAttempts) async {
    final tx = LocalTransaction(this, offline: true);
    final result = await handler(tx).timeout(timeout);
    final writes = tx.buildWrites();
    if (writes.isNotEmpty) {
      Future<void> retry() async {
        try {
          await _onlineAttempts(handler, timeout, maxAttempts);
        } on _TxOffline {
          throw const TxOfflineSignal();
        }
      }
      unawaited(engine.enqueue(writes, retry: retry).catchError((Object e) {
        debugPrint('local-db: отложенная транзакция не прошла: $e');
      }));
    }
    return result;
  }

  @override
  Future<void> waitForPendingWrites() => engine.waitForPendingWrites();

  @override
  FirebaseApp get app => Firebase.app();

  @override
  Settings get settings => const Settings(persistenceEnabled: true);

  @override
  set settings(Settings settings) {}

  @override
  Future<void> enableNetwork() async => engine.reconnectNow();

  @override
  Future<void> disableNetwork() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('Хранилище на сервере: ${invocation.memberName} не поддерживается');
}

// ------------------------------------------------------------ ссылки

class LocalDocRef implements DocumentReference<Map<String, dynamic>> {
  LocalDocRef(this.db, this.path);
  final LocalFirestore db;
  @override
  final String path;

  LocalEngine get _e => db.engine;

  @override
  FirebaseFirestore get firestore => db;

  @override
  String get id => lastSegment(path);

  @override
  CollectionReference<Map<String, dynamic>> get parent => LocalCollectionRef(db, parentOf(path));

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) => db.collection('$path/${_norm(collectionPath)}');

  @override
  Future<void> delete() => _e.enqueue([PendingWrite('delete', path)]);

  @override
  Future<void> update(Map<Object, Object?> data) =>
      _e.enqueue([PendingWrite('update', path, data: _wireMap({for (final e in data.entries) _fieldName(e.key): e.value}))]);

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) =>
      _e.enqueue([PendingWrite('set', path, data: _wireMap(data), merge: options?.merge == true)]);

  @override
  Future<DocumentSnapshot<Map<String, dynamic>>> get([GetOptions? options]) async {
    final source = switch (options?.source) { Source.cache => 'cache', Source.server => 'server', _ => 'default' };
    final (v, fromCache) = await _e.getDoc(path, source);
    return LocalDocSnap(this, v, fromCache);
  }

  @override
  Stream<DocumentSnapshot<Map<String, dynamic>>> snapshots(
      {bool includeMetadataChanges = false, ListenSource source = ListenSource.defaultSource}) {
    return Stream.multi((c) {
      String? lastStamp;
      bool? lastFromCache;
      late Sub sub;
      Timer? cacheTimer;
      var closed = false;
      void emit({bool fromTimer = false}) {
        if (closed) return;
        final err = sub.error;
        if (err != null) {
          closed = true;
          c.addError(err);
          c.close();
          return;
        }
        final v = _e.view(path);
        final fromCache = !sub.synced;
        // Из памяти — только если документ там есть (или уже ждали сервер).
        if (fromCache && !v.known && !fromTimer && lastStamp == null) return;
        final stamp = '${v.stamp}|${v.exists}';
        if (lastStamp != null) {
          final syncFlip = lastFromCache == true && !fromCache;
          final metaChanged = includeMetadataChanges && lastFromCache != fromCache;
          if (stamp == lastStamp && !syncFlip && !metaChanged) return;
        }
        lastStamp = stamp;
        lastFromCache = fromCache;
        c.add(LocalDocSnap(this, v, fromCache));
      }

      sub = _e.listen(docPath: path, onChange: emit);
      scheduleMicrotask(emit);
      cacheTimer = Timer(Duration(milliseconds: _e.online.value ? 2500 : 300), () => emit(fromTimer: true));
      c.onCancel = () {
        closed = true;
        cacheTimer?.cancel();
        _e.unlisten(sub, emit);
      };
    });
  }

  @override
  DocumentReference<R> withConverter<R>({required FromFirestore<R> fromFirestore, required ToFirestore<R> toFirestore}) =>
      throw UnsupportedError('withConverter не поддерживается');

  @override
  bool operator ==(Object other) => other is LocalDocRef && other.path == path;

  @override
  int get hashCode => path.hashCode;

  @override
  String toString() => 'DocumentReference($path)';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LocalQuery implements Query<Map<String, dynamic>> {
  LocalQuery(this.db, this.spec);
  final LocalFirestore db;
  final QSpec spec;

  LocalEngine get _e => db.engine;

  @override
  FirebaseFirestore get firestore => db;

  @override
  Map<String, dynamic> get parameters => spec.toWire();

  Query<Map<String, dynamic>> _with(QSpec s) => LocalQuery(db, s);

  @override
  Query<Map<String, dynamic>> limit(int limit) => _with(spec.copyWith(limit: limit, limitToLast: false));

  @override
  Query<Map<String, dynamic>> limitToLast(int limit) => _with(spec.copyWith(limit: limit, limitToLast: true));

  @override
  Query<Map<String, dynamic>> orderBy(Object field, {bool descending = false}) =>
      _with(spec.copyWith(orders: [...spec.orders, (_fieldName(field), descending)]));

  @override
  Query<Map<String, dynamic>> where(Object field,
      {Object? isEqualTo = _unset,
      Object? isNotEqualTo = _unset,
      Object? isLessThan,
      Object? isLessThanOrEqualTo,
      Object? isGreaterThan,
      Object? isGreaterThanOrEqualTo,
      Object? arrayContains,
      Iterable<Object?>? arrayContainsAny,
      Iterable<Object?>? whereIn,
      Iterable<Object?>? whereNotIn,
      bool? isNull}) {
    final f = _fieldName(field);
    final add = <QFilter>[];
    void put(String op, Object? v) => add.add(QFilter(f, op, toWire(v is Iterable ? v.toList() : v)));
    if (!identical(isEqualTo, _unset)) put('==', isEqualTo);
    if (!identical(isNotEqualTo, _unset)) put('!=', isNotEqualTo);
    if (isLessThan != null) put('<', isLessThan);
    if (isLessThanOrEqualTo != null) put('<=', isLessThanOrEqualTo);
    if (isGreaterThan != null) put('>', isGreaterThan);
    if (isGreaterThanOrEqualTo != null) put('>=', isGreaterThanOrEqualTo);
    if (arrayContains != null) put('array-contains', arrayContains);
    if (arrayContainsAny != null) put('array-contains-any', arrayContainsAny);
    if (whereIn != null) put('in', whereIn);
    if (whereNotIn != null) put('not-in', whereNotIn);
    if (isNull != null) put(isNull ? '==' : '!=', null);
    return _with(spec.copyWith(filters: [...spec.filters, ...add]));
  }

  @override
  Future<QuerySnapshot<Map<String, dynamic>>> get([GetOptions? options]) async {
    final source = switch (options?.source) { Source.cache => 'cache', Source.server => 'server', _ => 'default' };
    final (paths, fromCache) = await _e.getQuery(spec, source);
    final docs = [for (final p in paths) LocalQueryDocSnap(LocalDocRef(db, p), _e.view(p), fromCache)];
    return LocalQuerySnap(docs, [
      for (var i = 0; i < docs.length; i++) LocalDocChange(DocumentChangeType.added, -1, i, docs[i]),
    ], fromCache);
  }

  @override
  Stream<QuerySnapshot<Map<String, dynamic>>> snapshots(
      {bool includeMetadataChanges = false, ListenSource source = ListenSource.defaultSource}) {
    return Stream.multi((c) {
      Map<String, String>? last; // путь → отметка версии
      List<String> lastOrder = const [];
      bool? lastFromCache;
      late Sub sub;
      Timer? cacheTimer;
      var closed = false;
      void emit({bool fromTimer = false}) {
        if (closed) return;
        final err = sub.error;
        if (err != null) {
          closed = true;
          c.addError(err);
          c.close();
          return;
        }
        final fromCache = !sub.synced;
        final paths = _e.evalQuery(spec, sub.membership);
        // Первый снимок из памяти — если там что-то есть (или сервер молчит).
        if (last == null && fromCache && paths.isEmpty && !fromTimer) return;
        final views = {for (final p in paths) p: _e.view(p)};
        final docs = [for (final p in paths) LocalQueryDocSnap(LocalDocRef(db, p), views[p]!, fromCache)];
        final changes = <DocumentChange<Map<String, dynamic>>>[];
        final prev = last;
        if (prev == null) {
          for (var i = 0; i < docs.length; i++) {
            changes.add(LocalDocChange(DocumentChangeType.added, -1, i, docs[i]));
          }
        } else {
          final newIndex = {for (var i = 0; i < paths.length; i++) paths[i]: i};
          final oldIndex = {for (var i = 0; i < lastOrder.length; i++) lastOrder[i]: i};
          for (final p in lastOrder) {
            if (!newIndex.containsKey(p)) {
              final v = _e.view(p);
              changes.add(LocalDocChange(DocumentChangeType.removed, oldIndex[p]!, -1, LocalQueryDocSnap(LocalDocRef(db, p), v, fromCache)));
            }
          }
          for (var i = 0; i < paths.length; i++) {
            final p = paths[i];
            final o = oldIndex[p];
            if (o == null) {
              changes.add(LocalDocChange(DocumentChangeType.added, -1, i, docs[i]));
            } else if (prev[p] != views[p]!.stamp) {
              changes.add(LocalDocChange(DocumentChangeType.modified, o, i, docs[i]));
            }
          }
          final orderChanged = lastOrder.length != paths.length || !_sameOrder(lastOrder, paths);
          final syncFlip = lastFromCache == true && !fromCache;
          if (changes.isEmpty && !orderChanged && !syncFlip && !(includeMetadataChanges && lastFromCache != fromCache)) return;
        }
        last = {for (final p in paths) p: views[p]!.stamp};
        lastOrder = paths;
        lastFromCache = fromCache;
        c.add(LocalQuerySnap(docs, changes, fromCache));
      }

      sub = _e.listen(spec: spec, onChange: emit);
      scheduleMicrotask(emit);
      cacheTimer = Timer(Duration(milliseconds: _e.online.value ? 2500 : 300), () => emit(fromTimer: true));
      c.onCancel = () {
        closed = true;
        cacheTimer?.cancel();
        _e.unlisten(sub, emit);
      };
    });
  }

  static bool _sameOrder(List<String> a, List<String> b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  @override
  Query<R> withConverter<R>({required FromFirestore<R> fromFirestore, required ToFirestore<R> toFirestore}) =>
      throw UnsupportedError('withConverter не поддерживается');

  @override
  bool operator ==(Object other) => other is LocalQuery && other.spec.key == spec.key;

  @override
  int get hashCode => spec.key.hashCode;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('Хранилище на сервере: запрос ${invocation.memberName} не поддерживается');
}

const _unset = _Unset();

class _TxOffline implements Exception {
  const _TxOffline();
}

class _Unset {
  const _Unset();
}

class LocalCollectionRef extends LocalQuery implements CollectionReference<Map<String, dynamic>> {
  LocalCollectionRef(LocalFirestore db, this.path) : super(db, QSpec(col: path));

  @override
  final String path;

  @override
  String get id => lastSegment(path);

  @override
  DocumentReference<Map<String, dynamic>>? get parent => path.contains('/') ? LocalDocRef(db, parentOf(path)) : null;

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) {
    final id = path == null || path.isEmpty ? LocalEngine.autoId() : _norm(path);
    return db.doc('${this.path}/$id');
  }

  @override
  Future<DocumentReference<Map<String, dynamic>>> add(Map<String, dynamic> data) async {
    final ref = doc();
    // Как в Firestore: ссылка сразу, запись уходит в очередь.
    unawaited(ref.set(data).catchError((Object _) {}));
    return ref;
  }

  @override
  CollectionReference<R> withConverter<R extends Object?>(
          {required FromFirestore<R> fromFirestore, required ToFirestore<R> toFirestore}) =>
      throw UnsupportedError('withConverter не поддерживается');

  @override
  bool operator ==(Object other) => other is LocalCollectionRef && other.path == path;

  @override
  int get hashCode => path.hashCode;
}

// ------------------------------------------------------------ снимки

class _Meta implements SnapshotMetadata {
  const _Meta(this.hasPendingWrites, this.isFromCache);
  @override
  final bool hasPendingWrites;
  @override
  final bool isFromCache;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LocalDocSnap implements DocumentSnapshot<Map<String, dynamic>> {
  LocalDocSnap(this.reference, this._view, this._fromCache);
  @override
  final DocumentReference<Map<String, dynamic>> reference;
  final DocView _view;
  final bool _fromCache;

  @override
  String get id => reference.id;

  @override
  SnapshotMetadata get metadata => _Meta(_view.pending, _fromCache);

  @override
  bool get exists => _view.exists;

  @override
  Map<String, dynamic>? data() => _view.data == null ? null : fromWire(_view.data) as Map<String, dynamic>;

  @override
  dynamic get(Object field) {
    final v = fieldOf(_view.data, _fieldName(field));
    if (_view.data == null || isMissing(v)) throw StateError('field "$field" does not exist within the DocumentSnapshotPlatform');
    return fromWire(v);
  }

  @override
  dynamic operator [](Object field) => get(field);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LocalQueryDocSnap extends LocalDocSnap implements QueryDocumentSnapshot<Map<String, dynamic>> {
  LocalQueryDocSnap(super.reference, super.view, super.fromCache);

  @override
  Map<String, dynamic> data() => super.data() ?? <String, dynamic>{};
}

class LocalDocChange implements DocumentChange<Map<String, dynamic>> {
  LocalDocChange(this.type, this.oldIndex, this.newIndex, this.doc);
  @override
  final DocumentChangeType type;
  @override
  final int oldIndex;
  @override
  final int newIndex;
  @override
  final DocumentSnapshot<Map<String, dynamic>> doc;
}

class LocalQuerySnap implements QuerySnapshot<Map<String, dynamic>> {
  LocalQuerySnap(this.docs, this.docChanges, this._fromCache);
  @override
  final List<QueryDocumentSnapshot<Map<String, dynamic>>> docs;
  @override
  final List<DocumentChange<Map<String, dynamic>>> docChanges;
  final bool _fromCache;

  @override
  SnapshotMetadata get metadata => _Meta(docs.any((d) => d.metadata.hasPendingWrites), _fromCache);

  @override
  int get size => docs.length;
}

// ------------------------------------------------------------ пачки и транзакции

PendingWrite _setWrite(DocumentReference ref, Object? data, SetOptions? options) =>
    PendingWrite('set', ref.path, data: _wireMap(data as Map), merge: options?.merge == true);

PendingWrite _updateWrite(DocumentReference ref, Map<String, dynamic> data) => PendingWrite('update', ref.path, data: _wireMap(data));

class LocalWriteBatch implements WriteBatch {
  LocalWriteBatch(this.db);
  final LocalFirestore db;
  final List<PendingWrite> _writes = [];
  bool _committed = false;

  @override
  Future<void> commit() {
    if (_committed) throw StateError('Пачка уже отправлена');
    _committed = true;
    return db.engine.enqueue(List.of(_writes));
  }

  @override
  void delete(DocumentReference document) => _writes.add(PendingWrite('delete', document.path));

  @override
  void set<T>(DocumentReference<T> document, T data, [SetOptions? options]) => _writes.add(_setWrite(document, data, options));

  @override
  void update(DocumentReference document, Map<String, dynamic> data) => _writes.add(_updateWrite(document, data));

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class LocalTransaction implements Transaction {
  LocalTransaction(this.db, {this.offline = false});
  final LocalFirestore db;
  final bool offline;
  final Map<String, int?> _readVers = {};
  final List<PendingWrite> _writes = [];

  /// Чтение не прошло из-за связи (запись ещё не отправлялась).
  bool offlineRead = false;

  @override
  Future<DocumentSnapshot<T>> get<T extends Object?>(DocumentReference<T> documentReference) async {
    if (_writes.isNotEmpty) throw StateError('В транзакции сначала чтения, потом записи');
    final path = documentReference.path;
    if (offline) {
      final (v, ver) = db.engine.txGetLocal(path);
      _readVers[path] = ver;
      return LocalDocSnap(LocalDocRef(db, path), v, true) as DocumentSnapshot<T>;
    }
    try {
      final (v, ver) = await db.engine.txGet(path);
      _readVers[path] = ver;
      return LocalDocSnap(LocalDocRef(db, path), v, false) as DocumentSnapshot<T>;
    } on FirebaseException catch (e) {
      if (e.code == 'unavailable') offlineRead = true;
      rethrow;
    }
  }

  @override
  Transaction delete(DocumentReference documentReference) {
    _writes.add(PendingWrite('delete', documentReference.path));
    return this;
  }

  @override
  Transaction update(DocumentReference documentReference, Map<String, dynamic> data) {
    _writes.add(_updateWrite(documentReference, data));
    return this;
  }

  @override
  Transaction set<T>(DocumentReference<T> documentReference, T data, [SetOptions? options]) {
    _writes.add(_setWrite(documentReference, data, options));
    return this;
  }

  /// Записи со сверкой версий прочитанного (кто-то успел изменить — повтор).
  List<PendingWrite> buildWrites() {
    if (_writes.isEmpty) return const [];
    final out = <PendingWrite>[];
    final written = <String>{};
    for (final w in _writes) {
      final ver = written.add(w.path) ? _readVers[w.path] : null;
      out.add(PendingWrite(w.op, w.path, data: w.data, merge: w.merge, ver: ver));
    }
    for (final e in _readVers.entries) {
      if (!written.contains(e.key) && e.value != null) out.add(PendingWrite('check', e.key, ver: e.value));
    }
    return out;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
