import 'package:flutter/material.dart';

import '../../utils/adaptive.dart';
import '../../widgets/devices_panel.dart';

/// Админ → «Устройства»: все устройства заведения с кассой, сколько из них
/// разрешает тариф, и удаление ненужного.
class DevicesScreen extends StatelessWidget {
  const DevicesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Устройства')),
      body: CenteredBody(
        maxWidth: 640,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: const [
            DevicesPanel(),
            SizedBox(height: 16),
            Text(
              'Нужно больше устройств — перейдите на тариф побольше в кабинете zalpos.ru, раздел «Тарифы». '
              'Новое устройство подключается в кабинете: «Устройства» → скачать кассу.',
              style: TextStyle(fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}
