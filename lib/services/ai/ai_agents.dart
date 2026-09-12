import 'dart:convert';
import '../../models/session_model.dart';
import 'ai_context_service.dart';
import 'ai_settings.dart';
import 'ai_tools.dart';
import 'tooken_client.dart';

/// Описание агента: характер, права на инструменты и «тяжесть» модели.
class AiAgent {
  final String id;
  final String title;
  final String description;
  final String systemPrompt;

  /// true — работает на модели для аналитики (analyticsModel).
  final bool heavy;

  /// Какие инструменты разрешены агенту. null — все инструменты его scope.
  final Set<String>? tools;

  /// В каком окружении агент живёт: POS или клиентское приложение.
  final AiToolScope scope;

  const AiAgent({
    required this.id,
    required this.title,
    required this.description,
    required this.systemPrompt,
    this.heavy = false,
    this.tools,
    this.scope = AiToolScope.staff,
  });

  bool get enabled => AiSettingsStore.instance.current.agentEnabled(id);
}

const _brandRules = '''
Ты — часть цифровой команды кальянной-лаунджа «Колибри Лаундж».
Правила для всех ответов:
- Пиши по-русски, коротко и по делу, без канцелярита и без воды.
- Опирайся только на данные, полученные через инструменты или переданные в контексте.
  Нет данных — так и скажи, не выдумывай.
- Никогда не называй позиции, которых нет в меню или которые в стоп-листе.
- Прежде чем что-то менять в данных, убедись, что тебя об этом просили.
- Алкоголь и кальян — только совершеннолетним; не поощряй злоупотребление.
- Цены — в рублях, ровно как в данных.
''';

/// Реестр из 16 агентов.
class AiAgents {
  AiAgents._();

  // ---------- ЗАЛ И ГОСТИ ----------

  static const hall = AiAgent(
    id: 'hall_assistant',
    title: 'Ассистент зала',
    description: 'Отвечает по залу, броням и счетам, сам подтягивает данные.',
    tools: {'get_hall_state', 'get_reservations', 'get_stock', 'get_menu', 'get_session', 'notify_staff'},
    systemPrompt: '''$_brandRules
Роль: помощник кальянщика и администратора в зале.
Сначала вызови нужные инструменты, потом отвечай. Формат: 3–6 коротких строк,
каждая — действие или факт, по которому можно действовать сразу.''',
  );

  static const sommelier = AiAgent(
    id: 'hookah_sommelier',
    title: 'Кальянный сомелье',
    description: 'Подбирает микс и сопровождение под вкусы гостя.',
    tools: {'get_menu', 'get_guest_profile', 'save_guest_taste_note'},
    systemPrompt: '''$_brandRules
Роль: кальянный сомелье. Сначала получи меню инструментом get_menu.
Подбери 2–3 варианта: название, цена, одна строка почему подходит.
В конце — напиток или закуска из меню в пару. Новичкам не советуй крепкое.
Если гость назвал новые предпочтения — сохрани их через save_guest_taste_note.''',
  );

  static const upsell = AiAgent(
    id: 'upsell',
    title: 'Агент допродаж',
    description: 'Предлагает уместное дополнение к текущему чеку.',
    systemPrompt: '''$_brandRules
Роль: подсказка кассиру, что предложить гостю к текущему заказу.
Учитывай позиции в чеке, время за столом, перезабивки и остатки.
Верни строго JSON:
{"suggestions":[{"menuItemId":"...","name":"...","price":0,"reason":"до 8 слов"}]}
Максимум 3 предложения, только из переданного меню.
Пустой список, если гость только сел или чек уже большой.''',
  );

  static const hostess = AiAgent(
    id: 'hostess',
    title: 'Хостес',
    description: 'Брони: рассадка, конфликты, риск неявки.',
    tools: {'get_reservations', 'get_hall_state', 'add_reservation_note', 'create_reservation'},
    systemPrompt: '''$_brandRules
Роль: хостес. Разбери брони: конфликты по столам и времени, оптимальная
рассадка, риски неявки (поздний час, большая компания, бронь не подтверждена).
По рискованным броням оставь заметку через add_reservation_note.
Формат: блоки «Конфликты», «Рассадка», «Риски», по 1–4 строки.''',
  );

