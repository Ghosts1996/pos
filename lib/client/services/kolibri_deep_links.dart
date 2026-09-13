import 'dart:async';
import 'package:app_links/app_links.dart';
import '../../models/table_model.dart';
import '../../services/guest_link_service.dart';
import 'kolibri_auth_service.dart';

/// Обработка ссылок вида `kolibri://table/{tableId}`.
///
/// Гость наводит обычную камеру телефона на QR со стола — Android
/// открывает приложение по этой схеме, и стол привязывается сам, без
/// встроенного сканера. Если приложение было закрыто, ссылка приходит
/// первым же событием при запуске.
class KolibriDeepLinks {
  KolibriDeepLinks._();
  static final KolibriDeepLinks instance = KolibriDeepLinks._();

  final _links = AppLinks();
  final _auth = KolibriAuthService();
  final _guest = GuestLinkService();

  StreamSubscription? _sub;

  /// Вызывается, когда стол успешно привязан — оболочка переключает
  /// вкладку на «Мой стол».
  void Function(String sessionId)? onTableBound;

  /// Вызывается, если за столом нет открытого чека.
  void Function(String message)? onFailed;

  /// За столом несколько открытых чеков — нужно спросить гостя, какой его.
  void Function(String tableId, String tableName, List<TableCheck> checks)?
      onChooseCheck;

  Future<void> start() async {
    if (_sub != null) return;

    // Ссылка, с которой приложение запустили (было закрыто).
    try {
      final initial = await _links.getInitialLink();
      if (initial != null) unawaited(_handle(initial));
    } catch (_) {}

    // Ссылки, пришедшие пока приложение открыто.
    _sub = _links.uriLinkStream.listen(
      (uri) => unawaited(_handle(uri)),
      onError: (_) {},
    );
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
  }

  Future<void> _handle(Uri uri) async {
    final tableId = _extractTableId(uri);
    if (tableId == null) return;

    try {
      await _auth.ensureGuest();
      final result = await _guest.bindToTable(_auth.uid, tableId);
      if (result.isEmpty) {
        onFailed?.call('За этим столом сейчас нет открытого счёта — '
            'попросите кальянщика начать сеанс');
        return;
      }
      if (result.needsChoice) {
        onChooseCheck?.call(tableId, result.tableName, result.choices);
        return;
      }
      onTableBound?.call(result.sessionId!);
    } on SessionTakenException catch (e) {
      onFailed?.call('$e');
    } catch (e) {
      onFailed?.call('Не удалось открыть стол: $e');
    }
  }

  /// Поддерживаем и `kolibri://table/xxx`, и обычную ссылку с параметром
  /// `?table=xxx` — чтобы старые наклейки продолжали работать.
  String? _extractTableId(Uri uri) {
    if (uri.scheme == 'kolibri') {
      if (uri.host == 'table' && uri.pathSegments.isNotEmpty) {
        return uri.pathSegments.last;
      }
      if (uri.pathSegments.length >= 2 && uri.pathSegments.first == 'table') {
        return uri.pathSegments.last;
      }
    }
    final param = uri.queryParameters['table'];
    if (param != null && param.isNotEmpty) return param;

    final segments = uri.pathSegments;
    if (segments.length >= 2 && segments[segments.length - 2] == 'table') {
      return segments.last;
    }
    return null;
  }
}
