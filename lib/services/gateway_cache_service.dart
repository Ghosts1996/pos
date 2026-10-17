import 'dart:async';

import '../build_info.dart';
import '../models/employee.dart';
import '../models/menu_models.dart';
import '../models/venue_models.dart';
import 'gateway_api.dart';

/// Кеш статических данных заведения, получаемых с saas-gateway.
///
/// Снижает количество прямых чтений Firestore: меню, сотрудники и профиль
/// заведения читаются сервером один раз и отдаются всем устройствам из
/// серверного кеша (TTL 5 мин). Приложение запрашивает данные раз в 5 минут
/// вместо того, чтобы держать постоянные snapshot-listeners.
///
/// Работает только в SaaS-режиме с настроенным [kSaasGatewayUrl].
/// При недоступности сервера молча пропускает — приложение продолжает
/// работать через прямые Firestore-подписки.
class GatewayCacheService {
  GatewayCacheService._();
  static final instance = GatewayCacheService._();

  List<MenuCategory> menuCategories = const [];
  List<MenuItem> menuItems = const [];
  List<Employee> employees = const [];
  VenueProfile? venueProfile;

  bool get hasData => menuCategories.isNotEmpty || menuItems.isNotEmpty;

  /// Сервер хоть раз ответил. До этого экраны читают базу напрямую:
  /// иначе пустой кеш или недоступный сервер оставляли «Меню»,
  /// «Сотрудников» и «Зарплату» с вечной загрузкой.
  bool loaded = false;

  final _catCtrl = StreamController<List<MenuCategory>>.broadcast();
  final _itemCtrl = StreamController<List<MenuItem>>.broadcast();
  final _empCtrl = StreamController<List<Employee>>.broadcast();

  Stream<List<MenuCategory>> get menuCategoriesStream => _catCtrl.stream;
  Stream<List<MenuItem>> get menuItemsStream => _itemCtrl.stream;
  Stream<List<Employee>> get employeesStream => _empCtrl.stream;

  Timer? _timer;
  String? _tenantId;

  Future<void> init(String tenantId) async {
    if (!kSaasMode || kSaasGatewayUrl.isEmpty) return;
    _tenantId = tenantId;
    await _fetch(tenantId);
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 5), (_) => _fetch(tenantId));
  }

  Future<void> refresh() async {
    if (_tenantId != null) await _fetch(_tenantId!);
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _tenantId = null;
    menuCategories = const [];
    menuItems = const [];
    employees = const [];
    venueProfile = null;
    loaded = false;
  }

  /// Разбор списка: запись, которую не удалось прочитать, пропускаем, а
  /// не теряем из-за неё весь список.
  static List<T> _parse<T>(Object? raw, T Function(Map<String, dynamic>) from) {
    final out = <T>[];
    for (final m in (raw as List?) ?? const []) {
      if (m is! Map) continue;
      try {
        out.add(from(Map<String, dynamic>.from(m)));
      } catch (_) {}
    }
    return out;
  }

  Future<void> _fetch(String tenantId) async {
    try {
      final data = await GatewayApi.get('tenantStaticData', {'tenantId': tenantId});
      menuCategories = _parse(data['menuCategories'], MenuCategory.fromMap);
      menuItems = _parse(data['menuItems'], MenuItem.fromMap);
      employees = _parse(data['employees'], Employee.fromMap);
      final rawProfile = data['venueProfile'];
      if (rawProfile is Map<String, dynamic>) {
        venueProfile = VenueProfile.fromMap(rawProfile);
      }
      loaded = true;
      _catCtrl.add(menuCategories);
      _itemCtrl.add(menuItems);
      _empCtrl.add(employees);
    } catch (_) {
      // Gateway недоступен — данные остаются прежними, Firestore-подписки работают
    }
  }
}
