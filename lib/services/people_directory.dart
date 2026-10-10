import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../build_info.dart';
import 'app_scope.dart';

/// Справочник людей заведения: имена и телефоны сотрудников и гостей,
/// контакты броней, очереди и доставки. Хранится на сервере в РФ
/// (pii-gateway/vault.js), а в Firestore у документов остаются только
/// идентификаторы — uid гостя, id сотрудника, id брони или чека.
///
/// Касса держит копию справочника у себя (файл на устройстве) и раз в
/// полминуты забирает изменения, поэтому имена видны сразу и без сети.
/// Чего в копии нет — догружается пачкой, а экраны перерисовываются сами
/// ([PeopleRefresh]).
///
/// Режим:
///  • 'rf' — в Firestore имён нет, источник — справочник. Так у всех
///    заведений платформы (сборки с адресом справочника, kPiiGatewayUrl);
///  • 'mirror' — имена пишутся и читаются в Firestore, справочник —
///    запасной источник. Только без справочника (сборка одного заведения).
///
/// Модели берут значения через [Pd]: `Pd.staffName(employeeId, legacy)`,
/// где legacy — то, что лежит в документе Firestore (старые записи и режим
/// mirror). Записывают — через [People.put]: значение сразу появляется на
/// этой кассе, а на сервер уходит из очереди (переживает отсутствие сети).
class People extends ChangeNotifier {
  People({PiiTransport? transport, PeopleStore? store, Duration? syncEvery})
      : _transport = transport,
        _store = store ?? (kIsWeb ? MemoryPeopleStore() : FilePeopleStore()),
        _syncEvery = syncEvery ?? const Duration(seconds: 30);

  static People instance = People();

  final PiiTransport? _transport;
  final PeopleStore _store;
  final Duration _syncEvery;

  String? _tenant;
  bool _staff = false;
  bool _persist = true;
  bool _rf = false;

  final Map<String, PdEntry> _data = {};
  final Map<String, Map<String, dynamic>> _cursor = {};
  final List<Map<String, dynamic>> _outbox = [];

  Timer? _syncTimer;
  Timer? _saveTimer;
  Timer? _missTimer;
  Timer? _notifyTimer;
  final Set<String> _pending = {};
  final Map<String, DateTime> _missedAt = {};
  Future<void>? _syncing;
  Future<void>? _flushing;

  // ------------------------------------------------------------ состояние

  /// Заведение переведено на справочник в РФ: имён в Firestore нет.
  bool get rf => _rf;

  /// Справочник подключён (SaaS-заведение, сборка с адресом сервера в РФ).
  bool get active => _tenant != null && _transportOrDefault != null;

  /// Касса (персонал) — синхронизирует весь справочник заведения; гость
  /// видит только своё.
  bool get isStaff => _staff;

  PiiTransport? get _transportOrDefault =>
      _transport ?? (kPiiGatewayUrl.isEmpty ? null : _httpTransport);

  /// Режим из meta/venueProfile — его передаёт VenueService.
  void setMode(String? mode) {
    final v = mode == 'rf';
    if (v == _rf) return;
    _rf = v;
    _scheduleSave();
    _notifySoon();
  }

  /// Подключает справочник заведения. [staff] — касса (полная копия и
  /// синхронизация), иначе приложение гостя. [persist] — хранить копию
  /// на устройстве (фоновая служба только читает файл кассы).
  Future<void> start({required bool staff, bool persist = true}) async {
    final tenant = AppScope.tenantId;
    // Демо — тоже: имена, которые там вводят, хранятся в РФ, как у всех, а
    // при сбросе демо стираются (saas-gateway, purgeDemoTenant).
    if (tenant == null) return;
    if (_tenant == tenant && _staff == staff) return;
    stop();
    _tenant = tenant;
    _staff = staff;
    _persist = persist;
    // Все заведения платформы хранят имена только в РФ — режим rf сразу,
    // не дожидаясь профиля заведения (VenueService.piiModeOf).
    if (kPiiGatewayUrl.isNotEmpty) _rf = true;
    await _load(tenant);
    if (staff && persist) {
      unawaited(syncNow());
      _syncTimer = Timer.periodic(_syncEvery, (_) => unawaited(syncNow()));
    }
    if (_outbox.isNotEmpty) unawaited(_flushOutbox());
  }

