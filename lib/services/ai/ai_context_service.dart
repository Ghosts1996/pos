import 'package:cloud_firestore/cloud_firestore.dart';
import '../app_scope.dart';
import '../../models/client_models.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../models/staff_shift_model.dart';
import '../../models/table_model.dart';
import '../../utils/promo_policy.dart';
import '../../utils/table_label.dart';
import '../people_directory.dart';

/// Сборка компактного текстового контекста для ИИ-агентов.
///
/// Принцип: модели отдаём не «сырые» документы, а сжатую выжимку —
/// так дешевле по токенам (tooken.club считает именно их) и точнее ответ.
/// Ни телефоны гостей, ни ключи, ни персональные данные в промпт не идут.
class AiContextService {

  String money(num v) => '${v.toStringAsFixed(0)} ₽';

  /// Вместо имени гостя — только первая буква: ИИ-шлюз находится у
  /// стороннего провайдера (часто за рубежом), а имя с временем брони —
  /// уже персональные данные (152-ФЗ). Для рассадки буквы достаточно.
  static String guestAlias(String name) {
    final t = name.trim();
    if (t.isEmpty) return 'гость';
    return 'гость ${String.fromCharCode(t.runes.first).toUpperCase()}.';
  }

  static final _phoneLike = RegExp(r'\+?\d(?:[\s\-()]*\d){5,}');
  static final _emailLike = RegExp(r'[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+');

  /// Комментарии к броням пишут гости и персонал — там бывают телефоны
  /// и почта. Перед отправкой в ИИ вырезаем их.
  static String scrubContacts(String text) => text
      .replaceAll(_emailLike, '[почта скрыта]')
      .replaceAll(_phoneLike, '[телефон скрыт]');

  // ---------- МЕНЮ ----------

  /// Меню в виде «Категория → позиция, цена, граммовка».
  /// [onlyAvailable] — не показывать ИИ позиции из стоп-листа, иначе он
  /// порекомендует то, чего нет.
  Future<String> menuSnapshot({bool onlyAvailable = true, int limit = 200}) async {
    final cats = await AppScope.col('menuCategories').orderBy('order').get();
    final items = await AppScope.col('menuItems').get();

    final byCat = <String, List<MenuItem>>{};
    for (final doc in items.docs) {
      final item = MenuItem.fromDoc(doc);
      if (onlyAvailable && !item.available) continue;
      byCat.putIfAbsent(item.categoryId, () => []).add(item);
    }

    final buf = StringBuffer();
    var count = 0;
    for (final catDoc in cats.docs) {
      final cat = MenuCategory.fromDoc(catDoc);
      final list = byCat[cat.id] ?? const [];
      if (list.isEmpty) continue;
      buf.writeln('## ${cat.name}');
      for (final i in list) {
        if (count++ >= limit) break;
        final weight = i.weight > 0 ? ', ${i.weight.toStringAsFixed(0)} ${i.weightUnit.name}' : '';
        // Табак помечаем, чтобы ИИ не советовал его сам и не называл хитом.
        final tobacco = PromoPolicy.menuTobacco(i, cat.name);
        final hit = tobacco
            ? ', табак — только по вопросу гостя'
            : (i.popularRank > 0 ? ', хит продаж №${i.popularRank}' : '');
        final desc = i.description.isNotEmpty ? '. Состав: ${i.description}' : '';
        buf.writeln('- ${i.name} — ${money(i.price)}$weight$hit [id:${i.id}]$desc');
      }
    }
    return buf.toString();
  }

  // ---------- СКЛАД ----------

