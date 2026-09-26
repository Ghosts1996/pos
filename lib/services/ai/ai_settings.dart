import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import '../app_scope.dart';

/// Готовый провайдер ИИ: адрес API, формат и модели по умолчанию.
///
/// Все, кроме «Своего шлюза», говорят на OpenAI-совместимом API
/// (POST {baseUrl}/chat/completions), поэтому один клиент
/// ([TookenClient]) обслуживает их одинаково — отличаются только адрес,
/// ключ и имена моделей.
class AiVendor {
  final String id;
  final String title;
  final String baseUrl;

  /// 'openai' | 'anthropic' | 'auto' (определить по первому ответу).
  final String format;
  final String defaultModel;
  final String defaultAnalyticsModel;
  final String keyHint;
  final List<String> suggestedModels;

  /// Важное про провайдера, показывается в настройках под полями.
  final String note;

  const AiVendor({
    required this.id,
    required this.title,
    required this.baseUrl,
    required this.format,
    required this.defaultModel,
    required this.defaultAnalyticsModel,
    required this.keyHint,
    this.suggestedModels = const [],
    this.note = '',
  });
}

class AiVendors {
  AiVendors._();

  static const tooken = AiVendor(
    id: 'tooken',
    title: 'Tooken Club',
    baseUrl: 'https://tooken.club/v1',
    format: 'openai',
    defaultModel: 'gpt-4o-mini',
    defaultAnalyticsModel: 'gpt-4o',
    keyHint: 'Ключ из личного кабинета tooken.club',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'claude-sonnet-4-5', 'deepseek-chat'],
  );

  /// DarkAPI — OpenAI-совместимый шлюз к DeepSeek, GLM и MiMo с одним
  /// ключом. Точный адрес API показан в кабинете darkapi.shop рядом с
  /// ключом — если он отличается, поправьте поле «Адрес API».
  static const darkapi = AiVendor(
    id: 'darkapi',
    title: 'DarkAPI',
    baseUrl: 'https://darkapi.shop/v1',
    format: 'openai',
    defaultModel: 'deepseek-chat',
    defaultAnalyticsModel: 'deepseek-chat',
    keyHint: 'Ключ из кабинета darkapi.shop — там же адрес API',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'Имена моделей у DarkAPI свои — после ввода ключа нажмите «Загрузить модели» и выберите из списка.',
  );

  /// Google Gemini через официальный OpenAI-совместимый адрес. Алиасы
  /// «-latest» Google сам переключает на свежую модель — не устаревают.
  static const gemini = AiVendor(
    id: 'gemini',
    title: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    format: 'openai',
    defaultModel: 'gemini-flash-latest',
    defaultAnalyticsModel: 'gemini-flash-latest',
    keyHint: 'Ключ из Google AI Studio: aistudio.google.com → Get API key',
    suggestedModels: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'],
    note: 'Google не пускает к Gemini API из России: запросы с планшетов в РФ получают отказ '
        'по региону. Работает через VPN на уровне сети заведения или через ваш прокси — '
        'укажите его в поле «Адрес API». Назначьте резервным провайдером DarkAPI или '
        'Tooken Club: при отказе Gemini ИИ сам переключится на него.',
  );

  static const custom = AiVendor(
    id: 'custom',
    title: 'Свой шлюз',
    baseUrl: '',
    format: 'auto',
    defaultModel: 'gpt-4o-mini',
    defaultAnalyticsModel: 'gpt-4o-mini',
    keyHint: 'Ключ из кабинета вашего шлюза',
    note: 'Любой OpenAI-совместимый или Anthropic-совместимый шлюз (например ai.d1n0tf.ru). '
        'Формат можно оставить «Определить автоматически».',
  );

  static const all = [tooken, darkapi, gemini, custom];

  static AiVendor byId(String id) => all.firstWhere((v) => v.id == id, orElse: () => tooken);

  /// Какой провайдер у старых настроек (до выбора провайдера) — по адресу.
  static String inferFromBaseUrl(String baseUrl) {
    final u = baseUrl.toLowerCase();
    if (u.isEmpty || u.contains('tooken.club')) return tooken.id;
    if (u.contains('darkapi')) return darkapi.id;
    if (u.contains('generativelanguage.googleapis.com')) return gemini.id;
    return custom.id;
  }
}

