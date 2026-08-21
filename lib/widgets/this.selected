import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

/// Крупная кнопка первичного действия ("Оплатить", "Отправить на кухню").
///
/// Не используем голый ElevatedButton напрямую в экранах — оборачиваем,
/// чтобы drop-shadow и disabled-состояние были одинаковыми везде.
class PosActionButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final bool loading;

  const PosActionButton({
    super.key,
    required this.label,
    this.icon,
    required this.onPressed,
    this.loading = false,
  });

  bool get _enabled => onPressed != null && !loading;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        // Тень только когда кнопка активна — это и есть премиальный акцент,
        // а не "просто ещё одна яркая заливка".
        boxShadow: _enabled ? AppShadows.primaryButton : null,
      ),
      child: ElevatedButton(
        onPressed: _enabled ? onPressed : null,
        child: loading
            ? const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2.4,
                  color: AppColors.textPrimary,
                ),
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 20),
                    const SizedBox(width: 10),
                  ],
                  Text(label),
                ],
              ),
      ),
    );
  }
}

/// Плитка блюда/категории в сетке меню.
/// Состояния: default / selected (обведена primary) / disabled (стоп-лист).
class PosMenuTile extends StatelessWidget {
  final String title;
  final String? subtitle; // вес/объём — muted text
  final String price;
  final bool selected;
  final bool disabled; // стоп-лист / нет в наличии
  final VoidCallback? onTap;

  const PosMenuTile({
    super.key,
    required this.title,
    this.subtitle,
    required this.price,
    this.selected = false,
    this.disabled = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final borderColor = selected
        ? AppColors.primary
        : disabled
            ? AppColors.border.withOpacity(0.5)
            : AppColors.border;

    return Material(
      color: selected ? AppColors.selection : AppColors.surface,
      borderRadius: BorderRadius.circular(AppRadius.md),
      child: InkWell(
        onTap: disabled ? null : onTap,
        borderRadius: BorderRadius.circular(AppRadius.md),
        // Заметный tap-фидбек пальцем на глянцевом экране.
        splashColor: AppColors.primary.withOpacity(0.18),
        highlightColor: AppColors.primary.withOpacity(0.10),
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSpacing.minTouchTarget + 20),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.md),
            border: Border.all(color: borderColor, width: selected ? 1.6 : 1),
          ),
          child: Opacity(
            opacity: disabled ? 0.4 : 1,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontSize: 14.5,
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 3),
                  Text(
                    subtitle!,
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  price,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}