  /// Для фоновой службы и разовых мест: подтянуть копию с устройства, если
  /// справочник ещё не подключён в этом процессе.
  Future<void> ensureReady({bool staff = true}) async {
    if (_tenant != null && _tenant == AppScope.tenantId) return;
    await start(staff: staff, persist: false);
  }

  void stop() {
    _syncTimer?.cancel();
    _syncTimer = null;
    _missTimer?.cancel();
    if (_saveTimer?.isActive == true) {
      _saveTimer!.cancel();
      unawaited(_saveNow());
    }
    _tenant = null;
    _data.clear();
    _cursor.clear();
    _outbox.clear();
    _pending.clear();
    _missedAt.clear();
  }

  // ------------------------------------------------------------ чтение

  PdEntry? entry(String k, String id) => id.isEmpty ? null : _data['$k:$id'];

  /// Значение для экрана: в режиме mirror — из документа Firestore, если
  /// оно там есть; в режиме rf — из справочника (документ — запасной).
  String pick(String k, String id, String legacy, String Function(PdEntry e) field) {
    final e = entry(k, id);
    if (!_rf) {
      if (legacy.isNotEmpty) return legacy;
      return e == null ? '' : field(e);
    }
    if (e != null) return field(e);
    if (id.isNotEmpty) _miss(k, id);
    return legacy;
  }

  /// Дождаться, пока справочник узнает о записях (уведомление, печать
  /// чека): пачкой спрашивает сервер о тех, чего нет в копии.
  Future<void> ensure(Iterable<PdRef> refs) async {
    if (!active) return;
    final need = <PdRef>[];
    for (final r in refs) {
      if (r.id.isEmpty || _data.containsKey(r.key)) continue;
      need.add(r);
    }
    if (need.isEmpty) return;
    try {
      await _lookup(need);
    } catch (_) {
      // Нет сети — покажем то, что есть.
    }
  }

  void _miss(String k, String id) {
    if (!active) return;
    final key = '$k:$id';
    final at = _missedAt[key];
    if (at != null && DateTime.now().difference(at) < const Duration(minutes: 5)) return;
    if (!_pending.add(key)) return;
    _missTimer ??= Timer(const Duration(milliseconds: 150), () {
      _missTimer = null;
      final refs = [for (final k in _pending) PdRef.parse(k)];
      _pending.clear();
      unawaited(_lookup(refs).catchError((_) {}));
    });
  }

  Future<void> _lookup(List<PdRef> refs) async {
    final t = _transportOrDefault;
    if (t == null || refs.isEmpty) return;
    final chunk = _staff ? 300 : 40;
    for (var i = 0; i < refs.length; i += chunk) {
      final part = refs.sublist(i, i + chunk > refs.length ? refs.length : i + chunk);
      final now = DateTime.now();
      for (final r in part) {
        _missedAt[r.key] = now;
      }
      final res = await t({'kind': 'pii_lookup', 'refs': [for (final r in part) r.toJson()]});
      if (_apply(res)) _changed();
    }
  }

  /// Гости по телефону или имени — с сервера; без сети — по копии.
  Future<List<PdGuest>> searchGuests(String q) async {
    final query = q.trim();
    if (query.length < 2) return const [];
    final t = _transportOrDefault;
    if (t != null && _staff) {
      try {
        final res = await t({'kind': 'pii_search', 'q': query});
        _apply(res);
        return [
          for (final g in (res['guests'] as List? ?? const []))
            if (g is Map) PdGuest(uid: '${g['id']}', name: '${g['name'] ?? ''}', phone: '${g['phone'] ?? ''}'),
        ];
      } catch (_) {}
    }
    final digits = query.replaceAll(RegExp(r'\D'), '');
    final lower = query.toLowerCase();
    final out = <PdGuest>[];
    _data.forEach((key, e) {
      if (!key.startsWith('guest:')) return;
      final hit = digits.length >= 3 ? e.phone.contains(digits) : e.name.toLowerCase().contains(lower);
      if (hit) out.add(PdGuest(uid: key.substring(6), name: e.name, phone: e.phone));
    });
    return out.take(30).toList();
  }

