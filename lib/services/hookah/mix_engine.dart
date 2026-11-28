import 'brand_profiles.dart';
import 'flavors.dart';
import 'mix_base.dart';
import 'tobacco_catalog.dart';

/// Банка табака на полке заведения (tenants/{t}/tobaccoShelf).
class TobaccoCan {
  final String id;
  final String brand;

  /// Как написано на банке: «Пинкман», «Абрикосовый джем», «Strawberry».
  final String name;

  /// Вкусы банки (ключи flavors.dart): «Пинкман» → клубника, малина, грейпфрут.
  final List<String> flavors;

  /// 'light' | 'medium' | 'strong' | '' — если известна.
  final String strength;
  final bool inStock;

  /// Линейка марки, если видна по банке: «Core», «Base», «Hard», «Земля».
  final String line;

  /// Вид банки словами («чёрная жестянка, красная лента») — из распознавания.
  /// Уходит в общий каталог вместе с маркой и линейкой: ИИ учится узнавать
  /// линейку по цвету и форме банки.
  final String look;

  const TobaccoCan({
    required this.id,
    required this.brand,
    required this.name,
    required this.flavors,
    this.strength = '',
    this.inStock = true,
    this.line = '',
    this.look = '',
  });

  String get label {
    final b = [brand, line].where((x) => x.isNotEmpty).join(' ');
    return b.isEmpty ? '«$name»' : '$b «$name»';
  }

  factory TobaccoCan.fromMap(String id, Map<String, dynamic> m) {
    final name = '${m['name'] ?? ''}'.trim();
    final raw = (m['flavors'] is List) ? [for (final f in m['flavors'] as List) '$f'] : const <String>[];
    final keys = [for (final f in raw) if (kFlavorByKey.containsKey(f)) f];
    // Марка к одному написанию; старые записи с линейкой вместо марки
    // («Terror» → Trofimoff's, линейка Terror) показываются правильно.
    final rawBrand = '${m['brand'] ?? ''}'.trim();
    final brand = rawBrand.isEmpty ? '' : canonicalBrand(rawBrand);
    var line = '${m['line'] ?? ''}'.trim();
    if (line.isEmpty && brand != rawBrand) line = lineFromBrandText(rawBrand);
    return TobaccoCan(
      id: id,
      brand: brand,
      name: name,
      // Вкусы не указаны — узнаём по названию на банке.
      flavors: keys.isNotEmpty ? keys : flavorsInText('$name ${m['note'] ?? ''}'),
      strength: '${m['strength'] ?? ''}',
      inStock: m['inStock'] != false,
      line: line,
      look: '${m['look'] ?? ''}'.trim(),
    );
  }

  Map<String, dynamic> toMap() => {
        'brand': brand,
        'name': name,
        'flavors': flavors,
        if (strength.isNotEmpty) 'strength': strength,
        if (line.isNotEmpty) 'line': line,
        if (look.isNotEmpty) 'look': look,
        'inStock': inStock,
      };
}

/// Что попросил гость: теги («кислое», «свежее»), вкусы, которые хочет, и
/// которые не любит.
class MixRequest {
  final Set<String> tags;
  final List<String> want;
  final Set<String> avoid;

  /// Марка, на которой просили собрать («на дарксайде»): её банки — первыми.
  final String? brand;

  /// Просят другие варианты: «ещё», «другое», «не то».
  final bool more;
  const MixRequest({this.tags = const {}, this.want = const [], this.avoid = const {}, this.brand, this.more = false});

  /// Ключ просьбы — та же просьба ещё раз даёт другие миксы.
  String get key => [
        (tags.toList()..sort()).join(','),
        (want.toList()..sort()).join(','),
        (avoid.toList()..sort()).join(','),
        brand ?? '',
      ].join('|');

  static final _moreRe = RegExp(r'(^|[^а-яa-z])(ещ[её]|друг(ое|ие|ой|ую|их)|иначе|не то|не та|не нравится|поменяй|замени|вариант)');

