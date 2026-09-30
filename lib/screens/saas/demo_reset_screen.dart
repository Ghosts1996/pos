import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../../services/demo_gate.dart';
import '../../services/tenant_join_flow.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../image_preload_screen.dart';
import 'saas_device_pairing_screen.dart';

/// Демо прожило 3 дня (DemoGate): поверх любого экрана кассы открываем
/// новое демо-заведение в исходном виде — всё введённое в прежнем
/// стирается, поэтому демо нельзя использовать как рабочую кассу. Не вышло
/// (нет сети) — «Повторить» или подключить своё заведение.
class DemoResetScreen extends StatefulWidget {
  const DemoResetScreen({super.key});

  @override
  State<DemoResetScreen> createState() => _DemoResetScreenState();
}

class _DemoResetScreenState extends State<DemoResetScreen> {
  bool _busy = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reset());
  }

  Future<void> _reset() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid == null) throw StateError('Нет входа — перезапустите приложение');
      await startFreshDemo(uid);
      _leave(const ImagePreloadScreen());
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = humanError(e);
      });
    }
  }

  /// Уйти с экрана сброса на [screen], убрав экраны прежнего демо.
  void _leave(Widget screen) {
    appNavigatorKey.currentState?.pushAndRemoveUntil(MaterialPageRoute(builder: (_) => screen), (_) => false);
    DemoGate.expired.value = false;
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
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.auto_awesome, color: AppColors.primary, size: 52),
                const SizedBox(height: 14),
                const Text(
                  'Демо обновляется',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 10),
                const Text(
                  'Демо-заведение живёт 3 дня: всё, что в нём ввели, стирается, и оно открывается '
                  'заново в исходном виде — залы, меню, брони и гости. Для настоящей работы '
                  'подключите своё заведение из личного кабинета.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white70, fontSize: 14, height: 1.4),
                ),
                const SizedBox(height: 22),
                if (_busy)
                  const CircularProgressIndicator(color: Colors.white70)
                else ...[
                  Text('Не получилось открыть новое демо: $_error',
                      textAlign: TextAlign.center, style: const TextStyle(color: AppColors.danger)),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: _reset,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Повторить'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: () {
                        DemoGate.stop();
                        _leave(const SaasDevicePairingScreen());
                      },
                      child: const Text('Подключить своё заведение'),
                    ),
                  ),
                ],
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
