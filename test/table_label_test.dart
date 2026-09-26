import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/table_label.dart';

void main() {
  test('слово «Стол» не дублируется', () {
    expect(tableLabel('Стол 2'), 'Стол 2');
    expect(tableLabel('стол у окна'), 'стол у окна');
    expect(tableLabel('5'), 'Стол 5');
    expect(tableLabel('VIP'), 'Стол VIP');
    expect(tableLabel('  '), 'Стол');
  });

  test('согласование «бонус» с числом', () {
    expect(bonusesLabel(1), '1 бонус');
    expect(bonusesLabel(3), '3 бонуса');
    expect(bonusesLabel(5), '5 бонусов');
    expect(bonusesLabel(11), '11 бонусов');
    expect(bonusesLabel(21), '21 бонус');
    expect(bonusesLabel(81), '81 бонус');
    expect(bonusesLabel(112), '112 бонусов');
    expect(bonusesLabel(0), '0 бонусов');
  });
}
