import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

import '../build_info.dart';
import 'app_scope.dart';

/// Что сейчас с обновлением — по этому рисуется плашка (AppUpdateBanner).
enum AppUpdatePhase {
  /// Обновлений нет (или проверка ещё не прошла).
  none,

  /// Вышла новая версия — плашка «Обновить».
  available,

  /// Качаем файл — полоса загрузки.
  downloading,

  /// Файл скачан, осталось подтвердить установку (Android).
  ready,

  /// Ставим: открыт системный установщик / Windows перезапускает кассу.
  installing,

  /// Загрузка не удалась — «Повторить».
  failed,
}

/// Ответ сервера о новой версии (POST /appUpdate, см. handleAppUpdate в
/// saas-gateway/server.js).
class AppUpdateInfo {
  final int buildNumber;
  final int sizeBytes;

  /// Подписанная ссылка на файл — живёт минуту, поэтому перед загрузкой
  /// берётся свежая.
  final String url;

  const AppUpdateInfo({required this.buildNumber, required this.sizeBytes, required this.url});

  /// null — обновления нет или ответ не похож на правду (номер не больше
  /// нашего, ссылка не на файл сборки).
  static AppUpdateInfo? fromJson(Map<String, dynamic> json, {required int current}) {
    if (json['update'] != true) return null;
    final n = json['buildNumber'];
    final url = json['url'];
    if (n is! int || n <= current) return null;
    if (url is! String || !url.startsWith('/downloadBuild?')) return null;
    final size = json['sizeBytes'];
    return AppUpdateInfo(buildNumber: n, sizeBytes: size is int && size > 0 ? size : 0, url: url);
  }
}

@immutable
class AppUpdateState {
  final AppUpdatePhase phase;
  final AppUpdateInfo? info;
  final int received;
  final int total;

  /// Текст для плашки: почему не скачалось / что сделать для установки.
  final String? message;

  const AppUpdateState(this.phase, {this.info, this.received = 0, this.total = 0, this.message});

  static const none = AppUpdateState(AppUpdatePhase.none);

  /// 0..1 или null, если размер неизвестен (тогда полоса «бегущая»).
  double? get progress => total > 0 ? (received / total).clamp(0.0, 1.0) : null;
}

/// Обновление приложения изнутри, без магазина и без ручного скачивания.
///
/// Сборки у каждого заведения свои (конвейер «Собрать APK»), поэтому и
/// обновления приходят не из Google Play, а с сервера платформы:
///  1. приложение спрашивает POST /appUpdate — на старте, при возврате в
///     приложение и по таймеру; сравнивается номер сборки (BUILD_NUMBER,
///     он же versionCode APK) с последней успешной сборкой заведения;
///  2. есть новее — плашка «Вышла новая версия · Обновить»;
///  3. «Обновить» — файл качается прямо в приложении, с полосой загрузки;
///  4. Android: открывается системное «Обновить приложение?» — одно
///     касание «Установить» (без него Android не ставит приложения не из
///     магазина — обойти нельзя, и это правильно). Новая версия ставится
///     ПОВЕРХ: та же подпись и тот же applicationId, поэтому все данные —
///     вход, привязка к заведению, настройки, офлайн-кэш и неотправленные
///     изменения Firestore — остаются на месте;
///     Windows: касса закрывается, новые файлы распаковываются поверх
///     папки программы (данные лежат в профиле пользователя, не там) и
///     касса открывается снова.
/// Перед установкой приложение до 5 секунд ждёт, пока Firestore отправит
/// несохранённые на сервер изменения; не успело (нет сети) — они и так
/// лежат на диске и уйдут после перезапуска.
class AppUpdateService {
  /// 'pos' — касса, 'guest' — приложение гостя.
  final String app;

  /// 'android' | 'windows'.
  final String platform;
  final int currentBuild;
  final String gatewayUrl;
  final http.Client Function() _clientFactory;
  final Future<Directory> Function() _dirProvider;
  final Future<String?> Function() _authToken;
  final String? Function() _tenantId;
  final bool Function() _isForeground;

