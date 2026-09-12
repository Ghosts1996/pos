import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../models/client_models.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';
import '../guest_link_service.dart';
import '../reservation_service.dart';
import 'ai_context_service.dart';

/// Кому разрешён инструмент.
enum AiToolScope {
  /// POS: сотрудник в зале и админ — читает всё, может менять стоп-лист,
  /// создавать брони и оставлять заметки.
  staff,

  /// Клиентское приложение: гость — только своё и только витрина.
  guest,
}

/// Один инструмент агента: JSON-описание для модели + исполнитель.
class AiTool {
  final String name;
  final String description;

  /// JSON Schema параметров (формат OpenAI function calling).
  final Map<String, dynamic> parameters;

  /// Кому доступен.
  final Set<AiToolScope> scopes;

  /// true — инструмент меняет данные. Такие вызовы логируются в aiActions
  /// и, если включено подтверждение, требуют кнопки от сотрудника.
  final bool mutating;

  final Future<String> Function(Map<String, dynamic> args, AiToolContext ctx) run;

  const AiTool({
    required this.name,
    required this.description,
    required this.parameters,
    required this.scopes,
    required this.run,
    this.mutating = false,
  });

  Map<String, dynamic> toSchema() => {
        'type': 'function',
        'function': {
          'name': name,
          'description': description,
          'parameters': parameters,
        },
      };
}

/// Контекст запуска инструментов: кто спрашивает и в каком окружении.
class AiToolContext {
  final AiToolScope scope;

  /// UID гостя (для guest-инструментов) — ограничивает доступ своими данными.
  final String guestUid;

  /// Имя сотрудника — попадает в журнал действий агента.
  final String employeeName;

  /// Чек, вокруг которого идёт разговор (экран стола).
  final String sessionId;

  const AiToolContext({
    required this.scope,
    this.guestUid = '',
    this.employeeName = '',
    this.sessionId = '',
  });
}

/// Реестр инструментов. Модель получает только те, что разрешены её scope,
/// поэтому гость физически не может вызвать «поменять стоп-лист».
class AiToolRegistry {
  AiToolRegistry._();
  static final AiToolRegistry instance = AiToolRegistry._();

  final _db = FirebaseFirestore.instance;
  final _ctx = AiContextService();
  final _reservations = ReservationService();
  final _link = GuestLinkService();

  static Map<String, dynamic> _params(Map<String, dynamic> props, [List<String> required = const []]) =>
      {'type': 'object', 'properties': props, 'required': required};

