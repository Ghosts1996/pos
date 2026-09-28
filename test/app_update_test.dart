import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/app_update_service.dart';
import 'package:hookah_pos/widgets/app_update_banner.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Сервер обновлений из теста: /appUpdate отвечает JSON, /downloadBuild —
/// байтами «сборки» кусками.
class _FakeServer {
  int latest;
  List<int> file;
  int status = 200;
  int? contentLength;
  Duration chunkDelay = Duration.zero;
  final asked = <Map<String, dynamic>>[];
  final authHeaders = <String?>[];

  _FakeServer({this.latest = 43, List<int>? file}) : file = file ?? [0x50, 0x4B, ...List.filled(4094, 7)];

  http.Client client() => MockClient.streaming((req, body) async {
        if (req.url.path.endsWith('/appUpdate')) {
          final json = jsonDecode(await body.bytesToString()) as Map<String, dynamic>;
          asked.add(json);
          authHeaders.add(req.headers['Authorization']);
          final current = json['current'] as int;
          final res = latest > current
              ? {'update': true, 'buildNumber': latest, 'sizeBytes': file.length, 'url': '/downloadBuild?jobId=j$latest&token=1.ab'}
              : {'update': false, 'buildNumber': latest};
          return http.StreamedResponse(Stream.value(utf8.encode(jsonEncode(res))), 200);
        }
        expect(req.url.toString(), 'https://gw.test/saas/downloadBuild?jobId=j$latest&token=1.ab');
        Stream<List<int>> chunks() async* {
          for (var i = 0; i < file.length; i += 1024) {
            if (chunkDelay > Duration.zero) await Future<void>.delayed(chunkDelay);
            yield file.sublist(i, i + 1024 > file.length ? file.length : i + 1024);
          }
        }

        return http.StreamedResponse(chunks(), status, contentLength: contentLength ?? file.length);
      });
}