  /// uid гостя с этим номером (касса): сначала копия, потом сервер.
  Future<String> guestUidByPhone(String phone) async {
    final p = normalizedPhone(phone);
    if (p.isEmpty) return '';
    for (final e in _data.entries) {
      if (e.key.startsWith('guest:') && e.value.phone == p) return e.key.substring(6);
    }
    final t = _transportOrDefault;
    if (t == null || !_staff) return '';
    final res = await t({'kind': 'pii_phone', 'phone': p});
    return '${res['uid'] ?? ''}';
  }

  /// Занят ли номер другим гостем (приложение гостя).
  Future<bool> phoneTakenByOther(String phone) async {
    final t = _transportOrDefault;
    final p = normalizedPhone(phone);
    if (t == null || p.isEmpty) return false;
    final res = await t({'kind': 'pii_phone', 'phone': p});
    return res['taken'] == true;
  }

  // ------------------------------------------------------------ запись

  /// Записывает значения человека: на этой кассе — сразу, на сервер — из
  /// очереди. null — не трогать поле, '' — стереть. [confirm] — дождаться
  /// ответа сервера (где запись в РФ должна быть до создания документа):
  /// не вышло — ошибка, и запись из очереди убирается.
  Future<void> put(
    String k,
    String id, {
    String? name,
    String? phone,
    String? address,
    Map<String, String?>? extra,
    bool confirm = false,
  }) async {
    if (id.isEmpty || _tenant == null) return;
    if (name == null && phone == null && address == null && (extra == null || extra.isEmpty)) return;
    final key = '$k:$id';
    final p = phone == null ? null : normalizedPhone(phone);
    final before = _data[key];
    _data[key] = (before ?? const PdEntry()).merge(name: name, phone: p, address: address, extra: extra);
    _missedAt.remove(key);
    final fields = <String, dynamic>{
      if (name != null) 'name': name,
      if (p != null) 'phone': p,
      if (address != null) 'address': address,
      if (extra != null && extra.isNotEmpty) 'extra': extra,
    };
    final item = _enqueue({'op': 'put', 'k': k, 'id': id, 'fields': fields});
    _changed();
    if (_transportOrDefault == null) {
      _outbox.remove(item);
      return;
    }
    if (!confirm) {
      unawaited(_flushOutbox());
      return;
    }
    try {
      await _flushOutbox(rethrowErrors: true);
    } catch (e) {
      _outbox.remove(item);
      _scheduleSave();
      rethrow;
    }
  }

  /// Значения, которые уже записаны на сервере в РФ другим запросом
  /// (первичная запись брони, очереди, доставки), — только в копию на этом
  /// устройстве, чтобы имя было видно сразу, без повторной отправки.
  void remember(String k, String id, {String? name, String? phone, String? address}) {
    if (id.isEmpty || _tenant == null) return;
    if (name == null && phone == null && address == null) return;
    final key = '$k:$id';
    _data[key] = (_data[key] ?? const PdEntry())
        .merge(name: name, phone: phone == null ? null : normalizedPhone(phone), address: address);
    _missedAt.remove(key);
    _changed();
  }

  /// Стирает значения человека (удаление гостя, сотрудника, карты).
  Future<void> erase(String k, String id) async {
    if (id.isEmpty || _tenant == null) return;
    _data['$k:$id'] = const PdEntry();
    _outbox.removeWhere((x) => x['k'] == k && x['id'] == id);
    _enqueue({'op': 'erase', 'k': k, 'id': id});
    _changed();
    unawaited(_flushOutbox());
  }

