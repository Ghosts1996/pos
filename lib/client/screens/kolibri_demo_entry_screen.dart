import 'package:flutter/material.dart';

import '../../services/saas_device_join_service.dart';
import '../../utils/human_error.dart';
import '../theme/kolibri_theme.dart';

/// Вход в демо приложения гостя (сборка с kSaasGuestDemo, кнопка на
/// сайте): код демо-сети из кассы в демо-режиме — тогда заказы, вызовы и
/// брони из приложения видит та касса — или новая демо-сеть.
class KolibriDemoEntryScreen extends StatefulWidget {
  const KolibriDemoEntryScreen({super.key, required this.onOpen, this.notice});

  /// Код демо-сети (chains.slug), который открыть.
  final ValueChanged<String> onOpen;

  /// Почему снова здесь (например, демо сбросилось).
  final String? notice;

  @override
  State<KolibriDemoEntryScreen> createState() => _KolibriDemoEntryScreenState();
}

class _KolibriDemoEntryScreenState extends State<KolibriDemoEntryScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _openByCode() async {
    final code = _code.text.trim().toLowerCase();
    if (!RegExp(r'^demo-[a-z0-9]{3,32}$').hasMatch(code)) {
      setState(() => _error = 'Код демо выглядит так: demo-ab12cd — он на экране входа кассы в демо-режиме');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await SaasDeviceJoinService().resolveChainBySlug(code);
      widget.onOpen(code);
    } on GatewayNotFound {
      setState(() => _error = 'Демо с таким кодом нет — возможно, оно уже сбросилось (демо живёт 3 дня)');
    } catch (e) {
      setState(() => _error = 'Не удалось открыть демо: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openNew() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final demo = await SaasDeviceJoinService().createDemoTenant();
      if (demo.chainSlug.isEmpty) throw StateError('сервис не вернул код демо');
      widget.onOpen(demo.chainSlug);
    } catch (e) {
      setState(() => _error = 'Не удалось открыть демо: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final muted = TextStyle(color: KolibriColors.textMuted, fontSize: 14, height: 1.4);
    return Scaffold(
      backgroundColor: KolibriColors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: Container(
                      width: 64,
                      height: 64,
                      decoration: BoxDecoration(
                        color: KolibriColors.primary.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: Icon(Icons.phone_iphone_rounded, color: KolibriColors.primary, size: 32),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text('Демо приложения гостя',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: KolibriColors.textPrimary, fontSize: 24, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 8),
                  Text(
                    'Так ваши гости видят заведение: меню с фото, бронь стола, вызов официанта, '
                    'счёт и бонусы. Демо — сеть из двух заведений: гость выбирает, в какое пришёл '
                    'и где забронировать, бонусы общие.',
                    textAlign: TextAlign.center,
                    style: muted,
                  ),
                  if (widget.notice != null) ...[
                    const SizedBox(height: 12),
                    Text(widget.notice!,
                        textAlign: TextAlign.center, style: TextStyle(color: KolibriColors.gold, fontSize: 13.5)),
                  ],
                  const SizedBox(height: 24),
                  TextField(
                    controller: _code,
                    enabled: !_busy,
                    autocorrect: false,
                    textInputAction: TextInputAction.go,
                    onSubmitted: (_) => _openByCode(),
                    decoration: const InputDecoration(
                      labelText: 'Код демо из кассы',
                      hintText: 'demo-ab12cd',
                      prefixIcon: Icon(Icons.qr_code_2_rounded),
                    ),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: _busy ? null : _openByCode,
                    child: const Text('Открыть по коду'),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Код — на экране входа кассы в демо-режиме. С ним заказы, вызовы и брони '
                    'из этого приложения сразу видны в той кассе.',
                    textAlign: TextAlign.center,
                    style: muted.copyWith(fontSize: 12.5),
                  ),
                  const SizedBox(height: 20),
                  Row(children: [
                    Expanded(child: Divider(color: KolibriColors.textMuted.withValues(alpha: 0.3))),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      child: Text('или', style: muted.copyWith(fontSize: 12.5)),
                    ),
                    Expanded(child: Divider(color: KolibriColors.textMuted.withValues(alpha: 0.3))),
                  ]),
                  const SizedBox(height: 20),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _openNew,
                    icon: const Icon(Icons.auto_awesome_rounded),
                    label: const Text('Открыть новое демо без кассы'),
                  ),
                  if (_busy) ...[
                    const SizedBox(height: 16),
                    Center(child: CircularProgressIndicator(color: KolibriColors.primary)),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(_error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Color(0xFFE0715E), fontSize: 13.5, fontWeight: FontWeight.w600)),
                  ],
                  const SizedBox(height: 18),
                  Text('Демо сбрасывается через 3 дня. Все данные в нём вымышленные.',
                      textAlign: TextAlign.center, style: muted.copyWith(fontSize: 12)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