  Future<String> stockSnapshot({bool onlyProblems = false}) async {
    final snap = await AppScope.col('inventoryItems').get();
    final items = snap.docs.map(InventoryItem.fromDoc).toList();

    final buf = StringBuffer();
    for (final i in items) {
      final low = i.minQuantity > 0 && i.quantity <= i.minQuantity;
      if (onlyProblems && !low) continue;
      buf.writeln(
        '- ${i.name}: ${i.quantity.toStringAsFixed(1)} ${i.unit.name}'
        '${i.minQuantity > 0 ? ' (мин. ${i.minQuantity.toStringAsFixed(1)})' : ''}'
        '${low ? ' ← НИЖЕ МИНИМУМА' : ''}',
      );
    }
    return buf.isEmpty ? 'Склад в норме.' : buf.toString();
  }

  // ---------- ЗАЛ ПРЯМО СЕЙЧАС ----------

  /// Столы для гостя: места, зона и занят ли сейчас — без имён гостей,
  /// сумм и таймеров других столов.
  Future<String> tablesForGuest() async {
    final snap = await AppScope.col('tables').get();
    final tables = snap.docs.map(TableModel.fromDoc).where((t) => !t.isTakeaway).toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    if (tables.isEmpty) return 'Столы не заведены.';
    return tables.map((t) {
      final busy = t.activeSessionIds.isNotEmpty || t.status == 'occupied';
      final zone = t.zone.isNotEmpty ? ', зона «${t.zone}»' : '';
      return '- ${t.name} (${seatsLabel(t.seats)}$zone): ${busy ? 'сейчас занят' : 'сейчас свободен'}';
    }).join('\n');
  }

  Future<String> hallSnapshot() async {
    final tablesSnap = await AppScope.col('tables').get();
    final tables = tablesSnap.docs.map(TableModel.fromDoc).where((t) => !t.isTakeaway).toList();

    final sessionsSnap =
        await AppScope.col('sessions').where('status', isEqualTo: 'active').get();
    final sessions = sessionsSnap.docs.map(SessionModel.fromDoc).toList();
    final byTable = <String, List<SessionModel>>{};
    for (final s in sessions) {
      byTable.putIfAbsent(s.tableId, () => []).add(s);
    }

    final buf = StringBuffer('Время: ${DateTime.now()}\n');
    for (final t in tables) {
      final list = byTable[t.id] ?? const [];
      if (list.isEmpty) {
        buf.writeln('- ${t.name} (${seatsLabel(t.seats)}): свободен');
      } else {
        for (final s in list) {
          final left = s.remaining.inMinutes;
          buf.writeln(
            '- ${t.name} (${seatsLabel(t.seats)}): занят, счёт ${money(s.orderTotal)}, '
            'до конца $left мин, перезабивок ${s.refillCount}'
            '${s.guestTag.isNotEmpty ? ', ${guestAlias(s.guestTag)}' : ''}',
          );
        }
      }
    }
    return buf.toString();
  }

  // ---------- БРОНИ ----------

  Future<String> reservationsSnapshot({int hours = 12}) async {
    final now = DateTime.now();
    final snap = await AppScope.col('reservations')
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
        .where('startTime', isLessThan: Timestamp.fromDate(now.add(Duration(hours: hours))))
        .orderBy('startTime')
        .get();

    final list = snap.docs.map(ReservationModel.fromDoc).toList();
    if (list.isEmpty) return 'Броней на ближайшие $hours ч нет.';

    final buf = StringBuffer();
    for (final r in list) {
      buf.writeln(
        '- [id ${r.id}] ${r.startTime.hour.toString().padLeft(2, '0')}:'
        '${r.startTime.minute.toString().padLeft(2, '0')} '
        '${guestAlias(r.guestName)}, ${r.guestsCount} чел, стол ${r.tableName.isEmpty ? '—' : r.tableName}, '
        '${r.status.label}${r.comment.isNotEmpty ? ', «${scrubContacts(r.comment)}»' : ''}',
      );
    }
    return buf.toString();
  }

  // ---------- ПРОДАЖИ ----------