/// Подключение к одному провайдеру: адрес, ключ, формат, модели.
class AiVendorConfig {
  final String baseUrl;
  final String apiKey;
  final String format;
  final String model;
  final String analyticsModel;

  /// Ключ задан (без самого ключа) — по нему гостевое приложение, которое
  /// ключей не видит (ходит через saas-gateway), понимает, что ИИ готов.
  final bool hasKey;

  const AiVendorConfig({
    this.baseUrl = '',
    this.apiKey = '',
    this.format = '',
    this.model = '',
    this.analyticsModel = '',
    this.hasKey = false,
  });

  bool get keySet => apiKey.isNotEmpty || hasKey;

  AiVendorConfig copyWith({String? baseUrl, String? apiKey, String? format, String? model, String? analyticsModel, bool? hasKey}) =>
      AiVendorConfig(
        baseUrl: baseUrl ?? this.baseUrl,
        apiKey: apiKey ?? this.apiKey,
        format: format ?? this.format,
        model: model ?? this.model,
        analyticsModel: analyticsModel ?? this.analyticsModel,
        hasKey: hasKey ?? this.hasKey,
      );
}

/// Готовая «точка» для запроса: провайдер с заполненными значениями по
/// умолчанию. [slot] — 'primary' или 'fallback' (по нему saas-gateway
/// понимает, чей ключ подставить, когда гость ходит через прокси).
class AiEndpoint {
  final AiVendor vendor;
  final String slot;
  final String baseUrl;
  final String apiKey;
  final String format;
  final String model;
  final String analyticsModel;

  const AiEndpoint({
    required this.vendor,
    required this.slot,
    required this.baseUrl,
    required this.apiKey,
    required this.format,
    required this.model,
    required this.analyticsModel,
  });
}

/// Настройки ИИ заведения.
///
/// Хранятся в Firestore, а не в коде: ключ меняется из админки на любом
/// планшете без пересборки APK. В SaaS-режиме — в двух документах:
/// meta/aiSettings (провайдер, модели, агенты — читают и гости, их
/// ИИ-консьержу это нужно) и meta/aiSecrets (адреса и ключи — только
/// персонал). Раньше ключ лежал прямо в aiSettings, и его мог прочитать
/// любой гость, открывший веб-версию заведения. Гостевое приложение ключей
/// не видит и ходит к ИИ через saas-gateway (/aiProxy).
class AiSettings {
  /// Глобальный рубильник ИИ. Выключено — все агенты молчат, приложение
  /// работает как обычный POS без единого сетевого запроса к ИИ.
  final bool enabled;

  /// Основной провайдер (AiVendors.*.id).
  final String vendor;

  /// Резервный провайдер: при любом сбое основного (нет связи, ключ
  /// отклонён, отказ по региону, лимит) запрос повторяется через него.
  /// Пусто — без резервного.
  final String fallbackVendor;

