import '../models/menu_models.dart';
import 'promo_policy.dart';

/// Можно ли продать позицию с собой или с доставкой. Нельзя: табак и
/// кальяны (ст. 19 закона № 15-ФЗ) и алкоголь, включая пиво (ст. 16 закона
/// № 171-ФЗ запрещает дистанционную продажу), — по флагу «табак», признаку
/// «подакцизный товар» и по названию. Те же правила — на сервере
/// (saas-gateway/guest-delivery.js, remoteSaleBanned): он и решает.
class RemoteSale {
  RemoteSale._();

  static final _alcohol = RegExp(
    r'(^|[^а-яё])(пив[оа]|пивн|вин[оа]($|[^а-яё])|винн|игрист|шампанск|просекко|виски|коньяк|водк|ром($|[^а-яё])|джин($|[^а-яё])|текил|ликёр|ликер|настойк|наливк|сидр|абсент|бренди|вермут|мартини|портвейн|херес|саке|бурбон|кальвадос|граппа|самбук|аперол|медовух|алко)',
    caseSensitive: false,
  );
  static final _extraTobacco = RegExp(r'чаш[аи]|забивк', caseSensitive: false);

  static bool banned(MenuItem item, {String categoryName = ''}) {
    final name = item.name.toLowerCase();
    final cat = categoryName.toLowerCase();
    if (PromoPolicy.menuTobacco(item, categoryName) || _extraTobacco.hasMatch(name) || _extraTobacco.hasMatch(cat)) {
      return true;
    }
    if (item.fiscalSubject == 'excise') return true;
    if (name.contains('безалк')) return false;
    return _alcohol.hasMatch(name) || _alcohol.hasMatch(cat);
  }
}
