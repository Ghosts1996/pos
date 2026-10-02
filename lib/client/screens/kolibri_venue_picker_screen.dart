import 'package:flutter/material.dart';
import '../../services/saas_device_join_service.dart';
import '../theme/kolibri_theme.dart';

/// Экран выбора заведения — показывается ТОЛЬКО в гостевой сборке для сети
/// (см. kSaasPresetChainSlug в lib/build_info.dart): в отличие от обычной
/// гостевой сборки (одна точка запечена в APK насовсем), здесь гость сам
/// решает, в каком именно заведении сети он сейчас находится, прежде чем
/// увидит меню/зал/бронирование этой конкретной точки.
///
/// Сообщает о выборе через [onSelected] — kolibri_main.dart сам решает,
/// что делать дальше (AppScope.enterTenant + сохранение выбора на диск).
class KolibriVenuePickerScreen extends StatelessWidget {
  final ChainDirectory chain;
  final ValueChanged<ChainLocation> onSelected;

  /// Где гость был в прошлый раз — отмечено и стоит первым.
  final String? lastTenantId;

  /// Выбор из бронирования: «где забронировать стол».
  final bool forBooking;

  const KolibriVenuePickerScreen({
    super.key,
    required this.chain,
    required this.onSelected,
    this.lastTenantId,
    this.forBooking = false,
  });

  @override
  Widget build(BuildContext context) {
    final locations = chain.locations.where((l) => l.status != 'suspended' && l.status != 'deleted').toList()
      ..sort((a, b) => (b.tenantId == lastTenantId ? 1 : 0) - (a.tenantId == lastTenantId ? 1 : 0));
    return Scaffold(
      backgroundColor: KolibriColors.background,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    chain.name.isNotEmpty ? chain.name : 'Выберите заведение',
                    style: KolibriFonts.display(34),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    forBooking
                        ? 'В каком заведении сети забронировать стол?'
                        : 'В каком заведении вы сейчас или где хотите забронировать стол? '
                            'Бонусы и уровень общие во всех заведениях сети.',
                    style: TextStyle(color: KolibriColors.textMuted, fontSize: 14),
                  ),
                ],
              ),
            ),
            Expanded(
              child: locations.isEmpty
                  ? Center(
                      child: Text(
                        'В этой сети пока нет доступных заведений',
                        style: TextStyle(color: KolibriColors.textMuted),
                      ),
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                      itemCount: locations.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 10),
                      itemBuilder: (context, i) {
                        final loc = locations[i];
                        return _VenueCard(
                          location: loc,
                          last: loc.tenantId == lastTenantId,
                          onTap: () => onSelected(loc),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VenueCard extends StatelessWidget {
  final ChainLocation location;
  final bool last;
  final VoidCallback onTap;

  const _VenueCard({required this.location, required this.onTap, this.last = false});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: KolibriColors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: KolibriColors.primary.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(Icons.storefront_rounded, color: KolibriColors.primary),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      location.name.isNotEmpty ? location.name : location.slug,
                      style: TextStyle(
                        color: KolibriColors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (last)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text('Вы были здесь в прошлый раз',
                            style: TextStyle(color: KolibriColors.textMuted, fontSize: 12.5)),
                      ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: KolibriColors.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}