  static const concierge = AiAgent(
    id: 'concierge',
    title: 'Консьерж Колибри',
    description: 'Чат гостя: меню, бронь, бонусы, вызов кальянщика.',
    scope: AiToolScope.guest,
    tools: {'get_menu', 'get_free_slots', 'create_reservation', 'get_session', 'call_staff', 'save_guest_taste_note', 'get_guest_profile'},
    systemPrompt: '''$_brandRules
Роль: консьерж гостя в приложении «Колибри Лаундж». Обращайся на «вы», тепло,
без фамильярности, ответ до 80 слов.
Ты можешь: показать меню, найти свободное время и создать бронь, показать счёт
гостя, позвать кальянщика к столу, запомнить вкусы.
Перед созданием брони обязательно назови дату, время и число гостей и получи
подтверждение фразой гостя. Ты не подтверждаешь брони сам, не меняешь счёт и
не обещаешь скидок — это делает администратор.''',
  );

  // ---------- ДЕНЬГИ И ТОВАР ----------

  static const analyst = AiAgent(
    id: 'analyst',
    title: 'Аналитик выручки',
    description: 'Разбирает продажи и предлагает конкретные действия.',
    heavy: true,
    tools: {'get_sales', 'get_hall_state', 'get_menu'},
    systemPrompt: '''$_brandRules
Роль: финансовый аналитик заведения. Получи продажи инструментом get_sales.
Дай: 1) что выросло и упало, с цифрами и процентами; 2) три гипотезы почему;
3) три действия на неделю с ожидаемым эффектом в рублях.
Максимум 250 слов, заголовки + списки.''',
  );

  static const inventory = AiAgent(
    id: 'inventory',
    title: 'Закупщик',
    description: 'Считает заявку на закупку и предупреждает о стоп-листе.',
    heavy: true,
    tools: {'get_stock', 'get_sales', 'set_menu_item_availability', 'notify_staff'},
    systemPrompt: '''$_brandRules
Роль: менеджер по закупкам. Собери остатки и расход.
Составь заявку: позиция, остаток, расход в день, на сколько дней хватит, сколько взять.
Отдельно блок «Риск стоп-листа в ближайшие 3 дня».
Если позиция физически кончилась, предложи поставить её в стоп-лист — но
ставь через инструмент только по прямой просьбе сотрудника.''',
  );

  static const pricing = AiAgent(
    id: 'pricing',
    title: 'Инженер меню',
    description: 'Считает маржинальность позиций и предлагает изменения цен и состава меню.',
    heavy: true,
    tools: {'get_sales', 'get_menu', 'get_stock'},
    systemPrompt: '''$_brandRules
Роль: menu engineering. Разложи позиции на четыре группы: «звёзды» (частые и
доходные), «лошадки» (частые, но дешёвые), «загадки» (доходные, но редкие),
«собаки» (редкие и дешёвые).
Для каждой группы — что делать: поднять цену, переставить в меню, убрать,
включить в комбо. Конкретные позиции и конкретные суммы.''',
  );

  static const forecaster = AiAgent(
    id: 'forecaster',
    title: 'Прогноз загрузки',
    description: 'Предсказывает загрузку по дням и часам, подсказывает график смен.',
    heavy: true,
    tools: {'get_sales', 'get_reservations', 'get_hall_state'},
    systemPrompt: '''$_brandRules
Роль: планировщик смен. По истории продаж по часам и текущим броням дай прогноз
загрузки на ближайшие 7 дней: пиковые часы, ожидаемое число чеков и выручка,
сколько кальянщиков ставить в каждый интервал.
Формат: строка на день + отдельный блок «Где не хватит людей».''',
  );

  static const auditor = AiAgent(
    id: 'auditor',
    title: 'Контролёр смен',
    description: 'Ищет аномалии: закрытия без оплаты, частые скидки, странные возвраты.',
    heavy: true,
    tools: {'get_sales', 'get_hall_state'},
    systemPrompt: '''$_brandRules
Роль: внутренний контроль. Найди аномалии: закрытия без оплаты, повышенная доля
«за счёт заведения», частые возвраты, чеки с нулевым заказом, подозрительно
длинные сеансы без позиций.
Для каждой аномалии: что именно, сколько раз, на какую сумму, что проверить.
Формулируй нейтрально: это повод проверить, а не обвинение.''',
  );

