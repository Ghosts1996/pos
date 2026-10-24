import 'dart:async';

import '../build_info.dart';
import '../models/menu_models.dart';
import 'app_scope.dart';
import 'gateway_api.dart';

/// Меню для приложения гостя — с сервера платформы (GET /publicMenu), а не
/// прямо из Firestore. Сервер держит живую копию меню в памяти и тратит
/// лимит Firebase только на изменения; раньше каждый гость при каждом
/// открытии читал из базы всё меню (сотни чтений).
///
/// Меню обновляется раз в [refreshEvery], пока экран открыт. Сервер
/// недоступен или ещё не обновлён — читаем базу напрямую, как раньше:
/// гость меню видит в любом случае.
class PublicMenuService {
  PublicMenuService._();

  static const refreshEvery = Duration(minutes: 2);

  /// Один запрос на блюда и категории сразу: оба потока берут его отсюда.
  static String? _cacheKey;
  static DateTime _cachedAt = DateTime.fromMillisecondsSinceEpoch(0);
  static Future<PublicMenu>? _inFlight;
  static PublicMenu? _cached;

  static bool get enabled => kSaasMode && kSaasGatewayUrl.isNotEmpty;

  static Future<PublicMenu> fetch({bool fresh = false}) {
    final tenantId = AppScope.tenantId;
    if (tenantId == null) return Future.error(StateError('Заведение не выбрано'));
    final key = tenantId;
    final cached = _cached;
    if (!fresh && cached != null && _cacheKey == key && DateTime.now().difference(_cachedAt) < const Duration(seconds: 50)) {
      return Future.value(cached);
    }
    final running = _inFlight;
    if (running != null && _cacheKey == key) return running;
    _cacheKey = key;
    final f = GatewayApi.get('publicMenu', {'tenantId': tenantId}).then((json) {
      final menu = PublicMenu.fromJson(json);
      if (_cacheKey == key) {
        _cached = menu;
        _cachedAt = DateTime.now();
      }
      return menu;
    }).whenComplete(() => _inFlight = null);
    _inFlight = f;
    return f;
  }

  /// Поток: сервер (раз в [refreshEvery]), а если он не ответил — [fallback].
  static Stream<T> stream<T>(T Function(PublicMenu menu) pick, Stream<T> Function() fallback) {
    if (!enabled) return fallback();
    late final StreamController<T> out;
    Timer? timer;
    StreamSubscription<T>? direct;
    var stopped = false;

    void useDirect() {
      if (direct != null || stopped) return;
      timer?.cancel();
      direct = fallback().listen(out.add, onError: out.addError);
    }

    Future<void> poll({bool fresh = false}) async {
      try {
        final menu = await fetch(fresh: fresh);
        if (!stopped) out.add(pick(menu));
      } catch (_) {
        // Сервер недоступен — меню из базы, чтобы гость не остался без него.
        useDirect();
      }
    }

    out = StreamController<T>(
      onListen: () {
        unawaited(poll());
        timer = Timer.periodic(refreshEvery, (_) => unawaited(poll(fresh: true)));
      },
      onCancel: () {
        stopped = true;
        timer?.cancel();
        direct?.cancel();
      },
    );
    return out.stream;
  }
}

class PublicMenu {
  final List<MenuItem> items;
  final List<MenuCategory> categories;
  const PublicMenu(this.items, this.categories);

  factory PublicMenu.fromJson(Map<String, dynamic> json) {
    List<T> parse<T>(Object? raw, T Function(Map<String, dynamic>) from) {
      final out = <T>[];
      for (final m in (raw as List?) ?? const []) {
        if (m is! Map) continue;
        try {
          out.add(from(Map<String, dynamic>.from(m)));
        } catch (_) {}
      }
      return out;
    }

    return PublicMenu(
      parse(json['menuItems'], MenuItem.fromMap).where((i) => i.available).toList(),
      parse(json['menuCategories'], MenuCategory.fromMap)..sort((a, b) => a.order.compareTo(b.order)),
    );
  }
}
