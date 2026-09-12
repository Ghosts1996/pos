import 'package:cloud_firestore/cloud_firestore.dart';

/// Настройки подключения к Tooken Club (tooken.club) — единый
/// OpenAI-совместимый шлюз к GPT / Claude / DeepSeek и др.
///
/// Хранятся в Firestore (meta/aiSettings), а не в коде: ключ можно менять
/// из админки на любом планшете без пересборки APK, и оба приложения
/// (POS и «Колибри Лаундж») сразу подхватывают новый ключ и модель.
///
/// Ключ получается в личном кабинете tooken.club после пополнения баланса.
/// baseUrl берётся оттуда же (раздел «Документация» → base URL);
/// значение по умолчанию ниже подходит для стандартной выдачи.
class AiSettings {
  /// Глобальный рубильник ИИ. Выключено — все агенты молчат, приложение
  /// работает как обычный POS без единого сетевого запроса к ИИ.
  final bool enabled;

  /// Base URL OpenAI-совместимого API Tooken Club (без /chat/completions).
  final String baseUrl;

  /// API-ключ из кабинета tooken.club.
  final String apiKey;

  /// Рабочая модель по умолчанию — быстрые агенты подсказок.
  final String model;

  /// «Тяжёлая» модель для аналитики и отчётов (можно оставить = model).
  final String analyticsModel;

  final double temperature;
  final int maxTokens;

  /// Индивидуальные выключатели агентов: {'hookah_sommelier': true, ...}.
  /// Ключ отсутствует — агент считается включённым.
  final Map<String, bool> agents;

  /// Месячный лимит расхода в рублях — мягкая защита от неожиданного счёта.
  /// 0 — без лимита.
  final double monthlyLimitRub;

  const AiSettings({
    this.enabled = false,
    this.baseUrl = 'https://tooken.club/v1',
    this.apiKey = '',
    this.model = 'gpt-4o-mini',
    this.analyticsModel = 'gpt-4o',
    this.temperature = 0.4,
    this.maxTokens = 900,
    this.agents = const {},
    this.monthlyLimitRub = 0,
  });

  bool get isReady => enabled && apiKey.isNotEmpty && baseUrl.isNotEmpty;

  bool agentEnabled(String agentId) => enabled && (agents[agentId] ?? true);

  factory AiSettings.fromMap(Map<String, dynamic>? data) {
    if (data == null) return const AiSettings();
    return AiSettings(
      enabled: data['enabled'] ?? false,
      baseUrl: (data['baseUrl'] as String?)?.trim().isNotEmpty == true
          ? (data['baseUrl'] as String).trim()
          : 'https://tooken.club/v1',
      apiKey: data['apiKey'] ?? '',
      model: data['model'] ?? 'gpt-4o-mini',
      analyticsModel: data['analyticsModel'] ?? data['model'] ?? 'gpt-4o',
      temperature: (data['temperature'] ?? 0.4).toDouble(),
      maxTokens: (data['maxTokens'] as num?)?.toInt() ?? 900,
      agents: Map<String, bool>.from(
        (data['agents'] as Map?)?.map((k, v) => MapEntry(k.toString(), v == true)) ?? {},
      ),
      monthlyLimitRub: (data['monthlyLimitRub'] ?? 0).toDouble(),
    );
  }

  Map<String, dynamic> toMap() => {
        'enabled': enabled,
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'model': model,
        'analyticsModel': analyticsModel,
        'temperature': temperature,
        'maxTokens': maxTokens,
        'agents': agents,
        'monthlyLimitRub': monthlyLimitRub,
      };

  AiSettings copyWith({
    bool? enabled,
    String? baseUrl,
    String? apiKey,
    String? model,
    String? analyticsModel,
    double? temperature,
    int? maxTokens,
    Map<String, bool>? agents,
    double? monthlyLimitRub,
  }) =>
      AiSettings(
        enabled: enabled ?? this.enabled,
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        model: model ?? this.model,
        analyticsModel: analyticsModel ?? this.analyticsModel,
        temperature: temperature ?? this.temperature,
        maxTokens: maxTokens ?? this.maxTokens,
        agents: agents ?? this.agents,
        monthlyLimitRub: monthlyLimitRub ?? this.monthlyLimitRub,
      );
}

/// Глобальный кэш настроек ИИ: один раз подписываемся на документ,
/// дальше все агенты читают [current] синхронно, без похода в сеть.
class AiSettingsStore {
  AiSettingsStore._();
  static final AiSettingsStore instance = AiSettingsStore._();

  static const _path = 'meta/aiSettings';

  AiSettings _current = const AiSettings();
  AiSettings get current => _current;

  final _db = FirebaseFirestore.instance;

  Stream<AiSettings> stream() => _db
      .doc(_path)
      .snapshots()
      .map((d) => AiSettings.fromMap(d.data()))
      .map((s) {
        _current = s;
        return s;
      });

  /// Вызывается один раз при старте приложения (main). Не блокирует запуск:
  /// если сети нет — ИИ просто останется выключенным до первого ответа.
  Future<void> init() async {
    try {
      final doc = await _db.doc(_path).get();
      _current = AiSettings.fromMap(doc.data());
    } catch (_) {
      _current = const AiSettings();
    }
    _db.doc(_path).snapshots().listen(
          (d) => _current = AiSettings.fromMap(d.data()),
          onError: (_) {},
        );
  }

  Future<void> save(AiSettings settings) =>
      _db.doc(_path).set(settings.toMap(), SetOptions(merge: true));
}