  /// Агрегат по закрытым чекам за период — основа для ИИ-аналитики.
  Future<String> salesSnapshot({required DateTime from, required DateTime to}) async {
    // Фильтр только по дате: связка status + closedAt потребовала бы
    // составного индекса Firestore, который пришлось бы создавать руками.
    // Статус и возвраты отсеиваем уже на устройстве — чеков за период
    // немного, и это дешевле, чем ручная настройка индексов.
    final snap = await AppScope.col('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('closedAt', isLessThan: Timestamp.fromDate(to))
        .get();

    final sessions = snap.docs
        .map(SessionModel.fromDoc)
        .where((s) => s.status == 'closed' && !s.refunded)
        .toList();
    if (sessions.isEmpty) return 'Закрытых чеков за период нет.';

    var revenue = 0.0;
    var cash = 0.0, card = 0.0, terminal = 0.0, comp = 0.0, aggregator = 0.0;
    final byItem = <String, ({int qty, double sum})>{};
    final byHour = <int, double>{};
    var refills = 0;

    for (final s in sessions) {
      revenue += s.paymentTotal;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
      comp += s.paymentComp;
      aggregator += s.paymentAggregator;
      refills += s.refillCount;
      final h = (s.closedAt ?? s.startTime).hour;
      byHour[h] = (byHour[h] ?? 0) + s.paymentTotal;
      for (final i in s.orderItems) {
        final prev = byItem[i.name] ?? (qty: 0, sum: 0.0);
        byItem[i.name] = (qty: prev.qty + i.qty, sum: prev.sum + i.total);
      }
    }

    final top = byItem.entries.toList()..sort((a, b) => b.value.sum.compareTo(a.value.sum));
    final hours = byHour.entries.toList()..sort((a, b) => b.value.compareTo(a.value));

    final buf = StringBuffer()
      ..writeln('Период: ${from.toIso8601String()} — ${to.toIso8601String()}')
      ..writeln('Чеков: ${sessions.length}')
      ..writeln('Выручка: ${money(revenue)}')
      ..writeln('Средний чек: ${money(revenue / sessions.length)}')
      ..writeln('Перезабивок всего: $refills')
      ..writeln('Оплаты — нал ${money(cash)}, карта ${money(card)}, '
          'терминал ${money(terminal)}, за счёт заведения ${money(comp)}'
          '${aggregator > 0 ? ', агрегаторы доставки ${money(aggregator)}' : ''}')
      ..writeln('ТОП-15 позиций по выручке:');
    for (final e in top.take(15)) {
      buf.writeln('- ${e.key}: ${e.value.qty} шт, ${money(e.value.sum)}');
    }
    buf.writeln('Аутсайдеры (продавались, но мало):');
    for (final e in top.reversed.take(8)) {
      buf.writeln('- ${e.key}: ${e.value.qty} шт, ${money(e.value.sum)}');
    }
    buf.writeln('Выручка по часам (топ-5): '
        '${hours.take(5).map((e) => '${e.key}:00 — ${money(e.value)}').join('; ')}');

    return buf.toString();
  }

  // ---------- ГОСТЬ ----------

  /// Обезличенный портрет гостя для персональных рекомендаций.
  /// Телефон и полное имя в промпт не передаются.
  Future<String> guestSnapshot(String clientUid) async {
    final doc = await AppScope.loyaltyCol('clients').doc(clientUid).get();
    if (!doc.exists) return 'Новый гость, истории нет.';
    final p = ClientProfile.fromDoc(doc);

    // Список любимых позиций — best-effort: если индекс Firestore для
    // status+closedAt ещё строится или временно недоступен, гостю не
    // должно быть видно «Консьерж недоступен» из-за этого одного поля —
    // просто отвечаем без истории заказов.
    var top = const <MapEntry<String, int>>[];
    try {
      final past = await AppScope.col('sessions')
          .where('status', isEqualTo: 'closed')
          .orderBy('closedAt', descending: true)
          .limit(60)
          .get();

      final favNames = <String, int>{};
      for (final d in past.docs) {
        final s = SessionModel.fromDoc(d);
        if (s.guestTag.isEmpty || s.guestTag != p.name) continue;
        for (final i in s.orderItems) {
          favNames[i.name] = (favNames[i.name] ?? 0) + i.qty;
        }
      }
      top = favNames.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    } catch (_) {
      // Индекс не готов / нет сети — не роняем весь ответ ИИ из-за этого.
    }

    return [
      'Уровень: ${p.tier}, визитов ${p.visits}, бонусов ${p.bonusBalance.toStringAsFixed(0)}',
      if (p.aiProfile.isNotEmpty) 'Заметки о вкусах: ${p.aiProfile}',
      if (top.isNotEmpty) 'Часто заказывает: ${top.take(8).map((e) => '${e.key} (${e.value})').join(', ')}',
    ].join('\n');
  }

  // ---------- ОТЗЫВЫ ----------

  Future<String> reviewsSnapshot({int limit = 60}) async {
    final snap = await AppScope.col('reviews')
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get();
    if (snap.docs.isEmpty) return 'Отзывов пока нет.';
    final buf = StringBuffer();
    for (final d in snap.docs) {
      final r = GuestReview.fromDoc(d);
      buf.writeln('- ${r.rating}/5: ${r.text.isEmpty ? '(без текста)' : scrubContacts(r.text)}');
    }
    return buf.toString();
  }
}

/// Имена сотрудников уходят в ИИ под номерами («Сотрудник №1»): провайдер
/// ИИ чаще всего за рубежом, а имя — персональные данные (152-ФЗ). В ответе
/// номера меняются обратно на имена уже на устройстве — владелец видит
/// имена, провайдер ИИ — нет.
class AiPseudonyms {
  final _byName = <String, int>{};

