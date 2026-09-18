import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/venue_models.dart';

/// Профиль заведения, FAQ и «счастливые часы».
///
/// Два применения:
///  • гость видит часы работы, адрес и ответы на частые вопросы;
///  • ИИ-агенты получают это как базу знаний — консьерж больше не выдумывает
///    режим работы и правила, а отвечает тем, что записал администратор.
class VenueService {
  VenueService._();
  static final VenueService instance = VenueService._();


  VenueProfile _cached = const VenueProfile();
  VenueProfile get cached => _cached;

  static const _profilePath = 'meta/venueProfile';

  Future<VenueProfile> load() async {
    final doc = await AppScope.doc(_profilePath).get();
    _cached = VenueProfile.fromMap(doc.data());
    return _cached;
  }

  /// Подписка при старте приложения — профиль всегда свежий.
  void watch() {
    AppScope.doc(_profilePath).snapshots().listen(
          (d) => _cached = VenueProfile.fromMap(d.data()),
          onError: (_) {},
        );
  }

  Stream<VenueProfile> stream() =>
      AppScope.doc(_profilePath).snapshots().map((d) => VenueProfile.fromMap(d.data()));

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

  /// Текстовый блок для промпта агентов. Передаётся как extraContext —
  /// дешевле инструмента и всегда актуален.
  Future<String> aiKnowledge() async {
    final p = await load();
    final happy = await activeHappyHour();

    final days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    final hours = [
      for (var i = 1; i <= 7; i++)
        '${days[i - 1]}: ${p.workingHours[i]?.isNotEmpty == true ? p.workingHours[i] : 'выходной'}'
    ].join(', ');

    return [
      'ЗАВЕДЕНИЕ: ${p.name}',
      if (p.address.isNotEmpty) 'Адрес: ${p.address}',
      if (p.phone.isNotEmpty) 'Телефон: ${p.phone}',
      'Часы работы: $hours',
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