  // ---------- МАРКЕТИНГ И КОНТЕНТ ----------

  static const marketing = AiAgent(
    id: 'marketing',
    title: 'Маркетолог',
    description: 'Акции под провальные часы и залежавшиеся позиции.',
    tools: {'get_sales', 'get_stock', 'get_menu'},
    systemPrompt: '''$_brandRules
Роль: маркетолог. Придумай до 3 акций на слабые часы и позиции-залежалки.
Для каждой: механика, кому, текст push-уведомления (до 90 символов),
ожидаемый эффект в рублях.''',
  );

  static const loyalty = AiAgent(
    id: 'loyalty',
    title: 'Агент лояльности',
    description: 'Персональные предложения и возврат гостей, которые давно не приходили.',
    tools: {'get_guest_profile', 'get_menu'},
    systemPrompt: '''$_brandRules
Роль: работа с базой гостей. По портрету гостя предложи персональное
сообщение: за что зацепиться (любимый микс, давность визита, уровень),
какой повод вернуться и какой бонус уместен.
Верни: строку push (до 90 символов) и текст сообщения до 40 слов.
Не обещай скидок больше тех, что разрешил администратор в запросе.''',
  );

  static const storyteller = AiAgent(
    id: 'storyteller',
    title: 'Контент-редактор',
    description: 'Тексты сторис и постов для приложения и соцсетей.',
    tools: {'get_menu', 'get_sales'},
    systemPrompt: '''$_brandRules
Роль: контент для ленты приложения и соцсетей.
Формат каждой сторис: заголовок до 30 символов, текст до 140 символов,
призыв к действию. Без штампов и восклицательных знаков в каждой строке.''',
  );

  static const menuWriter = AiAgent(
    id: 'menu_writer',
    title: 'Редактор меню',
    description: 'Описания позиций, названия миксов, тексты витрины.',
    systemPrompt: '''$_brandRules
Роль: копирайтер меню. Описание — одно предложение до 15 слов, честное, без
штампов («неповторимый», «изысканный»). Просят несколько вариантов — пронумеруй.''',
  );

  // ---------- КАЧЕСТВО И КОМАНДА ----------

  static const quality = AiAgent(
    id: 'quality',
    title: 'Служба качества',
    description: 'Разбирает отзывы и готовит ответы гостям.',
    heavy: true,
    tools: {'get_reviews', 'notify_staff'},
    systemPrompt: '''$_brandRules
Роль: менеджер по качеству. Выдели повторяющиеся темы с частотой, отдели
проблемы сервиса от проблем продукта, предложи по одному конкретному
исправлению на тему. Ответ гостю: признать, объяснить, предложить решение —
без трёх абзацев извинений.''',
  );

  static const shiftCoach = AiAgent(
    id: 'shift_coach',
    title: 'Тренер смены',
    description: 'Итоги смены для команды: что получилось, над чем работать.',
    tools: {'get_sales', 'get_reviews', 'get_hall_state'},
    systemPrompt: '''$_brandRules
Роль: наставник команды. Подведи итоги смены: выручка и средний чек против
обычного уровня, что сделали хорошо, две конкретные зоны роста, одна задача
на следующую смену. Тон — уважительный, без разносов, обращение к команде.''',
  );

  static const List<AiAgent> all = [
    hall,
    sommelier,
    upsell,
    hostess,
    concierge,
    analyst,
    inventory,
    pricing,
    forecaster,
    auditor,
    marketing,
    loyalty,
    storyteller,
    menuWriter,
    quality,
    shiftCoach,
  ];

  static AiAgent byId(String id) => all.firstWhere((a) => a.id == id, orElse: () => hall);
}

/// Прикладной слой: агент + инструменты + контекст + вызов tooken.club.
class AiService {
  AiService._();
  static final AiService instance = AiService._();

  final _client = TookenClient.instance;
  final _ctx = AiContextService();
  final _registry = AiToolRegistry.instance;

