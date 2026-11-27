import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/apk_patch.dart';
import 'package:hookah_pos/services/app_update_service.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Обновление «как у Google»: касса собирает новую версию из установленной и
/// патча сервера (saas-gateway/apk-delta.js). Образцы в test/fixtures/apk_delta
/// построены серверным кодом (test.apk-delta.js проверяет, что они сходятся).
void main() {
  const fx = 'test/fixtures/apk_delta';
  final oldApk = File('$fx/old.bin');
  final newApk = File('$fx/new.bin');
  final patch = File('$fx/update.zpatch');
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('apk_patch_test'));
  tearDown(() async {
    AppUpdateService.debugInstalledApk = null;
    if (await dir.exists()) await dir.delete(recursive: true);
  });

  test('патч сервера собирает новую версию байт в байт', () async {
    final out = '${dir.path}/out.apk';
    await ApkPatch.apply(oldPath: oldApk.path, patchPath: patch.path, outPath: out);
    expect(await File(out).readAsBytes(), await newApk.readAsBytes());
    expect(ApkPatch.fileSha256(out), sha256.convert(await newApk.readAsBytes()).toString());
  });

  test('к другой версии патч не применяется', () async {
    expect(
      () => ApkPatch.applySync(oldPath: newApk.path, patchPath: patch.path, outPath: '${dir.path}/x.apk'),
      throwsA(isA<ApkPatchException>()),
    );
  });

  test('оборванный патч — ошибка, а не битый файл', () async {
    final raw = gzip.decode(await patch.readAsBytes());
    final cut = File('${dir.path}/cut.zpatch')..writeAsBytesSync(gzip.encode(raw.sublist(0, raw.length ~/ 2)));
    expect(
      () => ApkPatch.applySync(oldPath: oldApk.path, patchPath: cut.path, outPath: '${dir.path}/x.apk'),
      throwsA(isA<ApkPatchException>()),
    );
  });

  group('AppUpdateService', () {
    final newBytes = newApk.readAsBytesSync();
    final oldBytes = oldApk.readAsBytesSync();
    final patchBytes = patch.readAsBytesSync();
    final asked = <String>[];

    http.Client client() => MockClient.streaming((req, body) async {
          asked.add(req.url.toString());
          if (req.url.path.endsWith('/appUpdate')) {
            return http.StreamedResponse(
                Stream.value(utf8.encode(jsonEncode({
                  'update': true,
                  'buildNumber': 101,
                  'sizeBytes': newBytes.length,
                  'url': '/downloadBuild?jobId=j101&token=1.ab',
                  'patch': {
                    'url': '/downloadBuild?jobId=j101&token=1.ab&from=100',
                    'sizeBytes': patchBytes.length,
                    'sha256': sha256.convert(newBytes).toString(),
                    'fromSize': oldBytes.length,
                    'fromSha256': sha256.convert(oldBytes).toString(),
                  },
                }))),
                200);
          }
          final bytes = req.url.queryParameters.containsKey('from') ? patchBytes : newBytes;
          return http.StreamedResponse(Stream.value(bytes), 200, contentLength: bytes.length);
        });

    AppUpdateService svc() => AppUpdateService(
          app: 'pos',
          platform: 'android',
          currentBuild: 100,
          gatewayUrl: 'https://gw.test/saas',
          clientFactory: client,
          dirProvider: () async => dir,
          authToken: () async => 'tok',
          tenantId: () => 'tenant1',
          isForeground: () => false,
        );

    test('качает патч, а не весь файл, и собирает новую версию', () async {
      asked.clear();
      AppUpdateService.debugInstalledApk = (size) async => size == oldBytes.length ? oldApk.path : null;
      final s = svc();
      await s.checkNow();
      await s.download(openInstaller: false);
      expect(s.state.value.phase, AppUpdatePhase.ready);
      expect(await File('${dir.path}/update-101.apk').readAsBytes(), newBytes);
      expect(asked.where((u) => u.contains('downloadBuild')), ['https://gw.test/saas/downloadBuild?jobId=j101&token=1.ab&from=100']);
      expect(dir.listSync().map((f) => f.uri.pathSegments.last).toList(), ['update-101.apk']);
    });

    test('установлена другая версия — качает целиком', () async {
      asked.clear();
      AppUpdateService.debugInstalledApk = (size) async => null;
      final s = svc();
      await s.checkNow();
      await s.download(openInstaller: false);
      expect(s.state.value.phase, AppUpdatePhase.ready);
      expect(await File('${dir.path}/update-101.apk').readAsBytes(), newBytes);
      expect(asked.where((u) => u.contains('downloadBuild')), ['https://gw.test/saas/downloadBuild?jobId=j101&token=1.ab']);
    });

    test('установленный файл не тот (отпечаток) — качает целиком', () async {
      asked.clear();
      final fake = File('${dir.path}/fake.apk')..writeAsBytesSync(List.filled(oldBytes.length, 1));
      AppUpdateService.debugInstalledApk = (size) async => fake.path;
      final s = svc();
      await s.checkNow();
      await s.download(openInstaller: false);
      expect(await File('${dir.path}/update-101.apk').readAsBytes(), newBytes);
      expect(asked.where((u) => u.contains('from=')), isEmpty);
    });
  });

  test('патч ещё готовится — ничего не качаем, честно говорим и спросим позже', () async {
    final asked = <String>[];
    final s = AppUpdateService(
      app: 'pos',
      platform: 'android',
      currentBuild: 100,
      gatewayUrl: 'https://gw.test/saas',
      clientFactory: () => MockClient((req) async {
        asked.add(req.url.path);
        return http.Response(jsonEncode({'update': false, 'preparing': true, 'buildNumber': 101, 'retryInSec': 60}), 200);
      }),
      dirProvider: () async => dir,
      authToken: () async => 'tok',
      tenantId: () => 'tenant1',
      isForeground: () => false,
    );
    final text = await s.checkManually();
    expect(text, contains('готовит маленькое обновление'));
    expect(s.preparingBuild, 101);
    expect(s.state.value.phase, AppUpdatePhase.none);
    expect(asked.where((p) => p.contains('downloadBuild')), isEmpty);
    s.dispose();
  });

  test('ответ без патча или с кривым патчем — обычное обновление', () {
    final base = {'update': true, 'buildNumber': 50, 'sizeBytes': 10, 'url': '/downloadBuild?jobId=a&token=b'};
    expect(AppUpdateInfo.fromJson(base, current: 49)?.patch, isNull);
    final bad = AppUpdateInfo.fromJson({...base, 'patch': {'url': 'https://evil/x', 'sizeBytes': 1}}, current: 49);
    expect(bad?.patch, isNull);
    expect(bad?.buildNumber, 50);
  });
}
