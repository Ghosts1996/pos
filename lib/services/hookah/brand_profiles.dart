/// Справочник марок табака для кальяна: лист, крепость, жаростойкость,
/// как забивать, сколько углей и сколько греть. По нему касса считает у
/// микса общую крепость, подсказывает забивку («слоями» — если марки
/// по-разному держат жар) и выбирает банки под просьбу гостя (лёгкое —
/// светлый лист, крепкое — тёмный).
///
/// Цифры — ориентир (описания производителей, опыт кальянщиков): у разных
/// линеек одной марки крепость и жар бывают разными — это сказано в
/// подсказке. Без ИИ и без сети.
///
/// Классика на светлом листе с глицерином (Al Fakher, Adalya, Serbetli,
/// Nakhla, Afzal) в миксы не идёт — по просьбе заведения подбор строится на
/// современных табаках; распознавание полки их по-прежнему узнаёт.
library;

import 'tobacco_catalog.dart';

/// Лист: светлый (вирджиния, мягче, больше аромата), тёмный (бёрли,
/// крепче, держит жар), смешанный, чайная смесь.
enum Leaf { light, dark, mixed, tea }

/// Забивка.
enum Pack {
  /// Пушистая внасыпку: табак разрыхлить и сыпать до края, не трамбовать.
  fluffy,

  /// Внакидку с отступом 2–3 мм от края чаши, без трамбовки — тёмный лист.
  edges,

  /// «С горкой» (овербаунс) — для очень жаростойких, сухих табаков.
  overpack,
}

class BrandProfile {
  final String brand;
  final Leaf leaf;

  /// Крепость 1–10 (обычная для марки).
  final int strength;

  /// Жаростойкость 1–5: 5 — держит три угля весь сеанс, 2 — легко пригорает.
  final int heat;
  final Pack pack;

  /// Граммов в чашу (обычная чаша «фанел»/«убивашка» 15–20 г).
  final int gramsMin;
  final int gramsMax;

  /// Прогрев, минут (3 угля 25 мм).
  final int warmup;

  /// Подсказка кальянщику — одна-две фразы.
  final String tip;

  /// Идёт в подбор миксов.
  final bool mixable;

  /// «Усилитель»: сухой табак без глицерина и аромата (Frigate). Отдельно
  /// не курят — 1–2 из 10 на дно чаши, чтобы поднять крепость микса.
  final bool booster;

  const BrandProfile(
    this.brand,
    this.leaf,
    this.strength,
    this.heat,
    this.pack,
    this.gramsMin,
    this.gramsMax,
    this.warmup,
    this.tip, {
    this.mixable = true,
    this.booster = false,
  });

  String get leafLabel => switch (leaf) {
        Leaf.light => 'светлый лист',
        Leaf.dark => 'тёмный лист',
        Leaf.mixed => 'смешанный лист',
        Leaf.tea => 'чайная смесь',
      };

  String get packLabel => switch (pack) {
        Pack.fluffy => 'пушистая забивка внасыпку, не трамбовать',
        Pack.edges => 'внакидку с отступом 2–3 мм от края, без трамбовки',
        Pack.overpack => '«с горкой» (овербаунс), табак рыхлый',
      };

  String get heatLabel => switch (heat) {
        5 => 'очень высокая',
        4 => 'высокая',
        3 => 'средняя',
        2 => 'низкая',
        _ => 'очень низкая',
      };

  /// Карточка марки для кальянщика.
  String card() => booster
      ? '$brand — сухой табак без глицерина, крепость $strength/10 (${strengthWord(strength)}).\n'
          'Для чего: поднять крепость микса, не меняя вкус. Отдельно не курят.\n'
          'Сколько: 1–2 из 10 (2–3 г на чашу), на дно чаши, под ароматный табак.\n'
          '$tip'
      : '$brand — $leafLabel, крепость $strength/10 (${strengthWord(strength)}), '
      'жаростойкость $heatLabel.\n'
      'Забивка: $packLabel, $gramsMin–$gramsMax г.\n'
      'Угли: ${heat >= 4 ? '3 угля 25 мм' : '2–3 угля 25 мм, лучше калауд или угли по краям'}, прогрев $warmup мин.\n'
      '$tip'
      '${mixable ? '' : '\nВ подбор миксов не идёт: классика на светлом листе с глицерином.'}';
}

String strengthWord(num s) => s >= 9
    ? 'очень крепкий'
    : s >= 7
        ? 'крепкий'
        : s >= 4
            ? 'средний'
            : 'лёгкий';

