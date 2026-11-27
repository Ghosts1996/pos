import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/build_info.dart';
import 'package:hookah_pos/models/venue_models.dart';

// «Кеги на кране» и «Табак и миксы» в меню персонала включаются в
// «Профиле заведения». Не трогали — кеги у бара, табак у заведения с кальянами.
void main() {
  test('по умолчанию: табак у кальянной, кеги у бара', () {
    final hookah = VenueProfile.fromMap({'venueType': 'hookah'});
    expect(hookah.showTobaccoShelf, isTrue);
    expect(hookah.showKegs, isFalse);
    final bar = VenueProfile.fromMap({'venueType': 'bar'});
    expect(bar.showKegs, isTrue);
    expect(bar.showTobaccoShelf, isFalse);
  });

  test('владелец выключил и включил', () {
    final p = VenueProfile.fromMap({'venueType': 'hookah', 'tobaccoShelfEnabled': false, 'kegsEnabled': true});
    expect(p.showTobaccoShelf, isFalse);
    expect(p.showKegs, isTrue);
    // В SaaS выбор сохраняется в профиле (toMap), в hookah-pos полей нет.
    final saved = p.copyWith(tobaccoShelfEnabled: true).toMap();
    if (kSaasMode) {
      expect(saved['tobaccoShelfEnabled'], isTrue);
      expect(saved['kegsEnabled'], isTrue);
    } else {
      expect(saved.containsKey('kegsEnabled'), isFalse);
    }
  });

  test('без кальянов табака нет, даже если переключатель включён', () {
    final p = VenueProfile.fromMap({'venueType': 'restaurant', 'tobaccoShelfEnabled': true});
    expect(p.showTobaccoShelf, isFalse);
  });
}
