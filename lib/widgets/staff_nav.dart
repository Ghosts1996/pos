import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

/// Детали меню персонала и админки в SaaS-кассе: одна система вместо
/// разномастных ListTile — значок в мягкой «таблетке» цвета раздела,
/// название, короткая подсказка и счётчик. Разделы подписаны капителью,
/// а не разделены чертой: глаз сразу находит «Зал», «Касса», «Склад».

/// Подпись раздела меню.
class StaffNavSection extends StatelessWidget {
  final String label;
  const StaffNavSection(this.label, {super.key});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 18, 20, 6),
        child: Text(label.toUpperCase(), style: AppFonts.overline.copyWith(color: AppColors.textMuted)),
      );
}

/// Значок в скруглённой подложке цвета [tint].
class StaffNavIcon extends StatelessWidget {
  final IconData icon;
  final Color tint;
  final double size;
  const StaffNavIcon(this.icon, {super.key, required this.tint, this.size = 38});

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: tint.withValues(alpha: AppColors.isLight ? 0.10 : 0.13),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, size: size * 0.53, color: tint),
      );
}

/// Счётчик справа от пункта: «3 заказа ждут».
class StaffNavBadge extends StatelessWidget {
  final int count;
  final Color color;
  const StaffNavBadge(this.count, {super.key, required this.color});

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(minWidth: 24),
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(12)),
        child: Text(
          count > 99 ? '99+' : '$count',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.onAccent, height: 1.2),
        ),
      );
}

/// Пункт меню.
class StaffNavItem extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final Color? tint;
  final Widget? trailing;
  final VoidCallback? onTap;
  const StaffNavItem({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.tint,
    this.trailing,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = tint ?? AppColors.brass;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 1),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Row(children: [
              StaffNavIcon(icon, tint: color),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(subtitle!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.25)),
                    ],
                  ],
                ),
              ),
              if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            ]),
          ),
        ),
      ),
    );
  }
}

/// Карточка состояния — «Моя смена», «Смена заведения»: цветная точка,
/// заголовок, подробности; рамка цвета состояния.
class StaffStatusCard extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final bool busy;
  final bool chevron;
  final VoidCallback? onTap;
  const StaffStatusCard({
    super.key,
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    this.busy = false,
    this.chevron = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
        child: Material(
          color: Color.alphaBlend(color.withValues(alpha: AppColors.isLight ? 0.07 : 0.10), AppColors.surface),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: color.withValues(alpha: 0.35)),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: busy ? null : onTap,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              child: Row(children: [
                StaffNavIcon(icon, tint: color, size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                      const SizedBox(height: 2),
                      Text(subtitle,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.25)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (busy) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              ]),
            ),
          ),
        ),
      );
}

/// Выделенная карточка — «Ассистент зала»: латунная рамка и мягкий градиент.
class StaffAccentCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  const StaffAccentCard({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final b = AppColors.brass;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: b.withValues(alpha: 0.45)),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              Color.alphaBlend(b.withValues(alpha: AppColors.isLight ? 0.14 : 0.20), AppColors.surface),
              AppColors.surface,
            ],
          ),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Container(
                  width: 40,
                  height: 40,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: b),
                  child: Icon(icon, size: 21, color: AppColors.onAccent),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: AppFonts.display(19)),
                      const SizedBox(height: 2),
                      Text(subtitle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.25)),
                    ],
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Маленькая кнопка подвала меню: значок и подпись под ним.
class StaffFooterButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const StaffFooterButton({super.key, required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) => Material(
        color: AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: AppColors.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 9),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 20, color: AppColors.textMuted),
              const SizedBox(height: 4),
              Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: AppColors.textMuted, fontWeight: FontWeight.w600)),
            ]),
          ),
        ),
      );
}
