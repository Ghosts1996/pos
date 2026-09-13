import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../models/table_model.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// QR-коды столов для печати и наклейки на стол.
///
/// В QR зашит обычный https-адрес страницы-прослойки (см. `public/table.html`).
/// Она мгновенно уводит гостя в приложение по `kolibri://table/{id}`, а если
/// приложение не установлено — показывает, откуда его скачать.
///
/// Почему не `kolibri://` напрямую, как было раньше: это собственная схема
/// приложения, и при его отсутствии телефону нечем обработать такую ссылку.
/// Гость видел непонятную строку или «приложение не найдено», и подсказать
/// ему было нечем — в этот момент не выполняется никакой наш код.
///
/// ВАЖНО про уже наклеенные коды: приложение по-прежнему понимает и старый
/// формат `kolibri://table/{id}`, поэтому напечатанные раньше наклейки
/// продолжают работать как работали. Новый формат нужен только для тех
/// кодов, которые будут печататься впредь.
class TableQrScreen extends StatelessWidget {
  const TableQrScreen({super.key});

  /// Домен Firebase Hosting. Это отдельный сайт `colibri-lounge` внутри
  /// проекта hoocah-pos (Firebase → Hosting → Add another site), а не сайт
  /// проекта по умолчанию: адрес должен читаться гостю как название
  /// заведения. Привязан в `firebase.json` → hosting.site.
  static const hostingDomain = 'https://colibri-lounge.web.app';

  /// Ссылка для НОВЫХ наклеек — через страницу-прослойку.
  static String linkFor(String tableId) => '$hostingDomain/table/$tableId';

  /// Ссылка в старом формате — то, что зашито в уже напечатанные коды.
  /// Приложение принимает оба варианта.
  static String legacyLinkFor(String tableId) => 'kolibri://table/$tableId';

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
                content: const SingleChildScrollView(
                  child: Text(
                    'Распечатайте коды и наклейте на столы. Гость сканирует код '
                    'обычной камерой телефона и сразу видит свой счёт, таймер и '
                    'кнопки вызова кальянщика.\n\n'
                    'Если приложения у гостя нет, код открывает страницу с '
                    'предложением установить его — с Яндекс.Диска или Google '
                    'Диска.\n\n'
                    'Уже наклеенные раньше коды продолжают работать: приложение '
                    'понимает и старый формат. Но на них подсказка об установке '
                    'не появится — там зашита ссылка, которую телефон без '
                    'приложения обработать не может. Если это важно, перепечатайте '
                    'коды с этого экрана.\n\n'
                    'Скриншот этого экрана можно отдать в печать как есть.',
                  ),
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
            const Text('Colibri Lounge',
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
