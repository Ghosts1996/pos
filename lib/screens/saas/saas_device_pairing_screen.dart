import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../../build_info.dart';
import '../../services/saas_device_join_service.dart';
import '../../services/tenant_join_flow.dart';
import '../../theme/app_colors.dart';
import '../../widgets/pin_pad.dart';
import '../../theme/app_theme.dart';
import '../image_preload_screen.dart';
import '../../utils/human_error.dart';
import '../../utils/startup_log.dart';

/// Присоединение планшета к заведению SaaS-платформы — SaaS-аналог
/// [StaffDeviceSetupScreen] из одно-арендной версии. Отличие: вместо
/// одного секрета на всю платформу — код заведения (slug) + код
/// приглашения устройства, свой у каждого заведения (см. saas/README.md,
/// раздел про tenants/{tenantId}/settings/deviceInvite).
///
/// Сюда же касса возвращается, когда планшет отвязали от заведения
/// ([lostVenueName] объясняет, что случилось) или демо-заведение удалилось
/// по истечении 3 дней — тогда ([lostDemo]) сразу открывается новое демо в
/// исходном виде.
class SaasDevicePairingScreen extends StatefulWidget {
  const SaasDevicePairingScreen({super.key, this.lostVenueName, this.lostDemo = false});

  /// Заведение, к которому планшет был привязан до этого.
  final String? lostVenueName;

  /// Прежнее заведение — демо, которое удалилось само: сразу открываем
  /// новое.
  final bool lostDemo;

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

  static bool get _presetBuild => kSaasPresetSlug.isNotEmpty && kSaasPresetInviteCode.isNotEmpty;

  /// Пересоздаём демо (а не подключаем заведение сборки).
  bool get _resettingDemo => widget.lostDemo && !_presetBuild;

  @override
  void initState() {
    super.initState();
    if (_presetBuild) {
      // Сборка заведения — к нему, даже если до неё на телефоне было демо.
      _autoJoining = true;
      _slug.text = kSaasPresetSlug;
      _code.text = kSaasPresetInviteCode;
      WidgetsBinding.instance.addPostFrameCallback((_) => _join());
    } else if (widget.lostDemo) {
      // Демо прожило свои 3 дня — новое в исходном виде, без лишних
      // нажатий. Не вышло (нет сети) — обычный экран с кнопкой «Демо».
      _autoJoining = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _tryDemo());
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
      StartupLog.step('присоединение: поиск заведения по коду');
      final resolved = await _service.resolveTenantIdBySlug(slug);
      await joinAndEnterTenant(tenantId: resolved.tenantId, inviteCode: code, uid: uid, deviceName: _label.text.trim());
      if (slug == kSaasPresetSlug) await PresetJoinMarker.markJoined();
      StartupLog.step('присоединение завершено — экран входа');
      _openApp();
    } catch (e) {
      StartupLog.step('присоединение не удалось: $e');
      if (!mounted) return;
      setState(() {
        _busy = false;
        // Автопривязка не удалась (например, код приглашения успели
        // обновить в кабинете после сборки APK) — показываем обычную форму
        // с уже подставленными значениями, а не держим владельца на вечной
        // загрузке без объяснений.
        _autoJoining = false;
        _error = 'Не удалось присоединиться: ${humanError(e, lower: true)}';
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
      await startFreshDemo(uid);
      _openApp();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _autoJoining = false;
        _error = 'Не удалось запустить демо: ${humanError(e, lower: true)}';
      });
    }
  }

  void _openApp() {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const ImagePreloadScreen()),
    );
  }

  String get _intro {
    const where = 'Код заведения и код приглашения устройства — в личном кабинете '
        'владельца, раздел «Устройства».';
    if (_resettingDemo) {
      return 'Демо-заведение прожило 3 дня и сбросилось вместе со всеми данными. '
          'Откройте новое демо в исходном виде или присоедините планшет '
          'к своему заведению. $where';
    }
    final venue = widget.lostVenueName?.trim() ?? '';
    if (venue.isNotEmpty) {
      return 'Планшет больше не подключён к заведению «$venue» — его могли '
          'отключить в личном кабинете. Присоедините его заново. $where';
    }
    return 'Этот планшет ещё не привязан ни к одному заведению платформы. $where';
  }

  @override
  Widget build(BuildContext context) {
    if (_autoJoining) {
      return Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(color: AppColors.brass, strokeWidth: 2),
                const SizedBox(height: 16),
                Text(
                  _resettingDemo ? 'Демо обновляется — возвращаем исходный вид…' : 'Подключаем ваше заведение…',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 16),
                ),
                if (_resettingDemo) ...[
                  const SizedBox(height: 8),
                  const Text(
                    'Демо-заведение живёт 3 дня, потом всё введённое стирается.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white54, fontSize: 13),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: AppColors.background,
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
                  const BrandMark(),
                  const SizedBox(height: 26),
                  Text(
                    'Присоединить планшет к заведению',
                    textAlign: TextAlign.center,
                    style: AppFonts.display(30),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    _intro,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 14),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _slug,
                    autofocus: true,
                    style: const TextStyle(color: Colors.white),
                    decoration: const InputDecoration(
                      labelText: 'Код заведения',
                      hintText: 'kafe-leto',
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
                    'Демо-сеть из двух заведений: залы со столами, меню с фото, брони, гости '
                    'и отчёты, у каждой точки свои сотрудники — без регистрации, сбрасывается через 3 дня.',
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