  late final List<AiTool> _tools = [
    // ---------- ЧТЕНИЕ ----------

    AiTool(
      name: 'get_menu',
      description: 'Актуальное меню с ценами. Позиции из стоп-листа не попадают в выдачу.',
      parameters: _params({
        'query': {'type': 'string', 'description': 'Фильтр по названию, необязательно'},
      }),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      run: (args, ctx) async {
        final menu = await _ctx.menuSnapshot();
        final q = (args['query'] as String?)?.trim().toLowerCase() ?? '';
        if (q.isEmpty) return menu;
        final lines = menu
            .split('\n')
            .where((l) => l.startsWith('##') || l.toLowerCase().contains(q))
            .join('\n');
        return lines.isEmpty ? 'Ничего не найдено по запросу «$q».' : lines;
      },
    ),

    AiTool(
      name: 'get_hall_state',
      description: 'Состояние зала прямо сейчас: столы, открытые чеки, таймеры, суммы.',
      parameters: _params({}),
      scopes: {AiToolScope.staff},
      run: (args, ctx) => _ctx.hallSnapshot(),
    ),

    AiTool(
      name: 'get_stock',
      description: 'Остатки склада. only_problems=true — только позиции ниже минимума.',
      parameters: _params({
        'only_problems': {'type': 'boolean'},
      }),
      scopes: {AiToolScope.staff},
      run: (args, ctx) => _ctx.stockSnapshot(onlyProblems: args['only_problems'] == true),
    ),

    AiTool(
      name: 'get_reservations',
      description: 'Брони на ближайшие часы.',
      parameters: _params({
        'hours': {'type': 'integer', 'description': 'Горизонт в часах, по умолчанию 12'},
      }),
      scopes: {AiToolScope.staff},
      run: (args, ctx) =>
          _ctx.reservationsSnapshot(hours: (args['hours'] as num?)?.toInt() ?? 12),
    ),

    AiTool(
      name: 'get_sales',
      description: 'Агрегат продаж за период: выручка, средний чек, топ и аутсайдеры позиций.',
      parameters: _params({
        'days': {'type': 'integer', 'description': 'Сколько последних дней взять'},
      }, ['days']),
      scopes: {AiToolScope.staff},
      run: (args, ctx) {
        final days = (args['days'] as num?)?.toInt() ?? 7;
        final to = DateTime.now();
        return _ctx.salesSnapshot(from: to.subtract(Duration(days: days)), to: to);
      },
    ),

    AiTool(
      name: 'get_guest_profile',
      description: 'Обезличенный портрет гостя: уровень, частые заказы, заметки о вкусах.',
      parameters: _params({
        'client_uid': {'type': 'string'},
      }),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      run: (args, ctx) {
        // Гость может смотреть только себя — подменяем аргумент принудительно.
        final uid = ctx.scope == AiToolScope.guest
            ? ctx.guestUid
            : (args['client_uid'] as String? ?? '');
        if (uid.isEmpty) return Future.value('Гость не указан.');
        return _ctx.guestSnapshot(uid);
      },
    ),

    AiTool(
      name: 'get_session',
      description: 'Текущий чек: позиции, сумма, время сеанса, перезабивки.',
      parameters: _params({
        'session_id': {'type': 'string'},
      }),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      run: (args, ctx) async {
        var id = (args['session_id'] as String?) ?? ctx.sessionId;
        if (ctx.scope == AiToolScope.guest) {
          final profile = await _db.collection('clients').doc(ctx.guestUid).get();
          id = (profile.data()?['activeSessionId'] as String?) ?? '';
        }
        if (id.isEmpty) return 'Открытого чека нет.';
        final doc = await _db.collection('sessions').doc(id).get();
        if (!doc.exists) return 'Чек не найден.';
        final s = SessionModel.fromDoc(doc);
        return [
          'Стол: ${s.tableName}, статус ${s.status}',
          'Сумма: ${s.orderTotal.toStringAsFixed(0)} ₽, со скидкой '
              '${s.totalWithDiscount.toStringAsFixed(0)} ₽',
          'Осталось минут: ${s.remaining.inMinutes}, перезабивок ${s.refillCount}',
          'Позиции: ${s.orderItems.isEmpty ? 'пусто' : s.orderItems.map((i) => '${i.name} x${i.qty}').join(', ')}',
        ].join('\n');
      },
    ),

    AiTool(
      name: 'get_free_slots',
      description: 'Свободное время для брони на конкретный день.',
      parameters: _params({
        'date': {'type': 'string', 'description': 'Дата в формате YYYY-MM-DD'},
        'guests': {'type': 'integer'},
        'duration_minutes': {'type': 'integer'},
      }, ['date']),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      run: (args, ctx) async {
        final day = DateTime.tryParse(args['date']?.toString() ?? '') ?? DateTime.now();
        final slots = await _reservations.availableSlots(
          day: day,
          guestsCount: (args['guests'] as num?)?.toInt() ?? 2,
          durationMinutes: (args['duration_minutes'] as num?)?.toInt() ?? 90,
        );
        if (slots.isEmpty) return 'На ${args['date']} свободных столов нет.';
        return 'Свободно: ${slots.map((s) => '${s.hour.toString().padLeft(2, '0')}:${s.minute.toString().padLeft(2, '0')}').join(', ')}';
      },
    ),

    AiTool(
      name: 'get_reviews',
      description: 'Последние отзывы гостей с оценками.',
      parameters: _params({}),
      scopes: {AiToolScope.staff},
      run: (args, ctx) => _ctx.reviewsSnapshot(),
    ),

    // ---------- ДЕЙСТВИЯ ----------

    AiTool(
      name: 'create_reservation',
      description: 'Создать бронь. Для гостя бронь создаётся от его имени со статусом «новая».',
      parameters: _params({
        'guest_name': {'type': 'string'},
        'phone': {'type': 'string'},
        'start_time': {'type': 'string', 'description': 'ISO 8601, например 2026-09-13T20:00:00'},
        'guests': {'type': 'integer'},
        'duration_minutes': {'type': 'integer'},
        'comment': {'type': 'string'},
      }, ['start_time', 'guests']),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      mutating: true,
      run: (args, ctx) async {
        final start = DateTime.tryParse(args['start_time']?.toString() ?? '');
        if (start == null) return 'Не понял время брони.';
        if (start.isBefore(DateTime.now())) return 'Это время уже прошло.';

        var name = args['guest_name']?.toString() ?? '';
        var phone = args['phone']?.toString() ?? '';
        if (ctx.scope == AiToolScope.guest) {
          final p = await _db.collection('clients').doc(ctx.guestUid).get();
          name = (p.data()?['name'] as String?) ?? name;
          phone = (p.data()?['phone'] as String?) ?? phone;
        }

        try {
          final id = await _reservations.create(ReservationModel(
            id: '',
            clientUid: ctx.scope == AiToolScope.guest ? ctx.guestUid : '',
            guestName: name.isEmpty ? 'Гость' : name,
            phone: phone,
            guestsCount: (args['guests'] as num?)?.toInt() ?? 2,
            startTime: start,
            durationMinutes: (args['duration_minutes'] as num?)?.toInt() ?? 90,
            comment: args['comment']?.toString() ?? '',
            status: ctx.scope == AiToolScope.staff
                ? ReservationStatus.confirmed
                : ReservationStatus.newRequest,
            source: ctx.scope == AiToolScope.guest ? 'kolibri' : 'pos',
            handledBy: ctx.employeeName,
            createdAt: DateTime.now(),
          ));
          await _logAction(ctx, 'create_reservation', {'id': id, 'start': start.toIso8601String()});
          return 'Бронь создана (id $id) на ${start.hour}:${start.minute.toString().padLeft(2, '0')}.';
        } on NoTablesAvailableException {
          return 'Свободных столов на это время нет — предложи другое время.';
        }
      },
    ),

    AiTool(
      name: 'set_menu_item_availability',
      description: 'Поставить позицию меню в стоп-лист или вернуть её в продажу.',
      parameters: _params({
        'menu_item_id': {'type': 'string'},
        'available': {'type': 'boolean'},
        'reason': {'type': 'string'},
      }, ['menu_item_id', 'available']),
      scopes: {AiToolScope.staff},
      mutating: true,
      run: (args, ctx) async {
        final id = args['menu_item_id']?.toString() ?? '';
        if (id.isEmpty) return 'Не указана позиция.';
        await _db.collection('menuItems').doc(id).update({'available': args['available'] == true});
        await _logAction(ctx, 'set_menu_item_availability', args);
        return args['available'] == true ? 'Позиция вернулась в продажу.' : 'Позиция в стоп-листе.';
      },
    ),

    AiTool(
      name: 'add_reservation_note',
      description: 'Дописать заметку к брони (риск неявки, пожелания гостя, рассадка).',
      parameters: _params({
        'reservation_id': {'type': 'string'},
        'note': {'type': 'string'},
      }, ['reservation_id', 'note']),
      scopes: {AiToolScope.staff},
      mutating: true,
      run: (args, ctx) async {
        await _reservations.setAiNote(
            args['reservation_id'].toString(), args['note'].toString());
        await _logAction(ctx, 'add_reservation_note', args);
        return 'Заметка добавлена.';
      },
    ),

    AiTool(
      name: 'call_staff',
      description: 'Позвать персонал к столу гостя: угли, перезабивка, счёт, кальянщик.',
      parameters: _params({
        'type': {
          'type': 'string',
          'enum': ['waiter', 'coal', 'bill', 'refill'],
        },
        'comment': {'type': 'string'},
      }, ['type']),
      scopes: {AiToolScope.guest},
      mutating: true,
      run: (args, ctx) async {
        final profileDoc = await _db.collection('clients').doc(ctx.guestUid).get();
        if (!profileDoc.exists) return 'Профиль не найден.';
        final profile = ClientProfile.fromDoc(profileDoc);
        if (profile.activeTableId.isEmpty) {
          return 'Гость не привязан к столу — предложи открыть вкладку «Мой стол».';
        }
        final tableDoc = await _db.collection('tables').doc(profile.activeTableId).get();
        final table = tableDoc.exists ? TableModel.fromDoc(tableDoc) : null;
        await _link.callStaff(
          tableId: profile.activeTableId,
          tableName: table?.name ?? '',
          sessionId: profile.activeSessionId,
          type: GuestCallTypeX.fromCode(args['type']?.toString()),
          clientUid: ctx.guestUid,
          guestName: profile.name,
          comment: args['comment']?.toString() ?? '',
        );
        return 'Передал кальянщику — сейчас подойдут.';
      },
    ),

    AiTool(
      name: 'save_guest_taste_note',
      description: 'Сохранить вкусовые предпочтения гостя, чтобы помнить их к следующему визиту.',
      parameters: _params({
        'note': {'type': 'string', 'description': 'Короткая заметка: вкусы, крепость, что не понравилось'},
      }, ['note']),
      scopes: {AiToolScope.staff, AiToolScope.guest},
      mutating: true,
      run: (args, ctx) async {
        final uid = ctx.scope == AiToolScope.guest ? ctx.guestUid : '';
        if (uid.isEmpty) return 'Гость не определён.';
        final ref = _db.collection('clients').doc(uid);
        final snap = await ref.get();
        final old = (snap.data()?['aiProfile'] as String?) ?? '';
        final merged = old.isEmpty ? args['note'].toString() : '$old; ${args['note']}';
        await ref.set({'aiProfile': merged.length > 800 ? merged.substring(merged.length - 800) : merged},
            SetOptions(merge: true));
        return 'Запомнил.';
      },
    ),

    AiTool(
      name: 'notify_staff',
      description: 'Отправить заметку персоналу в ленту уведомлений POS (без изменения чеков).',
      parameters: _params({
        'text': {'type': 'string'},
        'priority': {
          'type': 'string',
          'enum': ['info', 'warning'],
        },
      }, ['text']),
      scopes: {AiToolScope.staff},
      mutating: true,
      run: (args, ctx) async {
        await _db.collection('staffNotes').add({
          'text': args['text'].toString(),
          'priority': args['priority']?.toString() ?? 'info',
          'source': 'ai',
          'createdAt': Timestamp.fromDate(DateTime.now()),
          'read': false,
        });
        return 'Уведомление отправлено персоналу.';
      },
    ),
  ];