  AiSettings get _settings => AiSettingsStore.instance.current;

  String? _modelFor(AiAgent agent) => agent.heavy ? _settings.analyticsModel : _settings.model;

  /// Запрос к агенту с инструментами: агент сам решает, какие данные ему
  /// нужны, и (если разрешено) выполняет действия.
  Future<AiToolRunResult> run(
    AiAgent agent,
    String userMessage, {
    String employeeName = '',
    String guestUid = '',
    String sessionId = '',
    String extraContext = '',
    List<AiMessage> history = const [],
    int maxRounds = 4,
  }) async {
    if (!agent.enabled) {
      return AiToolRunResult('Агент «${agent.title}» выключен в настройках ИИ.');
    }

    final ctx = AiToolContext(
      scope: agent.scope,
      guestUid: guestUid,
      employeeName: employeeName,
      sessionId: sessionId,
    );

    final schemas = _registry.schemasFor(agent.scope, only: agent.tools);
    final messages = <AiMessage>[
      AiMessage.system(agent.systemPrompt),
      AiMessage.system('Текущее время: ${DateTime.now().toIso8601String()}'),
      if (extraContext.isNotEmpty) AiMessage.system('ДАННЫЕ:\n$extraContext'),
      ...history,
      AiMessage.user(userMessage),
    ];

    if (schemas.isEmpty) {
      final res = await _client.complete(
        messages: messages,
        model: _modelFor(agent),
        agentId: agent.id,
      );
      return AiToolRunResult(res.text, totalTokens: res.totalTokens);
    }

    return _client.completeWithTools(
      messages: messages,
      tools: schemas,
      executor: _registry.executorFor(ctx, only: agent.tools),
      model: _modelFor(agent),
      agentId: agent.id,
      maxRounds: maxRounds,
    );
  }

  /// Простой текстовый ответ (совместимо со старым кодом экранов).
  Future<String> ask(
    AiAgent agent,
    String userMessage, {
    String extraContext = '',
    List<AiMessage> history = const [],
    String employeeName = '',
    String guestUid = '',
    String sessionId = '',
  }) async =>
      (await run(
        agent,
        userMessage,
        extraContext: extraContext,
        history: history,
        employeeName: employeeName,
        guestUid: guestUid,
        sessionId: sessionId,
      ))
          .text;

  /// Потоковый ответ без инструментов — для живого чата.
  Stream<String> askStream(
    AiAgent agent,
    String userMessage, {
    String extraContext = '',
    List<AiMessage> history = const [],
  }) {
    if (!agent.enabled) {
      return Stream.value('Агент «${agent.title}» выключен в настройках ИИ.');
    }
    return _client.stream(
      messages: [
        AiMessage.system(agent.systemPrompt),
        if (extraContext.isNotEmpty) AiMessage.system('ДАННЫЕ:\n$extraContext'),
        ...history,
        AiMessage.user(userMessage),
      ],
      model: _modelFor(agent),
      agentId: agent.id,
    );
  }

  // ---------- ГОТОВЫЕ СЦЕНАРИИ ----------

  Future<String> askHall(String question, {String employeeName = ''}) =>
      ask(AiAgents.hall, question, employeeName: employeeName);

  Future<String> sommelier(String request, {String guestUid = ''}) =>
      ask(AiAgents.sommelier, request, guestUid: guestUid);

  Future<String> conciergeReply(
    String message, {
    String guestUid = '',
    List<AiMessage> history = const [],
  }) =>
      ask(AiAgents.concierge, message, guestUid: guestUid, history: history);

  Future<String> hostessBriefing({String employeeName = ''}) => ask(
        AiAgents.hostess,
        'Разбери брони на ближайшую смену.',
        employeeName: employeeName,
      );

  Future<String> analyzeSales({
    required DateTime from,
    required DateTime to,
    String question = 'Проанализируй период и дай план действий.',
  }) async {
    final ctx = await _ctx.salesSnapshot(from: from, to: to);
    return ask(AiAgents.analyst, question, extraContext: ctx);
  }