  Map<String, dynamic> _enqueue(Map<String, dynamic> item) {
    // Правки одной записи подряд — одной строкой очереди.
    if (item['op'] == 'put') {
      for (final x in _outbox) {
        if (x['op'] == 'put' && x['k'] == item['k'] && x['id'] == item['id'] && !(x['sending'] == true)) {
          final f = Map<String, dynamic>.from(x['fields'] as Map);
          final add = item['fields'] as Map<String, dynamic>;
          for (final e in add.entries) {
            if (e.key == 'extra' && f['extra'] is Map) {
              f['extra'] = {...(f['extra'] as Map), ...(e.value as Map)};
            } else {
              f[e.key] = e.value;
            }
          }
          x['fields'] = f;
          _scheduleSave();
          return x;
        }
      }
    }
    _outbox.add(item);
    _scheduleSave();
    return item;
  }

  /// Отправляет очередь. Ошибка — запись остаётся и уйдёт со следующей
  /// синхронизацией.
  Future<void> _flushOutbox({bool rethrowErrors = false}) async {
    final running = _flushing;
    if (running != null) {
      await running;
      if (_outbox.isEmpty) return;
    }
    final t = _transportOrDefault;
    if (t == null || _outbox.isEmpty) return;
    final done = Completer<void>();
    _flushing = done.future;
    Object? error;
    try {
      while (_outbox.isNotEmpty) {
        // Строго по порядку: подряд идущие правки — одним запросом,
        // стирание — отдельным, чтобы оно не обогнало правку и не отстало.
        final batch = <Map<String, dynamic>>[];
        for (final x in _outbox) {
          if (x['op'] != 'put' || batch.length == 100) break;
          batch.add(x);
        }
        final erase = batch.isEmpty ? _outbox.first : const <String, dynamic>{};
        if (batch.isNotEmpty) {
          for (final x in batch) {
            x['sending'] = true;
          }
          try {
            await t({
              'kind': 'pii_put',
              'items': [
                for (final x in batch) {'k': x['k'], 'id': x['id'], 'fields': x['fields']},
              ],
            });
          } finally {
            for (final x in batch) {
              x.remove('sending');
            }
          }
          _outbox.removeWhere(batch.contains);
        } else {
          await t({'kind': 'pii_erase', 'k': erase['k'], 'id': erase['id']});
          _outbox.remove(erase);
        }
        _scheduleSave();
      }
    } catch (e) {
      error = e;
    } finally {
      _flushing = null;
      done.complete();
    }
    if (error != null && rethrowErrors) throw error;
  }

  // ------------------------------------------------------------ синхронизация

  /// Забирает изменения справочника с сервера (касса).
  Future<void> syncNow() {
    final running = _syncing;
    if (running != null) return running;
    final f = _sync().whenComplete(() => _syncing = null);
    _syncing = f;
    return f;
  }

  Future<void> _sync() async {
    final t = _transportOrDefault;
    if (t == null || !_staff || _tenant == null) return;
    final tenant = _tenant;
    try {
      await _flushOutbox();
      // Каждый заход — с нахлёстом в полминуты: транзакции на сервере
      // завершаются не строго по порядку, повтор строк безвреден.
      var since = <String, dynamic>{
        for (final table in const ['staff', 'guests', 'contacts'])
          table: _overlap(_cursor[table]),
      };
      var changed = false;
      for (var page = 0; page < 50; page++) {
        final res = await t({'kind': 'pii_sync', 'since': since});
        if (_tenant != tenant) return;
        changed = _apply(res) || changed;
        final c = res['cursor'];
        if (c is Map) {
          since = {for (final e in c.entries) '${e.key}': e.value};
          for (final e in c.entries) {
            if (e.value is Map) _cursor['${e.key}'] = Map<String, dynamic>.from(e.value as Map);
          }
        }
        if (res['more'] != true) break;
      }
      _scheduleSave();
      if (changed) _changed();
    } catch (_) {
      // Нет сети — попробуем в следующий раз; копия на устройстве остаётся.
    }
  }

