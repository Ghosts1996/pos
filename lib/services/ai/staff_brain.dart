import 'dart:async';
import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:crypto/crypto.dart';

import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../models/session_model.dart';
import '../../utils/promo_policy.dart';
import '../../utils/service_charge.dart';
import '../app_scope.dart';
import '../../data/app_db.dart';
import '../firestore_service.dart';
import '../hookah/brand_profiles.dart';
import '../hookah/mix_engine.dart';
import '../hookah/tobacco_shelf.dart';
import '../venue_service.dart';
import 'ai_agents.dart';
import 'ai_context_service.dart';

/// «Память» ассистента зала (только SaaS): отвечает персоналу без ИИ там,
/// где ответ уже известен, и копит знания, чтобы в следующий раз не тратить
/// токены.
///
/// 1. Готовые ответы без ИИ: миксы из полки табака, состав и рецепт
///    позиции, что подать к позиции (по реальным продажам), что заканчивается
///    на складе.
/// 2. Карточки знаний (tenants/{t}/aiKnowledge/item_<id>): ИИ один раз
///    описывает позицию меню — что это, вкус, подача, с чем рекомендовать;
///    при изменении позиции (название, описание, состав) карточка
///    обновляется. Дальше ассистент берёт её отсюда.
/// 3. Кэш ответов (aiKnowledge/qa_<hash>): ответ ИИ на вопрос, который не
///    зависит от того, что сейчас в зале, хранится неделю и отдаётся сразу,
///    пока меню не поменялось.
class StaffBrain {
  StaffBrain._();
  static final StaffBrain instance = StaffBrain._();

  final _fs = FirestoreService();
  CollectionReference<Map<String, dynamic>> get _kb => AppScope.col('aiKnowledge');

  // ---------------------------------------------------------------- данные

  List<MenuItem> _menu = const [];
  DateTime _menuAt = DateTime(2000);

  Future<List<MenuItem>> menu() async {
    if (DateTime.now().difference(_menuAt) < const Duration(minutes: 2) && _menu.isNotEmpty) return _menu;
    try {
      _menu = await _fs.menuItemsStream().first.timeout(const Duration(seconds: 8));
      _menuAt = DateTime.now();
    } catch (_) {}
    return _menu;
  }

  /// Отпечаток меню: поменялись позиции или цены — кэш ответов устарел.
  String menuVersion(List<MenuItem> items) {
    final s = (items.map((m) => '${m.id}:${m.name}:${m.price}:${m.available}').toList()..sort()).join('|');
    return sha1.convert(utf8.encode(s)).toString().substring(0, 12);
  }

