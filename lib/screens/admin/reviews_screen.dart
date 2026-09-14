import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/phone_utils.dart';

/// Отзывы гостей — кто, когда и что поставил.
///
/// Отзывы собирались с самого начала (гость оценивает визит после закрытия
/// чека), но посмотреть их в приложении было негде: они уходили только в
/// ИИ-разбор общей сводкой «что чинить в первую очередь». По ней нельзя
/// ни узнать, кто поставил двойку, ни позвонить и извиниться — а именно это
/// с плохим отзывом и нужно делать.
///
/// Имя и телефон берутся из профиля гостя: в самом отзыве лежит только uid.
class ReviewsScreen extends StatefulWidget {
  const ReviewsScreen({super.key});

  @override
  State<ReviewsScreen> createState() => _ReviewsScreenState();
}

class _ReviewsScreenState extends State<ReviewsScreen> {
  final _link = GuestLinkService();

  /// Профили гостей, уже поднятые из базы. Без кэша один и тот же гость
  /// перечитывался бы на каждой перерисовке списка.
  final _profiles = <String, ClientProfile?>{};

  /// Показывать только оценки ниже этой. 0 — показывать все.
  int _onlyBelow = 0;

  Future<ClientProfile?> _profile(String uid) async {
    if (uid.isEmpty) return null;
    if (_profiles.containsKey(uid)) return _profiles[uid];
    final p = await _link.profileOnce(uid);
    _profiles[uid] = p;
    return p;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Отзывы гостей'),
        actions: [
          PopupMenuButton<int>(
            tooltip: 'Фильтр',
            icon: Icon(_onlyBelow == 0 ? Icons.filter_alt_outlined : Icons.filter_alt),
            onSelected: (v) => setState(() => _onlyBelow = v),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 0, child: Text('Все отзывы')),
              PopupMenuItem(value: 5, child: Text('Ниже 5 звёзд')),
              PopupMenuItem(value: 4, child: Text('Ниже 4 звёзд — разобраться')),
            ],
          ),
        ],
      ),
      body: StreamBuilder<List<GuestReview>>(
        stream: _link.recentReviewsStream(limit: 100),
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(child: Text('Ошибка: ${snap.error}'));
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final all = snap.data!;
          final list = _onlyBelow == 0
              ? all
              : all.where((r) => r.rating < _onlyBelow).toList();

          if (all.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text(
                  'Отзывов пока нет. Гость видит предложение оценить визит '
                  'сразу после того, как вы закроете его чек.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.textMuted),
                ),
              ),
            );
          }

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _summary(all),
              const SizedBox(height: 16),
              if (list.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Text('Под фильтр ничего не попало — и хорошо.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.textMuted)),
                ),
              for (final r in list) ...[
                _tile(r),
                const SizedBox(height: 10),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _summary(List<GuestReview> all) {
    final avg = all.fold<int>(0, (sum, r) => sum + r.rating) / all.length;
    final bad = all.where((r) => r.rating <= 3).length;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(avg.toStringAsFixed(1),
                  style: const TextStyle(fontSize: 30, fontWeight: FontWeight.bold)),
              Text('средняя из ${all.length}',
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
            ],
          ),
          const SizedBox(width: 20),
          Expanded(
            child: Text(
              bad == 0
                  ? 'Плохих оценок нет'
                  : 'Оценок «3 и ниже»: $bad — стоит позвонить и разобраться',
              style: TextStyle(
                color: bad == 0 ? AppColors.success : AppColors.warning,
                fontSize: 13,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tile(GuestReview r) {
    return FutureBuilder<ClientProfile?>(
      future: _profile(r.clientUid),
      builder: (context, snap) {
        final profile = snap.data;
        // Имя из профиля свежее того, что попало в отзыв: гость мог
        // заполнить его уже после визита.
        final name = (profile?.name.isNotEmpty ?? false)
            ? profile!.name
            : (r.guestName.isEmpty ? 'Гость без имени' : r.guestName);
        final phone = profile?.phone ?? '';

        return Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: r.rating <= 3
                  ? AppColors.danger.withValues(alpha: 0.5)
                  : AppColors.border,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  _stars(r.rating),
                  const Spacer(),
                  Text(_fmtDate(r.createdAt),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                ],
              ),
              const SizedBox(height: 10),
              Text(name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              if (phone.isEmpty)
                const Text('Телефон не указан',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13))
              else
                // Позвонить прямо отсюда: с плохим отзывом это и нужно
                // сделать, пока гость не ушёл навсегда.
                InkWell(
                  onTap: () => launchUrl(Uri.parse('tel:+$phone')),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.call, size: 15, color: AppColors.primary),
                        const SizedBox(width: 6),
                        Text(formatPhone(phone),
                            style: const TextStyle(
                                color: AppColors.primary, fontSize: 13)),
                      ],
                    ),
                  ),
                ),
              if (r.text.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(r.text, style: const TextStyle(color: AppColors.textPrimary)),
              ],
              if (r.aiSummary.isNotEmpty) ...[
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.auto_awesome, size: 14, color: AppColors.primary),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(r.aiSummary,
                          style: const TextStyle(
                              color: AppColors.textMuted, fontSize: 12)),
                    ),
                  ],
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _stars(int rating) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= 5; i++)
            Icon(
              i <= rating ? Icons.star : Icons.star_border,
              size: 18,
              color: rating <= 3 ? AppColors.danger : AppColors.warning,
            ),
          const SizedBox(width: 8),
          Text('$rating из 5',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
        ],
      );

  String _fmtDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} '
      'в ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