  AppUpdateService({
    required this.app,
    required this.platform,
    required this.currentBuild,
    required this.gatewayUrl,
    http.Client Function()? clientFactory,
    Future<Directory> Function()? dirProvider,
    Future<String?> Function()? authToken,
    String? Function()? tenantId,
    bool Function()? isForeground,
  })  : _clientFactory = clientFactory ?? http.Client.new,
        _isForeground = isForeground ?? _appInForeground,
        _dirProvider = dirProvider ?? _defaultDir,
        _authToken = authToken ?? _firebaseToken,
        _tenantId = tenantId ?? (() => AppScope.tenantId);

  final ValueNotifier<AppUpdateState> state = ValueNotifier(AppUpdateState.none);

  /// «Позже» — плашка «Вышла новая версия» прячется до этого времени.
  final ValueNotifier<DateTime?> hiddenUntil = ValueNotifier(null);

  static AppUpdateService? _instance;

  /// null — в этой сборке обновления изнутри выключены (веб, iOS,
  /// одно-арендная или универсальная сборка, сборка сети, запуск без CI).
  static AppUpdateService? get instance => _instance;

  @visibleForTesting
  static set debugInstance(AppUpdateService? s) => _instance = s;

  /// Включает проверку обновлений для этого процесса. Вызывается из main()
  /// до runApp — плашка решает, оборачивать ли экраны, по [instance].
  static void start({required String app}) {
    if (_instance != null) return;
    final build = int.tryParse(kBuildNumber) ?? 0;
    if (!kInAppUpdates || !kSaasMode || kSaasGatewayUrl.isEmpty || build <= 0 || kIsWeb) return;
    final String platform;
    if (Platform.isAndroid) {
      platform = 'android';
    } else if (Platform.isWindows && app == 'pos') {
      platform = 'windows';
    } else {
      return;
    }
    // Гостевая сборка «сеть целиком» в конвейере не собирается — её
    // нельзя обновлять сборкой отдельной точки.
    if (app == 'guest' && kSaasPresetChainSlug.isNotEmpty) return;
    _instance = AppUpdateService(app: app, platform: platform, currentBuild: build, gatewayUrl: kSaasGatewayUrl)
      .._begin();
  }

  Timer? _timer;
  AppLifecycleListener? _lifecycle;
  DateTime? _lastCheck;
  bool _checking = false;
  http.Client? _downloadClient;
  bool _cancelled = false;

  /// Касса проверяет чаще: планшет в зале работает сутками и не
  /// перезапускается, а гостевое приложение открывают на время визита.
  Duration get _interval => app == 'pos' ? const Duration(minutes: 30) : const Duration(hours: 3);
  Duration get _resumeGap => app == 'pos' ? const Duration(minutes: 10) : const Duration(hours: 1);

  void _begin() {
    // Первый раз — не в самый старт: там и так грузятся меню, смены, фото.
    Timer(const Duration(seconds: 20), () {
      unawaited(_cleanupOld());
      unawaited(checkNow());
    });
    _timer = Timer.periodic(_interval, (_) => unawaited(checkNow()));
    _lifecycle = AppLifecycleListener(onResume: () {
      final last = _lastCheck;
      if (last == null || DateTime.now().difference(last) >= _resumeGap) unawaited(checkNow());
      // Файл скачался, пока приложение было свёрнуто, — Android не даёт
      // открыть установщик из фона, предлагаем сейчас.
      if (state.value.phase == AppUpdatePhase.ready && _autoInstallPending) {
        _autoInstallPending = false;
        unawaited(install());
      }
    });
  }

  bool _autoInstallPending = false;

  @visibleForTesting
  void dispose() {
    _timer?.cancel();
    _lifecycle?.dispose();
    _downloadClient?.close();
  }

  String get _ext => platform == 'windows' ? 'zip' : 'apk';

  Future<File> _fileFor(int buildNumber) async {
    final dir = await _dirProvider();
    return File('${dir.path}${Platform.pathSeparator}update-$buildNumber.$_ext');
  }

