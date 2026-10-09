import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../app_scope.dart';
import '../venue_service.dart';
import '../../models/client_models.dart';
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

  /// Системный промпт с текущими уровнями лояльности заведения.
  String get prompt => systemPrompt.contains(_tiersPlaceholder)
      ? systemPrompt.replaceAll(_tiersPlaceholder, loyaltyTiersText())
      : systemPrompt;
}

const _brandRules = '''
Ты — часть цифровой команды заведения (кафе, ресторан, бар или лаунж). Название, адрес, часы работы
и правила заведения — в блоке «О ЗАВЕДЕНИИ» ниже; другого названия не придумывай.
Правила для всех ответов:
- Пиши по-русски, коротко и по делу, без канцелярита и без воды.
- Опирайся только на данные, полученные через инструменты или переданные в контексте.
  Нет данных — так и скажи, не выдумывай.
- Никогда не называй позиции, которых нет в меню или которые в стоп-листе.
- Прежде чем что-то менять в данных, убедись, что тебя об этом просили.
- Алкоголь и кальян — только совершеннолетним; не поощряй злоупотребление.
- Цены — в рублях, ровно как в данных.
''';

/// Реклама табака и стимулирование его продажи запрещены (ст. 16 № 15-ФЗ):
/// акции, сторис и push не должны упоминать кальяны, табак и никотин.
const _noTobaccoAds = '''
- Не рекламируй табак, кальяны и никотинсодержащую продукцию: не упоминай
  их в акциях, сторис, push и рассылках и не предлагай на них скидок,
  бонусов и подарков — это запрещено законом № 15-ФЗ. Продвигай кухню,
  напитки, атмосферу, события и бронь.
''';

/// Кальянная база знаний: вкусовые семейства, рабочие пропорции и
/// проверенные миксы. Без неё модель сочиняет вкусы, которых не бывает,
/// или предлагает позиции меню вместо микса.
const _hookahKnowledge = '''
ВКУСОВЫЕ СЕМЕЙСТВА:
- Цитрус: лимон, лайм, грейпфрут, апельсин. Дают кислинку и свежесть.
- Ягоды: малина, клубника, черника, вишня, смородина. Сладкие, мягкие.
- Тропики: манго, маракуйя, ананас, банан, кокос, личи. Сочные, сладкие.
- Свежесть: мята, лёд, эвкалипт, холодок. Добавляются 10–20%.
- Десерт: ваниль, крем, карамель, шоколад, выпечка, мёд.
- Пряности: корица, кардамон, имбирь, чай, тархун.
- Кислые добавки: барбарис, гранат, клюква — 10–15% для баланса сладкого.

КРЕПОСТЬ:
- Лёгкая: фруктово-ягодные линейки, светлый лист. Для новичков и девушек.
- Средняя: классические линейки, большинство гостей.
- Крепкая: тёмный лист. Только опытным, кто просит сам. Предупреди, что
  крепко, и посоветуй не курить натощак.

ПРАВИЛА МИКСА:
- 2–3 вкуса, редко 4. Больше — каша.
- Доли считай на 10 частей, например 5/3/2.
- Основа 50–60%, дополнение 30%, акцент 10–20%.
- Кислое + сладкое работает почти всегда; два десерта вместе — тяжело.
- Мята/лёд поверх фруктов освежает, поверх десерта обычно лишняя.
- Один яркий доминант: два сильных вкуса забивают друг друга.

ПРОВЕРЕННЫЕ МИКСЫ:
- Цитрус-фреш: грейпфрут 5 / лайм 3 / мята 2 — кисло, свежо, лёгкий.
- Летний сад: малина 4 / клубника 4 / мята 2 — сладкий, мягкий, для начала вечера.
- Тропик: манго 5 / маракуйя 3 / лёд 2 — сочный, летний, средняя крепость.
- Кола-лайм: кола 6 / лайм 4 — газировочный, бодрит, средний.
- Вишня в шоколаде: вишня 6 / шоколад 4 — десертный, вечерний.
- Пряная груша: груша 5 / корица 3 / ваниль 2 — тёплый, осенний.
- Арбуз-дыня: арбуз 5 / дыня 5 — классика для компании, лёгкий.
- Гранат-барбарис: гранат 5 / барбарис 3 / лёд 2 — кислый, освежающий.
- Чай с бергамотом: чёрный чай 6 / бергамот 2 / лимон 2 — некрепкий, к чаю.
- Мохито: лайм 4 / мята 4 / лёд 2 — самый безопасный выбор для новичка.
- Тёмная ночь: тёмный лист вишня 6 / чёрная смородина 4 — крепкий, опытным.
''';