  String of(String name) {
    final n = name.trim();
    if (n.isEmpty) return 'сотрудник без имени';
    return 'Сотрудник №${_byName.putIfAbsent(n, () => _byName.length + 1)}';
  }

  static final _alias = RegExp(r'([Сс]отрудник([а-яё]*))\s*№\s*(\d+)');

  /// «Сотрудник №1» → «Анна»; в косвенном падеже слово остаётся, чтобы
  /// фраза читалась: «Сотруднику №1 помочь» → «Сотруднику Анна помочь».
  String restore(String text) {
    if (_byName.isEmpty) return text;
    final names = {for (final e in _byName.entries) e.value: e.key};
    return text.replaceAllMapped(_alias, (m) {
      final name = names[int.parse(m[3]!)];
      if (name == null) return m[0]!;
      return m[2]!.isEmpty ? name : '${m[1]} $name';
    });
  }
}

/// Срез всего, что происходило в заведении за период, — для ИИ-разборов.
/// Без персональных данных: ни имён, ни телефонов, ни адресов гостей;
/// сотрудники — под номерами (AiPseudonyms); тексты отзывов и причин —
/// без телефонов и почты. Раздел, который этому устройству читать нельзя
/// (журнал кассы — только администратор), просто пропускается.
extension AiVenueDigest on AiContextService {
  static const _positions = {
    'waiter': 'официант',
    'hookah_master': 'кальянщик',
    'bartender': 'бармен',
    'universal': 'универсал',
  };
  static const _weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  static const _audit = {
    'order_item_removed': 'удаление позиции из чека',
    'order_item_voided': 'отмена позиции',
    'closed_without_payment': 'закрытие без оплаты',
    'discount_applied': 'ручная скидка',
    'refund': 'возврат',
    'timer_changed': 'изменение таймера',
    'inventory_adjusted': 'правка склада',
  };

  Future<String> venueDigest({required DateTime from, required DateTime to, required AiPseudonyms staff}) async {
    final parts = <String>[
      'Период: ${_d(from)} — ${_d(to)}',
      await _safe('ПРОДАЖИ', () => _salesDigest(from, to, staff)),
      await _safe('СМЕНЫ ПЕРСОНАЛА', () => _shiftsDigest(from, to, staff)),
      await _safe('ЖУРНАЛ КАССЫ', () => _auditDigest(from, to, staff)),
      await _safe('БРОНИ', () => _reservationsDigest(from, to)),
      await _safe('ОТЗЫВЫ', () => _reviewsDigest(from, to)),
      await _safe('БОНУСЫ', () => _bonusDigest(from, to)),
      await _safe('СКЛАД (проблемы)', () => stockSnapshot(onlyProblems: true)),
    ];
    return parts.where((p) => p.isNotEmpty).join('\n\n');
  }