  static String _norm(String s) =>
      s.toLowerCase().replaceAll('ё', 'е').replaceAll(RegExp(r'[^a-zа-я0-9 ]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

  /// Позиция меню, названная в вопросе: «что в цезаре», «рецепт мохито».
  MenuItem? itemIn(String question, List<MenuItem> items) {
    final q = ' ${_norm(question)} ';
    MenuItem? best;
    var bestLen = 0;
    for (final m in items) {
      final n = _norm(m.name);
      if (n.length < 3) continue;
      // Полное название или его основа без последней буквы («цезар» в «цезаре»).
      final stem = n.length > 5 ? n.substring(0, n.length - 1) : n;
      if ((q.contains(' $n') || q.contains(' $stem')) && n.length > bestLen) {
        best = m;
        bestLen = n.length;
      }
    }
    return best;
  }

  // ------------------------------------------------------ ответы без ИИ

  /// Подбор миксов с памятью: та же просьба или «ещё» — другие миксы.
  static final _mixes = MixSession();
  static bool _lastWasMix = false;

  static final _mixRe = RegExp(r'микс|забить|забивк|какой кальян|кальян\w* .*(вкус|посоветуй|подбери)|табак');
  static final _infoRe = RegExp(r'что в |что входит|состав|из чего|рецепт|как готов|расскажи|что такое|аллерг|выход|сколько грам|описани');
  static final _pairRe = RegExp(r'что (предложить|подать|посоветовать|допродать) к|с чем (подать|предложить)|к (нему|ней|этому) предложить|допродаж');
  static final _stockRe = RegExp(r'заканчива|на складе|остатк|что мало|стоп.?лист');

  /// Вопросы про то, что сейчас в зале: на них кэш не годится.
  static final _liveRe = RegExp(r'стол|брон|сейчас|смен|заказ|чек|гост|свобод|занят|сегодня|вчера|выручк|склад|остат|кто ');

  static final _dryRe = RegExp(r'сух(ой|ого|им) табак|для крепости|как (сделать|добавить) крепост|усилител');
  static final _brandQRe = RegExp(r'забив|жаро|крепост|угл|прогре|как курит|расскажи|что за|какой лист|лист|сколько грам|греть|пригора|горчит|держит жар');
  static final _rulesRe = RegExp(r'как (правильно )?(миксовать|смешивать|собрать микс|составить микс|делать микс)|правила микс|как сочетать|пропорци');

  /// Про марку табака («как забивать бонч», «жаростойкость дарксайда») и
  /// про правила миксов — по справочнику, без ИИ. null — вопрос не про это.
  static String? tobaccoAnswer(String question) {
    final q = _norm(question);
    if (_rulesRe.hasMatch(q)) return kMixRules;
    if (_dryRe.hasMatch(q)) return kDryTobacco;
    final brand = brandInText(question);
    if (brand == null || q.contains('микс') || !_brandQRe.hasMatch(q)) return null;
    final p = profileOf(brand);
    return p == null ? null : '${p.card()}\nЦифры — ориентир: у линеек одной марки крепость и жар бывают разными.';
  }

  /// Ответ без ИИ или null — тогда спрашиваем модель.
  Future<String?> localAnswer(String question) async {
    final q = _norm(question);
    if (q.isEmpty) return null;
    final venue = VenueService.instance.cached;
    if (venue.terms.isHookah) {
      final tobacco = tobaccoAnswer(question);
      if (tobacco != null) return tobacco;
    }
    final mixFollow = _lastWasMix && MixRequest.parse(question).more;
    _lastWasMix = false;
    if (venue.terms.isHookah && (_mixRe.hasMatch(q) || mixFollow)) {
      _lastWasMix = true;
      final engine = MixEngine(await TobaccoShelf.once());
      return _mixes.answer(engine, question);
    }
    final items = await menu();
    final item = itemIn(question, items);
    if (item != null && _pairRe.hasMatch(q)) {
      final pairs = await pairsFor({item.id}, limit: 3);
      if (pairs.isNotEmpty) {
        return 'К позиции «${item.name}» чаще всего берут:\n'
            '${pairs.map((p) => '— ${p.name} · ${p.price.toStringAsFixed(0)} ₽').join('\n')}\n'
            'По продажам заведения за последний месяц.';
      }
    }
    if (item != null && _infoRe.hasMatch(q)) return itemAnswer(item, items);
    if (_stockRe.hasMatch(q) && !q.contains('стол')) {
      final text = await AiContextService().stockSnapshot(onlyProblems: true);
      return text == 'Склад в норме.' ? 'Склад в норме: ниже минимума ничего нет.' : 'Ниже минимума:\n${text.replaceAll('- ', '— ').replaceAll(' ← НИЖЕ МИНИМУМА', '')}';
    }
    // Кэш ответов ИИ на «вечные» вопросы.
    if (!_liveRe.hasMatch(q)) {
      try {
        final d = await _kb.doc(_qaId(q)).get().timeout(const Duration(seconds: 4));
        final m = d.data();
        final at = (m?['at'] as Timestamp?)?.toDate();
        if (m != null && m['menuVer'] == menuVersion(items) && at != null && DateTime.now().difference(at).inDays < 7) {
          return '${m['answer']}';
        }
      } catch (_) {}
    }
    return null;
  }

  String _qaId(String normQuestion) => 'qa_${sha1.convert(utf8.encode(normQuestion)).toString().substring(0, 20)}';

  /// Запомнить ответ ИИ на «вечный» вопрос (не про текущий зал).
  Future<void> rememberAnswer(String question, String answer) async {
    final q = _norm(question);
    if (q.isEmpty || answer.trim().length < 20 || _liveRe.hasMatch(q)) return;
    final items = await menu();
    try {
      await _kb.doc(_qaId(q)).set({'q': q, 'answer': answer.trim(), 'menuVer': menuVersion(items), 'at': FieldValue.serverTimestamp()});
    } catch (_) {}
  }

  /// Всё про позицию: описание, выход, цена, состав по техкарте, карточка знаний.
  Future<String> itemAnswer(MenuItem item, List<MenuItem> menu) async {
    final b = StringBuffer('${item.name} · ${item.price.toStringAsFixed(0)} ₽');
    if (item.weight > 0) b.write(' · выход ${item.weight.toStringAsFixed(0)} ${item.weightUnit == InventoryUnit.ml ? 'мл' : 'г'}');
    if (!item.available) b.write(' · сейчас в стоп-листе');
    b.writeln();
    if (item.description.trim().isNotEmpty) b.writeln(item.description.trim());
    final comp = await componentsText(item);
    if (comp.isNotEmpty) b.writeln('Состав по техкарте: $comp');
    final card = await cardFor(item);
    if (card != null && card.isNotEmpty) b.writeln(card);
    final pairs = await pairsFor({item.id}, limit: 2);
    if (pairs.isNotEmpty) b.writeln('С ним чаще берут: ${pairs.map((p) => p.name).join(', ')}');
    return b.toString().trim();
  }

  Map<String, InventoryItem>? _stock;
  DateTime _stockAt = DateTime(2000);

  Future<String> componentsText(MenuItem item) async {
    if (item.components.isEmpty) return '';
    if (_stock == null || DateTime.now().difference(_stockAt) > const Duration(minutes: 5)) {
      try {
        final snap = await AppScope.col('inventoryItems').get().timeout(const Duration(seconds: 8));
        _stock = {for (final d in snap.docs) d.id: InventoryItem.fromDoc(d)};
        _stockAt = DateTime.now();
      } catch (_) {
        _stock ??= {};
      }
    }
    return [
      for (final c in item.components)
        if (_stock![c.inventoryItemId] != null)
          '${_stock![c.inventoryItemId]!.name}${c.weight > 0 ? ' ${c.weight.toStringAsFixed(0)} ${c.weightUnit == InventoryUnit.ml ? 'мл' : c.weightUnit == InventoryUnit.pcs ? 'шт' : 'г'}' : ''}',
    ].join(', ');
  }

  // ------------------------------------------------- карточки знаний

  String _itemHash(MenuItem m) =>
      sha1.convert(utf8.encode('${m.name}|${m.description}|${m.components.map((c) => '${c.inventoryItemId}:${c.weight}').join(',')}')).toString().substring(0, 12);

  Future<String?> cardFor(MenuItem m) async {
    try {
      final d = await _kb.doc('item_${m.id}').get().timeout(const Duration(seconds: 4));
      return d.data()?['text'] as String?;
    } catch (_) {
      return null;
    }
  }

  DateTime _lastBuild = DateTime(2000);
  bool _building = false;

  /// Дописать карточки знаний для новых и изменённых позиций: не чаще раза
  /// в 10 минут, до 30 позиций за раз, по 15 в одном запросе к ИИ. Табак
  /// не описываем (реклама табака запрещена).
  Future<int> buildCards() async {
    if (_building || DateTime.now().difference(_lastBuild) < const Duration(minutes: 10)) return 0;
    if (!AiAgents.hall.enabled) return 0;
    _building = true;
    _lastBuild = DateTime.now();
    var made = 0;
    try {
      final items = [for (final m in await menu()) if (!PromoPolicy.menuTobacco(m) && m.id.isNotEmpty) m];
      final have = <String, String>{};
      final snap = await _kb.where('kind', isEqualTo: 'item').get().timeout(const Duration(seconds: 10));
      for (final d in snap.docs) {
        have[d.id] = '${d.data()['hash'] ?? ''}';
      }
      final todo = [for (final m in items) if (have['item_${m.id}'] != _itemHash(m)) m].take(30).toList();
      for (var i = 0; i < todo.length; i += 15) {
        final part = todo.sublist(i, i + 15 > todo.length ? todo.length : i + 15);
        final lines = <String>[];
        for (final m in part) {
          lines.add('${m.id} | ${m.name} | ${m.description} | состав: ${await componentsText(m)}');
        }
        final cards = await AiService.instance.describeMenuItems(lines.join('\n'));
        final batch = AppDb.instance.batch();
        for (final m in part) {
          final text = cards[m.id];
          if (text == null || text.trim().isEmpty) continue;
          batch.set(_kb.doc('item_${m.id}'), {
            'kind': 'item',
            'name': m.name,
            'hash': _itemHash(m),
            'text': text.trim(),
            'at': FieldValue.serverTimestamp(),
          });
          made++;
        }
        await batch.commit();
      }
    } catch (_) {
      // Нет связи или ИИ — допишем в следующий раз.
    } finally {
      _building = false;
    }
    return made;
  }

  /// Карточки позиций, названных в вопросе, — в контекст ИИ (дёшево).
  Future<String> cardsContext(String question) async {
    final items = await menu();
    final item = itemIn(question, items);
    if (item == null) return '';
    final card = await cardFor(item);
    final comp = await componentsText(item);
    return [
      'ПОЗИЦИЯ «${item.name}»: ${item.price.toStringAsFixed(0)} ₽${item.description.isNotEmpty ? '. ${item.description}' : ''}',
      if (comp.isNotEmpty) 'Состав: $comp',
      if (card != null) card,
    ].join('\n');
  }

  // --------------------------------------------------- что подать к заказу

  Map<String, Map<String, int>>? _pairs;
  Map<String, int> _counts = const {};
  DateTime _pairsAt = DateTime(2000);

  /// Совместные продажи за 30 дней: что берут вместе с чем. Считается на
  /// кассе раз в час, без ИИ.
  Future<void>? _pairsLoading;

  /// Один расчёт на всех: несколько столов, открытых подряд, раньше каждый
  /// заново грузили чеки за 30 дней — касса подтормаживала.
  Future<void> _loadPairs() {
    if (_pairs != null && DateTime.now().difference(_pairsAt) < const Duration(hours: 1)) return Future.value();
    return _pairsLoading ??= _loadPairsNow().whenComplete(() => _pairsLoading = null);
  }

  Future<void> _loadPairsNow() async {
    final pairs = <String, Map<String, int>>{};
    var ok = false;
    final counts = <String, int>{};
    try {
      final to = DateTime.now();
      final sessions = await _fs.closedSessionsInRange(to.subtract(const Duration(days: 30)), to).timeout(const Duration(seconds: 15));
      for (final s in sessions.take(1500)) {
        if (s.refunded || s.training) continue;
        final ids = {for (final i in s.orderItems) if (i.menuItemId.isNotEmpty && !ServiceCharge.isLine(i)) i.menuItemId};
        for (final a in ids) {
          counts[a] = (counts[a] ?? 0) + 1;
          for (final b in ids) {
            if (a == b) continue;
            final m = pairs.putIfAbsent(a, () => {});
            m[b] = (m[b] ?? 0) + 1;
          }
        }
      }
      ok = true;
    } catch (_) {}
    if (!ok && _pairs != null) {
      // Не загрузилось (нет связи) — оставляем прежние пары, повтор через 5 мин.
      _pairsAt = DateTime.now().subtract(const Duration(minutes: 55));
      return;
    }
    _pairs = pairs;
    _counts = counts;
    // Пустой результат из-за сбоя — повторим через 5 минут, а не через час.
    _pairsAt = ok ? DateTime.now() : DateTime.now().subtract(const Duration(minutes: 55));
  }

  /// Что предложить к позициям чека: часто берут вместе, в наличии, не
  /// табак (стимулировать продажу табака нельзя), не то, что уже в чеке.
  Future<List<MenuItem>> pairsFor(Set<String> inCheck, {int limit = 3}) async {
    await _loadPairs();
    final items = {for (final m in await menu()) m.id: m};
    final score = <String, double>{};
    for (final id in inCheck) {
      final p = _pairs?[id];
      if (p == null) continue;
      final base = (_counts[id] ?? 1).toDouble();
      p.forEach((other, n) {
        if (n < 2) return;
        score[other] = (score[other] ?? 0) + n / base;
      });
    }
    final out = <MenuItem>[];
    final sorted = score.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    for (final e in sorted) {
      final m = items[e.key];
      if (m == null || !m.available || inCheck.contains(m.id) || PromoPolicy.menuTobacco(m) || m.byWeight) continue;
      out.add(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  /// Подсказки к открытому чеку: пары по продажам; чек пустой — хиты.
  Future<List<MenuItem>> upsellFor(SessionModel s) async {
    final ids = {for (final i in s.orderItems) if (i.menuItemId.isNotEmpty) i.menuItemId};
    if (ids.isEmpty) return const [];
    return pairsFor(ids, limit: 3);
  }
}