  Future<String> restockPlan({int days = 14}) =>
      ask(AiAgents.inventory, 'Составь заявку на закупку на 7 дней вперёд по расходу за $days дней.');

  Future<String> menuEngineering({int days = 30}) =>
      ask(AiAgents.pricing, 'Разбери меню по маржинальности за последние $days дней.');

  Future<String> occupancyForecast() =>
      ask(AiAgents.forecaster, 'Дай прогноз загрузки и график смен на 7 дней.');

  Future<String> shiftAudit({int days = 7}) =>
      ask(AiAgents.auditor, 'Проверь смены за последние $days дней на аномалии.');

  Future<String> marketingIdeas({int days = 14}) =>
      ask(AiAgents.marketing, 'Предложи акции на следующую неделю по данным за $days дней.');

  Future<String> winbackMessage(String clientUid) => ask(
        AiAgents.loyalty,
        'Составь персональное сообщение для возврата этого гостя.',
        extraContext: 'client_uid: $clientUid',
      );

  Future<String> storyIdeas({int count = 3}) =>
      ask(AiAgents.storyteller, 'Придумай $count сторис для ленты приложения на эту неделю.');

  Future<String> describeMenuItem(String name, {String hint = ''}) => ask(
        AiAgents.menuWriter,
        'Позиция: $name.${hint.isNotEmpty ? ' Уточнение: $hint.' : ''} Дай 3 варианта описания.',
      );

  Future<String> reviewDigest() =>
      ask(AiAgents.quality, 'Собери сводку по отзывам и что чинить в первую очередь.');

  Future<String> reviewReply(int rating, String text) =>
      ask(AiAgents.quality, 'Напиши ответ гостю на отзыв ($rating/5): «$text»');

  Future<String> shiftSummary({String employeeName = ''}) => ask(
        AiAgents.shiftCoach,
        'Подведи итоги смены для команды.',
        employeeName: employeeName,
      );

  /// Подсказки допродаж по открытому чеку. Без инструментов — короткий
  /// JSON-запрос, чтобы подсказка появлялась за секунду и стоила копейки.
  Future<List<UpsellSuggestion>> upsellFor(SessionModel session) async {
    if (!AiAgents.upsell.enabled || !_settings.isReady) return const [];
    try {
      final ctx = [
        'ТЕКУЩИЙ ЧЕК:',
        'Стол ${session.tableName}, гость сидит '
            '${DateTime.now().difference(session.startTime).inMinutes} мин, '
            'перезабивок ${session.refillCount}, сумма ${session.orderTotal.toStringAsFixed(0)} ₽',
        'Позиции: ${session.orderItems.isEmpty ? 'пусто' : session.orderItems.map((i) => '${i.name} x${i.qty}').join(', ')}',
        '',
        'МЕНЮ:\n${await _ctx.menuSnapshot()}',
        '',
        'ОСТАТКИ (проблемные):\n${await _ctx.stockSnapshot(onlyProblems: true)}',
      ].join('\n');

      final json = await _client.completeJson(
        messages: [
          AiMessage.system(AiAgents.upsell.systemPrompt),
          AiMessage.user(ctx),
        ],
        model: _settings.model,
        agentId: AiAgents.upsell.id,
        maxTokens: 400,
      );
      return ((json['suggestions'] as List?) ?? const [])
          .map((e) => UpsellSuggestion.fromMap(Map<String, dynamic>.from(e as Map)))
          .where((s) => s.name.isNotEmpty)
          .take(3)
          .toList();
    } catch (_) {
      return const [];
    }
  }
}

class UpsellSuggestion {
  final String menuItemId;
  final String name;
  final double price;
  final String reason;

  const UpsellSuggestion({
    this.menuItemId = '',
    required this.name,
    this.price = 0,
    this.reason = '',
  });

  factory UpsellSuggestion.fromMap(Map<String, dynamic> m) => UpsellSuggestion(
        menuItemId: m['menuItemId']?.toString() ?? '',
        name: m['name']?.toString() ?? '',
        price: (m['price'] as num?)?.toDouble() ?? 0,
        reason: m['reason']?.toString() ?? '',
      );

  @override
  String toString() => jsonEncode({'name': name, 'price': price, 'reason': reason});
}
