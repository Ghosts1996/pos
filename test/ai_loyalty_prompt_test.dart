import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/services/ai/ai_agents.dart';

void main() {
  tearDown(ClientProfile.resetTiers);

  test('уровни по умолчанию', () {
    expect(loyaltyTiersText(),
        'Бронза (с 0 ₽) — 3%, Серебро (с 10 000 ₽) — 5%, Золото (с 25 000 ₽) — 7%, '
        'Платина (с 50 000 ₽) — 10%, Алмаз (с 100 000 ₽) — 15%');
  });

  test('помощник гостя называет уровни из настроек заведения', () {
    ClientProfile.applyTiers([
      {'name': 'Гость', 'from': 0, 'cashback': 2},
      {'name': 'Свой', 'from': 5000, 'cashback': 7.5},
    ]);
    final prompt = AiAgents.all.map((a) => a.prompt).firstWhere((p) => p.contains('КАК РАБОТАЮТ БОНУСЫ'));
    expect(prompt, contains('Гость (с 0 ₽) — 2%, Свой (с 5 000 ₽) — 7,5%'));
    expect(prompt, isNot(contains('{{LOYALTY_TIERS}}')));
    expect(prompt, isNot(contains('Бронза')));
  });
}