const List<BrandProfile> kBrandProfiles = [
  // ---- Тёмный лист: крепкие, держат жар
  BrandProfile('Darkside', Leaf.dark, 7, 5, Pack.edges, 15, 18, 6,
      'Яркий концентрированный вкус: в миксе 3–5 из 10 перекрывает лёгкие табаки. Линейка Base крепче Core. Не трамбовать, иначе горчит.'),
  BrandProfile('Black Burn', Leaf.dark, 7, 5, Pack.edges, 15, 18, 6,
      'Сочные «ледяные» и ягодные вкусы, держит три угля весь сеанс. Хорош как основа крепкого микса.'),
  BrandProfile('Bonche', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Крупная нарезка, табак суховат: не перегревать первые минуты, греть дольше. Гастрономичные и необычные вкусы — акцент, не основа для новичка.'),
  BrandProfile('Dogma', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Крепкий тёмный лист, вкусы плотные. Для новичка — не больше 3 из 10 в миксе со светлым листом.'),
  BrandProfile('Северный', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Крепкий, «северные» ягоды и травы. Прогревать спокойно, первые затяжки мягкие.'),
  BrandProfile('Satyr', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Высокая крепость и жаростойкость, вкус держится до конца. В лёгкий микс — только акцентом.'),
  BrandProfile('Overdose', Leaf.dark, 7, 5, Pack.edges, 15, 17, 6,
      'Тёмный лист, насыщенные сладкие вкусы. Хорошо держит жар, в миксе — основа или сильный акцент.'),
  BrandProfile('Хулиган', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Крепкий тёмный лист с яркими вкусами. Новичку — в миксе со светлым листом, не больше трети.'),
  BrandProfile('WTO', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Табак с выраженным табачным вкусом (линейки по странам листа). Для ценителей крепкого; в миксе — основа.'),
  BrandProfile('Dedushka', Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
      'Крепкий, «домашние» вкусы (земляника, варенье). Хорош акцентом к светлому листу.'),
  BrandProfile('Tangiers', Leaf.dark, 9, 5, Pack.edges, 12, 15, 8,
      'Очень крепкий, только для опытных. Долгий прогрев, в миксе со светлым листом — не больше 3 из 10.'),
  BrandProfile('Burn', Leaf.dark, 6, 4, Pack.edges, 15, 18, 6, 'Тёмный лист средней крепости, ровный вкус.'),
  BrandProfile('Duft', Leaf.dark, 6, 4, Pack.edges, 15, 17, 6,
      'Средне-крепкий (линейка Strong крепче). Насыщенные классические вкусы.'),
  // ---- Смешанный лист: средние, универсальные основы
  BrandProfile('Musthave', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5,
      'Универсальная основа миксов: средняя крепость, держит жар. Сочетается почти со всеми марками.'),
  BrandProfile('Trofimoff', Leaf.mixed, 6, 4, Pack.edges, 15, 17, 6,
      'Средне-крепкий, у линеек крепость разная. Насыщенные вкусы, ровно держит жар.'),
  BrandProfile('Deus', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5,
      'Средняя крепость, сочные фруктовые и десертные вкусы. Хорошая основа для гостей среднего уровня.'),
  BrandProfile('Spectrum', Leaf.mixed, 5, 4, Pack.fluffy, 17, 20, 5,
      'Линейки разные: Classic — светлее и мягче, Hard — тёмный лист и крепче, Kitchen — гастрономичные вкусы. Смотрите линейку на банке.'),
  BrandProfile('Banger', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5,
      'Средняя крепость, яркие сладкие вкусы (жвачки, сорбеты). Хорош основой «сладкого» микса.'),
  BrandProfile('Sarma', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5,
      'Средняя крепость, натуральные фруктовые вкусы. Ровно курится, хорошая основа.'),
  BrandProfile('Element', Leaf.mixed, 5, 3, Pack.fluffy, 18, 20, 5,
      'Линейки по стихиям: Вода и Воздух — светлый лист, мягкие; Земля — тёмный, крепче; Огонь — самый крепкий. Не перегревать светлые линейки.'),
  BrandProfile('Sebero', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость, сочные вкусы, универсален в миксах.'),
  BrandProfile('Jent', Leaf.mixed, 5, 3, Pack.fluffy, 17, 19, 5, 'Средний, мягкий дым; не перегревать.'),
  BrandProfile('NАШ', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость, понятные «домашние» вкусы.'),
  BrandProfile('Kraken', Leaf.mixed, 6, 4, Pack.fluffy, 16, 18, 5, 'Средне-крепкий, насыщенный вкус.'),
  BrandProfile('Lastochka', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость, яркие вкусы; основа или акцент.'),
  BrandProfile('Timeless', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость, ровный дым.'),
  BrandProfile('Craftium', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость, «крафтовые» вкусы.'),
  BrandProfile('Morpheus', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость.'),
  BrandProfile('Timeline', Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5, 'Средняя крепость.'),
  BrandProfile('MattPear', Leaf.mixed, 5, 3, Pack.fluffy, 17, 19, 5, 'Средний, мягкий; не перегревать.'),
  BrandProfile('Original Virginia', Leaf.light, 6, 4, Pack.fluffy, 16, 18, 6,
      'Вирджиния, но не «лёгкая»: крепость средняя и выше, табачная нота. Держит жар лучше обычного светлого листа.'),
  // ---- Светлый лист: лёгкие, ароматные, боятся перегрева
  BrandProfile('Blanch', Leaf.light, 4, 3, Pack.fluffy, 18, 20, 4,
      'Светлый лист, мягкий и ароматный. Не перегревать: 2–3 угля, следить за первыми затяжками.'),
  BrandProfile('Daily Hookah', Leaf.light, 4, 3, Pack.fluffy, 18, 20, 4, 'Светлый лист, мягкий, хорош для новичков.'),
  BrandProfile('Starline', Leaf.light, 3, 3, Pack.fluffy, 18, 20, 4, 'Лёгкий, ароматный; основа «лёгкого» микса.'),
  BrandProfile('Palitra', Leaf.light, 3, 3, Pack.fluffy, 18, 20, 4, 'Лёгкий, светлый лист.'),
  BrandProfile('Zomo', Leaf.light, 3, 3, Pack.fluffy, 18, 20, 4, 'Лёгкий, светлый лист; мягкий дым.'),
  BrandProfile('Brusko', Leaf.light, 4, 3, Pack.fluffy, 18, 20, 4, 'Мягкий, сладкие вкусы; не перегревать.'),
  BrandProfile('Fumari', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Светлый лист, лёгкий; боится перегрева — 2–3 угля, калауд.'),
  BrandProfile('Starbuzz', Leaf.light, 4, 3, Pack.fluffy, 18, 20, 4, 'Светлый лист, яркие сладкие вкусы.'),
  BrandProfile('Sapphire Crown', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Лёгкий, влажный; 2–3 угля, не перегревать.'),
  BrandProfile('Chabacco', Leaf.tea, 3, 4, Pack.fluffy, 16, 18, 5,
      'Смесь на основе чая: держит жар, мягкая. Подходит тем, кто не любит табачную крепость.'),
  // ---- Сухой табак — усилитель крепости, в подбор вкусов не идёт
  BrandProfile('Frigate', Leaf.dark, 10, 5, Pack.edges, 2, 3, 7,
      'Почти без аромата, поэтому вкус микса остаётся прежним. Новичку не добавлять. Прогрев дольше обычного, первые затяжки — мягко.',
      mixable: false, booster: true),
  // ---- Классика на светлом листе — в подбор не идёт
  BrandProfile('Al Fakher', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Классика на светлом листе с глицерином.', mixable: false),
  BrandProfile('Adalya', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Классика на светлом листе с глицерином.', mixable: false),
  BrandProfile('Serbetli', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Классика на светлом листе с глицерином.', mixable: false),
  BrandProfile('Nakhla', Leaf.light, 4, 2, Pack.fluffy, 18, 20, 4, 'Классика на светлом листе с глицерином.', mixable: false),
  BrandProfile('Afzal', Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4, 'Классика на светлом листе с глицерином.', mixable: false),
];

/// Профиль по виду марки из дополнительного списка (tobacco_catalog.dart):
/// цифры — ориентир по типу листа, у конкретной банки может отличаться.
BrandProfile? _byKind(String brand, String kind) => switch (kind) {
      'classic' => BrandProfile(brand, Leaf.light, 3, 2, Pack.fluffy, 18, 20, 4,
          'Классика на светлом листе с глицерином: мягкая, боится перегрева. Цифры — ориентир.', mixable: false),
      'light' => BrandProfile(brand, Leaf.light, 4, 3, Pack.fluffy, 18, 20, 4,
          'Светлый лист: мягкий, ароматный, не перегревать — 2–3 угля. Цифры — ориентир.'),
      'mixed' => BrandProfile(brand, Leaf.mixed, 5, 4, Pack.fluffy, 16, 18, 5,
          'Средняя крепость, держит жар. Цифры — ориентир, смотрите линейку на банке.'),
      'dark' => BrandProfile(brand, Leaf.dark, 7, 5, Pack.edges, 15, 17, 6,
          'Тёмный лист: крепкий, держит жар, внакидку без трамбовки. Цифры — ориентир.'),
      'strong' => BrandProfile(brand, Leaf.dark, 8, 5, Pack.edges, 14, 16, 7,
          'Очень крепкий тёмный лист: новичку — не больше трети микса. Цифры — ориентир.'),
      'herbal' => BrandProfile(brand, Leaf.tea, 1, 4, Pack.fluffy, 16, 18, 5,
          'Без табака и никотина (травяная/чайная смесь): подходит тем, кто не курит табак.', mixable: false),
      _ => null,
    };

final Map<String, BrandProfile> _byName = {
  for (final p in kBrandProfiles) p.brand: p,
  for (final line in kMoreBrandLines)
    if (!kBrandProfiles.any((p) => p.brand == line.split('|').first))
      if (_byKind(line.split('|').first, line.split('|')[2]) case final p?) line.split('|').first: p,
};

/// Профиль марки по написанию с банки («дарксайд», «BONCHE»). null — не знаем.
BrandProfile? profileOf(String brand) {
  if (brand.trim().isEmpty) return null;
  return _byName[canonicalBrand(brand)];
}

/// Крепость линеек, у которых она заметно отличается от обычной у марки.
const Map<String, Map<String, int>> kLineStrength = {
  'Darkside': {'core': 7, 'base': 8, 'rare': 7, 'xperience': 7, 'shot': 7},
  'Black Burn': {'shock': 8},
  'Adalya': {'black': 6},
  'Nakhla': {'mizo': 3, 'mix': 3},
  'Sarma': {'360': 6},
  'Spectrum': {'classic': 4, 'hard': 7, 'kitchen': 5},
  'Element': {'вода': 4, 'воздух': 4, 'земля': 6, 'огонь': 7},
  'Sebero': {'black': 7, 'classic': 5},
  'Duft': {'strong': 7, 'pheromone': 6, 'all-in': 5, 'all in': 5},
  'Хулиган': {'hard': 8},
  'Trofimoff': {'burley': 7, 'classic': 5, 'terror': 8, 'террор': 8},
  'Tangiers': {'birquq': 7, 'noir': 9, 'нуар': 9, 'f-line': 9},
  'Jent': {'cigar': 8},
};

/// Линейки марки для подсказки в окне правки банки: «Classic, Burley, Terror».
List<String> linesOf(String brand) {
  final map = kLineStrength[canonicalBrand(brand)];
  if (map == null) return const [];
  final out = <String>[];
  for (final k in map.keys) {
    if (RegExp(r'[а-я]').hasMatch(k) && map.keys.any((x) => x != k && map[x] == map[k] && !RegExp(r'[а-я]').hasMatch(x))) continue;
    final title = RegExp(r'^[a-z]').hasMatch(k) ? '${k[0].toUpperCase()}${k.substring(1)}' : '${k[0].toUpperCase()}${k.substring(1)}';
    if (!out.contains(title)) out.add(title);
  }
  return out;
}

/// Линейка из надписи марки: «Darkside Shot» → Shot, «Сарма 360» → 360,
/// «Noir» (это Tangiers) → Noir. Пусто — линейки в надписи нет.
String lineFromBrandText(String raw) {
  final brand = canonicalBrand(raw);
  final map = kLineStrength[brand];
  if (map == null) return '';
  final t = ' ${raw.toLowerCase().replaceAll('ё', 'е')} ';
  for (final k in map.keys) {
    if (RegExp('[^a-zа-я0-9]${RegExp.escape(k)}(?![a-zа-я0-9])').hasMatch(t)) {
      if (k == 'нуар') return 'Noir';
      if (k == 'террор') return 'Terror';
      return RegExp(r'^[a-z]').hasMatch(k) ? '${k[0].toUpperCase()}${k.substring(1)}' : k;
    }
  }
  return '';
}

/// Крепость линейки марки или null — линейка не известна.
int? lineStrength(String brand, String line) {
  final l = line.toLowerCase().replaceAll('ё', 'е').trim();
  if (l.isEmpty) return null;
  final map = kLineStrength[canonicalBrand(brand)];
  if (map == null) return null;
  for (final e in map.entries) {
    if (l.contains(e.key)) return e.value;
  }
  return null;
}

/// Одна строка о банке для кальянщика: лист, крепость (с линейкой),
/// жаростойкость, забивка. Пусто — марку не знаем.
String canProfileLine(String brand, {String line = ''}) {
  final p = profileOf(brand);
  if (p == null) return '';
  final s = lineStrength(brand, line) ?? p.strength;
  if (p.booster) return 'сухой табак для крепости · ${p.strength}/10 · 1–2 из 10 в микс';
  final pack = p.pack == Pack.edges ? 'внакидку' : (p.pack == Pack.overpack ? 'с горкой' : 'пушисто');
  return '${p.leafLabel} · крепость $s/10 · жар ${p.heat}/5 · $pack';
}

/// Крепость банки 1–10: по марке, иначе по отметке на банке.
int canStrength(String brand, String strengthTag, {String line = ''}) {
  final byLine = lineStrength(brand, line);
  if (byLine != null) return byLine;
  final p = profileOf(brand);
  if (p != null) return p.strength;
  return switch (strengthTag) {
    'light' => 3,
    'strong' => 8,
    _ => 5,
  };
}

/// Марка, упомянутая в тексте: «на дарксайде», «что-то из бонча».
/// Возвращает каноническое имя или null.
String? brandInText(String text) {
  final t = ' ${text.toLowerCase().replaceAll('ё', 'е')} ';
  for (final b in kAllBrands) {
    for (final w in [b.name, ...b.aliases]) {
      final k = w.toLowerCase().replaceAll('ё', 'е');
      if (k.length < 3) continue;
      // «сарма» найдёт и «сармы», «бонче» — «бонча»: основа без последней
      // буквы. Короткие («вто», «нуар») — только целым словом, иначе «вто»
      // нашлось бы во «втором».
      final stem = k.length >= 5 ? k.substring(0, k.length - 1) : k;
      final tail = k.length >= 5 ? '' : '(?![а-яa-z])';
      if (RegExp('(^|[^а-яa-z])${RegExp.escape(stem)}$tail').hasMatch(t)) return b.name;
    }
  }
  return null;
}

/// Что такое сухой табак и зачем он — для ассистента.
const String kDryTobacco = '''Сухой табак (например, Frigate)
— Табачный лист без глицерина и почти без аромата. Отдельно его не курят: дыма мало, вкус «табачный».
— Зачем: поднять крепость микса, не меняя вкус. Гость просит «покрепче», а любимые вкусы — на мягком табаке: добавьте сухой.
— Сколько: 1–2 из 10 (2–3 г на чашу 16–18 г). Больше — вкус «просядет» и станет горчить.
— Как: на дно чаши, под ароматный табак, не перемешивать. Прогрев на 1–2 минуты дольше, первые затяжки — мягко.
— Кому нельзя: новичкам и тем, кто просит «полегче».''';

/// Правила сборки миксов — для ассистента («как правильно миксовать»).
const String kMixRules = '''Как собрать вкусный микс
— Доли на 10 частей: основа 5–6, акцент 3–4, «связка» или холодок 1–2. Больше трёх вкусов — каша, вкус теряется.
— Основа — сочный фрукт или ягода, акцент — кислое (цитрус, смородина, гранат) или контраст (сливки, пряность). Холодок — не больше 2 из 10, иначе глушит вкус.
— Сухой табак (Frigate) — без глицерина и почти без аромата, его добавляют для крепости: 1–2 из 10 на дно чаши, вкус микса не меняется. Отдельно не курят, новичкам не добавляют.
— Крепость: тёмный лист (Darkside, Black Burn, Bonche, Dogma, Северный, Overdose, WTO) — крепче и ярче; светлый лист (Blanch, Daily Hookah, Starline) — мягче. Новичку тёмного листа не больше трети микса, лучше основа на смешанном листе (Musthave, Deus, Sarma, Banger, Spectrum Classic).
— Яркие марки (Darkside, Black Burn) перебивают мягкие: долю делайте меньше, чем по рецепту, — 3 вместо 5.
— Жар: марки с разной жаростойкостью кладите слоями — жаростойкий сверху, ближе к углям, нежный снизу. Одинаковые — перемешать.
— Забивка: тёмный лист — внакидку с отступом 2–3 мм, без трамбовки; светлый и смешанный — пушистая внасыпку до края. Трамбовка = горечь и пригар.
— Угли: 3 угля 25 мм, прогрев 5–7 минут (тёмному листу — дольше). Светлый лист боится перегрева: 2–3 угля или калауд.
— Холодок (мята, лёд, ментол) кладите вниз или перемешайте — сверху он «сгорает» первым.
— Десерт + кислое, сладкое + свежее, фрукт + сливки — беспроигрышные пары. Пряности (корица, кардамон) и травы — 1–2 из 10.''';