/// Как устроены бонусы — модель отвечает на это сама. Уровни владелец
/// настраивает в админке, поэтому в const-промпте вместо них метка, которую
/// [AiAgent.prompt] заменяет текущими ClientProfile.tiers.
const _tiersPlaceholder = '{{LOYALTY_TIERS}}';

const _loyaltyKnowledge = '''
КАК РАБОТАЮТ БОНУСЫ (отвечай сама, не зови сотрудника — это твой вопрос):
- 1 бонус = 1 рубль. Начисляются процентом от суммы визита сразу после
  оплаты чека, копятся на балансе гостя без срока сгорания.
- Уровень зависит от суммы всех визитов за всё время (не за один чек) и
  определяет процент начисления: $_tiersPlaceholder.
- Списать бонусы можно на кассе при оплате — они закрывают до 50% суммы
  чека, остальное оплачивается обычным способом.
- Если гость спрашивает свой баланс или уровень — возьми через
  get_guest_profile, не выдумывай число.
''';

/// Реестр агентов.
class AiAgents {
  AiAgents._();

  // ---------- ЗАЛ И ГОСТИ ----------

  static const hall = AiAgent(
    id: 'hall_assistant',
    title: 'Ассистент зала',
    description: 'Отвечает по залу, броням и счетам, сам подтягивает данные.',
    tools: {'get_hall_state', 'get_reservations', 'get_stock', 'get_menu', 'get_session', 'notify_staff'},
    systemPrompt: '''$_brandRules
Роль: помощник персонала зала и администратора.
Сначала вызови нужные инструменты, потом отвечай. Формат: 3–6 коротких строк,
каждая — действие или факт, по которому можно действовать сразу.''',
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

  /// ИИ-помощник гостя (id прежний — 'concierge', чтобы сохранились
  /// выключатели в настройках ИИ). Заменил консьержа и кальянного
  /// сомелье. Доступен только гостю за столом (consumeAiQuota), поэтому
  /// и про кальян отвечает лишь в заведении — как и табачные позиции меню.
  static const concierge = AiAgent(
    id: 'concierge',
    title: 'ИИ-помощник',
    description: 'Чат гостя: меню и состав блюд, популярное, столы и брони, бонусы, вызов персонала.',
    scope: AiToolScope.guest,
    tools: {'get_menu', 'get_tables', 'get_free_slots', 'create_reservation', 'get_session', 'call_staff', 'save_guest_taste_note', 'get_guest_profile', 'get_weather'},
    systemPrompt: '''$_brandRules
Роль: ИИ-помощник гостя в приложении заведения. Обращайся на «вы», тепло,
без фамильярности, ответ до 90 слов.

Что ты знаешь и умеешь:
- Меню (блок «МЕНЮ» ниже или get_menu): только позиции, которые сейчас есть,
  с ценами. Состав блюда называй ТОЛЬКО из поля «Состав» — если его нет,
  так и скажи и предложи уточнить у персонала: не выдумывай ингредиенты,
  у гостя может быть аллергия.
- Популярное: позиции с пометкой «хит продаж №N» — самые заказываемые за
  последний месяц. На «что у вас популярное / что посоветуете» называй их
  первыми, добавь 1–2 варианта под вкусы гостя (О ГОСТЕ) и время суток.
- Советы по заказу: сочетай блюда и напитки из меню, учитывай число гостей
  и бюджет, если их назвали. Можно вызвать get_weather: в жару — лёгкое и
  освежающее, в холод — горячее и сытное; нет погоды — не упоминай её.
- Столы и брони: какие столы свободны сейчас и на сколько мест — get_tables;
  свободное время на дату — get_free_slots; бронь — create_reservation.
  Перед бронью назови дату, время и число гостей и дождись подтверждения
  гостя. Ты не подтверждаешь бронь сам — это делает администратор.
- Счёт гостя — get_session; позвать персонал к столу — call_staff.
- Бонусы, уровень, кешбэк — отвечай сама по знаниям ниже, баланс и уровень
  бери из get_guest_profile, не выдумывай.
- Гость назвал вкусы или предпочтения — сохрани через save_guest_taste_note.

$_loyaltyKnowledge

Кальян (закон № 15-ФЗ о табаке):
- Говори о кальянах и миксах ТОЛЬКО когда гость сам об этом спросил. Сам не
  предлагай кальян, не называй его хитом и не советуй «взять ещё».
- Не обещай и не упоминай скидки, бонусы и подарки на кальян и табак.
- Отвечая, подбери микс по знаниям ниже: два микса с составом в долях и
  крепостью, позицию кальяна из меню с ценой — отдельной строкой. Новичку и
  на «полегче» — лёгкие и средние миксы, без тёмного листа.
- Кальяна нет в меню — скажи, что его здесь не подают.
- Кальян — только для совершеннолетних.

$_hookahKnowledge
Ты не меняешь счёт и не обещаешь скидок — это делает администратор.''',
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
сколько сотрудников ставить в каждый интервал.
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
ожидаемый эффект в рублях.
$_noTobaccoAds''',
  );

  static const loyalty = AiAgent(
    id: 'loyalty',
    title: 'Агент лояльности',
    description: 'Персональные предложения и возврат гостей, которые давно не приходили.',
    tools: {'get_guest_profile', 'get_menu'},
    systemPrompt: '''$_brandRules
Роль: работа с базой гостей. По портрету гостя предложи персональное
сообщение: за что зацепиться (давность визита, уровень, любимые блюда и напитки),
какой повод вернуться и какой бонус уместен.
Верни: строку push (до 90 символов) и текст сообщения до 40 слов.
Не обещай скидок больше тех, что разрешил администратор в запросе.
$_noTobaccoAds''',
  );

  static const storyteller = AiAgent(
    id: 'storyteller',
    title: 'Контент-редактор',
    description: 'Тексты сторис и постов для приложения и соцсетей.',
    tools: {'get_menu', 'get_sales'},
    // Ответ строго в JSON. Свободный текст модель отдавала с разметкой и
    // служебными словами — «**Сторис 3 — Ночной формат**», «Заголовок: …
    // Текст: … Призыв: …» — и всё это одной строкой уезжало в карточку.
    // Гость видел не сторис, а черновик с внутренними подписями.
    systemPrompt: '''$_brandRules
Роль: контент для ленты приложения.
$_noTobaccoAds
Отвечай ОДНИМ JSON-объектом:
{"stories":[{"title":"","text":"","cta":"","action":"booking|menu|none"}]}

Правила для каждой сторис:
- title: до 30 символов, без кавычек, без точки в конце, без слова «Сторис»
  и без нумерации — это то, что гость видит крупно;
- text: одно-два предложения до 140 символов, по делу: что это, чем хорошо;
- cta: 1-3 слова на кнопку («Забронировать», «Открыть меню»);
- action: booking — если зовём бронировать, menu — если смотреть меню,
  иначе none.

Ничего, кроме JSON. Без markdown, без ** и #, без слов «Заголовок»,
«Текст», «Призыв» внутри значений. Без восклицательных знаков и штампов.''',
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
    final venue = await VenueService.instance.aiKnowledgeCached();
    final messages = <AiMessage>[
      AiMessage.system(agent.prompt),
      if (venue.isNotEmpty) AiMessage.system('О ЗАВЕДЕНИИ:\n$venue'),
      AiMessage.system(
          'Текущее время: ${DateTime.now().toIso8601String()} (${_weekdayRu(DateTime.now())})'),
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
  }) async* {
    if (!agent.enabled) {
      yield 'Агент «${agent.title}» выключен в настройках ИИ.';
      return;
    }
    final venue = await VenueService.instance.aiKnowledgeCached();
    yield* _client.stream(
      messages: [
        AiMessage.system(agent.prompt),
        if (venue.isNotEmpty) AiMessage.system('О ЗАВЕДЕНИИ:\n$venue'),
        if (extraContext.isNotEmpty) AiMessage.system('ДАННЫЕ:\n$extraContext'),
        ...history,
        AiMessage.user(userMessage),
      ],
      model: _modelFor(agent),
      agentId: agent.id,
    );
  }

  // ---------- ГОТОВЫЕ СЦЕНАРИИ ----------

  /// Контекст собирается заранее и передаётся в промпт: не все шлюзы
  /// поддерживают вызов инструментов, и без этого агент отвечал «данных нет».
  Future<String> hallContext() async {
    final parts = await Future.wait([
      _ctx.hallSnapshot(),
      _ctx.reservationsSnapshot(),
      _ctx.stockSnapshot(onlyProblems: true),
    ]);
    return 'ЗАЛ СЕЙЧАС:\n${parts[0]}\n\nБРОНИ:\n${parts[1]}\n\n'
        'ПРОБЛЕМЫ СКЛАДА:\n${parts[2]}';
  }

  Future<String> askHall(String question, {String employeeName = ''}) async =>
      ask(AiAgents.hall, question,
          employeeName: employeeName, extraContext: await hallContext());

  Future<String> conciergeReply(
    String message, {
    String guestUid = '',
    List<AiMessage> history = const [],
  }) async {
    final menu = await _ctx.menuSnapshot();
    final guest = guestUid.isEmpty ? '' : await _ctx.guestSnapshot(guestUid);
    return ask(
      AiAgents.concierge,
      message,
      guestUid: guestUid,
      history: history,
      extraContext: 'МЕНЮ:\n$menu${guest.isEmpty ? '' : '\n\nО ГОСТЕ:\n$guest'}',
    );
  }

  Future<String> hostessBriefing({String employeeName = ''}) async => ask(
        AiAgents.hostess,
        'Разбери брони на ближайшую смену.',
        employeeName: employeeName,
        extraContext: await hallContext(),
      );

  /// Разбор периода по всем данным заведения (AiVenueDigest): продажи,
  /// смены, журнал кассы, брони, отзывы, бонусы, склад. Сотрудники уходят
  /// в ИИ под номерами и получают имена обратно уже в готовом ответе.
  Future<String> analyzeSales({
    required DateTime from,
    required DateTime to,
    String question = 'Проанализируй период и дай план действий.',
  }) =>
      _withDigest(AiAgents.analyst, question, from: from, to: to);

  static const _keepAliases = 'Сотрудников называй так же, как в данных: «Сотрудник №N».';

  Future<String> _withDigest(
    AiAgent agent,
    String question, {
    required DateTime from,
    required DateTime to,
  }) async {
    final staff = AiPseudonyms();
    final ctx = await _ctx.venueDigest(from: from, to: to, staff: staff);
    return staff.restore(await ask(agent, '$question\n$_keepAliases', extraContext: ctx));
  }

  /// Ежедневный разбор для владельца — то, что попадает в «Сводки ИИ».
  /// null — за период не было ни одного чека: разбирать нечего, токены
  /// не тратим.
  Future<String?> venueDigest({int days = 1}) async {
    final to = DateTime.now();
    final from = to.subtract(Duration(days: days));
    final any = await AppScope.col('sessions')
        .where('closedAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .limit(1)
        .get();
    if (any.docs.isEmpty) return null;
    return _withDigest(
      AiAgents.analyst,
      days == 1
          ? 'Разбери последние сутки заведения. Дай: 1) главное в цифрах; '
              '2) что насторожило — отмены, возвраты, скидки, закрытия без оплаты, '
              'низкие оценки, склад; 3) кто из сотрудников отличился и кому нужна '
              'помощь; 4) три действия на завтра. До 250 слов.'
          : 'Разбери неделю заведения: что выросло и упало, сильные и слабые дни '
              'и часы, работа сотрудников, отзывы, склад. Дай пять действий на '
              'следующую неделю с ожидаемым эффектом в рублях. До 300 слов.',
      from: from,
      to: to,
    );
  }

  Future<String> restockPlan({int days = 14}) async {
    final to = DateTime.now();
    final parts = await Future.wait([
      _ctx.stockSnapshot(),
      _ctx.salesSnapshot(from: to.subtract(Duration(days: days)), to: to),
    ]);
    return ask(
      AiAgents.inventory,
      'Составь заявку на закупку на 7 дней вперёд по расходу за $days дней.',
      extraContext: 'ОСТАТКИ:\n${parts[0]}\n\nПРОДАЖИ ЗА $days ДНЕЙ:\n${parts[1]}',
    );
  }

  Future<String> menuEngineering({int days = 30}) async {
    final to = DateTime.now();
    final parts = await Future.wait([
      _ctx.salesSnapshot(from: to.subtract(Duration(days: days)), to: to),
      _ctx.menuSnapshot(onlyAvailable: false),
    ]);
    return ask(AiAgents.pricing, 'Разбери меню по маржинальности за последние $days дней.',
        extraContext: 'ПРОДАЖИ ЗА $days ДНЕЙ:\n${parts[0]}\n\nМЕНЮ:\n${parts[1]}');
  }

  Future<String> occupancyForecast() async {
    final to = DateTime.now();
    final parts = await Future.wait([
      _ctx.salesSnapshot(from: to.subtract(const Duration(days: 28)), to: to),
      _ctx.reservationsSnapshot(hours: 7 * 24),
    ]);
    return ask(AiAgents.forecaster, 'Дай прогноз загрузки и график смен на 7 дней.',
        extraContext: 'ПРОДАЖИ ЗА 4 НЕДЕЛИ:\n${parts[0]}\n\nБРОНИ НА НЕДЕЛЮ:\n${parts[1]}');
  }

  /// Контекст для контролёра: журнал кассы (передаётся отдельно вызывающим
  /// экраном — сам журнал не хранится здесь) плюс продажи за период. Без
  /// продаж контролёр не может оценить долю аномалий от общего оборота и
  /// честно отвечает, что ему нечем считать — это как раз тот случай,
  /// который решает предзагрузка данных вместо надежды на вызов инструмента.
  Future<String> auditContext({int days = 7}) =>
      _ctx.salesSnapshot(from: DateTime.now().subtract(Duration(days: days)), to: DateTime.now());

  Future<String> shiftAudit({int days = 7}) async => ask(
        AiAgents.auditor,
        'Проверь смены за последние $days дней на аномалии.',
        extraContext: 'ПРОДАЖИ ЗА ПЕРИОД:\n${await auditContext(days: days)}',
      );

  /// Контекст для аналитика в свободном диалоге: продажи за последние
  /// [days] дней и проблемные остатки склада — то же самое, что показывают
  /// готовые карточки на экране «ИИ-разборы», только без выбора периода.
  Future<String> analystContext({int days = 30}) async {
    final parts = await Future.wait([
      _ctx.salesSnapshot(from: DateTime.now().subtract(Duration(days: days)), to: DateTime.now()),
      _ctx.stockSnapshot(onlyProblems: true),
    ]);
    return 'ПРОДАЖИ ЗА $days ДНЕЙ:\n${parts[0]}\n\nПРОБЛЕМЫ СКЛАДА:\n${parts[1]}';
  }

  Future<String> marketingIdeas({int days = 14}) async {
    final to = DateTime.now();
    final parts = await Future.wait([
      _ctx.salesSnapshot(from: to.subtract(Duration(days: days)), to: to),
      _ctx.stockSnapshot(),
    ]);
    return ask(AiAgents.marketing, 'Предложи акции на следующую неделю по данным за $days дней.',
        extraContext: 'ПРОДАЖИ ЗА $days ДНЕЙ:\n${parts[0]}\n\nОСТАТКИ:\n${parts[1]}');
  }

  Future<String> winbackMessage(String clientUid) => ask(
        AiAgents.loyalty,
        'Составь персональное сообщение для возврата этого гостя.',
        extraContext: 'client_uid: $clientUid',
      );

  Future<String> storyIdeas({int count = 3}) =>
      ask(AiAgents.storyteller, 'Придумай $count сторис для ленты приложения на эту неделю.');

  /// Черновики сторис, разобранные по полям: заголовок, текст, призыв —
  /// без разметки и служебных подписей из ответа модели.
  Future<List<StoryDraft>> storyDrafts({int count = 3}) async {
    if (!AiAgents.storyteller.enabled || !_settings.isReady) return const [];
    final json = await _client.completeJson(
      messages: [
        AiMessage.system(AiAgents.storyteller.prompt),
        AiMessage.user('Придумай $count сторис для ленты приложения на эту '
            'неделю. Опирайся на меню и на то, что гости берут чаще.\n\n'
            'МЕНЮ:\n${await _ctx.menuSnapshot()}'),
      ],
      model: _settings.model,
      agentId: AiAgents.storyteller.id,
      maxTokens: 900,
    );
    return ((json['stories'] as List?) ?? const [])
        .map((e) => StoryDraft.fromMap(Map<String, dynamic>.from(e as Map)))
        .where((d) => d.title.isNotEmpty && d.text.isNotEmpty)
        .take(count)
        .toList();
  }

  Future<String> describeMenuItem(String name, {String hint = ''}) => ask(
        AiAgents.menuWriter,
        'Позиция: $name.${hint.isNotEmpty ? ' Уточнение: $hint.' : ''} Дай 3 варианта описания.',
      );

  Future<String> reviewDigest() async => ask(
        AiAgents.quality,
        'Собери сводку по отзывам и что чинить в первую очередь.',
        extraContext: 'ПОСЛЕДНИЕ ОТЗЫВЫ:\n${await _ctx.reviewsSnapshot()}',
      );

  Future<String> reviewReply(int rating, String text) =>
      ask(AiAgents.quality, 'Напиши ответ гостю на отзыв ($rating/5): «$text»');

  /// Итоги смены — по данным последних 18 часов (смена через полночь
  /// целиком попадает в окно).
  Future<String> shiftSummary({String employeeName = ''}) {
    final to = DateTime.now();
    return _withDigest(AiAgents.shiftCoach, 'Подведи итоги смены для команды.',
        from: to.subtract(const Duration(hours: 18)), to: to);
  }

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
          AiMessage.system(AiAgents.upsell.prompt),
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

/// Черновик сторис от ИИ, уже разобранный по полям.
class StoryDraft {
  final String title;
  final String text;
  final String cta;
  final String action;

  const StoryDraft({
    required this.title,
    required this.text,
    this.cta = '',
    this.action = 'none',
  });

  factory StoryDraft.fromMap(Map<String, dynamic> m) => StoryDraft(
        title: cleanAiText(m['title'], maxLength: 40),
        text: cleanAiText(m['text'], maxLength: 180),
        cta: cleanAiText(m['cta'], maxLength: 24),
        action: switch (m['action']?.toString()) {
          'booking' => 'booking',
          'menu' => 'menu',
          _ => 'none',
        },
      );
}

/// Приводит строку от модели к виду, пригодному для показа гостю.
///
/// Модель периодически возвращает то, что попросили НЕ возвращать:
/// markdown-звёздочки, решётки заголовков, нумерацию «1.», служебные
/// подписи «Заголовок:» и переводы строк посреди фразы. Одна такая
/// оплошность — и гость видит в ленте «**Сторис 3 — Ночной формат**».
/// Просить вежливее бесполезно, поэтому чистим на своей стороне.
String cleanAiText(Object? raw, {int maxLength = 200}) {
  var v = (raw?.toString() ?? '').trim();
  if (v.isEmpty) return '';
  v = v.replaceAll(RegExp(r'[*#`_]+'), '');
  v = v.replaceAll(RegExp(r'^\s*(сторис|история)\s*\d*\s*[—\-:.]\s*',
      caseSensitive: false), '');
  v = v.replaceAll(
      RegExp(r'^\s*(заголовок|текст|призыв|описание)\s*:\s*',
          caseSensitive: false),
      '');
  v = v.replaceAll(RegExp(r'^\s*\d+\s*[.)]\s*'), '');
  v = v.replaceAll(RegExp(r'\s+'), ' ').trim();
  v = v.replaceAll(RegExp(r'^["«»\s]+|["«»\s]+$'), '');
  if (v.length > maxLength) {
    // Режем по границе слова, чтобы не обрывать на половине буквы.
    final cut = v.substring(0, maxLength);
    final space = cut.lastIndexOf(' ');
    v = '${space > maxLength ~/ 2 ? cut.substring(0, space) : cut}…';
  }
  return v;
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

/// День недели по-русски — модели проще ориентироваться на «пятница»,
/// чем самой считать день недели по ISO-дате.
String _weekdayRu(DateTime d) {
  const names = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  return names[d.weekday - 1];
}

/// «Бронза (с 0 ₽) — 3%, Серебро (с 10 000 ₽) — 5%, …» по текущим настройкам.
String loyaltyTiersText() {
  String num(double v) {
    final whole = v == v.roundToDouble();
    final raw = whole ? v.round().toString() : v.toStringAsFixed(1);
    if (!whole) return raw.replaceAll('.', ',');
    return raw.replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+$)'), (m) => '${m[1]} ');
  }

  return ClientProfile.tiers
      .map((t) => '${t.name} (с ${num(t.from)} ₽) — ${num(t.cashback)}%')
      .join(', ');
}