  static Map<String, dynamic> _overlap(Map<String, dynamic>? c) {
    final u = int.tryParse('${c?['u'] ?? '0'}') ?? 0;
    final back = u - 30 * 1000 * 1000;
    return {'u': '${back < 0 ? 0 : back}', 'id': ''};
  }

  /// Раскладывает ответ сервера по копии. true — что-то изменилось.
  bool _apply(Map<String, dynamic> res) {
    var changed = false;
    void put(String key, PdEntry e) {
      if (_data[key]?.sameAs(e) == true) return;
      // Своя ещё не отправленная правка важнее того, что пришло с сервера.
      final sep = key.indexOf(':');
      final k = key.substring(0, sep);
      final id = key.substring(sep + 1);
      if (_outbox.any((x) => x['k'] == k && x['id'] == id)) return;
      _data[key] = e;
      changed = true;
    }

    for (final r in (res['staff'] as List? ?? const [])) {
      if (r is Map) put('staff:${r['id']}', PdEntry.fromJson(r));
    }
    for (final r in (res['guests'] as List? ?? const [])) {
      if (r is Map) put('guest:${r['id']}', PdEntry.fromJson(r));
    }
    for (final r in (res['contacts'] as List? ?? const [])) {
      if (r is Map) put('${r['k']}:${r['id']}', PdEntry.fromJson(r));
    }
    return changed;
  }

  void _changed() {
    _scheduleSave();
    _notifySoon();
  }

  /// Перерисовка не чаще четырёх раз в секунду: пачка ответов — одна.
  void _notifySoon() {
    if (_notifyTimer?.isActive == true) return;
    _notifyTimer = Timer(const Duration(milliseconds: 250), notifyListeners);
  }

  // ------------------------------------------------------------ хранение

  Future<void> _load(String tenant) async {
    Map<String, dynamic>? raw;
    try {
      raw = await _store.load(tenant);
    } catch (_) {}
    if (raw == null || raw['v'] != 1) return;
    _rf = raw['mode'] == 'rf' || _rf;
    final data = raw['data'];
    if (data is Map) {
      for (final e in data.entries) {
        if (e.value is Map) _data['${e.key}'] = PdEntry.fromJson(e.value as Map);
      }
    }
    final cursor = raw['cursor'];
    if (cursor is Map) {
      for (final e in cursor.entries) {
        if (e.value is Map) _cursor['${e.key}'] = Map<String, dynamic>.from(e.value as Map);
      }
    }
    final outbox = raw['outbox'];
    if (outbox is List) {
      for (final x in outbox) {
        if (x is Map) _outbox.add(Map<String, dynamic>.from(x));
      }
    }
  }

  void _scheduleSave() {
    if (_tenant == null || !_persist) return;
    if (_saveTimer?.isActive == true) return;
    _saveTimer = Timer(const Duration(seconds: 3), () => unawaited(_saveNow()));
  }

  Future<void> _saveNow() async {
    final tenant = _tenant;
    if (tenant == null || !_persist) return;
    try {
      await _store.save(tenant, {
        'v': 1,
        'mode': _rf ? 'rf' : 'mirror',
        'data': {for (final e in _data.entries) e.key: e.value.toJson()},
        'cursor': _cursor,
        'outbox': [for (final x in _outbox) Map<String, dynamic>.from(x)..remove('sending')],
      });
    } catch (_) {}
  }

  /// Для тестов: сохранить сразу.
  @visibleForTesting
  Future<void> flushForTest() async {
    _saveTimer?.cancel();
    await _saveNow();
    await _flushOutbox();
  }

  @visibleForTesting
  int get outboxLength => _outbox.length;

  // ------------------------------------------------------------ сеть

