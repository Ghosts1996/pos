import 'flavors.dart';
import 'mix_base.dart';

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

  const TobaccoCan({
    required this.id,
    required this.brand,
    required this.name,
    required this.flavors,
    this.strength = '',
    this.inStock = true,
  });

  String get label => brand.isEmpty ? '«$name»' : '$brand «$name»';

  factory TobaccoCan.fromMap(String id, Map<String, dynamic> m) {
    final name = '${m['name'] ?? ''}'.trim();
    final raw = (m['flavors'] is List) ? [for (final f in m['flavors'] as List) '$f'] : const <String>[];
    final keys = [for (final f in raw) if (kFlavorByKey.containsKey(f)) f];
    return TobaccoCan(
      id: id,
      brand: '${m['brand'] ?? ''}'.trim(),
      name: name,
      // Вкусы не указаны — узнаём по названию на банке.
      flavors: keys.isNotEmpty ? keys : flavorsInText('$name ${m['note'] ?? ''}'),
      strength: '${m['strength'] ?? ''}',
      inStock: m['inStock'] != false,
    );
  }

  Map<String, dynamic> toMap() => {
        'brand': brand,
        'name': name,
        'flavors': flavors,
        if (strength.isNotEmpty) 'strength': strength,
        'inStock': inStock,
      };
}

/// Что попросил гость: теги («кислое», «свежее»), вкусы, которые хочет, и
/// которые не любит.
class MixRequest {
  final Set<String> tags;
  final List<String> want;
  final Set<String> avoid;
  const MixRequest({this.tags = const {}, this.want = const [], this.avoid = const {}});

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
    return MixRequest(tags: tags, want: want, avoid: avoid);
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
      : shelf = [for (final c in shelf) if (c.inStock && c.flavors.isNotEmpty) c],
        mixes = mixes ?? kMixes;

  final List<TobaccoCan> shelf;
  final List<Mix> mixes;

  /// Полка не заполнена — подбираем по всей базе, без банок.
  bool get noShelf => shelf.isEmpty;

  /// Банки с этим вкусом: сначала «чистые» (один вкус), потом смешанные.
  List<TobaccoCan> cansFor(String flavor) {
    final list = [for (final c in shelf) if (c.flavors.contains(flavor)) c];
    list.sort((a, b) => a.flavors.length.compareTo(b.flavors.length));
    return list;
  }

  Set<String> get available => {for (final c in shelf) ...c.flavors};

  /// Чем заменить вкус, которого нет: тот же «характер» (холодок на
  /// холодок, кислое на кислое), потом то же семейство.
  String? substitute(String flavor, Set<String> avoid, Set<String> used) {
    final f = kFlavorByKey[flavor];
    if (f == null) return null;
    final av = available.difference(avoid).difference(used);
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

  List<MixPick> pick(MixRequest req, {int limit = 3}) {
    final picks = <MixPick>[];
    for (final mix in mixes) {
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
        var cans = cansFor(flavor);
        if (cans.isEmpty) {
          final s = substitute(flavor, req.avoid, used);
          if (s == null) {
            ok = false;
            break;
          }
          flavor = s;
          cans = cansFor(s);
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
      if (req.tags.contains('крепкий')) {
        if (parts.any((x) => x.can?.strength == 'strong')) score += 2;
      }
      if (req.tags.contains('лёгкий') || req.tags.contains('для новичка')) {
        if (parts.any((x) => x.can?.strength == 'strong')) score -= 3;
      }
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
      if (own != null) out.add(own);
    }
    return out;
  }

  /// Ничего из базы не подошло — собираем по правилам из того, что есть:
  /// основа (что просили или сочный фрукт) + акцент + холодок.
  MixPick? _compose(MixRequest req) {
    final av = available.difference(req.avoid);
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
    return MixPick(mix, [for (final p in mixParts) (part: p, flavor: p.flavor, can: cansFor(p.flavor).firstOrNull)], 0, 0);
  }

  /// Текст ответа: без разметки, по строкам. [forGuest] — без марок табака:
  /// гостю — вкус и доли, банку выберет кальянщик.
  String render(List<MixPick> picks, {bool forGuest = false}) {
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
      if (i < picks.length - 1) b.writeln();
    }
    if (noShelf && !forGuest) {
      b.writeln();
      b.write('Полка табака не заполнена — миксы из общей базы. Сфотографируйте полки в разделе «Табак и миксы», и подбор будет только из того, что есть.');
    }
    return b.toString().trim();
  }
}

String _cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
