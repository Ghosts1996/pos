import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// QR-коды столов для печати и наклейки на стол.
///
/// В QR зашита ссылка вида `kolibri://table/{tableId}` — клиентское
/// приложение по ней сразу привязывает гостя к открытому за столом чеку,
/// без списков и поиска. Тот же QR можно открыть в браузере, если добавить
/// страницу-редирект на установку приложения.
class TableQrScreen extends StatelessWidget {
  const TableQrScreen({super.key});

  static String linkFor(String tableId) => 'kolibri://table/$tableId';

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();

    return Scaffold(
      appBar: AppBar(
        title: const Text('QR-коды столов'),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            onPressed: () => showDialog(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('Как использовать'),
                content: const Text(
                  'Распечатайте коды и наклейте на столы. Гость сканирует код '
                  'в приложении «Колибри Лаундж» и сразу видит свой счёт, '
                  'таймер и кнопки вызова кальянщика.\n\n'
                  'Скриншот этого экрана можно отдать в печать как есть.',
                ),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Понятно')),
                ],
              ),
            ),
          ),
        ],
      ),
      body: StreamBuilder<List<TableModel>>(
        stream: fs.tablesStream(),
        builder: (context, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final tables = snap.data!..sort((a, b) => a.name.compareTo(b.name));
          if (tables.isEmpty) {
            return const Center(
              child: Text('Сначала добавьте столы в карту зала',
                  style: TextStyle(color: AppColors.textMuted)),
            );
          }
          return GridView.count(
            padding: const EdgeInsets.all(16),
            crossAxisCount: MediaQuery.of(context).size.width > 800 ? 4 : 2,
            mainAxisSpacing: 16,
            crossAxisSpacing: 16,
            childAspectRatio: 0.78,
            children: tables.map(_qrCard).toList(),
          );
        },
      ),
    );
  }

  Widget _qrCard(TableModel table) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('Колибри Лаундж',
                style: TextStyle(
                    color: Colors.black87, fontWeight: FontWeight.w700, fontSize: 13)),
            const SizedBox(height: 8),
            Expanded(
              child: QrImageView(
                data: linkFor(table.id),
                version: QrVersions.auto,
                backgroundColor: Colors.white,
              ),
            ),
            const SizedBox(height: 8),
            Text(table.name,
                style: const TextStyle(
                    color: Colors.black, fontSize: 18, fontWeight: FontWeight.w700)),
            const Text('Наведите камеру — откроется приложение',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.black54, fontSize: 11)),
          ],
        ),
      );
}