  /// Спросить сервер. null — обновления нет или спросить не получилось
  /// (заведение ещё не выбрано, сервер отказал) — при фоновой проверке это
  /// не ошибка для пользователя; при [strict] (он сам нажал «Обновить») —
  /// ошибка с причиной.
  Future<AppUpdateInfo?> _ask({bool strict = false}) async {
    final tenantId = _tenantId();
    if (tenantId == null || tenantId.isEmpty) return null;
    String? token;
    if (app == 'pos') {
      token = await _authToken();
      if (token == null || token.isEmpty) return null;
    }
    final client = _clientFactory();
    try {
      final resp = await client
          .post(
            Uri.parse('$gatewayUrl/appUpdate'),
            headers: {
              'Content-Type': 'application/json',
              if (token != null) 'Authorization': 'Bearer $token',
            },
            body: jsonEncode({'tenantId': tenantId, 'app': app, 'platform': platform, 'current': currentBuild}),
          )
          .timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) {
        if (strict) throw _UpdateError('сервер обновлений ответил ${resp.statusCode}');
        return null;
      }
      final json = jsonDecode(resp.body);
      if (json is! Map<String, dynamic>) return null;
      return AppUpdateInfo.fromJson(json, current: currentBuild);
    } finally {
      client.close();
    }
  }

  /// Проверить, не вышла ли новая версия. Во время загрузки/установки
  /// ничего не делает.
  Future<void> checkNow() async {
    final phase = state.value.phase;
    if (_checking || phase == AppUpdatePhase.downloading || phase == AppUpdatePhase.installing) return;
    _checking = true;
    try {
      final info = await _ask();
      _lastCheck = DateTime.now();
      final now = state.value.phase;
      if (now == AppUpdatePhase.downloading || now == AppUpdatePhase.installing) return;
      if (info == null) {
        if (now == AppUpdatePhase.available) state.value = AppUpdateState.none;
        return;
      }
      // Уже скачано раньше (например, установку отменили или приложение
      // закрыли) — второй раз не качаем.
      final file = await _fileFor(info.buildNumber);
      final complete = await file.exists() && (info.sizeBytes <= 0 || await file.length() == info.sizeBytes);
      final sameBuild = state.value.info?.buildNumber == info.buildNumber;
      if (complete) {
        // Подсказку про разрешение на установку не затираем.
        if (now != AppUpdatePhase.ready || !sameBuild) state.value = AppUpdateState(AppUpdatePhase.ready, info: info);
      } else if (now != AppUpdatePhase.failed || !sameBuild) {
        state.value = AppUpdateState(AppUpdatePhase.available, info: info);
      }
    } catch (_) {
      // Нет сети — спросим в следующий раз.
    } finally {
      _checking = false;
    }
  }

  /// «Позже» — спрятать плашку на несколько часов.
  void later() {
    hiddenUntil.value = DateTime.now().add(app == 'pos' ? const Duration(hours: 4) : const Duration(hours: 12));
  }

  /// Видна ли сейчас плашка.
  bool visibleFor(AppUpdateState s, {DateTime? now}) {
    switch (s.phase) {
      case AppUpdatePhase.none:
        return false;
      case AppUpdatePhase.available:
      case AppUpdatePhase.failed:
        final until = hiddenUntil.value;
        return until == null || (now ?? DateTime.now()).isAfter(until);
      case AppUpdatePhase.downloading:
      case AppUpdatePhase.ready:
      case AppUpdatePhase.installing:
        return true;
    }
  }

  /// Скачать новую версию с полосой загрузки; скачалось — сразу к установке.
  Future<void> download() async {
    final phase = state.value.phase;
    if (phase == AppUpdatePhase.downloading || phase == AppUpdatePhase.installing) return;
    hiddenUntil.value = null;
    _cancelled = false;
    state.value = AppUpdateState(AppUpdatePhase.downloading, info: state.value.info);

    if (platform == 'windows') {
      final problem = await _windowsCanReplace();
      if (problem != null) {
        state.value = AppUpdateState(AppUpdatePhase.failed, info: state.value.info, message: problem);
        return;
      }
    }

    File? part;
    IOSink? sink;
    try {
      // Ссылка живёт минуту — берём свежую прямо перед загрузкой.
      final info = await _ask(strict: true);
      if (info == null) {
        // Сервер говорит, что эта версия уже последняя.
        state.value = AppUpdateState.none;
        return;
      }
      final target = await _fileFor(info.buildNumber);
      part = File('${target.path}.part');
      final client = _downloadClient = _clientFactory();
      final resp = await client
          .send(http.Request('GET', Uri.parse('$gatewayUrl${info.url}')))
          .timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) {
        throw _UpdateError('сервер ответил ${resp.statusCode}');
      }
      final total = (resp.contentLength ?? 0) > 0 ? resp.contentLength! : info.sizeBytes;
      state.value = AppUpdateState(AppUpdatePhase.downloading, info: info, total: total);
      sink = part.openWrite();
      var received = 0;
      var shownPermille = -1;
      final header = <int>[];
      // Обрыв без единого байта 30 секунд — считаем, что связь пропала.
      await for (final chunk in resp.stream.timeout(const Duration(seconds: 30))) {
        if (_cancelled) break;
        if (header.length < 2) header.addAll(chunk.take(2 - header.length));
        sink.add(chunk);
        received += chunk.length;
        final permille = total > 0 ? received * 1000 ~/ total : received ~/ (256 * 1024);
        if (permille != shownPermille) {
          shownPermille = permille;
          state.value = AppUpdateState(AppUpdatePhase.downloading, info: info, received: received, total: total);
        }
      }
      await sink.close();
      sink = null;
      if (_cancelled) {
        await _deleteQuietly(part);
        state.value = AppUpdateState(AppUpdatePhase.available, info: info);
        return;
      }
      if (total > 0 && received != total) throw _UpdateError('файл скачался не полностью');
      // И APK, и zip — это zip-архивы: начинаются с «PK». Не «PK» —
      // пришла страница ошибки, а не сборка; ставить её нельзя.
      if (header.length < 2 || header[0] != 0x50 || header[1] != 0x4B) {
        throw _UpdateError('сервер прислал не файл сборки');
      }
      if (await target.exists()) await target.delete();
      await part.rename(target.path);
      state.value = AppUpdateState(AppUpdatePhase.ready, info: info);
      if (_isForeground()) {
        await install();
      } else {
        _autoInstallPending = true;
      }
    } catch (e) {
      try {
        await sink?.close();
      } catch (_) {}
      if (part != null) await _deleteQuietly(part);
      if (_cancelled) {
        state.value = AppUpdateState(AppUpdatePhase.available, info: state.value.info);
      } else {
        state.value = AppUpdateState(AppUpdatePhase.failed, info: state.value.info, message: _describe(e));
      }
    } finally {
      _downloadClient?.close();
      _downloadClient = null;
    }
  }

  /// «Отмена» во время загрузки.
  void cancel() {
    if (state.value.phase != AppUpdatePhase.downloading) return;
    _cancelled = true;
    _downloadClient?.close();
  }

  /// Поставить скачанную версию поверх текущей.
  Future<void> install() async {
    final info = state.value.info;
    if (info == null) return;
    final file = await _fileFor(info.buildNumber);
    if (!await file.exists()) {
      state.value = AppUpdateState(AppUpdatePhase.available, info: info);
      return;
    }
    state.value = AppUpdateState(AppUpdatePhase.installing, info: info);
    await _flushPendingWrites();
    try {
      if (platform == 'windows') {
        await _installWindows(file);
        return;
      }
      // Android 8+: ставить APK можно только с разрешения «Установка
      // неизвестных приложений» для этого приложения — один раз, дальше
      // обновления идут без этого шага.
      if (!await Permission.requestInstallPackages.isGranted) {
        final status = await Permission.requestInstallPackages.request();
        if (!status.isGranted) {
          state.value = AppUpdateState(AppUpdatePhase.ready,
              info: info,
              message: 'Разрешите этому приложению устанавливать обновления '
                  '(откроются настройки) и нажмите «Установить» ещё раз.');
          return;
        }
      }
      final result = await OpenFilex.open(file.path, type: 'application/vnd.android.package-archive');
      if (result.type != ResultType.done) throw _UpdateError(result.message);
      // Открылся системный установщик. Отменили его — плашка остаётся с
      // кнопкой «Установить»; подтвердили — Android заменит приложение.
      state.value = AppUpdateState(AppUpdatePhase.ready, info: info);
    } catch (e) {
      state.value = AppUpdateState(AppUpdatePhase.ready, info: info, message: 'Не удалось открыть установку: ${_describe(e)}');
    }
  }

  Future<void> _flushPendingWrites() async {
    try {
      await FirebaseFirestore.instance.waitForPendingWrites().timeout(const Duration(seconds: 5));
    } catch (_) {
      // Нет сети — изменения лежат в офлайн-кэше на диске и уйдут после перезапуска.
    }
  }

  // ---------- Windows ----------

  /// Папка программы должна быть доступна на запись — иначе новые файлы
  /// некуда положить (например, касса стоит в Program Files).
  Future<String?> _windowsCanReplace() async {
    try {
      final dir = File(Platform.resolvedExecutable).parent;
      final probe = File('${dir.path}\\.update_probe');
      await probe.writeAsString('ok');
      await probe.delete();
      return null;
    } catch (_) {
      return 'Нет прав на запись в папку кассы — скачайте новую версию в личном кабинете и распакуйте вручную.';
    }
  }

  Future<void> _installWindows(File zip) async {
    final exe = Platform.resolvedExecutable;
    final dir = File(exe).parent.path;
    final script = File('${zip.parent.path}\\apply-update.ps1');
    // С BOM: Windows PowerShell без него читает скрипт в кодировке ANSI и
    // портит кириллицу в путях (C:\Users\Иван\...).
    await script.writeAsBytes([0xEF, 0xBB, 0xBF, ...utf8.encode(windowsUpdateScript(pid: pid, zip: zip.path, dir: dir, exe: exe))]);
    await Process.start(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script.path],
      mode: ProcessStartMode.detached,
    );
    await Future<void>.delayed(const Duration(milliseconds: 400));
    exit(0);
  }

  /// Скрипт, который ставит Windows-сборку поверх: ждёт, пока касса
  /// закроется, распаковывает архив во временную папку (битый архив —
  /// старая версия не тронута), копирует поверх папки программы и
  /// запускает кассу снова.
  @visibleForTesting
  static String windowsUpdateScript({required int pid, required String zip, required String dir, required String exe}) {
    String q(String s) => "'${s.replaceAll("'", "''")}'";
    return '''
\$ErrorActionPreference = 'Stop'
\$appPid = $pid
\$zip = ${q(zip)}
\$dest = ${q(dir)}
\$exe = ${q(exe)}
try { Wait-Process -Id \$appPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 500
\$tmp = Join-Path \$env:TEMP ('hookah-pos-update-' + [guid]::NewGuid().ToString('N'))
try {
  Expand-Archive -LiteralPath \$zip -DestinationPath \$tmp -Force
  Copy-Item -Path (Join-Path \$tmp '*') -Destination \$dest -Recurse -Force
  Remove-Item -LiteralPath \$zip -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item -LiteralPath \$tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath \$exe)) {
  \$found = Get-ChildItem -LiteralPath \$dest -Filter *.exe | Select-Object -First 1
  if (\$found) { \$exe = \$found.FullName }
}
Start-Process -FilePath \$exe -WorkingDirectory \$dest
''';
  }

  // ---------- общее ----------

  /// Скачанные файлы старых версий (эта уже стоит) — удалить.
  Future<void> _cleanupOld() async {
    try {
      final dir = await _dirProvider();
      if (!await dir.exists()) return;
      await for (final f in dir.list()) {
        final m = RegExp(r'update-(\d+)\.(apk|zip)(\.part)?$').firstMatch(f.path);
        if (m == null) continue;
        final n = int.parse(m.group(1)!);
        if (n <= currentBuild || m.group(3) != null) await _deleteQuietly(f);
      }
    } catch (_) {}
  }

  static Future<void> _deleteQuietly(FileSystemEntity f) async {
    try {
      await f.delete();
    } catch (_) {}
  }

  static String _describe(Object e) {
    if (e is _UpdateError) return e.message;
    if (e is TimeoutException) return 'связь пропала — проверьте интернет';
    if (e is SocketException || e is http.ClientException) return 'нет связи с сервером — проверьте интернет';
    if (e is FileSystemException) return 'не хватает места на устройстве';
    return e.toString();
  }

  static Future<Directory> _defaultDir() async {
    final base = await getTemporaryDirectory();
    final dir = Directory('${base.path}${Platform.pathSeparator}app_update');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  static bool _appInForeground() => WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;

  static Future<String?> _firebaseToken() async => FirebaseAuth.instance.currentUser?.getIdToken();
}

class _UpdateError implements Exception {
  final String message;
  _UpdateError(this.message);
  @override
  String toString() => message;
}

/// «48,2 МБ» — размер обновления для плашки.
String formatUpdateSize(int bytes) {
  if (bytes <= 0) return '';
  final mb = bytes / (1024 * 1024);
  final s = mb >= 10 ? mb.toStringAsFixed(0) : mb.toStringAsFixed(1);
  return '${s.replaceAll('.', ',')} МБ';
}
