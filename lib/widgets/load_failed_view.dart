import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../utils/human_error.dart';

/// Экран настроек не загрузился (нет связи, а копии в памяти устройства ещё
/// нет): понятный текст и «Повторить» вместо вечной крутилки, и заголовок с
/// кнопкой «Назад» — на Windows без неё с экрана было не уйти.
class LoadFailedScaffold extends StatelessWidget {
  const LoadFailedScaffold({super.key, required this.title, required this.error, required this.onRetry});

  final String title;
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.cloud_off, size: 44, color: AppColors.textMuted),
                const SizedBox(height: 12),
                const Text('Настройки не загрузились',
                    textAlign: TextAlign.center, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                Text(
                  'Нет связи с сервером, а на этом устройстве настроек ещё нет. Проверьте интернет и повторите. '
                  '(${humanError(error, lower: true)})',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textMuted),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Повторить')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