  /// Подключения по провайдерам: ключ каждого хранится отдельно, поэтому
  /// переключение провайдера не стирает остальные ключи.
  final Map<String, AiVendorConfig> vendors;

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
    this.vendor = 'tooken',
    this.fallbackVendor = '',
    this.vendors = const {},
    this.temperature = 0.4,
    this.maxTokens = 900,
    this.agents = const {},
    this.monthlyLimitRub = 0,
  });

  AiVendorConfig configFor(String vendorId) => vendors[vendorId] ?? const AiVendorConfig();

  /// Провайдер с подставленными значениями по умолчанию.
  AiEndpoint endpointFor(String vendorId, {String slot = 'primary'}) {
    final v = AiVendors.byId(vendorId);
    final c = configFor(v.id);
    return AiEndpoint(
      vendor: v,
      slot: slot,
      baseUrl: (c.baseUrl.trim().isNotEmpty ? c.baseUrl.trim() : v.baseUrl).replaceAll(RegExp(r'/+$'), ''),
      apiKey: c.apiKey,
      format: c.format.isNotEmpty ? c.format : v.format,
      model: c.model.trim().isNotEmpty ? c.model.trim() : v.defaultModel,
      analyticsModel: c.analyticsModel.trim().isNotEmpty ? c.analyticsModel.trim() : v.defaultAnalyticsModel,
    );
  }

  AiEndpoint get primary => endpointFor(vendor);

  /// Резервный провайдер, только если он задан, отличается от основного и
  /// у него есть ключ.
  AiEndpoint? get fallback {
    if (fallbackVendor.isEmpty || fallbackVendor == vendor) return null;
    if (!configFor(fallbackVendor).keySet) return null;
    return endpointFor(fallbackVendor, slot: 'fallback');
  }

  /// Модели основного провайдера — их выбирают агенты.
  String get model => primary.model;
  String get analyticsModel => primary.analyticsModel;

  /// Гость ключей и адресов не видит (они в meta/aiSecrets) — ему хватает
  /// флага hasKey: адрес подставит сервер платформы.
  bool get isReady {
    final c = configFor(vendor);
    if (!enabled || !c.keySet) return false;
    return primary.baseUrl.isNotEmpty || (c.apiKey.isEmpty && c.hasKey);
  }

  bool agentEnabled(String agentId) => enabled && (agents[agentId] ?? true);

  /// [data] — meta/aiSettings, [secrets] — meta/aiSecrets (SaaS; у гостя
  /// недоступен и остаётся null). Понимает и старый формат, где один
  /// шлюз с ключом лежал прямо в aiSettings (baseUrl/apiKey/provider/model).
  factory AiSettings.fromMap(Map<String, dynamic>? data, {Map<String, dynamic>? secrets}) {
    if (data == null && secrets == null) return const AiSettings();
    final d = data ?? const <String, dynamic>{};
    final legacyBase = (d['baseUrl'] as String?)?.trim() ?? '';
    final vendorId = AiVendors.byId((d['vendor'] as String?)?.isNotEmpty == true
            ? d['vendor'] as String
            : AiVendors.inferFromBaseUrl(legacyBase))
        .id;

    final vendors = <String, AiVendorConfig>{};
    final pub = (d['vendors'] as Map?) ?? const {};
    final sec = ((secrets ?? const {})['vendors'] as Map?) ?? const {};
    // Ключи, сохранённые без разделения (одноарендная сборка — там один
    // документ, см. AiSettingsStore.save).
    final inline = (d['vendorKeys'] as Map?) ?? const {};
    for (final v in AiVendors.all) {
      final p = (pub[v.id] as Map?) ?? const {};
      final s = (sec[v.id] as Map?) ?? (inline[v.id] as Map?) ?? const {};
      vendors[v.id] = AiVendorConfig(
        baseUrl: (s['baseUrl'] ?? p['baseUrl'] ?? '').toString(),
        apiKey: (s['apiKey'] ?? '').toString(),
        format: (p['format'] ?? '').toString(),
        model: (p['model'] ?? '').toString(),
        analyticsModel: (p['analyticsModel'] ?? '').toString(),
        hasKey: p['hasKey'] == true,
      );
    }
    // Старый формат: один шлюз прямо в aiSettings.
    final legacyKey = (d['apiKey'] as String?) ?? '';
    if (legacyKey.isNotEmpty || legacyBase.isNotEmpty || d['model'] != null) {
      final cur = vendors[vendorId] ?? const AiVendorConfig();
      final legacyFormat = (d['provider'] as String?) ?? '';
      vendors[vendorId] = cur.copyWith(
        apiKey: cur.apiKey.isNotEmpty ? cur.apiKey : legacyKey,
        baseUrl: cur.baseUrl.isNotEmpty ? cur.baseUrl : legacyBase,
        format: cur.format.isNotEmpty ? cur.format : (vendorId == AiVendors.custom.id ? legacyFormat : ''),
        model: cur.model.isNotEmpty ? cur.model : (d['model'] ?? '').toString(),
        analyticsModel: cur.analyticsModel.isNotEmpty ? cur.analyticsModel : (d['analyticsModel'] ?? d['model'] ?? '').toString(),
        hasKey: cur.hasKey || legacyKey.isNotEmpty,
      );
    }

    return AiSettings(
      enabled: d['enabled'] ?? false,
      vendor: vendorId,
      fallbackVendor: (d['fallbackVendor'] as String?) ?? '',
      vendors: vendors,
      temperature: (d['temperature'] ?? 0.4).toDouble(),
      maxTokens: (d['maxTokens'] as num?)?.toInt() ?? 900,
      agents: Map<String, bool>.from(
        (d['agents'] as Map?)?.map((k, v) => MapEntry(k.toString(), v == true)) ?? {},
      ),
      monthlyLimitRub: (d['monthlyLimitRub'] ?? 0).toDouble(),
    );
  }

  /// Открытая часть (meta/aiSettings): без адресов и ключей.
  Map<String, dynamic> toPublicMap() => {
        'enabled': enabled,
        'vendor': vendor,
        'fallbackVendor': fallbackVendor,
        'vendors': {
          for (final e in vendors.entries)
            e.key: {
              'format': e.value.format,
              'model': e.value.model,
              'analyticsModel': e.value.analyticsModel,
              'hasKey': e.value.apiKey.isNotEmpty,
            },
        },
        'temperature': temperature,
        'maxTokens': maxTokens,
        'agents': agents,
        'monthlyLimitRub': monthlyLimitRub,
      };

  /// Секретная часть (meta/aiSecrets): адреса и ключи.
  Map<String, dynamic> toSecretsMap() => {
        'vendors': {
          for (final e in vendors.entries)
            e.key: {'baseUrl': e.value.baseUrl.trim(), 'apiKey': e.value.apiKey.trim()},
        },
      };

  AiSettings copyWith({
    bool? enabled,
    String? vendor,
    String? fallbackVendor,
    Map<String, AiVendorConfig>? vendors,
    double? temperature,
    int? maxTokens,
    Map<String, bool>? agents,
    double? monthlyLimitRub,
  }) =>
      AiSettings(
        enabled: enabled ?? this.enabled,
        vendor: vendor ?? this.vendor,
        fallbackVendor: fallbackVendor ?? this.fallbackVendor,
        vendors: vendors ?? this.vendors,
        temperature: temperature ?? this.temperature,
        maxTokens: maxTokens ?? this.maxTokens,
        agents: agents ?? this.agents,
        monthlyLimitRub: monthlyLimitRub ?? this.monthlyLimitRub,
      );

  AiSettings withVendorConfig(String vendorId, AiVendorConfig config) =>
      copyWith(vendors: {...vendors, vendorId: config});
}

