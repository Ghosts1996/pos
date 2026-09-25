import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../../build_info.dart';
import '../../services/app_bootstrap.dart';
import '../../services/app_scope.dart';
import '../../services/saas_device_join_service.dart';
import '../../services/subscription_gate.dart';
import '../../services/tenant_config_service.dart';
import '../../theme/app_colors.dart';
import '../image_preload_screen.dart';

/// Присоединение планшета к заведению SaaS-платформы — SaaS-аналог
/// [StaffDeviceSetupScreen] из одно-арендной версии. Отличие: вместо
/// одного секрета на всю платформу — код заведения (slug) + код
/// приглашения устройства, свой у каждого заведения (см. saas/README.md,
/// раздел про tenants/{tenantId}/settings/deviceInvite).
class SaasDevicePairingScreen extends StatefulWidget {
  const SaasDevicePairingScreen({super.key});

  @override
  State<SaasDevicePairingScreen> createState() => _SaasDevicePairingScreenState();
}

class _SaasDevicePairingScreenState extends State<SaasDevicePairingScreen> {
  final _service = SaasDeviceJoinService();
  final _slug = TextEditingController();
  final _code = TextEditingController();
  final _label = TextEditingController();

  bool _busy = false;
  String? _error;

  /// true, пока идёт (или ещё не провалилась) автопривязка по значениям,
  /// запечённым в эту сборку (см. kSaasPresetSlug/kSaasPresetInviteCode) —
  /// в это время экран показывает просто загрузку, а не форму ручного
  /// ввода, чтобы владелец, скачавший СВОЙ APK из личного кабинета, вообще
  /// не видел эти поля в обычном случае.
  bool _autoJoining = false;

  @override
  void initState() {
    super.initState();
    if (kSaasPresetSlug.isNotEmpty && kSaasPresetInviteCode.isNotEmpty) {
      _autoJoining = true;
      _slug.text = kSaasPresetSlug;
      _code.text = kSaasPresetInviteCode;
      WidgetsBinding.instance.addPostFrameCallback((_) => _join());
    }
  }

  @override
  void dispose() {
    _slug.dispose();
    _code.dispose();
    _label.dispose();
    super.dispose();
  }

  Future<void> _join() async {
    final slug = _slug.text.trim();
    final code = _code.text.trim();
    if (slug.isEmpty || code.isEmpty) {
      setState(() => _error = 'Заполните код заведения и код приглашения');
      return;
    }
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null) {
      setState(() => _error = 'Нет входа в Firebase — перезапустите приложение');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final resolved = await _service.resolveTenantIdBySlug(slug);
      await _completeJoin(tenantId: resolved.tenantId, inviteCode: code, uid: uid, deviceName: _label.text.trim());
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // Автопривязка не удалась (например, код приглашения успели
        // обновить в кабинете после сборки APK) — показываем обычную форму
        // с уже подставленными значениями, а не держим владельца на вечной
        // загрузке без объяснений.
        _autoJoining = false;
        _error = 'Не удалось присоединиться: $e';
      });
    }
  }

  /// Кнопка «Демо» — не спрашивает ни код заведения, ни код приглашения:
  /// саму пару tenantId+inviteCode выдаёт createDemoTenant (создаёт
  /// одноразовое тестовое заведение с заготовленными столами/меню, см.
  /// saas-gateway/README.md), присоединение дальше идёт тем же путём, что
  /// и обычное устройство.
  Future<void> _tryDemo() async {
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null) {
      setState(() => _error = 'Нет входа в Firebase — перезапустите приложение');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final demo = await _service.createDemoTenant();
      await _completeJoin(
        tenantId: demo.tenantId,
        inviteCode: demo.inviteCode,
        uid: uid,
        deviceName: 'Демо',
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Не удалось запустить демо: $e';
      });
    }
  }

  /// Общий хвост и для обычного присоединения, и для демо: записать
  /// устройство в заведение, забрать конфигурацию (брендинг, длительность
  /// кальяна и т.п.), запустить фоновые службы и перейти в приложение.
  Future<void> _completeJoin({
    required String tenantId,
    required String inviteCode,
    required String uid,
    required String deviceName,
  }) async {
    await _service.joinAsDevice(
      tenantId: tenantId,
      inviteCode: inviteCode,
      uid: uid,
      deviceName: deviceName,
    );

    final config = await TenantConfigService().refresh(uid, preferredTenantId: tenantId);
    if (config == null) {
      throw StateError('Заведение присоединилось, но конфигурация не загрузилась — попробуйте ещё раз');
    }
    AppScope.enterTenant(tenantId,
        branding: config.branding, slug: config.tenant.slug, chainId: config.tenant.chainId);
    SubscriptionGate.watch(tenantId, config);
    startBackgroundServices();

    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const ImagePreloadScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_autoJoining) {
      return const Scaffold(
        backgroundColor: Color(0xFF1B1B1F),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(color: Colors.white70),
              SizedBox(height: 16),
              Text(
                'Подключаем ваше заведение…',
                style: TextStyle(color: Colors.white, fontSize: 16),
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.store_mall_directory, color: Colors.white70, size: 48),
                  const SizedBox(height: 12),
                  const Text(
                    'Присоединить планшет к заведению',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Этот планшет ещё не привязан ни к одному заведению платформы. '
                    'Код заведения и код приглашения устройства — в личном кабинете '
                    'владельца, раздел «Устройства».',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 14),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _slug,
                    autofocus: true,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Код заведения',
                      hintText: 'hookah-lounge-riga',
                    ),
                    onSubmitted: (_) => _busy ? null : _join(),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _code,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Код приглашения устройства',
                    ),
                    onSubmitted: (_) => _busy ? null : _join(),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _label,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Название устройства (необязательно)',
                      hintText: 'Планшет у бара',
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 13)),
                  ],
                  const SizedBox(height: 24),
                  SizedBox(
                    height: 50,
                    child: FilledButton(
                      onPressed: _busy ? null : _join,
                      child: _busy
                          ? const SizedBox(
                              width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Присоединить'),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Row(children: [
                    Expanded(child: Divider(color: Colors.white24)),
                    Padding(
                      padding: EdgeInsets.symmetric(horizontal: 12),
                      child: Text('или', style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
                    ),
                    Expanded(child: Divider(color: Colors.white24)),
                  ]),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 50,
                    child: OutlinedButton(
                      onPressed: _busy ? null : _tryDemo,
                      child: const Text('Попробовать демо'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Одноразовое тестовое заведение с примерами столов и меню — '
                    'без регистрации, ничего не сохраняется.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
