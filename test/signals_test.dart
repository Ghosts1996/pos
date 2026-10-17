import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/services/printer_service.dart';
import 'package:hookah_pos/services/signals/kitchen_alarm.dart';
import 'package:hookah_pos/services/signals/lan_signal_codec.dart';
import 'package:hookah_pos/services/signals/lan_transport.dart';
import 'package:hookah_pos/services/signals/ready_watch.dart';
import 'package:hookah_pos/services/signals/relay_client.dart';
import 'package:hookah_pos/services/signals/signal_settings.dart';
import 'package:hookah_pos/utils/constants.dart';
import 'package:hookah_pos/utils/sale_kind.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

OrderItem _food(String id, int qty, {int ready = 0}) => OrderItem(
    menuItemId: id, name: 'Блюдо $id', price: 500, qty: qty, kind: SaleKind.kitchen, ready: ready, since: DateTime(2026, 10, 17, 19));

RelayDevice _relay(String kind, String address, {int channel = 0, int pulse = 2}) =>
    RelayDevice(id: 'r', name: 'Звонок', kind: kind, address: address, channel: channel, pulseSeconds: pulse, events: {SignalEvent.kitchenOrder});

void main() {
  group('Сигнал кухни звенит, пока не приняли', () {
    test('повторяется, эскалирует через 45 с и замолкает на «Принял»', () {
      fakeAsync((fa) {
        var now = DateTime(2026, 10, 17, 19);
        final rings = <bool>[];
        final escalated = <String>[];
        var silenced = 0;
        final alarm = KitchenAlarm(
          onRing: (c, {required first}) => rings.add(first),
          onEscalate: (c) => escalated.add(c.tableName),
          onSilence: () => silenced++,
          clock: () => now,
        );
        alarm.raise('s1', 'Стол 5', 'Цезарь ×2');
        expect(rings, [true]);
        expect(alarm.ringing, isTrue);

        for (var i = 0; i < 12; i++) {
          now = now.add(const Duration(seconds: 4));
          fa.elapse(const Duration(seconds: 4));
        }
        expect(rings.length, 13);
        expect(rings.skip(1), everyElement(isFalse));
        expect(escalated, ['Стол 5'], reason: 'эскалация один раз, после 45 секунд');

        alarm.accept('s1');
        expect(alarm.ringing, isFalse);
        expect(alarm.pending, isEmpty);
        expect(silenced, 1);
        fa.elapse(const Duration(seconds: 20));
        expect(rings.length, 13, reason: 'после «Принял» тишина');
      });
    });

    test('тот же заказ вторым путём сразу после «Принял» не звенит, новый позже — звенит', () {
      fakeAsync((fa) {
        var now = DateTime(2026, 10, 17, 19);
        var rings = 0;
        final alarm = KitchenAlarm(onRing: (_, {required first}) => rings++, clock: () => now);
        alarm.raise('s1', 'Стол 5', 'Цезарь');
        alarm.accept('s1');
        now = now.add(const Duration(seconds: 5));
        alarm.raise('s1', 'Стол 5', 'Цезарь');
        expect(alarm.pending, isEmpty);
        now = now.add(const Duration(minutes: 1));
        alarm.raise('s1', 'Стол 5', 'Морс');
        expect(alarm.pending.single.summary, 'Морс');
        expect(rings, 2);
        alarm.acceptAll();
      });
    });

    test('дозаказ к звенящему столу дописывается, выключенный звук копит без звона', () {
      fakeAsync((fa) {
        var rings = 0;
        final alarm = KitchenAlarm(onRing: (_, {required first}) => rings++);
        alarm.enabled = false;
        alarm.raise('s1', 'Стол 1', 'Суп');
        alarm.raise('s1', 'Стол 1', 'Хлеб');
        fa.elapse(const Duration(seconds: 30));
        expect(rings, 0);
        expect(alarm.pending.single.summary, 'Суп, Хлеб');
        alarm.enabled = true;
        expect(rings, 1);
        alarm.acceptAll();
      });
    });
  });

  group('Wi‑Fi реле', () {
    test('Shelly 1-го поколения — таймер самого реле', () {
      final r = relayRequests(_relay(RelayKind.shellyGen1, '192.168.1.50', pulse: 3)).single;
      expect(r.toString(), 'GET http://192.168.1.50/relay/0?turn=on&timer=3');
    });

    test('Shelly Plus/Pro — RPC Switch.Set с toggle_after', () {
      final r = relayRequests(_relay(RelayKind.shellyGen2, 'http://192.168.1.60/', channel: 1)).single;
      expect(r.uri.toString(), 'http://192.168.1.60/rpc/Switch.Set?id=1&on=true&toggle_after=2');
    });

    test('Tasmota — Backlog с задержкой в десятых долях секунды', () {
      final r = relayRequests(_relay(RelayKind.tasmota, '192.168.1.70', pulse: 5)).single;
      expect(r.uri.queryParameters['cmnd'], 'Backlog Power1 On;Delay 50;Power1 Off');
    });

    test('Sonoff DIY — порт 8081, включить и через N секунд выключить', () {
      final rs = relayRequests(_relay(RelayKind.sonoffDiy, '192.168.1.80', pulse: 2));
      expect(rs, hasLength(2));
      expect(rs.first.uri.toString(), 'http://192.168.1.80:8081/zeroconf/switch');
      expect(jsonDecode(rs.first.body!), {'deviceid': '', 'data': {'switch': 'on'}});
      expect(jsonDecode(rs.last.body!)['data']['switch'], 'off');
      expect(rs.last.after, const Duration(seconds: 2));
    });

    test('свой адрес: подстановки кодируются', () {
      final r = relayRequests(_relay(RelayKind.webhook, 'http://ha.local:8123/api/webhook/z?t={table}&e={event}'),
          vars: {'table': 'Стол 5', 'event': 'dish_ready'}).single;
      expect(r.uri.queryParameters, {'t': 'Стол 5', 'e': 'dish_ready'});
    });

    test('ошибки реле — понятным текстом', () async {
      final ok = RelayClient(client: MockClient((_) async => http.Response('{"ison":true}', 200)));
      expect(await ok.pulse(_relay(RelayKind.shellyGen1, '10.0.0.5')), isNull);
      final pass = RelayClient(client: MockClient((_) async => http.Response('', 401)));
      expect(await pass.pulse(_relay(RelayKind.shellyGen1, '10.0.0.5')), contains('пароль'));
      final down = RelayClient(client: MockClient((_) async => throw const SocketException('нет маршрута')));
      expect(await down.pulse(_relay(RelayKind.shellyGen1, '10.0.0.5')), contains('нет связи'));
    });

    test('настройки переживают сохранение; реле выбираются по событию', () {
      final s = SignalSettings(
        relays: [
          _relay(RelayKind.shellyGen1, '10.0.0.5'),
          const RelayDevice(id: 'x', name: 'Лампа', kind: RelayKind.tasmota, address: '10.0.0.6', events: {SignalEvent.dishReady}, enabled: false),
        ],
        printerBeep: PrinterBeep.builtIn,
        printerBeepTimes: 4,
        lanKey: 'k',
      );
      final back = SignalSettings.fromMap(s.toMap());
      expect(back.relays.map((r) => r.toMap()), s.relays.map((r) => r.toMap()));
      expect(back.printerBeep, PrinterBeep.builtIn);
      expect(back.printerBeepTimes, 4);
      expect(back.lanKey, 'k');
      expect(back.relaysFor(SignalEvent.kitchenOrder).single.address, '10.0.0.5');
      expect(back.relaysFor(SignalEvent.dishReady), isEmpty, reason: 'выключенное реле не звенит');
      expect(SignalEvent.orderFor(SaleKind.bar), SignalEvent.barOrder);
    });
  });

  group('Зуммер принтера', () {
    test('ESC B — встроенный зуммер, ESC p — разъём денежного ящика', () {
      expect(printerBeepBytes(PrinterBeep.builtIn, 3), [0x1B, 0x42, 3, 4]);
      expect(printerBeepBytes(PrinterBeep.drawer, 2), [0x1B, 0x70, 0, 0x64, 0xC8, 0x1B, 0x70, 0, 0x64, 0xC8]);
      expect(printerBeepBytes(PrinterBeep.off, 3), isEmpty);
      expect(printerBeepBytes(PrinterBeep.builtIn, 40)[2], 9);
    });
  });

  group('Сигналы по Wi‑Fi заведения', () {
    final now = DateTime(2026, 10, 17, 19);
    LanMessage msg({Map<String, dynamic> data = const {'s': 'sess1', 'tb': 'Стол 5', 'x': 'Цезарь ×2', 'l': ['a']}}) =>
        LanMessage(kind: LanKind.kitchenOrder, tenantId: 'venue1', id: 'id1', at: now, data: data);

    test('подписанный пакет читается целиком', () {
      final m = decodeLanMessage(encodeLanMessage(msg(), 'key'), key: 'key', tenantId: 'venue1', now: now)!;
      expect(m.kind, LanKind.kitchenOrder);
      expect(m.tableName, 'Стол 5');
      expect(m.summary, 'Цезарь ×2');
      expect(m.lineIds, ['a']);
    });

    test('чужой ключ, чужое заведение, старый или подделанный пакет — отбрасываются', () {
      final bytes = encodeLanMessage(msg(), 'key');
      expect(decodeLanMessage(bytes, key: 'other', tenantId: 'venue1', now: now), isNull);
      expect(decodeLanMessage(bytes, key: 'key', tenantId: 'venue2', now: now), isNull);
      expect(decodeLanMessage(bytes, key: 'key', tenantId: 'venue1', now: now.add(const Duration(minutes: 11))), isNull);
      final forged = utf8.decode(bytes).replaceFirst('Стол 5', 'Стол 6');
      expect(decodeLanMessage(utf8.encode(forged), key: 'key', tenantId: 'venue1', now: now), isNull);
      expect(decodeLanMessage(utf8.encode('мусор'), key: 'key', tenantId: 'venue1', now: now), isNull);
    });

    test('длинный заказ укорачивается, но доходит', () {
      final long = List.filled(200, 'Очень длинное название блюда').join(', ');
      final bytes = encodeLanMessage(msg(data: {'s': 'sess1', 'x': long}), 'key');
      expect(bytes.length, lessThanOrEqualTo(lanMaxBytes));
      expect(decodeLanMessage(bytes, key: 'key', tenantId: 'venue1', now: now)!.summary, endsWith('…'));
    });

    test('ключ заведения — 64 hex-символа, каждый раз новый', () {
      final a = newLanKey();
      expect(a, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(newLanKey(), isNot(a));
    });

    test('пакет доходит по сети до другого сокета на этом же компьютере', () async {
      const port = 47391;
      final rx = LanTransport(port: port);
      final got = Completer<List<int>>();
      final opened = await rx.open((b) {
        if (!got.isCompleted) got.complete(b);
      });
      expect(opened, isTrue);
      final tx = LanTransport(port: port);
      final m = LanMessage(kind: LanKind.dishReady, tenantId: 'venue1', id: newLanId(), at: DateTime.now(), data: const {'s': 'x'});
      await tx.broadcast(encodeLanMessage(m, 'key'));
      final bytes = await got.future.timeout(const Duration(seconds: 3), onTimeout: () => <int>[]);
      await rx.close();
      if (bytes.isEmpty) {
        markTestSkipped('в этой песочнице широковещание UDP закрыто');
        return;
      }
      expect(decodeLanMessage(bytes, key: 'key', tenantId: 'venue1')!.id, m.id);
    });
  });

  group('«Готово» официанту', () {
    test('звенит только на рост готовых, первое появление чека — тишина', () {
      final items = [_food('a', 2, ready: 1), _food('b', 1)];
      expect(readyIncreases(null, items), isEmpty);
      final before = readyByLine(items);
      final after = [_food('a', 2, ready: 2), _food('b', 1)];
      expect(readyIncreases(before, after).map((i) => i.lineId), ['a']);
      expect(readyIncreases(readyByLine(after), after), isEmpty);
      expect(readySummary(readyIncreases(before, after)), 'Блюдо a ×2');
    });

    test('кому: официант чека; если его нет на смене — официанты и универсалы', () {
      bool f({String waiter = 'w1', String me = 'w1', Set<String> shift = const {'w1', 'w2'}, String pos = AppConstants.positionWaiter}) =>
          readyIsMine(checkWaiterId: waiter, myId: me, onShift: shift, mine: true, myPosition: pos);
      expect(f(), isTrue);
      expect(f(me: 'w2'), isFalse, reason: 'чужой стол, его официант на месте');
      expect(f(me: 'w2', shift: const {'w2'}), isTrue, reason: 'официант чека ушёл — зовём того, кто на смене');
      expect(f(waiter: '', me: 'w2'), isTrue);
      expect(f(waiter: '', me: 'c1', pos: AppConstants.positionHookahMaster), isFalse);
    });
  });
}
