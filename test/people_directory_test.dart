import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/people_directory.dart';

/// Подделка сервера в РФ: хранит записи и считает запросы.
class FakeVault {
  final Map<String, Map<String, dynamic>> rows = {}; // 'k:id' -> {name, phone, address, extra, u}
  final List<Map<String, dynamic>> calls = [];
  bool offline = false;
  int _clock = 1000000;

  void seed(String k, String id, Map<String, dynamic> v) => rows['$k:$id'] = {...v, 'u': '${_clock += 10}'};

  Future<Map<String, dynamic>> call(Map<String, dynamic> body) async {
    calls.add(body);
    if (offline) throw PeopleException('нет сети');
    switch (body['kind']) {
      case 'pii_lookup':
        final out = {'staff': [], 'guests': [], 'contacts': []};
        for (final r in body['refs'] as List) {
          final row = rows['${r['k']}:${r['id']}'];
          if (row == null) continue;
          final item = {'id': r['id'], ...row};
          if (r['k'] == 'staff') {
            out['staff']!.add(item);
          } else if (r['k'] == 'guest') {
            out['guests']!.add(item);
          } else {
            out['contacts']!.add({'k': r['k'], ...item});
          }
        }
        return out;
      case 'pii_put':
        for (final it in body['items'] as List) {
          final key = '${it['k']}:${it['id']}';
          final cur = Map<String, dynamic>.from(rows[key] ?? {});
          final f = it['fields'] as Map;
          for (final e in f.entries) {
            if (e.key == 'extra') {
              final x = Map<String, dynamic>.from((cur['extra'] as Map?) ?? {});
              (e.value as Map).forEach((k, v) => v == null ? x.remove(k) : x[k] = v);
              cur['extra'] = x;
            } else {
              cur[e.key] = e.value;
            }
          }
          cur['u'] = '${_clock += 10}';
          rows[key] = cur;
        }
        return {'ok': true};
      case 'pii_erase':
        rows['${body['k']}:${body['id']}'] = {'name': '', 'phone': '', 'address': '', 'extra': {}, 'u': '${_clock += 10}'};
        return {'ok': true};
      case 'pii_sync':
        // Упрощённо: одна таблица на всё, страницы по 2 записи.
        final since = int.parse('${(body['since'] as Map)['contacts']?['u'] ?? '0'}');
        final all = rows.entries.where((e) => int.parse(e.value['u']) > since).toList()
          ..sort((a, b) => int.parse(a.value['u']).compareTo(int.parse(b.value['u'])));
        final page = all.take(2).toList();
        final out = {'staff': [], 'guests': [], 'contacts': []};
        for (final e in page) {
          final i = e.key.indexOf(':');
          final k = e.key.substring(0, i);
          final item = {'id': e.key.substring(i + 1), ...e.value};
          if (k == 'staff') {
            out['staff']!.add(item);
          } else if (k == 'guest') {
            out['guests']!.add(item);
          } else {
            out['contacts']!.add({'k': k, ...item});
          }
        }
        final last = page.isEmpty ? {'u': '$since', 'id': ''} : {'u': page.last.value['u'], 'id': page.last.key};
        return {
          ...out,
          'cursor': {'staff': last, 'guests': last, 'contacts': last},
          'more': all.length > 2,
        };
      case 'pii_search':
        return {
          'guests': [
            for (final e in rows.entries)
              if (e.key.startsWith('guest:') && '${e.value['name']}'.contains(body['q']))
                {'id': e.key.substring(6), ...e.value},
          ],
        };
      case 'pii_phone':
        for (final e in rows.entries) {
          if (e.key.startsWith('guest:') && e.value['phone'] == body['phone']) return {'uid': e.key.substring(6)};
        }
        return {'uid': ''};
    }
    throw StateError('неизвестный запрос ${body['kind']}');
  }
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 400));

