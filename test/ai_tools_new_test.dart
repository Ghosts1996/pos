import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/ai/ai_tools.dart';

// Новые функции ИИ-помощника: состав блюда видят и гость, и персонал;
// фудкост, стоп-лист, закупка и допродажа — только персонал.
void main() {
  Set<String> names(AiToolScope s) =>
      AiToolRegistry.instance.schemasFor(s).map((m) => (m['function'] as Map)['name'] as String).toSet();

  test('персоналу — все пять новых функций', () {
    expect(names(AiToolScope.staff),
        containsAll(['get_dish_details', 'get_food_cost', 'get_stop_list', 'get_purchase_list', 'suggest_upsell']));
  });

  test('гостю — только состав блюда, без себестоимости и склада', () {
    final g = names(AiToolScope.guest);
    expect(g, contains('get_dish_details'));
    expect(g.intersection({'get_food_cost', 'get_stop_list', 'get_purchase_list', 'suggest_upsell'}), isEmpty);
  });
}
