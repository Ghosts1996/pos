import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Показывается вместо аварийного закрытия приложения, если Firebase ещё
/// не настроен (firebase_options.dart содержит заглушку) или подключение
/// не удалось по другой причине. Даёт понятную инструкцию на русском,
/// вместо белого экрана / мгновенного закрытия непонятно почему.
class SetupRequiredScreen extends StatelessWidget {
  final String? errorDetails;
  const SetupRequiredScreen({super.key, this.errorDetails});

  static const _steps = [
    'Установите FlutterFire CLI: dart pub global activate flutterfire_cli',
    'В корне проекта выполните: flutterfire configure',
    'Выберите (или создайте) проект в консоли Firebase и платформу Android — команда сама перепишет lib/firebase_options.dart',
    'В консоли Firebase включите Firestore Database (production mode) и Authentication → Sign-in method → Anonymous',
    'Вставьте содержимое firestore.rules в Firestore → Rules',
    'Добавьте первого администратора вручную: коллекция employees, документ с полями name, pinCode, role: "admin"',
    'Закоммитьте и запушьте изменения — GitHub Actions соберёт новый APK уже с рабочим подключением',
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),
              const Icon(Icons.cloud_off, color: Colors.orangeAccent, size: 48),
              const SizedBox(height: 12),
              const Text(
                'Firebase ещё не настроен',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              const Text(
                'Приложение собралось и запустилось нормально — не хватает только '
                'подключения к базе данных. Это разовая настройка, займёт 5–10 минут.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white70, fontSize: 14),
              ),
              const SizedBox(height: 24),
              ..._steps.asMap().entries.map((e) => Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        CircleAvatar(
                          radius: 12,
                          backgroundColor: Colors.purpleAccent.withOpacity(0.25),
                          child: Text('${e.key + 1}',
                              style: const TextStyle(color: Colors.white, fontSize: 12)),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(e.value,
                              style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.3)),
                        ),
                      ],
                    ),
                  )),
              if (errorDetails != null) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.red.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.redAccent.withOpacity(0.4)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Техническая информация об ошибке:',
                          style: TextStyle(color: Colors.redAccent, fontSize: 12, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      SelectableText(errorDetails!,
                          style: const TextStyle(color: Colors.white70, fontSize: 11, fontFamily: 'monospace')),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 20),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white70),
                onPressed: () {
                  Clipboard.setData(const ClipboardData(
                      text: 'dart pub global activate flutterfire_cli\nflutterfire configure'));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Команды скопированы в буфер обмена')),
                  );
                },
                icon: const Icon(Icons.copy, size: 16),
                label: const Text('Скопировать команды настройки'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
