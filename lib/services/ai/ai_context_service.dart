import 'package:cloud_firestore/cloud_firestore.dart';
import '../../models/client_models.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';

/// Сборка компактного текстового контекста для ИИ-агентов.
///
/// Принцип: модели отдаём не «сырые» документы, а сжатую выжимку —
/// так дешевле по токенам (tooken.club считает именно их) и точнее ответ.
/// Ни телефоны гостей, ни ключи, ни персональные данные в промпт не идут.
class AiContextService {
  final _db = FirebaseFirestore.instance;

  String money(num v) => '${v.toStringAsFixed(0)} ₽';

  // ---------- МЕНЮ ----------

  /// Меню в виде «Категория → позиция, цена, граммовка».
  /// [onlyAvailable] — не показывать ИИ позиции из стоп-листа, иначе он
  /// порекомендует то, чего нет.
  Future<String> menuSnapshot({bool onlyAvailable = true, int limit = 200}) async {
    final cats = await _db.collection('menuCategories').orderBy('order').get();
    final items = await _db.collection('menuItems').get();

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
        buf.writeln('- ${i.name} — ${money(i.price)}$weight [id:${i.id}]');
      }
    }
    return buf.toString();
  }

  // ---------- СКЛАД ----------

  Future<String> stockSnapshot({bool onlyProblems = false}) async {
    final snap = await _db.collection('inventoryItems').get();
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

  Future<String> hallSnapshot() async {
    final tablesSnap = await _db.collection('tables').get();
    final tables = tablesSnap.docs.map(TableModel.fromDoc).toList();

    final sessionsSnap =
        await _db.collection('sessions').where('status', isEqualTo: 'active').get();
    final sessions = sessionsSnap.docs.map(SessionModel.fromDoc).toList();
    final byTable = <String, List<SessionModel>>{};
    for (final s in sessions) {
      byTable.putIfAbsent(s.tableId, () => []).add(s);
    }

    final buf = StringBuffer('Время: ${DateTime.now()}\n');
    for (final t in tables) {
      final list = byTable[t.id] ?? const [];
      if (list.isEmpty) {
        buf.writeln('- ${t.name} (${t.seats} мест): свободен');
      } else {
        for (final s in list) {
          final left = s.remaining.inMinutes;
          buf.writeln(
            '- ${t.name} (${t.seats} мест): занят, счёт ${money(s.orderTotal)}, '
            'до конца ${left} мин, перезабивок ${s.refillCount}'
            '${s.guestTag.isNotEmpty ? ', гость: ${s.guestTag}' : ''}',
          );
        }
      }
    }
    return buf.toString();
  }

  // ---------- БРОНИ ----------

  Future<String> reservationsSnapshot({int hours = 12}) async {
    final now = DateTime.now();
    final snap = await _db
        .collection('reservations')
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
        .where('startTime', isLessThan: Timestamp.fromDate(now.add(Duration(hours: hours))))
        .orderBy('startTime')
        .get();

    final list = snap.docs.map(ReservationModel.fromDoc).toList();
    if (list.isEmpty) return 'Броней на ближайшие $hours ч нет.';

    final buf = StringBuffer();
    for (final r in list) {
      buf.writeln(
        '- ${r.startTime.hour.toString().padLeft(2, '0')}:'
        '${r.startTime.minute.toString().padLeft(2, '0')} '
        '${r.guestName}, ${r.guestsCount} чел, стол ${r.tableName.isEmpty ? '—' : r.tableName}, '
        '${r.status.label}${r.comment.isNotEmpty ? ', «${r.comment}»' : ''}',
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
    final snap = await _db
        .collection('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('closedAt', isLessThan: Timestamp.fromDate(to))
        .get();

    final sessions = snap.docs
        .map(SessionModel.fromDoc)
        .where((s) => s.status == 'closed' && !s.refunded)
        .toList();
    if (sessions.isEmpty) return 'Закрытых чеков за период нет.';

    var revenue = 0.0;
    var cash = 0.0, card = 0.0, terminal = 0.0, comp = 0.0;
    final byItem = <String, ({int qty, double sum})>{};
    final byHour = <int, double>{};
    var refills = 0;

    for (final s in sessions) {
      revenue += s.paymentTotal;
      cash += s.paymentCash;
      card += s.paymentCard;
      terminal += s.paymentTerminal;
      comp += s.paymentComp;
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
          'терминал ${money(terminal)}, за счёт заведения ${money(comp)}')
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
    final doc = await _db.collection('clients').doc(clientUid).get();
    if (!doc.exists) return 'Новый гость, истории нет.';
    final p = ClientProfile.fromDoc(doc);

    final past = await _db
        .collection('sessions')
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
    final top = favNames.entries.toList()..sort((a, b) => b.value.compareTo(a.value));

    return [
      'Уровень: ${p.tier}, визитов ${p.visits}, бонусов ${p.bonusBalance.toStringAsFixed(0)}',
      if (p.aiProfile.isNotEmpty) 'Заметки о вкусах: ${p.aiProfile}',
      if (top.isNotEmpty) 'Часто заказывает: ${top.take(8).map((e) => '${e.key} (${e.value})').join(', ')}',
    ].join('\n');
  }

  // ---------- ОТЗЫВЫ ----------

  Future<String> reviewsSnapshot({int limit = 60}) async {
    final snap = await _db
        .collection('reviews')
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get();
    if (snap.docs.isEmpty) return 'Отзывов пока нет.';
    final buf = StringBuffer();
    for (final d in snap.docs) {
      final r = GuestReview.fromDoc(d);
      buf.writeln('- ${r.rating}/5: ${r.text.isEmpty ? '(без текста)' : r.text}');
    }
    return buf.toString();
  }
}
