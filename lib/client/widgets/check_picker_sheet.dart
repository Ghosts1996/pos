import 'package:flutter/material.dart';

import '../../models/table_model.dart';
import '../theme/kolibri_theme.dart';

/// Выбор своего чека, когда за столом открыто несколько счетов.
///
/// Стол может держать несколько отдельных чеков (раздельная оплата за одним
/// столом — см. TableModel.maxOpenSessions). Раньше приложение молча
/// привязывало гостя к последнему открытому: двое гостей за одним столом
/// видели один и тот же чек, причём не обязательно свой.
///
/// Отличить чеки помогает подпись, которую кассир ставит счёту на POS
/// («кто сидит за столом»), и время открытия. Суммы и позиции здесь не
/// показываются намеренно: пока гость не выбрал чек, он не должен видеть
/// содержимое соседнего счёта.
class CheckPickerSheet extends StatelessWidget {
  final String tableName;
  final List<TableCheck> checks;

  const CheckPickerSheet({
    super.key,
    required this.tableName,
    required this.checks,
  });

  /// Показывает лист выбора. Возвращает выбранный чек или null, если гость
  /// закрыл лист, не выбрав.
  static Future<TableCheck?> show(
    BuildContext context, {
    required String tableName,
    required List<TableCheck> checks,
  }) {
    return showModalBottomSheet<TableCheck>(
      context: context,
      backgroundColor: KolibriColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => CheckPickerSheet(tableName: tableName, checks: checks),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: KolibriColors.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              tableName.isEmpty ? 'Какой счёт ваш?' : 'Стол $tableName · какой счёт ваш?',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              'За этим столом открыто несколько счетов. Выберите свой — '
              'если ошибётесь, можно будет отвязаться на вкладке «Мой стол».',
              style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 16),
            for (var i = 0; i < checks.length; i++) _tile(context, checks[i], i),
          ],
        ),
      ),
    );
  }

  Widget _tile(BuildContext context, TableCheck check, int index) {
    final opened = check.openedAt;
    final subtitle = opened == null
        ? 'Время открытия неизвестно'
        : 'Открыт в ${opened.hour.toString().padLeft(2, '0')}:'
            '${opened.minute.toString().padLeft(2, '0')}';

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Opacity(
        opacity: check.taken ? 0.45 : 1,
        child: Material(
        color: KolibriColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          // Занятый чек выбрать нельзя — он уже открыт у другого гостя.
          onTap: check.taken ? null : () => Navigator.pop(context, check),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Icon(Icons.receipt_long, color: KolibriColors.primary),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        check.label.isEmpty ? 'Счёт ${index + 1}' : check.label,
                        style: const TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 15),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        check.taken ? 'Уже открыт у другого гостя' : subtitle,
                        style: TextStyle(
                          color: check.taken
                              ? KolibriColors.warning
                              : KolibriColors.textMuted,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  check.taken ? Icons.lock_outline : Icons.chevron_right,
                  color: KolibriColors.textMuted,
                ),
              ],
            ),
          ),
        ),
        ),
      ),
    );
  }
}