void main() {
  late FakeVault vault;
  late MemoryPeopleStore store;
  late People people;

  setUp(() async {
    AppScope.enterTenant('t1');
    vault = FakeVault();
    store = MemoryPeopleStore();
    people = People(transport: vault.call, store: store, syncEvery: const Duration(hours: 1));
    People.instance = people;
  });

  tearDown(() {
    people.stop();
    AppScope.reset();
  });

  test('режим mirror: значение из Firestore главнее, справочник — запасной, сеть не дёргаем', () async {
    vault.seed('staff', 'e1', {'name': 'Анна'});
    await people.start(staff: false);
    expect(Pd.staffName('e1', 'Анна (Firestore)'), 'Анна (Firestore)');
    expect(Pd.staffName('e1'), '');
    await settle();
    expect(vault.calls, isEmpty);
  });

  test('режим rf: справочник главнее, недостающее догружается одной пачкой', () async {
    vault.seed('staff', 'e1', {'name': 'Анна'});
    vault.seed('guest', 'g1', {'name': 'Иван', 'phone': '79001234567'});
    vault.seed('reservation', 'r1', {'name': 'Пётр', 'phone': '79005556677'});
    await people.start(staff: false);
    people.setMode('rf');
    var notified = 0;
    people.addListener(() => notified++);
    // Пока не загружено — запасное значение из документа.
    expect(Pd.staffName('e1', 'старое'), 'старое');
    expect(Pd.guestName('g1'), '');
    expect(Pd.name('reservation', 'r1'), '');
    await settle();
    final lookups = vault.calls.where((c) => c['kind'] == 'pii_lookup').toList();
    expect(lookups, hasLength(1));
    expect((lookups.single['refs'] as List), hasLength(3));
    expect(notified, greaterThan(0));
    expect(Pd.staffName('e1', 'старое'), 'Анна');
    expect(Pd.guestPhone('g1'), '79001234567');
    expect(Pd.phone('reservation', 'r1'), '79005556677');
    // Нет на сервере — не спрашиваем снова каждую перерисовку.
    expect(Pd.staffName('nobody'), '');
    await settle();
    expect(Pd.staffName('nobody'), '');
    await settle();
    expect(vault.calls.where((c) => c['kind'] == 'pii_lookup'), hasLength(2));
  });

  test('запись: на кассе сразу, на сервер — из очереди; нет сети — запись ждёт и уходит позже', () async {
    await people.start(staff: true);
    people.setMode('rf');
    vault.offline = true;
    await people.put('staff', 'e2', name: 'Борис', phone: '8 (900) 111-22-33');
    expect(Pd.staffName('e2'), 'Борис');
    expect(Pd.staffPhone('e2'), '79001112233');
    await settle();
    expect(people.outboxLength, 1);
    // Ещё правка той же записи — одна строка очереди.
    await people.put('staff', 'e2', name: 'Борис Н.');
    expect(people.outboxLength, 1);
    vault.offline = false;
    await people.syncNow();
    expect(people.outboxLength, 0);
    expect(vault.rows['staff:e2']!['name'], 'Борис Н.');
    expect(vault.rows['staff:e2']!['phone'], '79001112233');
  });

  test('запись с подтверждением: нет сети — ошибка, и в очереди её нет', () async {
    await people.start(staff: true);
    vault.offline = true;
    await expectLater(people.put('reservation', 'r9', name: 'Гость', phone: '79000000000', confirm: true), throwsA(isA<PeopleException>()));
    expect(people.outboxLength, 0);
    vault.offline = false;
    await people.put('reservation', 'r9', name: 'Гость', confirm: true);
    expect(vault.rows['reservation:r9']!['name'], 'Гость');
  });

  test('стирание не обгоняет правку и не отстаёт от неё', () async {
    await people.start(staff: true);
    vault.offline = true;
    await people.put('card', 'c1', name: 'Старое', extra: {'notes': 'x'});
    await people.erase('card', 'c1');
    await people.put('card', 'c1', name: 'Новое');
    vault.offline = false;
    await people.flushForTest();
    expect(vault.rows['card:c1']!['name'], 'Новое');
    final kinds = vault.calls.where((c) => c['kind'] != 'pii_sync').map((c) => c['kind']).toList();
    expect(kinds.sublist(kinds.length - 2), ['pii_erase', 'pii_put']);
  });

  test('доп. поля: null и пустое удаляют ключ', () async {
    await people.start(staff: true);
    people.setMode('rf');
    await people.put('delivery', 's1', address: 'Ленина, 1', extra: {'courierName': 'Пётр', 'courierPhone': '79990001122'});
    await people.put('delivery', 's1', extra: {'courierPhone': null});
    expect(Pd.extra('delivery', 's1', 'courierName'), 'Пётр');
    expect(Pd.extra('delivery', 's1', 'courierPhone'), '');
    await people.flushForTest();
    expect(vault.rows['delivery:s1']!['extra'], {'courierName': 'Пётр'});
  });

  test('синхронизация страницами; своя неотправленная правка не затирается сервером', () async {
    for (var i = 0; i < 5; i++) {
      vault.seed('guest', 'g$i', {'name': 'Гость $i'});
    }
    await people.start(staff: true);
    await people.syncNow();
    people.setMode('rf');
    expect([for (var i = 0; i < 5; i++) Pd.guestName('g$i')], ['Гость 0', 'Гость 1', 'Гость 2', 'Гость 3', 'Гость 4']);
    vault.offline = true;
    await people.put('guest', 'g1', name: 'Мой вариант');
    vault.offline = false;
    vault.seed('guest', 'g1', {'name': 'С сервера'});
    vault.offline = true; // правка ещё в очереди
    await people.syncNow();
    expect(Pd.guestName('g1'), 'Мой вариант');
  });

  test('копия на устройстве: режим, записи и очередь переживают перезапуск', () async {
    await people.start(staff: true);
    people.setMode('rf');
    vault.offline = true;
    await people.put('staff', 'e5', name: 'Вера');
    await people.flushForTest();
    people.stop();
    final again = People(transport: vault.call, store: store, syncEvery: const Duration(hours: 1));
    People.instance = again;
    await again.start(staff: true);
    expect(again.rf, isTrue);
    expect(Pd.staffName('e5'), 'Вера');
    expect(again.outboxLength, 1);
    vault.offline = false;
    await again.syncNow();
    expect(vault.rows['staff:e5']!['name'], 'Вера');
    again.stop();
  });

  test('поиск гостя: сервер, а без сети — по копии; uid по телефону', () async {
    vault.seed('guest', 'g7', {'name': 'Мария', 'phone': '79005554433'});
    await people.start(staff: true);
    await people.syncNow();
    expect((await people.searchGuests('Мар')).map((g) => g.uid), ['g7']);
    vault.offline = true;
    expect((await people.searchGuests('мари')).map((g) => g.uid), ['g7']);
    expect((await people.searchGuests('554433')).map((g) => g.uid), ['g7']);
    expect(await people.guestUidByPhone('8 900 555-44-33'), 'g7');
  });

  test('без заведения справочник выключен и ничего не меняет', () async {
    AppScope.reset();
    await people.start(staff: true);
    expect(people.active, isFalse);
    await people.put('staff', 'e1', name: 'x');
    expect(Pd.staffName('e1', 'из Firestore'), 'из Firestore');
    expect(vault.calls, isEmpty);
  });
}