  static Future<Map<String, dynamic>> _httpTransport(Map<String, dynamic> body) async {
    final user = FirebaseAuth.instance.currentUser;
    final token = await user?.getIdToken();
    if (token == null || token.isEmpty) throw PeopleException('нет входа');
    final resp = await http
        .post(
          Uri.parse(kPiiGatewayUrl),
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
          body: jsonEncode({'tenantId': AppScope.tenantId ?? '', ...body}),
        )
        .timeout(const Duration(seconds: 20));
    Map<String, dynamic> json;
    try {
      json = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw PeopleException('сервер в РФ ответил ${resp.statusCode}');
    }
    if (resp.statusCode != 200) {
      throw PeopleException('${json['error'] ?? 'сервер в РФ ответил ${resp.statusCode}'}');
    }
    return json;
  }
}

typedef PiiTransport = Future<Map<String, dynamic>> Function(Map<String, dynamic> body);

class PeopleException implements Exception {
  final String message;
  PeopleException(this.message);
  @override
  String toString() => message;
}

/// Номер в виде 79001234567, как его хранит сервер.
String normalizedPhone(String raw) {
  final d = raw.replaceAll(RegExp(r'\D'), '');
  if (d.isEmpty) return '';
  if (d.length == 11 && d.startsWith('8')) return '7${d.substring(1)}';
  if (d.length == 10 && d.startsWith('9')) return '7$d';
  return d;
}

/// Ссылка на запись справочника: вид и id.
@immutable
class PdRef {
  final String k;
  final String id;
  const PdRef(this.k, this.id);
  const PdRef.staff(this.id) : k = 'staff';
  const PdRef.guest(this.id) : k = 'guest';

  String get key => '$k:$id';
  Map<String, String> toJson() => {'k': k, 'id': id};

  static PdRef parse(String key) {
    final i = key.indexOf(':');
    return PdRef(key.substring(0, i), key.substring(i + 1));
  }
}

@immutable
class PdGuest {
  final String uid;
  final String name;
  final String phone;
  const PdGuest({required this.uid, required this.name, required this.phone});
}

/// Запись справочника.
@immutable
class PdEntry {
  final String name;
  final String phone;
  final String address;
  final Map<String, String> extra;

  const PdEntry({this.name = '', this.phone = '', this.address = '', this.extra = const {}});

  factory PdEntry.fromJson(Map m) => PdEntry(
        name: '${m['name'] ?? ''}',
        phone: '${m['phone'] ?? ''}',
        address: '${m['address'] ?? ''}',
        extra: {
          if (m['extra'] is Map)
            for (final e in (m['extra'] as Map).entries)
              if (e.value != null) '${e.key}': '${e.value}',
        },
      );

  Map<String, dynamic> toJson() => {
        if (name.isNotEmpty) 'name': name,
        if (phone.isNotEmpty) 'phone': phone,
        if (address.isNotEmpty) 'address': address,
        if (extra.isNotEmpty) 'extra': extra,
      };

  PdEntry merge({String? name, String? phone, String? address, Map<String, String?>? extra}) {
    final x = Map<String, String>.from(this.extra);
    extra?.forEach((k, v) {
      if (v == null || v.isEmpty) {
        x.remove(k);
      } else {
        x[k] = v;
      }
    });
    return PdEntry(
      name: name ?? this.name,
      phone: phone ?? this.phone,
      address: address ?? this.address,
      extra: x,
    );
  }

  bool sameAs(PdEntry o) =>
      name == o.name && phone == o.phone && address == o.address && mapEquals(extra, o.extra);
}

/// Где касса хранит копию справочника.
abstract class PeopleStore {
  Future<Map<String, dynamic>?> load(String tenant);
  Future<void> save(String tenant, Map<String, dynamic> data);
}

class MemoryPeopleStore implements PeopleStore {
  final Map<String, String> files = {};
  @override
  Future<Map<String, dynamic>?> load(String tenant) async {
    final s = files[tenant];
    return s == null ? null : jsonDecode(s) as Map<String, dynamic>;
  }

