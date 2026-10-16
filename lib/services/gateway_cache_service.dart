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
  }

  Future<void> _fetch(String tenantId) async {
    try {
      final data = await GatewayApi.get('tenantStaticData', {'tenantId': tenantId});
      menuCategories = (data['menuCategories'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .map(MenuCategory.fromMap)
              .toList() ??
          const [];
      menuItems = (data['menuItems'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .map(MenuItem.fromMap)
              .toList() ??
          const [];
      employees = (data['employees'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .map(Employee.fromMap)
              .toList() ??
          const [];
      final rawProfile = data['venueProfile'];
      if (rawProfile is Map<String, dynamic>) {
        venueProfile = VenueProfile.fromMap(rawProfile);
      }
      _catCtrl.add(menuCategories);
      _itemCtrl.add(menuItems);
      _empCtrl.add(employees);
    } catch (_) {
      // Gateway недоступен — данные остаются прежними, Firestore-подписки работают
    }
  }
}