  static String _d(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} ${d.hour.toString().padLeft(2, '0')}:00';

  Future<String> _safe(String title, Future<String> Function() part) async {
    try {
      final text = (await part()).trim();
      return text.isEmpty ? '' : '$title:\n$text';
    } catch (_) {
      return '';
    }
  }

  Future<String> _salesDigest(DateTime from, DateTime to, AiPseudonyms staff) async {
    final snap = await AppScope.col('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('closedAt', isLessThan: Timestamp.fromDate(to))
        .get();
    final all = snap.docs.map(SessionModel.fromDoc).toList();
    final closed = all.where((s) => s.status == 'closed' && !s.refunded).toList();
    if (closed.isEmpty) return 'Закрытых чеков за период нет.';

    var revenue = 0.0, cash = 0.0, card = 0.0, terminal = 0.0, comp = 0.0, online = 0.0, tips = 0.0;
    var aggregator = 0.0, aggregatorPayout = 0.0;
    var discounted = 0, minutes = 0, refills = 0;
    final byItem = <String, ({int qty, double sum})>{};
    final byHour = <int, double>{};
    final byWeekday = <int, double>{};
    final byEmployee = <String, ({int checks, double sum})>{};
    final byType = <String, ({int n, double sum})>{};
    for (final s in closed) {
      final total = s.paymentTotal;
      revenue += total;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
      comp += s.paymentComp;
      aggregator += s.paymentAggregator;
      aggregatorPayout += s.aggregatorPayout;
      online += s.guestPaidTotal;
      tips += s.tipsCash + s.tipsCard;
      refills += s.refillCount;
      if (s.discountPercent > 0) discounted++;
      final at = s.closedAt ?? s.startTime;
      byHour[at.hour] = (byHour[at.hour] ?? 0) + total;
      byWeekday[at.weekday] = (byWeekday[at.weekday] ?? 0) + total;
      if (s.closedAt != null) minutes += s.closedAt!.difference(s.startTime).inMinutes.clamp(0, 24 * 60);
      final who = staff.of(s.employeeName);
      final e = byEmployee[who] ?? (checks: 0, sum: 0.0);
      byEmployee[who] = (checks: e.checks + 1, sum: e.sum + total);
      final type = s.orderType == 'delivery' ? 'доставка' : s.orderType == 'takeaway' ? 'с собой' : 'в зале';
      final t = byType[type] ?? (n: 0, sum: 0.0);
      byType[type] = (n: t.n + 1, sum: t.sum + total);
      for (final i in s.orderItems) {
        final prev = byItem[i.name] ?? (qty: 0, sum: 0.0);
        byItem[i.name] = (qty: prev.qty + i.qty, sum: prev.sum + i.total);
      }
    }
    final refunded = all.where((s) => s.refunded).length;
    final cancelledDelivery = all.where((s) => s.deliveryStatus == 'cancelled').toList();
    final top = byItem.entries.toList()..sort((a, b) => b.value.sum.compareTo(a.value.sum));
    final hours = byHour.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    final staffTop = byEmployee.entries.toList()..sort((a, b) => b.value.sum.compareTo(a.value.sum));

    final buf = StringBuffer()
      ..writeln('Чеков: ${closed.length}, выручка ${money(revenue)}, средний чек ${money(revenue / closed.length)}')
      ..writeln('Среднее время за столом: ${(minutes / closed.length).round()} мин; перезабивок: $refills')
      ..writeln('Оплаты: нал ${money(cash)}, карта ${money(card)}, терминал ${money(terminal)}, '
          'онлайн из приложения ${money(online)}, за счёт заведения ${money(comp)}')
      ..writeln('Чаевые: ${money(tips)}; чеков со скидкой: $discounted; возвратов: $refunded')
      ..writeln('По типу: ${byType.entries.map((e) => '${e.key} — ${e.value.n} чеков, ${money(e.value.sum)}').join('; ')}');
    if (aggregator > 0) {
      buf.writeln('Агрегаторы доставки (Яндекс Еда и др.): ${money(aggregator)}, '
          'к выплате от них после комиссии ${money(aggregatorPayout)}');
    }
    if (cancelledDelivery.isNotEmpty) {
      buf.writeln('Отменённых заказов с собой и доставки: ${cancelledDelivery.length}; причины: '
          '${cancelledDelivery.map((s) => AiContextService.scrubContacts(s.cancelReason)).where((r) => r.isNotEmpty).take(8).join('; ')}');
    }
    buf.writeln('Выручка по дням недели: '
        '${(byWeekday.entries.toList()..sort((a, b) => a.key.compareTo(b.key))).map((e) => '${_weekdays[e.key - 1]} ${money(e.value)}').join(', ')}');
    buf.writeln('Пиковые часы: ${hours.take(5).map((e) => '${e.key}:00 — ${money(e.value)}').join('; ')}');
    buf.writeln('Продажи по сотрудникам: '
        '${staffTop.take(12).map((e) => '${e.key} — ${e.value.checks} чеков, ${money(e.value.sum)}').join('; ')}');
    buf.writeln('ТОП-15 позиций по выручке:');
    for (final e in top.take(15)) {
      buf.writeln('- ${e.key}: ${e.value.qty} шт, ${money(e.value.sum)}');
    }
    buf.writeln('Продаются хуже всего:');
    for (final e in top.reversed.take(8)) {
      buf.writeln('- ${e.key}: ${e.value.qty} шт, ${money(e.value.sum)}');
    }
    return buf.toString();
  }

  Future<String> _shiftsDigest(DateTime from, DateTime to, AiPseudonyms staff) async {
    final snap = await AppScope.col('staffShifts')
        .where('startedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from.subtract(const Duration(hours: 16))))
        .where('startedAt', isLessThan: Timestamp.fromDate(to))
        .get();
    final shifts = snap.docs.map(StaffShiftModel.fromDoc).where((s) => !s.cancelled).toList();
    if (shifts.isEmpty) return 'Смен за период нет.';
    final positions = <String, String>{};
    try {
      final emps = await AppScope.col('employees').get();
      for (final d in emps.docs) {
        final p = d.data()['position']?.toString() ?? '';
        final role = d.data()['role']?.toString() ?? '';
        positions[d.id] = role == 'admin' ? 'администратор' : (_positions[p] ?? 'сотрудник');
      }
    } catch (_) {}
    final byWho = <String, ({int n, double hours, int open, int manual})>{};
    for (final s in shifts) {
      final who = '${staff.of(s.employeeName)} (${positions[s.employeeId] ?? 'сотрудник'})';
      final v = byWho[who] ?? (n: 0, hours: 0.0, open: 0, manual: 0);
      byWho[who] = (
        n: v.n + 1,
        hours: v.hours + s.duration.inMinutes / 60,
        open: v.open + (s.status == 'open' ? 1 : 0),
        manual: v.manual + (s.manual ? 1 : 0),
      );
    }
    return byWho.entries
        .map((e) => '- ${e.key}: смен ${e.value.n}, ${e.value.hours.toStringAsFixed(1)} ч'
            '${e.value.open > 0 ? ', сейчас на смене' : ''}${e.value.manual > 0 ? ', правок вручную: ${e.value.manual}' : ''}')
        .join('\n');
  }

  Future<String> _auditDigest(DateTime from, DateTime to, AiPseudonyms staff) async {
    final snap = await AppScope.col('auditLog')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThan: Timestamp.fromDate(to))
        .get();
    if (snap.docs.isEmpty) return 'Отмен, возвратов и закрытий без оплаты не было.';
    final by = <String, ({int n, double sum})>{};
    final reasons = <String>[];
    for (final d in snap.docs) {
      final a = d.data();
      final action = _audit[a['action']] ?? a['action']?.toString() ?? '';
      final key = '$action — ${staff.of(Pd.whoName(a['employeeName']?.toString() ?? ''))}';
      final v = by[key] ?? (n: 0, sum: 0.0);
      by[key] = (n: v.n + 1, sum: v.sum + ((a['amount'] as num?)?.toDouble() ?? 0));
      final details = a['details'];
      final reason = details is Map ? (details['reason'] ?? '').toString() : '';
      if (reason.isNotEmpty && reasons.length < 10) reasons.add('$action: ${AiContextService.scrubContacts(reason)}');
    }
    final list = by.entries.toList()..sort((a, b) => b.value.sum.compareTo(a.value.sum));
    return [
      ...list.take(20).map((e) => '- ${e.key}: ${e.value.n} раз, на ${money(e.value.sum)}'),
      if (reasons.isNotEmpty) 'Причины: ${reasons.join('; ')}',
    ].join('\n');
  }

  Future<String> _reservationsDigest(DateTime from, DateTime to) async {
    final snap = await AppScope.col('reservations')
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('startTime', isLessThan: Timestamp.fromDate(to))
        .get();
    if (snap.docs.isEmpty) return 'Броней на период не было.';
    final list = snap.docs.map(ReservationModel.fromDoc).toList();
    final byStatus = <ReservationStatus, int>{};
    var guests = 0, fromApp = 0;
    for (final r in list) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      guests += r.guestsCount;
      if (r.source == 'app') fromApp++;
    }
    const names = {
      ReservationStatus.newRequest: 'не подтверждены',
      ReservationStatus.confirmed: 'подтверждены',
      ReservationStatus.seated: 'пришли',
      ReservationStatus.cancelled: 'отменены',
      ReservationStatus.noShow: 'не пришли',
    };
    return 'Броней ${list.length} на $guests гостей, из приложения $fromApp. '
        '${byStatus.entries.map((e) => '${names[e.key]}: ${e.value}').join(', ')}';
  }

