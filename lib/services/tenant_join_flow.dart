import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'app_bootstrap.dart';
import 'app_scope.dart';
import 'demo_gate.dart';
import 'hall_watch_service.dart';
import 'push_service.dart';
import 'saas_device_join_service.dart';
import 'session_alerts_service.dart';
import 'staff_session_store.dart';
import 'subscription_gate.dart';
import 'tenant_config_service.dart';

/// Записать устройство в заведение, забрать конфигурацию (брендинг,
/// длительность сеанса и т. п.), войти в него и перезапустить фоновые
/// службы — общий путь экрана присоединения (по коду и «Демо») и сброса
/// демо (DemoResetScreen).
Future<void> joinAndEnterTenant({
  required String tenantId,
  required String inviteCode,
  required String uid,
  required String deviceName,
}) async {
  final service = SaasDeviceJoinService();
  await service.joinAsDevice(tenantId: tenantId, inviteCode: inviteCode, uid: uid, deviceName: deviceName);
  await enterJoinedTenant(tenantId: tenantId, uid: uid);
}

/// Касса точки сети переходит в кассу другой точки той же сети: сервер
/// подключает к ней планшет, дальше — как после присоединения. Сотрудники
/// и PIN-коды у точки свои.
Future<void> switchChainPoint(String tenantId) async {
  final uid = FirebaseAuth.instance.currentUser?.uid;
  if (uid == null) throw StateError('Нет входа — перезапустите приложение');
  if (tenantId == AppScope.tenantId) return;
  await SaasDeviceJoinService().joinChainPoint(tenantId);
  await enterJoinedTenant(tenantId: tenantId, uid: uid);
}

/// Устройство уже участник заведения [tenantId]: забрать конфигурацию,
/// войти в него и перезапустить фоновые службы.
Future<void> enterJoinedTenant({required String tenantId, required String uid}) async {
  // Точка сети: подписку и документ сети правила отдают участнику сети —
  // записываемся в неё до того, как читать конфигурацию.
  try {
    final tenant = await FirebaseFirestore.instance.collection('tenants').doc(tenantId).get();
    final chainId = tenant.data()?['chainId'];
    if (chainId is String && chainId.isNotEmpty) {
      await SaasDeviceJoinService.ensureChainMembership(chainId: chainId, tenantId: tenantId, uid: uid);
    }
  } catch (_) {
    // Не вышло — refresh ниже скажет, что именно не так.
  }
  final config = await TenantConfigService().refresh(uid, preferredTenantId: tenantId);
  if (config == null) {
    throw StateError('Заведение присоединилось, но конфигурация не загрузилась — попробуйте ещё раз');
  }
  // Сотрудники у каждого заведения свои: вход прежнего здесь не действует,
  // вызовы прежнего сюда не приходят.
  if (AppScope.tenantId != tenantId) {
    await StaffSessionStore.instance.forget();
    if (AppScope.tenantId != null) await PushService.instance.leaveStaff();
  }
  AppScope.enterTenant(tenantId,
      branding: config.branding, slug: config.tenant.slug, chainId: config.tenant.chainId, demo: config.tenant.demo, demoPins: config.tenant.demoPins, demoCode: config.tenant.demoCode);
  SubscriptionGate.watch(tenantId, config);
  DemoGate.watch(config);
  final chainId = config.tenant.chainId;
  if (chainId != null) {
    await SaasDeviceJoinService.ensureChainMembership(chainId: chainId, tenantId: tenantId, uid: uid);
  }
  // Планшет мог работать в другом заведении (например, в удалённом демо):
  // фоновые службы следят за прежним — перезапускаем под новое.
  await HallWatchService.instance.stop();
  await SessionAlertsService.instance.stop();
  startBackgroundServices();
}

/// Новое демо-заведение в исходном виде вместо прежнего (прошло 3 дня или
/// гость нажал «Демо»). Запомненный вход сотрудника прежнего демо забываем
/// — в новом другие сотрудники.
Future<void> startFreshDemo(String uid) async {
  await StaffSessionStore.instance.forget();
  final demo = await SaasDeviceJoinService().createDemoTenant();
  await joinAndEnterTenant(tenantId: demo.tenantId, inviteCode: demo.inviteCode, uid: uid, deviceName: 'Демо');
}