  static const _tagWords = <String, String>{
    'кисл': 'кислый',
    'сладк': 'сладкий',
    'свеж': 'свежий',
    'холод': 'свежий',
    'ледян': 'свежий',
    'ягод': 'ягодный',
    'цитрус': 'цитрусовый',
    'тропи': 'тропический',
    'экзот': 'тропический',
    'фрукт': 'фруктовый',
    'десерт': 'десертный',
    'сладост': 'десертный',
    'выпеч': 'десертный',
    'прян': 'пряный',
    'цвет': 'цветочный',
    'парфюм': 'парфюмный',
    'духи': 'парфюмный',
    'духов': 'парфюмный',
    'одеколон': 'парфюмный',
    'трав': 'травяной',
    'напит': 'напиток',
    'газиров': 'напиток',
    'коктейл': 'напиток',
    'легк': 'лёгкий',
    'лёгк': 'лёгкий',
    'новичк': 'для новичка',
    'впервые': 'для новичка',
    'первый раз': 'для новичка',
    'крепк': 'крепкий',
    'покрепче': 'крепкий',
    'необыч': 'необычный',
    'интересн': 'необычный',
    'удиви': 'необычный',
    'летн': 'летний',
    'зимн': 'зимний',
    'осен': 'осенний',
    'бодр': 'бодрящий',
    'вечер': 'вечерний',
    'классик': 'классика',
  };

  /// Разбор просьбы: «что-нибудь кислое и свежее, только без мяты».
  factory MixRequest.parse(String text) {
    final t = text.toLowerCase().replaceAll('ё', 'е');
    final tags = <String>{};
    _tagWords.forEach((w, tag) {
      if (t.contains(w.replaceAll('ё', 'е'))) tags.add(tag);
    });
    // «без мяты», «не люблю мяту», «кроме кокоса», «не надо льда».
    final avoid = <String>{};
    for (final m in RegExp(r'(?:без|кроме|не люблю|не хочу|не надо|не нужно|только не)\s+([а-яa-z\- ,]+?)(?=[.,!?;]|$| и | но )').allMatches(t)) {
      avoid.addAll(flavorsInText(m.group(1)!));
    }
    final want = [for (final f in flavorsInText(t)) if (!avoid.contains(f)) f];
    return MixRequest(tags: tags, want: want, avoid: avoid, brand: brandInText(text), more: _moreRe.hasMatch(t));
  }

  bool get isEmpty => tags.isEmpty && want.isEmpty;
}

class MixPick {
  final Mix mix;

  /// Для каждой части микса — вкус, который реально кладём (с заменой), и банка.
  final List<({MixPart part, String flavor, TobaccoCan? can})> parts;
  final int substitutions;
  final double score;
  const MixPick(this.mix, this.parts, this.substitutions, this.score);
}

/// Подбор миксов без ИИ: база миксов × полка заведения × просьба гостя.
class MixEngine {
  MixEngine(List<TobaccoCan> shelf, {List<Mix>? mixes})
      : shelf = [
          // Классика на светлом листе с глицерином в миксы не идёт.
          for (final c in shelf)
            if (c.inStock && c.flavors.isNotEmpty && (profileOf(c.brand)?.mixable ?? true)) c
        ],
        boosters = [
          for (final c in shelf)
            if (c.inStock && (profileOf(c.brand)?.booster ?? false)) c
        ],
        mixes = mixes ?? kMixes;

  final List<TobaccoCan> shelf;

  /// Сухой табак на полке (Frigate) — добавка для крепости, не вкус.
  final List<TobaccoCan> boosters;
  final List<Mix> mixes;

  /// Полка не заполнена — подбираем по всей базе, без банок.
  bool get noShelf => shelf.isEmpty;

  /// Банки с этим вкусом: сначала марка, о которой просили, потом
  /// подходящие по крепости (лёгкое — светлый лист, крепкое — тёмный),
  /// потом «чистые» (один вкус).
  List<TobaccoCan> cansFor(String flavor, [MixRequest? req]) {
    final list = [for (final c in shelf) if (c.flavors.contains(flavor)) c];
    final light = req != null && (req.tags.contains('лёгкий') || req.tags.contains('для новичка'));
    final strong = req != null && req.tags.contains('крепкий');
    int rank(TobaccoCan c) {
      var r = c.flavors.length;
      if (req?.brand != null && canonicalBrand(c.brand) == req!.brand) r -= 100;
      final s = canStrength(c.brand, c.strength, line: c.line);
      if (light) r += s * 3;
      if (strong) r -= s * 3;
      return r;
    }

    list.sort((a, b) => rank(a).compareTo(rank(b)));
    return list;
  }

  Set<String> get available => {for (final c in shelf) ...c.flavors};