  /// Схемы инструментов для конкретного scope — именно их получает модель.
  List<Map<String, dynamic>> schemasFor(AiToolScope scope, {Set<String>? only}) => _tools
      .where((t) => t.scopes.contains(scope) && (only == null || only.contains(t.name)))
      .map((t) => t.toSchema())
      .toList();

  /// Исполнитель для TookenClient.completeWithTools.
  Future<String> Function(String, Map<String, dynamic>) executorFor(AiToolContext ctx,
      {Set<String>? only}) {
    return (name, args) async {
      final tool = _tools.where((t) => t.name == name).firstOrNull;
      if (tool == null) return 'Инструмент «$name» не существует.';
      if (!tool.scopes.contains(ctx.scope)) {
        return 'Нет прав на «$name».';
      }
      if (only != null && !only.contains(name)) {
        return 'Инструмент «$name» отключён для этого агента.';
      }
      return tool.run(args, ctx);
    };
  }

  /// Журнал действий агента — чтобы всегда было видно, что именно ИИ
  /// поменял в данных и по чьей команде.
  Future<void> _logAction(AiToolContext ctx, String tool, Map<String, dynamic> args) async {
    try {
      await _db.collection('aiActions').add({
        'tool': tool,
        'args': jsonEncode(args),
        'scope': ctx.scope.name,
        'employeeName': ctx.employeeName,
        'guestUid': ctx.guestUid,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } catch (_) {}
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
