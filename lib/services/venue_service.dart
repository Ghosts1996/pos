import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'app_scope.dart';
import '../build_info.dart';
import 'people_directory.dart';
import '../models/venue_models.dart';
import '../utils/shared_stream.dart';

/// Профиль заведения, FAQ и «счастливые часы».
///
/// Два применения:
///  • гость видит часы работы, адрес и ответы на частые вопросы;
///  • ИИ-агенты получают это как базу знаний — консьерж больше не выдумывает
///    режим работы и правила, а отвечает тем, что записал администратор.
class VenueService {
  VenueService._();
  static final VenueService instance = VenueService._();


  /// Профиль заведения, последний известный. Слушать через [notifier] —
  /// экраны, которые зависят от типа заведения или настроек чаевых,
  /// перерисуются, когда профиль придёт (он приезжает асинхронно, почти
  /// всегда позже первой отрисовки).
  final ValueNotifier<VenueProfile> notifier = ValueNotifier(const VenueProfile());
  VenueProfile get _cached => notifier.value;
  set _cached(VenueProfile p) {
    notifier.value = p;
    People.instance.setMode(piiModeOf(p));
  }

  /// Режим справочника людей: у всех заведений платформы имена и телефоны
  /// только в РФ ('rf') — отметка piiMode в профиле лишь показывает, что
  /// старые записи уже перенесены (saas-gateway/pii-migrate.js). Сборка
  /// одного заведения и сборка без адреса справочника — как в профиле.
  static String piiModeOf(VenueProfile p) =>
      AppScope.isSaasMode && kPiiGatewayUrl.isNotEmpty ? 'rf' : p.piiMode;
  VenueProfile get cached => _cached;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _watchSub;
  String _watchedPath = '';

  /// Слова под тип заведения (кальянщик/официант/бармен) — см. VenueTerms.
  VenueTerms get terms => _cached.terms;

  static const _profilePath = 'meta/venueProfile';

  Future<VenueProfile> load() async {
    final doc = await AppScope.doc(_profilePath).get();
    _cached = VenueProfile.fromMap(doc.data());
    return _cached;
  }

  /// Подписка при старте приложения — профиль всегда свежий.
  void watch() {
    // watch() зовут и при старте, и фоновые службы — вторая подписка на тот
    // же документ не нужна. Другое заведение (точка сети) — переподписка.
    final ref = AppScope.doc(_profilePath);
    if (_watchSub != null && _watchedPath == ref.path) return;
    _watchSub?.cancel();
    _watchedPath = ref.path;
    _watchSub = ref.snapshots().listen(
          (d) => _cached = VenueProfile.fromMap(d.data()),
          onError: (_) {},
        );
  }

  /// Одна подписка на профиль заведения: его берут в build экраны и гостя,
  /// и кассы.
  static final _profileS = SharedStreams<VenueProfile>();

  Stream<VenueProfile> stream() => _profileS.get(
      AppScope.tenantId ?? '-', () => AppScope.doc(_profilePath).snapshots().map((d) {
            final p = VenueProfile.fromMap(d.data());
            People.instance.setMode(piiModeOf(p));
            return p;
          }));

  Future<void> save(VenueProfile profile) =>
      AppScope.doc(_profilePath).set(profile.toMap(), SetOptions(merge: true));

  // ---------- СЧАСТЛИВЫЕ ЧАСЫ ----------

  Stream<List<HappyHour>> happyHoursStream() => AppScope.col('happyHours')
      .snapshots()
      .map((s) => s.docs.map(HappyHour.fromDoc).toList());

  Future<void> saveHappyHour(HappyHour hh) => hh.id.isEmpty
      ? AppScope.col('happyHours').add(hh.toMap())
      : AppScope.col('happyHours').doc(hh.id).set(hh.toMap());

  Future<void> deleteHappyHour(String id) => AppScope.col('happyHours').doc(id).delete();

  /// Акция, действующая прямо сейчас (берём самую выгодную для гостя).
  /// Возвращает null, если сейчас обычное время.
  Future<HappyHour?> activeHappyHour([DateTime? at]) async {
    final moment = at ?? DateTime.now();
    final snap = await AppScope.col('happyHours').where('active', isEqualTo: true).get();
    final matching = snap.docs.map(HappyHour.fromDoc).where((h) => h.matches(moment)).toList();
    if (matching.isEmpty) return null;
    matching.sort((a, b) => b.discountPercent.compareTo(a.discountPercent));
    return matching.first;
  }