/// Глобальный кэш настроек ИИ: один раз подписываемся на документы,
/// дальше все агенты читают [current] синхронно, без похода в сеть.
///
/// Где лежат настройки:
///  • одиночное заведение — tenants/{id}/meta/aiSettings (+ aiSecrets);
///  • точка сети — chains/{chainId}/meta/aiSettings (+ aiSecrets): ключ
///    покупается один раз на всю сеть и действует во всех точках. Пока у
///    сети своих настроек нет, работают прежние настройки самой точки —
///    при первом сохранении они переезжают на уровень сети.
class AiSettingsStore {
  AiSettingsStore._();
  static final AiSettingsStore instance = AiSettingsStore._();

  static const _path = 'meta/aiSettings';
  static const _secretsPath = 'meta/aiSecrets';

  AiSettings _current = const AiSettings();
  AiSettings get current => _current;

  // Документы сети и (для совместимости) самой точки.
  Map<String, dynamic>? _chainData;
  Map<String, dynamic>? _chainSecrets;
  Map<String, dynamic>? _data;
  Map<String, dynamic>? _secrets;
  final List<StreamSubscription> _subs = [];

  /// Ключи отдельно от открытых настроек — только в SaaS: одноарендная
  /// сборка живёт по своим правилам базы (корневой firestore.rules) и
  /// хранит всё в одном документе, как раньше.
  bool get _split => AppScope.isSaasMode;

