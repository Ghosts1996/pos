import 'package:flutter/material.dart';

import '../build_info.dart';
import '../services/app_update_service.dart';
import '../theme/app_colors.dart';

/// Номер сборки на устройстве — для подписи в меню.
String get appBuildLabel {
  final n = int.tryParse(kBuildNumber) ?? 0;
  return n > 0 ? 'Сборка $n' : 'Сборка для разработки';
}

/// «Обновления»: какая сборка стоит и кнопка «Проверить обновления» с
/// понятным ответом — последняя ли версия, что нашлось или почему сервер
/// не ответил. Фоновая проверка ошибки молча пропускает, и без этого
/// окна было не понять, почему плашка «Обновить» не появляется.
Future<void> showAboutAppDialog(BuildContext context) => showDialog<void>(
      context: context,
      builder: (_) => const _AboutAppDialog(),
    );

class _AboutAppDialog extends StatefulWidget {
  const _AboutAppDialog();

  @override
  State<_AboutAppDialog> createState() => _AboutAppDialogState();
}

class _AboutAppDialogState extends State<_AboutAppDialog> {
  bool _checking = false;
  String? _result;

  Future<void> _check() async {
    final service = AppUpdateService.instance;
    if (service == null) return;
    setState(() {
      _checking = true;
      _result = null;
    });
    final text = await service.checkManually();
    if (mounted) {
      setState(() {
        _checking = false;
        _result = text;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final service = AppUpdateService.instance;
    return AlertDialog(
      title: const Text('Обновления'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(appBuildLabel, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(
              service == null
                  ? 'В этой версии приложения обновления изнутри недоступны. Установите свежую сборку '
                      'из кабинета владельца (раздел «Устройства») — дальше обновления будут приходить сами.'
                  : 'Новая версия появляется после «Собрать APK» в кабинете владельца. Приложение проверяет '
                      'обновления само при запуске и раз в полчаса — или нажмите «Проверить».',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            if (_checking) ...[
              const SizedBox(height: 16),
              const LinearProgressIndicator(),
            ],
            if (_result != null) ...[
              const SizedBox(height: 16),
              Text(_result!, style: const TextStyle(fontWeight: FontWeight.w600)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Закрыть')),
        if (service != null)
          FilledButton(onPressed: _checking ? null : _check, child: const Text('Проверить')),
      ],
    );
  }
}