  /// Применить акцию к открытому чеку. Вызывается при открытии чека и при
  /// добавлении первой позиции. Не трогает чек, если скидка уже больше —
  /// карта гостя всегда в приоритете над акцией.
  Future<HappyHour?> applyToSession(String sessionId) async {
    final happy = await activeHappyHour();
    if (happy == null) return null;

    final ref = AppScope.col('sessions').doc(sessionId);
    final snap = await ref.get();
    if (!snap.exists) return null;
    final current = (snap.data()?['discountPercent'] ?? 0).toDouble();
    if (current >= happy.discountPercent) return null;

    await ref.update({
      'discountPercent': happy.discountPercent,
      'discountSource': 'happyHour:${happy.id}',
    });
    return happy;
  }

  // ---------- БАЗА ЗНАНИЙ ДЛЯ ИИ ----------

  /// Название заведения для чека и ИИ: из профиля, иначе имя приложения из
  /// брендинга (SaaS), иначе пусто.
  static String displayNameOf(VenueProfile p) {
    if (p.name.trim().isNotEmpty) return p.name.trim();
    final brand = AppScope.branding?.appName.trim() ?? '';
    if (brand.isNotEmpty) return brand;
    return '';
  }

  /// true — владелец так и не заполнил часы работы ни на один день. Гостевая
  /// бронь в этом случае невозможна (каждый день выглядит выходным), и об
  /// этом надо сказать и гостю, и персоналу, а не молча показывать «закрыто».
  static bool hoursNotConfigured(VenueProfile p) =>
      p.workingHours.values.every((v) => v.trim().isEmpty);

  String? _aiKnowledgeCache;
  DateTime _aiKnowledgeAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// [aiKnowledge] с кэшем на 5 минут: его получает каждый запрос к ИИ, а
  /// профиль и акции меняются редко. Ошибка чтения — пустая строка, ИИ
  /// просто отвечает без сведений о заведении.
  Future<String> aiKnowledgeCached() async {
    final fresh = DateTime.now().difference(_aiKnowledgeAt) < const Duration(minutes: 5);
    if (_aiKnowledgeCache != null && fresh) return _aiKnowledgeCache!;
    try {
      _aiKnowledgeCache = await aiKnowledge();
    } catch (_) {
      _aiKnowledgeCache = '';
    }
    _aiKnowledgeAt = DateTime.now();
    return _aiKnowledgeCache!;
  }

  /// Текстовый блок для промпта агентов (см. AiAgents.run): название,
  /// адрес, часы, правила и действующие акции заведения.
  Future<String> aiKnowledge() async {
    final p = await load();
    HappyHour? happy;
    try {
      happy = await activeHappyHour();
    } catch (_) {}
    final name = displayNameOf(p);

    final days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    final hours = [
      for (var i = 1; i <= 7; i++)
        '${days[i - 1]}: ${p.workingHours[i]?.isNotEmpty == true ? p.workingHours[i] : 'выходной'}'
    ].join(', ');

    return [
      if (name.isNotEmpty) 'ЗАВЕДЕНИЕ: $name',
      if (p.address.isNotEmpty) 'Адрес: ${p.address}',
      if (p.phone.isNotEmpty) 'Телефон: ${p.phone}',
      if (!hoursNotConfigured(p)) 'Часы работы: $hours',
      if (p.about.isNotEmpty) 'О нас: ${p.about}',
      if (p.rules.isNotEmpty) 'Правила: ${p.rules}',
      if (p.depositFrom > 0)
        'Депозит: от ${p.depositFrom.toStringAsFixed(0)} ₽ на компанию от ${p.depositGuests} чел.',
      if (happy != null)
        'Сейчас действует акция «${happy.title}»: −${happy.discountPercent.toStringAsFixed(0)}% '
            '(${happy.window})',
      if (p.faq.isNotEmpty) 'FAQ:',
      ...p.faq.map((f) => '- ${f.question} → ${f.answer}'),
    ].join('\n');
  }
}