  /// Настройки общие на всю сеть заведений.
  bool get isChainShared => AppScope.chainId != null;

  DocumentReference<Map<String, dynamic>> _chainDoc(String path) =>
      FirebaseFirestore.instance.doc('chains/${AppScope.chainId}/$path');

  /// Куда сохранять: сеть — на уровень сети, иначе — заведение.
  DocumentReference<Map<String, dynamic>> _target(String path) =>
      isChainShared ? _chainDoc(path) : AppScope.doc(path);

  void _rebuild() {
    final useChain = isChainShared && _chainData != null;
    _current = AiSettings.fromMap(
      useChain ? _chainData : _data,
      secrets: useChain ? _chainSecrets : _secrets,
    );
  }

  Future<Map<String, dynamic>?> _read(DocumentReference<Map<String, dynamic>> ref) async {
    try {
      return (await ref.get()).data();
    } catch (_) {
      return null; // нет прав (гость и ключи) или нет сети
    }
  }

  /// Прочитать настройки один раз (экран настроек). Ключи — если есть
  /// права (персонал); у гостя их нет, это не ошибка.
  Future<AiSettings> load() async {
    if (isChainShared) {
      final chain = await _read(_chainDoc(_path));
      if (chain != null) {
        return AiSettings.fromMap(chain, secrets: _split ? await _read(_chainDoc(_secretsPath)) : null);
      }
    }
    final own = await _read(AppScope.doc(_path));
    return AiSettings.fromMap(own, secrets: _split ? await _read(AppScope.doc(_secretsPath)) : null);
  }

  /// Вызывается один раз при старте приложения (main). Не блокирует запуск:
  /// если сети нет — ИИ просто останется выключенным до первого ответа.
  Future<void> init() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    _data = await _read(AppScope.doc(_path));
    if (_split) _secrets = await _read(AppScope.doc(_secretsPath));
    if (isChainShared) {
      _chainData = await _read(_chainDoc(_path));
      if (_split) _chainSecrets = await _read(_chainDoc(_secretsPath));
    }
    _rebuild();

    void listen(DocumentReference<Map<String, dynamic>> ref, void Function(Map<String, dynamic>?) set) {
      _subs.add(ref.snapshots().listen((d) {
        set(d.data());
        _rebuild();
      }, onError: (_) {}));
    }

    listen(AppScope.doc(_path), (d) => _data = d);
    if (_split) listen(AppScope.doc(_secretsPath), (d) => _secrets = d);
    if (isChainShared) {
      listen(_chainDoc(_path), (d) => _chainData = d);
      if (_split) listen(_chainDoc(_secretsPath), (d) => _chainSecrets = d);
    }
  }

  Future<void> save(AiSettings settings) async {
    final pub = settings.toPublicMap();
    // Старые поля одного шлюза (apiKey/baseUrl/provider/model) — убираем:
    // в SaaS ключ больше не должен лежать в документе, который читают гости.
    const legacy = ['apiKey', 'baseUrl', 'provider', 'model', 'analyticsModel', 'vendorKeys'];
    if (_split) {
      await _target(_secretsPath).set(settings.toSecretsMap(), SetOptions(merge: true));
      await _target(_path).set({
        ...pub,
        for (final f in legacy) f: FieldValue.delete(),
      }, SetOptions(merge: true));
    } else {
      // Одноарендная сборка: один документ. Старые поля основного
      // провайдера сохраняем — их читают уже установленные версии.
      final p = settings.primary;
      await AppScope.doc(_path).set({
        ...pub,
        'vendorKeys': settings.toSecretsMap()['vendors'],
        'apiKey': p.apiKey,
        'baseUrl': p.baseUrl,
        'provider': p.format,
        'model': p.model,
        'analyticsModel': p.analyticsModel,
      }, SetOptions(merge: true));
    }
    final saved = await _read(_target(_path)) ?? pub;
    if (isChainShared) {
      _chainData = saved;
      if (_split) _chainSecrets = settings.toSecretsMap();
    } else {
      _data = saved;
      if (_split) _secrets = settings.toSecretsMap();
    }
    _rebuild();
  }
}