  /// Чем заменить вкус, которого нет: тот же «характер» (холодок на
  /// холодок, кислое на кислое), потом то же семейство.
  String? substitute(String flavor, Set<String> avoid, Set<String> used) {
    final f = kFlavorByKey[flavor];
    if (f == null || _special.contains(flavor)) return null;
    final av = available.difference(avoid).difference(used).difference(_special);
    if (f.cooling) {
      for (final k in ['mint', 'ice', 'menthol', 'wintergreen', 'eucalyptus', 'lemongrass', 'pine']) {
        if (av.contains(k)) return k;
      }
    }
    String? best;
    var bestScore = -1;
    for (final k in av) {
      final g = kFlavorByKey[k];
      if (g == null) continue;
      var s = 0;
      if (g.family == f.family) s += 3;
      if (g.sour == f.sour) s += 1;
      if (g.cooling == f.cooling) s += 1;
      if (s >= 3 && s > bestScore) {
        best = k;
        bestScore = s;
      }
    }
    return best;
  }

  /// Табачный и солёный вкус — не замена фрукту и не основа своего микса.
  static const _special = {'tobacco', 'savory'};

  /// [exclude] — названия миксов, которые уже показали («другие варианты»).
  List<MixPick> pick(MixRequest req, {int limit = 3, Set<String> exclude = const {}}) {
    final picks = <MixPick>[];
    for (final mix in mixes) {
      if (exclude.contains(mix.name)) continue;
      if (mix.flavors.any(req.avoid.contains)) continue;
      final used = <String>{};
      final parts = <({MixPart part, String flavor, TobaccoCan? can})>[];
      var subs = 0;
      var ok = true;
      for (final p in mix.parts) {
        if (noShelf) {
          parts.add((part: p, flavor: p.flavor, can: null));
          continue;
        }
        var flavor = p.flavor;
        var cans = cansFor(flavor, req);
        if (cans.isEmpty) {
          final s = substitute(flavor, req.avoid, used);
          if (s == null) {
            ok = false;
            break;
          }
          flavor = s;
          cans = cansFor(s, req);
          subs++;
        }
        used.add(flavor);
        parts.add((part: p, flavor: flavor, can: cans.isEmpty ? null : cans.first));
      }
      if (!ok || subs > 1) continue;
      var score = 0.0;
      for (final t in req.tags) {
        if (mix.tags.contains(t)) score += 2;
      }
      for (final w in req.want) {
        if (parts.any((x) => x.flavor == w)) score += 4;
      }
      // Просили конкретное — микс без этого вкуса не годится.
      if (req.want.isNotEmpty && !req.want.any((w) => parts.any((x) => x.flavor == w))) continue;
      if (req.tags.isNotEmpty && !req.tags.any(mix.tags.contains) && req.want.isEmpty) continue;
      final power = mixStrength(parts);
      if (power != null) {
        if (req.tags.contains('крепкий')) score += power >= 7 ? 3 : (power >= 6 ? 1 : -2);
        if (req.tags.contains('лёгкий') || req.tags.contains('для новичка')) score += power <= 4.5 ? 3 : (power >= 7 ? -4 : 0);
      }
      if (req.brand != null && parts.any((x) => x.can != null && canonicalBrand(x.can!.brand) == req.brand)) score += 3;
      score -= subs * 1.5;
      picks.add(MixPick(mix, parts, subs, score));
    }
    picks.sort((a, b) => b.score.compareTo(a.score));
    // Разнообразие: не три микса с одной основой.
    final out = <MixPick>[];
    final bases = <String>{};
    for (final p in picks) {
      final base = p.parts.first.flavor;
      if (bases.contains(base) && picks.length > limit * 2) continue;
      bases.add(base);
      out.add(p);
      if (out.length >= limit) break;
    }
    if (out.isEmpty && !noShelf) {
      final own = _compose(req);
      if (own != null && !exclude.contains(own.mix.name)) out.add(own);
    }
    return out;
  }

