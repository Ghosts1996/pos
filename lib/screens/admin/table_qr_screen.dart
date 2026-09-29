import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../models/table_model.dart';
import '../../services/app_scope.dart';
import '../../services/firestore_service.dart';
import '../../theme/app_colors.dart';

/// QR-коды столов для печати.
///
/// В QR — https-адрес страницы стола: она открывает приложение по
/// `kolibri://table/{id}`, а без приложения предлагает его скачать. Голую
/// `kolibri://` телефону без приложения нечем открыть. Старые наклейки с
/// `kolibri://table/{id}` приложение понимает по-прежнему.
class TableQrScreen extends StatelessWidget {
  const TableQrScreen({super.key});

  /// Домен Firebase Hosting. Это отдельный сайт `colibri-lounge` внутри
  /// проекта hoocah-pos (Firebase → Hosting → Add another site), а не сайт
  /// проекта по умолчанию: адрес должен читаться гостю как название
  /// заведения. Привязан в `firebase.json` → hosting.site.
  ///
  /// Используется ТОЛЬКО в одно-арендном режиме (AppScope.isSaasMode ==
  /// false) — эта сборка одна на всех, менять её нельзя: заведение уже
  /// подключено и печатает коды с этим доменом.
  static const hostingDomain = 'https://colibri-lounge.web.app';

  /// Домен платформы для SaaS: у каждого заведения свой поддомен
  /// `{slug}.zalpos.ru` (wildcard DNS + wildcard SSL на сервере, см.
  /// saas/README.md) — отдаёт SaaS-версию страницы-прослойки и веб-гостя с
  /// брендингом именно этого заведения (раздел «Брендинг» в личном
  /// кабинете), а не общий "Colibri Lounge".
  static const saasDomain = 'zalpos.ru';

  /// Ссылка для НОВЫХ наклеек — через страницу-прослойку. В SaaS-режиме
  /// без AppScope.slug (например демо-заведение без человекочитаемого кода)
  /// откатываемся на tenantId — работает как адрес, просто менее красиво.
  static String linkFor(String tableId) {
    if (AppScope.isSaasMode) {
      final host = (AppScope.slug?.isNotEmpty ?? false) ? AppScope.slug! : AppScope.tenantId!;
      return 'https://$host.$saasDomain/table/$tableId';
    }
    return '$hostingDomain/table/$tableId';
  }

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
                    'Гостям с iPhone ничего устанавливать не нужно: тот же код '
                    'открывает у них версию в браузере — с тем же меню, счётом, '
                    'вызовами, бронью и бонусами. Перепечатывать коды для этого '
                    'не требуется.\n\n'
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
          // Колонки по ширине экрана (карточка ~240 dp), высота — QR во всю
          // ширину плюс подписи с поправкой на крупный системный шрифт.
          return LayoutBuilder(builder: (context, box) {
            const pad = 16.0, gap = 16.0;
            final cols = math.max(2, ((box.maxWidth - 2 * pad + gap) / (240 + gap)).floor());
            final cellWidth = (box.maxWidth - 2 * pad - gap * (cols - 1)) / cols;
            return GridView(
              padding: const EdgeInsets.all(pad),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: cols,
                mainAxisSpacing: gap,
                crossAxisSpacing: gap,
                mainAxisExtent: cellWidth + MediaQuery.textScalerOf(context).scale(96),
              ),
              children: tables.map(_qrCard).toList(),
            );
          });
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
            Text(
                AppScope.isSaasMode
                    ? (AppScope.branding?.appName ?? 'ZalPOS')
                    : 'Colibri Lounge',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
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
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: Colors.black, fontSize: 18, fontWeight: FontWeight.w700)),
            const Text('Наведите камеру — откроется приложение',
                textAlign: TextAlign.center,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: Colors.black54, fontSize: 11)),
          ],
        ),
      );
}
