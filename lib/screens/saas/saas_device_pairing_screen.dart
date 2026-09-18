import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

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
      final tenantId = await _service.resolveTenantIdBySlug(slug);
      await _service.joinAsDevice(
        tenantId: tenantId,
        inviteCode: code,
        uid: uid,
        deviceName: _label.text.trim(),
      );

      // Присоединение прошло — забираем полную конфигурацию заведения
      // (брендинг, длительность кальяна и т.п.) и запускаем фоновые службы,
      // которые при обычном (не-SaaS) запуске стартуют сразу в main().
      final config = await TenantConfigService().refresh(uid, preferredTenantId: tenantId);
      if (config == null) {
        throw StateError('Заведение присоединилось, но конфигурация не загрузилась — попробуйте ещё раз');
      }
      AppScope.enterTenant(tenantId, branding: config.branding);
      SubscriptionGate.watch(tenantId, config);
      startBackgroundServices();

      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const ImagePreloadScreen()),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Не удалось присоединиться: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
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
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