  /// Ничего из базы не подошло — собираем по правилам из того, что есть:
  /// основа (что просили или сочный фрукт) + акцент + холодок.
  MixPick? _compose(MixRequest req) {
    final av = available.difference(req.avoid).difference({for (final k in _special) if (!req.want.contains(k)) k});
    if (av.isEmpty) return null;
    String? base;
    for (final w in req.want) {
      if (av.contains(w)) base = w;
    }
    base ??= av.firstWhere(
        (k) => const {FlavorFamily.berry, FlavorFamily.tropic, FlavorFamily.fruit}.contains(kFlavorByKey[k]?.family),
        orElse: () => av.first);
    final rest = av.difference({base});
    final accent = rest.where((k) {
      final f = kFlavorByKey[k];
      if (f == null || f.cooling) return false;
      return req.tags.contains('кислый') || req.tags.contains('свежий') ? f.sour : f.family != kFlavorByKey[base]?.family;
    }).firstOrNull;
    final cool = req.tags.contains('сладкий') || req.tags.contains('десертный')
        ? null
        : rest.where((k) => kFlavorByKey[k]?.cooling == true).firstOrNull;
    final name = kFlavorByKey[base]?.name ?? base;
    final mixParts = [
      MixPart(base, accent == null && cool == null ? 10 : (cool == null ? 6 : 5)),
      if (accent != null) MixPart(accent, cool == null ? 4 : 3),
      if (cool != null) MixPart(cool, 2),
    ];
    final mix = Mix('Свой микс: ${_cap(name)}', mixParts, req.tags, 'Собран из того, что есть на полке');
    return MixPick(mix, [for (final p in mixParts) (part: p, flavor: p.flavor, can: cansFor(p.flavor, req).firstOrNull)], 0, 0);
  }

  /// Текст ответа: без разметки, по строкам. [forGuest] — без марок табака:
  /// гостю — вкус и доли, банку выберет кальянщик.
  String render(List<MixPick> picks, {bool forGuest = false, MixRequest? req}) {
    if (picks.isEmpty) {
      return forGuest
          ? 'Подходящего микса не нашлось — спросите кальянщика, он подберёт вкус лично для вас.'
          : 'Из того, что есть на полке, под эту просьбу микса не нашлось. Уточните вкус или обновите полку табака.';
    }
    final b = StringBuffer();
    for (var i = 0; i < picks.length; i++) {
      final p = picks[i];
      final tags = p.mix.tags.where((t) => t != 'для новичка').take(3).join(', ');
      b.writeln('${i + 1}. ${p.mix.name}${tags.isEmpty ? '' : ' — $tags'}');
      for (final x in p.parts) {
        final fl = kFlavorByKey[x.flavor]?.name ?? x.flavor;
        final can = (!forGuest && x.can != null) ? ' — ${x.can!.label}' : '';
        b.writeln('— ${_cap(fl)} ${x.part.share}/10$can');
      }
      if (p.substitutions > 0 && !forGuest) b.writeln('— Один вкус заменён похожим из того, что есть');
      if (p.mix.note.isNotEmpty) b.writeln(p.mix.note);
      final how = forGuest ? guestStrength(p.parts) : howToPack(p.parts);
      if (how.isNotEmpty) b.writeln(how);
      final boost = forGuest ? '' : boosterTip(boosters, p.parts, req);
      if (boost.isNotEmpty) b.writeln(boost);
      if (i < picks.length - 1) b.writeln();
    }
    if (noShelf && !forGuest) {
      b.writeln();
      b.write('Полка табака не заполнена — миксы из общей базы. Сфотографируйте полки в разделе «Табак и миксы», и подбор будет только из того, что есть.');
    }
    return b.toString().trim();
  }
}

typedef _Parts = List<({MixPart part, String flavor, TobaccoCan? can})>;

/// Крепость микса 1–10: средняя по долям (марка банки → справочник).
/// null — ни у одной банки марка не известна.
double? mixStrength(_Parts parts) {
  var sum = 0.0;
  var w = 0;
  var known = false;
  for (final x in parts) {
    final c = x.can;
    if (c == null) continue;
    if (profileOf(c.brand) != null || c.strength.isNotEmpty) known = true;
    sum += canStrength(c.brand, c.strength, line: c.line) * x.part.share;
    w += x.part.share;
  }
  if (!known || w == 0) return null;
  return sum / w;
}

/// Гостю — только крепость словами.
String guestStrength(_Parts parts) {
  final s = mixStrength(parts);
  return s == null ? '' : 'Крепость: ${strengthWord(s)}.';
}