AppUpdateService _svc(_FakeServer server, Directory dir,
        {String app = 'guest', int current = 42, String platform = 'android', bool autoDownload = false}) =>
    AppUpdateService(
      autoDownload: autoDownload,
      app: app,
      platform: platform,
      currentBuild: current,
      gatewayUrl: 'https://gw.test/saas',
      clientFactory: server.client,
      dirProvider: () async => dir,
      authToken: () async => 'tok',
      tenantId: () => 'tenant1',
      isForeground: () => false,
    );

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('app_update_test'));
  tearDown(() async {
    AppUpdateService.debugInstance = null;
    if (await dir.exists()) await dir.delete(recursive: true);
  });

  group('Ответ сервера', () {
    test('обновление есть — номер больше нашего и ссылка на файл сборки', () {
      final i = AppUpdateInfo.fromJson(
          {'update': true, 'buildNumber': 50, 'sizeBytes': 1000, 'url': '/downloadBuild?jobId=a&token=b'},
          current: 49);
      expect(i?.buildNumber, 50);
      expect(i?.sizeBytes, 1000);
    });
    test('не больше нашего, чужая ссылка или «нет» — обновления нет', () {
      expect(AppUpdateInfo.fromJson({'update': true, 'buildNumber': 49, 'url': '/downloadBuild?x'}, current: 49), isNull);
      expect(AppUpdateInfo.fromJson({'update': true, 'buildNumber': 50, 'url': 'https://evil/x.apk'}, current: 49), isNull);
      expect(AppUpdateInfo.fromJson({'update': false, 'buildNumber': 50}, current: 49), isNull);
    });
    test('размер для плашки', () {
      expect(formatUpdateSize(50 * 1024 * 1024), '50 МБ');
      expect(formatUpdateSize(3 * 1024 * 1024 + 300 * 1024), '3,3 МБ');
      expect(formatUpdateSize(0), '');
    });
  });

  group('Проверка и загрузка', () {
    test('касса спрашивает со своим номером, платформой и токеном', () async {
      final server = _FakeServer();
      final s = _svc(server, dir, app: 'pos');
      await s.checkNow();
      expect(server.asked.single, {'tenantId': 'tenant1', 'app': 'pos', 'platform': 'android', 'current': 42});
      expect(server.authHeaders.single, 'Bearer tok');
      expect(s.state.value.phase, AppUpdatePhase.available);
      expect(s.state.value.info?.buildNumber, 43);
    });

    test('гость спрашивает без входа', () async {
      final server = _FakeServer();
      await _svc(server, dir).checkNow();
      expect(server.authHeaders.single, isNull);
    });

    test('та же версия — плашки нет', () async {
      final server = _FakeServer(latest: 42);
      final s = _svc(server, dir);
      await s.checkNow();
      expect(s.state.value.phase, AppUpdatePhase.none);
    });

    test('загрузка идёт с прогрессом и кладёт файл целиком', () async {
      final server = _FakeServer();
      final s = _svc(server, dir);
      await s.checkNow();
      final seen = <double>[];
      s.state.addListener(() {
        final p = s.state.value.progress;
        if (s.state.value.phase == AppUpdatePhase.downloading && p != null) seen.add(p);
      });
      await s.download();
      expect(s.state.value.phase, AppUpdatePhase.ready);
      expect(seen.first, lessThan(0.5));
      expect(seen.last, 1.0);
      final f = File('${dir.path}/update-43.apk');
      expect(await f.readAsBytes(), server.file);
      expect(await File('${f.path}.part').exists(), isFalse);
    });

    test('автообновление: нашлась новая версия — качается сама, дальше одно «Установить»', () async {
      final server = _FakeServer();
      final s = _svc(server, dir, app: 'pos', autoDownload: true);
      await s.checkNow();
      for (var i = 0; i < 50 && s.state.value.phase != AppUpdatePhase.ready; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(s.state.value.phase, AppUpdatePhase.ready);
      expect(await File('${dir.path}/update-43.apk').readAsBytes(), server.file);
    });

    test('автообновление: после «Отмены» сама загрузка второй раз не начинается', () async {
      final server = _FakeServer()..chunkDelay = const Duration(milliseconds: 5);
      final s = _svc(server, dir, autoDownload: true);
      await s.checkNow();
      await Future<void>.delayed(const Duration(milliseconds: 12));
      expect(s.state.value.phase, AppUpdatePhase.downloading);
      s.cancel();
      for (var i = 0; i < 50 && s.state.value.phase == AppUpdatePhase.downloading; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(s.state.value.phase, AppUpdatePhase.available);
      await s.checkNow();
      expect(s.state.value.phase, AppUpdatePhase.available);
    });

    test('уже скачанная версия — сразу «Установить», без второй загрузки', () async {
      final server = _FakeServer();
      await File('${dir.path}/update-43.apk').writeAsBytes(server.file);
      final s = _svc(server, dir);
      await s.checkNow();
      expect(s.state.value.phase, AppUpdatePhase.ready);
    });

    test('вместо сборки пришла страница — не ставим', () async {
      final server = _FakeServer(file: utf8.encode('<html>502 Bad Gateway</html>'));
      final s = _svc(server, dir);
      await s.checkNow();
      await s.download();
      expect(s.state.value.phase, AppUpdatePhase.failed);
      expect(s.state.value.message, contains('не файл сборки'));
      expect(await File('${dir.path}/update-43.apk').exists(), isFalse);
    });

    test('оборвалось на середине — «Повторить», недокачанный файл удалён', () async {
      final server = _FakeServer()..contentLength = 9000;
      final s = _svc(server, dir);
      await s.checkNow();
      await s.download();
      expect(s.state.value.phase, AppUpdatePhase.failed);
      expect(s.state.value.message, contains('не полностью'));
      expect(dir.listSync(), isEmpty);
    });

    test('сервер отказал — понятная причина', () async {
      final server = _FakeServer()..status = 403;
      final s = _svc(server, dir);
      await s.checkNow();
      await s.download();
      expect(s.state.value.phase, AppUpdatePhase.failed);
      expect(s.state.value.message, contains('403'));
    });

    test('«Отмена» во время загрузки возвращает плашку «Обновить»', () async {
      final server = _FakeServer(file: [0x50, 0x4B, ...List.filled(20000, 1)])..chunkDelay = const Duration(milliseconds: 5);
      final s = _svc(server, dir);
      await s.checkNow();
      final done = s.download();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(s.state.value.phase, AppUpdatePhase.downloading);
      s.cancel();
      await done;
      expect(s.state.value.phase, AppUpdatePhase.available);
      expect(dir.listSync(), isEmpty);
    });

    test('«Позже» прячет плашку, но не загрузку', () async {
      final s = _svc(_FakeServer(), dir);
      await s.checkNow();
      expect(s.visibleFor(s.state.value), isTrue);
      s.later();
      expect(s.visibleFor(s.state.value), isFalse);
      expect(s.visibleFor(s.state.value, now: DateTime.now().add(const Duration(hours: 13))), isTrue);
      expect(s.visibleFor(AppUpdateState(AppUpdatePhase.downloading, info: s.state.value.info)), isTrue);
    });
  });

  group('Windows', () {
    test('скрипт ждёт закрытия кассы, распаковывает во временную папку и перезапускает', () {
      final script = AppUpdateService.windowsUpdateScript(
          pid: 4242, zip: r"C:\Temp\app_update\update-43.zip", dir: r"C:\Users\Иван\Касса O'Neil", exe: r"C:\Users\Иван\Касса O'Neil\hookah_pos.exe");
      expect(script, contains(r'$appPid = 4242'));
      expect(script, contains('Wait-Process -Id \$appPid'));
      expect(script, contains(r"$dest = 'C:\Users\Иван\Касса O''Neil'"));
      expect(script.indexOf('Expand-Archive'), lessThan(script.indexOf('Copy-Item')));
      expect(script.trim().split('\n').last, startsWith('Start-Process -FilePath \$exe'));
    });
  });

  group('Плашка', () {
    Widget app(GlobalKey<NavigatorState> nav) => MaterialApp(
          navigatorKey: nav,
          theme: ThemeData.dark(),
          builder: (context, child) => AppUpdateBanner(child: child!),
          home: const Scaffold(body: Text('Главный')),
        );

    testWidgets('появление плашки не сбрасывает открытые экраны', (tester) async {
      final s = _svc(_FakeServer(), dir);
      AppUpdateService.debugInstance = s;
      final nav = GlobalKey<NavigatorState>();
      await tester.pumpWidget(app(nav));
      nav.currentState!.push(MaterialPageRoute(builder: (_) => const Scaffold(body: Text('Стол 5'))));
      await tester.pumpAndSettle();

      s.state.value = const AppUpdateState(AppUpdatePhase.available,
          info: AppUpdateInfo(buildNumber: 43, sizeBytes: 50 * 1024 * 1024, url: '/downloadBuild?x'));
      await tester.pumpAndSettle();
      expect(find.text('Вышла новая версия приложения'), findsOneWidget);
      expect(find.textContaining('50 МБ'), findsOneWidget);
      expect(find.text('Стол 5'), findsOneWidget);
      expect(nav.currentState!.canPop(), isTrue);

      await tester.tap(find.text('Позже'));
      await tester.pumpAndSettle();
      expect(find.text('Вышла новая версия приложения'), findsNothing);
      expect(find.text('Стол 5'), findsOneWidget);
    });

    testWidgets('загрузка: проценты, мегабайты и полоса', (tester) async {
      final s = _svc(_FakeServer(), dir);
      AppUpdateService.debugInstance = s;
      s.state.value = const AppUpdateState(AppUpdatePhase.downloading,
          info: AppUpdateInfo(buildNumber: 43, sizeBytes: 0, url: '/downloadBuild?x'), received: 20 * 1024 * 1024, total: 50 * 1024 * 1024);
      await tester.pumpWidget(app(GlobalKey<NavigatorState>()));
      await tester.pump();
      expect(find.text('Загружаем обновление · 40%'), findsOneWidget);
      expect(find.textContaining('20 МБ из 50 МБ'), findsOneWidget);
      final bar = tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
      expect(bar.value, closeTo(0.4, 0.001));
      expect(find.text('Отмена'), findsOneWidget);
    });

    testWidgets('в сборке без обновлений экран не оборачивается', (tester) async {
      AppUpdateService.debugInstance = null;
      await tester.pumpWidget(app(GlobalKey<NavigatorState>()));
      expect(find.byType(Column), findsNothing);
      expect(find.text('Главный'), findsOneWidget);
    });
  });

  group('«Проверить обновления» из меню', () {
    test('последняя версия — так и говорим, с номером сборки', () async {
      final svc = _svc(_FakeServer(latest: 42), dir);
      expect(await svc.checkManually(), 'У вас последняя версия (сборка 42)');
      expect(svc.state.value.phase, AppUpdatePhase.none);
    });

    test('вышла новая — сообщаем номер и показываем плашку, даже если нажимали «Позже»', () async {
      final svc = _svc(_FakeServer(latest: 43), dir);
      svc.later();
      final text = await svc.checkManually();
      expect(text, contains('сборка 43'));
      expect(svc.state.value.phase, AppUpdatePhase.available);
      expect(svc.visibleFor(svc.state.value), isTrue);
    });

    AppUpdateService failing(int status, String body) => AppUpdateService(
          app: 'pos',
          platform: 'android',
          currentBuild: 23,
          gatewayUrl: 'https://gw.test/saas',
          clientFactory: () => MockClient((_) async => http.Response.bytes(utf8.encode(body), status,
              headers: {'content-type': 'application/json; charset=utf-8'})),
          dirProvider: () async => dir,
          authToken: () async => 'tok',
          tenantId: () => 'tenant1',
          isForeground: () => false,
        );

    test('на сервере старый saas-gateway без /appUpdate — понятная подсказка', () async {
      final text = await failing(404, '{"error":"not found"}').checkManually();
      expect(text, contains('обновите saas-gateway'));
    });

    test('ошибка сервера со своим текстом — показываем его', () async {
      final text = await failing(404, '{"error":"Заведение не найдено"}').checkManually();
      expect(text, 'Не удалось проверить: Заведение не найдено');
    });

    test('нет доступа', () async {
      expect(await failing(401, '{"error":"x"}').checkManually(), contains('войдите в кассу заново'));
    });

    test('устройство не привязано к заведению', () async {
      final svc = AppUpdateService(
        app: 'pos',
        platform: 'android',
        currentBuild: 23,
        gatewayUrl: 'https://gw.test/saas',
        clientFactory: () => MockClient((_) async => http.Response('{}', 200)),
        dirProvider: () async => dir,
        authToken: () async => 'tok',
        tenantId: () => null,
        isForeground: () => false,
      );
      expect(await svc.checkManually(), 'Устройство ещё не привязано к заведению');
    });
  });
}
