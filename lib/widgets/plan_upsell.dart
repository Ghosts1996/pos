import 'package:flutter/material.dart';

import '../services/plan_capabilities.dart';
import '../theme/app_colors.dart';

/// Возможности нет в тарифе заведения — объясняем, где её подключить, а не
/// показываем пустой экран или ошибку сервера.
Future<void> showPlanUpsell(BuildContext context, {required String title, required String text}) {
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      icon: const Icon(Icons.workspace_premium_outlined, color: AppColors.warning, size: 32),
      title: Text(title, textAlign: TextAlign.center),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(text),
          const SizedBox(height: 12),
          const Text(
            'Тариф меняет владелец в личном кабинете на zalpos.ru — раздел «Оплата». '
            'В пробный период — без оплаты.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 13),
          ),
        ],
      ),
      actions: [
        FilledButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Понятно')),
      ],
    ),
  );
}

/// Открыть ИИ-помощника кассы или, если ИИ нет в тарифе, объяснить, где
/// его подключить: сервер всё равно откажет, а пустой чат с «недоступен»
/// выглядит как поломка.
void openAiOrUpsell(BuildContext context, VoidCallback open) {
  if (PlanCapabilitiesService.current.value.ai) {
    open();
    return;
  }
  showPlanUpsell(
    context,
    title: 'ИИ-помощник',
    text: 'Ассистент зала, разбор броней и ИИ-помощник гостя не входят в тариф заведения.',
  );
}

String employeesWord(int n) {
  final mod10 = n % 10, mod100 = n % 100;
  if (mod10 == 1 && mod100 != 11) return 'сотрудника';
  return 'сотрудников';
}