/// Кальянщику: крепость, забивка (слоями — если марки по-разному держат
/// жар), граммы, угли и прогрев — по справочнику марок.
String howToPack(_Parts parts) {
  final profs = [
    for (final x in parts)
      if (x.can != null && profileOf(x.can!.brand) != null) (p: profileOf(x.can!.brand)!, share: x.part.share, can: x.can!),
  ];
  final s = mixStrength(parts);
  if (profs.isEmpty) return s == null ? '' : 'Крепость ≈ ${s.toStringAsFixed(0)}/10, ${strengthWord(s)}.';
  final b = StringBuffer();
  if (s != null) b.write('Крепость ≈ ${s.round()}/10, ${strengthWord(s)}. ');
  final darkShare = profs.where((x) => x.p.leaf == Leaf.dark).fold<int>(0, (a, x) => a + x.share);
  final pack = darkShare >= 4
      ? 'внакидку с отступом 2–3 мм, без трамбовки'
      : (profs.every((x) => x.p.pack == Pack.overpack) ? '«с горкой», рыхло' : 'пушистая внасыпку, не трамбовать');
  final gMin = (profs.map((x) => x.p.gramsMin).reduce((a, c) => a + c) / profs.length).round();
  final gMax = (profs.map((x) => x.p.gramsMax).reduce((a, c) => a + c) / profs.length).round();
  b.write('Забивка: $pack, $gMin–$gMax г');
  final hi = profs.map((x) => x.p.heat).reduce((a, c) => a > c ? a : c);
  final lo = profs.map((x) => x.p.heat).reduce((a, c) => a < c ? a : c);
  if (hi - lo >= 2) {
    final top = {for (final x in profs) if (x.p.heat == hi) x.p.brand}.join(', ');
    final bottom = {for (final x in profs) if (x.p.heat == lo) x.p.brand}.join(', ');
    b.write('; слоями: сверху $top (держит жар), снизу $bottom — иначе нежный табак пригорит');
  } else {
    b.write('; табаки перемешать');
  }
  b.write('. ');
  final warm = profs.map((x) => x.p.warmup).reduce((a, c) => a > c ? a : c);
  b.write(lo <= 3
      ? 'Угли: 2–3 по 25 мм (лучше калауд), прогрев $warm мин, следите за пригаром.'
      : 'Угли: 3 по 25 мм, прогрев $warm мин.');
  if (s != null && s >= 7 && profs.any((x) => x.p.leaf == Leaf.dark)) b.write(' Новичку — уменьшить долю тёмного листа.');
  return b.toString();
}

/// Просили крепче, а микс средний — подсказать сухой табак с полки.
String boosterTip(List<TobaccoCan> boosters, _Parts parts, MixRequest? req) {
  if (boosters.isEmpty || req == null || !req.tags.contains('крепкий')) return '';
  final s = mixStrength(parts);
  if (s != null && s >= 8) return '';
  return 'Для крепости: 1–2 из 10 сухого табака ${boosters.first.label} на дно чаши — вкус не изменится.';
}

/// Подбор с памятью: та же просьба ещё раз (или «ещё», «другое») — другие
/// миксы, пока они не закончатся; потом — по кругу.
class MixSession {
  MixRequest? _last;
  final Set<String> _shown = {};

  /// Ответ на просьбу. [fallback] — что подбирать, если просьба пустая.
  String answer(MixEngine engine, String text, {bool forGuest = false, String fallback = 'для новичка'}) {
    var req = MixRequest.parse(text);
    if (req.isEmpty) {
      req = (req.more && _last != null) ? _last! : MixRequest.parse(fallback);
    }
    if (_last == null || req.key != _last!.key) _shown.clear();
    var picks = engine.pick(req, exclude: _shown);
    var again = false;
    if (picks.isEmpty && _shown.isNotEmpty) {
      _shown.clear();
      again = true;
      picks = engine.pick(req);
    }
    _last = req;
    _shown.addAll(picks.map((p) => p.mix.name));
    var body = engine.render(picks, forGuest: forGuest, req: req);
    // «Парфюмное» — первый раз объясняем, что это за вкус.
    if (req.tags.contains('парфюмный') && _shown.length <= picks.length) body = '$kPerfumeNote\n\n$body';
    return again ? 'Другие варианты под эту просьбу закончились — показываю сначала.\n\n$body' : body;
  }

  void reset() {
    _last = null;
    _shown.clear();
  }
}

/// Что такое парфюмный вкус — для гостя и персонала.
const String kPerfumeNote = 'Парфюмный вкус — табак, который пахнет как духи: ноты бергамота, розы, лаванды, '
    'жасмина, фиалки, ванили и «парфюмерные» — уд, ладан, мускус, амбра, сандал, пачули. '
    'Он нежный и необычный, обычно для вечера. Миксы собирают на цветочных и цитрусовых вкусах '
    'с ягодой или ванилью; парфюмные банки кладут акцентом — 2–4 части из 10.';

String _cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