  @override
  Future<void> save(String tenant, Map<String, dynamic> data) async => files[tenant] = jsonEncode(data);
}

/// Файл в папке приложения: на устройстве в зале, не в облаке.
class FilePeopleStore implements PeopleStore {
  Future<File> _file(String tenant) async {
    final dir = await getApplicationSupportDirectory();
    final safe = tenant.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    return File('${dir.path}${Platform.pathSeparator}people_$safe.json');
  }

  @override
  Future<Map<String, dynamic>?> load(String tenant) async {
    final f = await _file(tenant);
    if (!await f.exists()) return null;
    return jsonDecode(await f.readAsString()) as Map<String, dynamic>;
  }

  @override
  Future<void> save(String tenant, Map<String, dynamic> data) async {
    final f = await _file(tenant);
    // Сначала во временный файл: оборванная запись не испортит копию.
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(f.path);
  }
}

/// Короткие обращения к справочнику для моделей и экранов. legacy — что
/// лежит в документе Firestore (старые записи, режим mirror).
class Pd {
  Pd._();
  static People get _p => People.instance;

  static String staffName(String id, [String legacy = '']) => _p.pick('staff', id, legacy, (e) => e.name);
  static String staffPhone(String id, [String legacy = '']) => _p.pick('staff', id, legacy, (e) => e.phone);

  static String guestName(String uid, [String legacy = '']) => _p.pick('guest', uid, legacy, (e) => e.name);
  static String guestPhone(String uid, [String legacy = '']) => _p.pick('guest', uid, legacy, (e) => e.phone);

  static String name(String kind, String id, [String legacy = '']) => _p.pick(kind, id, legacy, (e) => e.name);
  static String phone(String kind, String id, [String legacy = '']) => _p.pick(kind, id, legacy, (e) => e.phone);
  static String address(String kind, String id, [String legacy = '']) => _p.pick(kind, id, legacy, (e) => e.address);
  static String extra(String kind, String id, String key, [String legacy = '']) =>
      _p.pick(kind, id, legacy, (e) => e.extra[key] ?? '');

  /// Пишем ли ПДн в документы Firestore (режим mirror) — для toMap().
  static bool get mirror => !_p.rf;

  // ---- «кто сделал»: принял заказ, закрыл смену, отменил операцию ----

  static String _actorId = '';
  static String _actorName = '';

  /// Кто сейчас работает в кассе — его касса подписывает действия.
  static void setActor(String id, String name) {
    _actorId = id;
    _actorName = name;
  }

  /// Что записать в поле «кто сделал» документа Firestore. В режиме mirror
  /// — имя, как раньше. В режиме rf — ссылка `staff:<id>` (имя остаётся в
  /// справочнике в РФ); сотрудника не нашли — пусто, но не имя.
  /// Служебные значения ('auto', 'Telegram') не трогаем.
  static String who(String name, {String id = ''}) {
    if (name.isEmpty || name == 'auto' || name.startsWith('staff:')) return name;
    if (mirror) return name;
    final found = id.isNotEmpty ? id : _staffIdByName(name);
    return found.isEmpty ? '' : 'staff:$found';
  }

  /// Имя из поля «кто сделал»: ссылку `staff:<id>` раскрывает справочник.
  static String whoName(String raw) {
    if (!raw.startsWith('staff:')) return raw;
    final n = staffName(raw.substring(6));
    return n.isEmpty ? 'Сотрудник' : n;
  }

  static String _staffIdByName(String name) {
    if (_actorId.isNotEmpty && (_actorName == name || staffName(_actorId) == name)) return _actorId;
    String? hit;
    for (final e in _p._data.entries) {
      if (!e.key.startsWith('staff:') || e.value.name != name) continue;
      if (hit != null) return ''; // тёзки — не угадываем
      hit = e.key.substring(6);
    }
    return hit ?? '';
  }
}