  Future<String> _reviewsDigest(DateTime from, DateTime to) async {
    final snap = await AppScope.col('reviews')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThan: Timestamp.fromDate(to))
        .get();
    if (snap.docs.isEmpty) return 'Новых отзывов нет.';
    final list = snap.docs.map(GuestReview.fromDoc).toList();
    final avg = list.fold<int>(0, (a, r) => a + r.rating) / list.length;
    final low = list.where((r) => r.rating <= 3 && r.text.isNotEmpty).take(10);
    return [
      'Отзывов ${list.length}, средняя оценка ${avg.toStringAsFixed(1)}',
      for (final r in low) '- ${r.rating}/5: ${AiContextService.scrubContacts(r.text)}',
    ].join('\n');
  }

  Future<String> _bonusDigest(DateTime from, DateTime to) async {
    final snap = await AppScope.loyaltyCol('bonusOperations')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThan: Timestamp.fromDate(to))
        .get();
    if (snap.docs.isEmpty) return '';
    var accrued = 0.0, spent = 0.0;
    final guests = <String>{};
    for (final d in snap.docs) {
      final o = d.data();
      final bonus = (o['bonus'] as num?)?.toDouble() ?? (o['amount'] as num?)?.toDouble() ?? 0;
      if (o['type'] == 'accrual') accrued += bonus;
      if (o['type'] == 'redeem') spent += bonus.abs();
      final uid = o['clientUid']?.toString() ?? '';
      if (uid.isNotEmpty) guests.add(uid);
    }
    return 'Начислено бонусов ${money(accrued)}, списано ${money(spent)}, гостей с операциями: ${guests.length}';
  }
}
