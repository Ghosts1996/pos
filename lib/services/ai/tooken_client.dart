import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../app_scope.dart';
import 'package:http/http.dart' as http;
import 'ai_settings.dart';

/// Одно сообщение диалога в формате OpenAI Chat Completions.
class AiMessage {
  final String role; // 'system' | 'user' | 'assistant' | 'tool'
  final String content;

  /// Запросы модели на вызов инструментов (role == 'assistant').
  final List<Map<String, dynamic>>? toolCalls;

  /// Ответ инструмента (role == 'tool').
  final String? toolCallId;

  const AiMessage(this.role, this.content, {this.toolCalls, this.toolCallId});

  const AiMessage.system(this.content)
      : role = 'system',
        toolCalls = null,
        toolCallId = null;
  const AiMessage.user(this.content)
      : role = 'user',
        toolCalls = null,
        toolCallId = null;
  const AiMessage.assistant(this.content)
      : role = 'assistant',
        toolCalls = null,
        toolCallId = null;
  const AiMessage.tool(this.content, this.toolCallId)
      : role = 'tool',
        toolCalls = null;

  Map<String, dynamic> toJson() => {
        'role': role,
        'content': content,
        if (toolCalls != null) 'tool_calls': toolCalls,
        if (toolCallId != null) 'tool_call_id': toolCallId,
      };
}

class AiResult {
  final String text;
  final int promptTokens;
  final int completionTokens;

  /// Сырые tool_calls последнего ответа — нужны циклу инструментов.
  final List<Map<String, dynamic>> toolCalls;

  const AiResult(
    this.text, {
    this.promptTokens = 0,
    this.completionTokens = 0,
    this.toolCalls = const [],
  });

  int get totalTokens => promptTokens + completionTokens;
  bool get wantsTools => toolCalls.isNotEmpty;
}

class AiException implements Exception {
  final String message;
  final int? statusCode;
  AiException(this.message, {this.statusCode});
  @override
  String toString() => message;
}

/// Клиент Tooken Club (tooken.club) — OpenAI-совместимый шлюз к GPT,
/// Claude, DeepSeek и другим моделям.
///
/// Версия 2: вызов инструментов (function calling), автоповтор при 429/5xx,
/// кэш повторяющихся запросов и учёт токенов по каждому агенту.
class TookenClient {
  TookenClient._();
  static final TookenClient instance = TookenClient._();

  final _http = http.Client();

  /// Кэш идентичных запросов в пределах запуска приложения: один и тот же
  /// вопрос по неизменившимся данным не тратит токены дважды.
  final _cache = <String, _CacheEntry>{};

  AiSettings get _settings => AiSettingsStore.instance.current;

  /// Рабочий формат, определённый в режиме 'auto'. Живёт до перезапуска
  /// приложения, чтобы не проверять формат на каждом запросе.
  String? _detected;

  /// Формат API: openai | anthropic.
  String get _format {
    final p = _settings.provider;
    if (p == 'openai' || p == 'anthropic') return p;
    return _detected ?? 'openai';
  }

  bool get _isAnthropic => _format == 'anthropic';

  String get _base => _settings.baseUrl.replaceAll(RegExp(r'/+$'), '');

  Uri _endpoint(String path) => Uri.parse('$_base/$path');

  /// Anthropic-шлюзы ждут путь /v1/messages. Если в baseUrl уже есть /v1,
  /// второй раз его не добавляем — частая причина 404 на таких прокси.
  Uri get _messagesEndpoint => Uri.parse(
        _base.endsWith('/v1') ? '$_base/messages' : '$_base/v1/messages',
      );

  Map<String, String> get _headers => _isAnthropic
      ? {
          'Content-Type': 'application/json; charset=utf-8',
          'x-api-key': _settings.apiKey,
          'anthropic-version': '2023-06-01',
          // Часть прокси принимает и Bearer — отправляем оба заголовка,
          // лишний просто игнорируется.
          'Authorization': 'Bearer ${_settings.apiKey}',
        }
      : {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer ${_settings.apiKey}',
        };

  // ---------- КОНВЕРТАЦИЯ В ФОРМАТ ANTHROPIC ----------

  /// В Anthropic системные сообщения выносятся в отдельное поле system,
  /// а в messages остаются только user/assistant. Результаты инструментов
  /// приходят как блоки tool_result внутри user-сообщения.
  Map<String, dynamic> _anthropicBody({
    required List<AiMessage> messages,
    required String model,
    required double temperature,
    required int maxTokens,
    List<Map<String, dynamic>>? tools,
    bool stream = false,
  }) {
    final system = messages
        .where((m) => m.role == 'system')
        .map((m) => m.content)
        .where((c) => c.trim().isNotEmpty)
        .join('\n\n');

    final converted = <Map<String, dynamic>>[];
    for (final m in messages) {
      if (m.role == 'system') continue;

      if (m.role == 'tool') {
        converted.add({
          'role': 'user',
          'content': [
            {
              'type': 'tool_result',
              'tool_use_id': m.toolCallId ?? '',
              'content': m.content,
            }
          ],
        });
        continue;
      }

      if (m.role == 'assistant' && (m.toolCalls?.isNotEmpty ?? false)) {
        final blocks = <Map<String, dynamic>>[
          if (m.content.trim().isNotEmpty) {'type': 'text', 'text': m.content},
          ...m.toolCalls!.map((c) {
            final fn = (c['function'] as Map?) ?? const {};
            Map<String, dynamic> input = {};
            try {
              input = Map<String, dynamic>.from(
                  jsonDecode(fn['arguments']?.toString() ?? '{}') as Map);
            } catch (_) {}
            return {
              'type': 'tool_use',
              'id': c['id']?.toString() ?? '',
              'name': fn['name']?.toString() ?? '',
              'input': input,
            };
          }),
        ];
        converted.add({'role': 'assistant', 'content': blocks});
        continue;
      }

      converted.add({'role': m.role, 'content': m.content});
    }

    return {
      'model': model,
      'max_tokens': maxTokens,
      'temperature': temperature,
      if (system.isNotEmpty) 'system': system,
      'messages': converted,
      if (tools != null && tools.isNotEmpty)
        'tools': tools.map((t) {
          final fn = (t['function'] as Map?) ?? const {};
          return {
            'name': fn['name'],
            'description': fn['description'],
            'input_schema': fn['parameters'],
          };
        }).toList(),
      if (stream) 'stream': true,
    };
  }

  /// Ответ Anthropic приводим к той же форме, что и OpenAI, чтобы весь
  /// остальной код (агенты, инструменты, экраны) не знал о разнице.
  AiResult _parseAnthropic(Map<String, dynamic> data) {
    final content = (data['content'] as List?) ?? const [];
    final text = content
        .where((b) => (b as Map)['type'] == 'text')
        .map((b) => (b as Map)['text']?.toString() ?? '')
        .join('\n')
        .trim();

    final toolCalls = content
        .where((b) => (b as Map)['type'] == 'tool_use')
        .map((b) => {
              'id': (b as Map)['id']?.toString() ?? '',
              'type': 'function',
              'function': {
                'name': b['name']?.toString() ?? '',
                'arguments': jsonEncode(b['input'] ?? {}),
              },
            })
        .toList();

    final usage = (data['usage'] as Map?) ?? const {};
    return AiResult(
      text,
      promptTokens: (usage['input_tokens'] as num?)?.toInt() ?? 0,
      completionTokens: (usage['output_tokens'] as num?)?.toInt() ?? 0,
      toolCalls: toolCalls,
    );
  }

  // ---------- БАЗОВЫЙ ЗАПРОС ----------

  Future<AiResult> complete({
    required List<AiMessage> messages,
    String? model,
    double? temperature,
    int? maxTokens,
    bool jsonMode = false,
    List<Map<String, dynamic>>? tools,
    String agentId = 'generic',
    Duration timeout = const Duration(seconds: 60),
    Duration? cacheFor,
  }) async {
    final s = _settings;
    if (!s.isReady) {
      throw AiException('ИИ не настроен: укажите ключ tooken.club в «Админ → Настройки ИИ».');
    }

    final body = _isAnthropic
        ? _anthropicBody(
            messages: messages,
            model: model ?? s.model,
            temperature: temperature ?? s.temperature,
            maxTokens: maxTokens ?? s.maxTokens,
            tools: tools,
          )
        : <String, dynamic>{
            'model': model ?? s.model,
            'messages': messages.map((m) => m.toJson()).toList(),
            'temperature': temperature ?? s.temperature,
            'max_tokens': maxTokens ?? s.maxTokens,
            if (jsonMode) 'response_format': {'type': 'json_object'},
            if (tools != null && tools.isNotEmpty) 'tools': tools,
            if (tools != null && tools.isNotEmpty) 'tool_choice': 'auto',
          };

    final cacheKey = cacheFor == null ? null : jsonEncode(body);
    if (cacheKey != null) {
      final hit = _cache[cacheKey];
      if (hit != null && DateTime.now().isBefore(hit.expiresAt)) return hit.result;
    }

    final payload = jsonEncode(body);
    AiException? lastError;

    // Три попытки: шлюз и мобильная сеть иногда моргают, и показывать
    // кассиру ошибку из-за одной неудачной попытки не стоит.
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final resp = await _http
            .post(_isAnthropic ? _messagesEndpoint : _endpoint('chat/completions'),
                headers: _headers, body: payload)
            .timeout(timeout);

        // Режим 'auto': шлюз не понял OpenAI-формат — значит он Anthropic.
        // Переключаемся один раз и повторяем запрос уже правильно.
        if (_settings.provider == 'auto' &&
            _detected == null &&
            !_isAnthropic &&
            (resp.statusCode == 404 || resp.statusCode == 400 || resp.statusCode == 405)) {
          _detected = 'anthropic';
          // await обязателен: без него ошибка повторного запроса улетает
          // мимо catch-веток этого же цикла и приходит вызывающему как
          // необработанный Future, а не как понятный AiException.
          return await complete(
            messages: messages,
            model: model,
            temperature: temperature,
            maxTokens: maxTokens,
            jsonMode: jsonMode,
            tools: tools,
            agentId: agentId,
            timeout: timeout,
          );
        }

        if (resp.statusCode == 401 || resp.statusCode == 403) {
          throw AiException(
              'Ключ tooken.club отклонён (${resp.statusCode}). Проверьте ключ и баланс.',
              statusCode: resp.statusCode);
        }
        if (resp.statusCode == 429 || resp.statusCode >= 500) {
          lastError = AiException(
            resp.statusCode == 429
                ? 'Лимит запросов или баланс tooken.club исчерпан.'
                : 'Шлюз tooken.club недоступен (${resp.statusCode}).',
            statusCode: resp.statusCode,
          );
          await Future.delayed(Duration(milliseconds: 600 * (attempt + 1)));
          continue;
        }
        if (resp.statusCode >= 400) {
          final b = utf8.decode(resp.bodyBytes);
          throw AiException(
              'Ошибка ИИ ${resp.statusCode}: ${b.length > 300 ? b.substring(0, 300) : b}',
              statusCode: resp.statusCode);
        }

        final data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;

        late final AiResult result;
        if (_isAnthropic) {
          result = _parseAnthropic(data);
          if (_settings.provider == 'auto') _detected = 'anthropic';
        } else {
          final choices = (data['choices'] as List?) ?? const [];
          if (choices.isEmpty) throw AiException('Пустой ответ ИИ');
          final message = (choices.first['message'] as Map?) ?? const {};
          final usage = (data['usage'] as Map?) ?? const {};
          result = AiResult(
            (message['content'] as String?)?.trim() ?? '',
            promptTokens: (usage['prompt_tokens'] as num?)?.toInt() ?? 0,
            completionTokens: (usage['completion_tokens'] as num?)?.toInt() ?? 0,
            toolCalls: ((message['tool_calls'] as List?) ?? const [])
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList(),
          );
          if (_settings.provider == 'auto') _detected = 'openai';
        }

        if (cacheKey != null) {
          _cache[cacheKey] = _CacheEntry(result, DateTime.now().add(cacheFor!));
        }
        unawaited(_log(agentId, model ?? s.model, result));
        return result;
      } on TimeoutException {
        lastError = AiException('ИИ не ответил за ${timeout.inSeconds} c.');
      } on AiException {
        rethrow;
      } catch (e) {
        lastError = AiException('Нет связи с tooken.club: $e');
      }
    }
    throw lastError ?? AiException('Не удалось получить ответ ИИ');
  }

  // ---------- ЦИКЛ ИНСТРУМЕНТОВ ----------

  /// Диалог с инструментами: модель может несколько раз запросить данные
  /// (остатки, чек, брони) или выполнить действие, прежде чем ответить.
  ///
  /// [executor] решает, что агенту разрешено делать — см. AiToolRegistry.
  /// [maxRounds] не даёт агенту зациклиться и съесть баланс токенов.
  /// Запрос с инструментами и безопасным запасным путём.
  ///
  /// Часть шлюзов (особенно Claude-прокси) не поддерживает function calling
  /// и отвечает ошибкой на поле tools. Раньше это выглядело как «Консьерж
  /// сейчас недоступен». Теперь при такой ошибке повторяем запрос без
  /// инструментов: агент ответит по данным, которые уже лежат в промпте.
  Future<AiToolRunResult> completeWithTools({
    required List<AiMessage> messages,
    required List<Map<String, dynamic>> tools,
    required Future<String> Function(String name, Map<String, dynamic> args) executor,
    String? model,
    String agentId = 'generic',
    int maxRounds = 4,
    int? maxTokens,
  }) async {
    try {
      return await _completeWithToolsRaw(
        messages: messages,
        tools: tools,
        executor: executor,
        model: model,
        agentId: agentId,
        maxRounds: maxRounds,
        maxTokens: maxTokens,
      );
    } catch (_) {
      final res = await complete(
        messages: messages,
        model: model,
        agentId: agentId,
        maxTokens: maxTokens,
      );
      return AiToolRunResult(res.text, totalTokens: res.totalTokens);
    }
  }

  Future<AiToolRunResult> _completeWithToolsRaw({
    required List<AiMessage> messages,
    required List<Map<String, dynamic>> tools,
    required Future<String> Function(String name, Map<String, dynamic> args) executor,
    String? model,
    String agentId = 'generic',
    int maxRounds = 4,
    int? maxTokens,
  }) async {
    final history = List<AiMessage>.from(messages);
    final trace = <AiToolCallTrace>[];
    var tokens = 0;

    for (var round = 0; round < maxRounds; round++) {
      final res = await complete(
        messages: history,
        tools: tools,
        model: model,
        agentId: agentId,
        maxTokens: maxTokens,
      );
      tokens += res.totalTokens;

      if (!res.wantsTools) {
        return AiToolRunResult(res.text, trace: trace, totalTokens: tokens);
      }

      history.add(AiMessage('assistant', res.text, toolCalls: res.toolCalls));

      for (final call in res.toolCalls) {
        final fn = (call['function'] as Map?) ?? const {};
        final name = fn['name']?.toString() ?? '';
        var args = <String, dynamic>{};
        try {
          final raw = fn['arguments']?.toString() ?? '{}';
          args = Map<String, dynamic>.from(jsonDecode(raw.isEmpty ? '{}' : raw) as Map);
        } catch (_) {}

        String output;
        try {
          output = await executor(name, args);
        } catch (e) {
          output = 'Ошибка инструмента: $e';
        }
        trace.add(AiToolCallTrace(name, args, output));
        history.add(AiMessage.tool(output, call['id']?.toString() ?? name));
      }
    }

    // Круги кончились — просим итоговый ответ уже без инструментов.
    final fallback = await complete(
      messages: history +
          const [AiMessage.user('Сформулируй итоговый ответ без вызова инструментов.')],
      model: model,
      agentId: agentId,
    );
    return AiToolRunResult(fallback.text,
        trace: trace, totalTokens: tokens + fallback.totalTokens);
  }

  // ---------- ПОТОК ----------

  Stream<String> stream({
    required List<AiMessage> messages,
    String? model,
    double? temperature,
    int? maxTokens,
    String agentId = 'generic',
  }) async* {
    final s = _settings;
    if (!s.isReady) throw AiException('ИИ не настроен: укажите ключ tooken.club.');

    final request =
        http.Request('POST', _isAnthropic ? _messagesEndpoint : _endpoint('chat/completions'))
          ..headers.addAll(_headers)
          ..body = jsonEncode(
            _isAnthropic
                ? _anthropicBody(
                    messages: messages,
                    model: model ?? s.model,
                    temperature: temperature ?? s.temperature,
                    maxTokens: maxTokens ?? s.maxTokens,
                    stream: true,
                  )
                : {
                    'model': model ?? s.model,
                    'messages': messages.map((m) => m.toJson()).toList(),
                    'temperature': temperature ?? s.temperature,
                    'max_tokens': maxTokens ?? s.maxTokens,
                    'stream': true,
                  },
          );

    final resp = await _http.send(request);
    if (resp.statusCode >= 400) {
      throw AiException('Ошибка ИИ ${resp.statusCode}: ${await resp.stream.bytesToString()}',
          statusCode: resp.statusCode);
    }

    await for (final chunk
        in resp.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      if (!chunk.startsWith('data:')) continue;
      final payload = chunk.substring(5).trim();
      if (payload.isEmpty || payload == '[DONE]') continue;
      try {
        final data = jsonDecode(payload) as Map<String, dynamic>;
        if (_isAnthropic) {
          // У Anthropic текст приходит событиями content_block_delta.
          final delta = data['delta'] as Map?;
          final piece = delta?['text'] as String?;
          if (piece != null && piece.isNotEmpty) yield piece;
        } else {
          final delta = ((data['choices'] as List?)?.first as Map?)?['delta'] as Map?;
          final piece = delta?['content'] as String?;
          if (piece != null && piece.isNotEmpty) yield piece;
        }
      } catch (_) {}
    }
  }

  // ---------- JSON ----------

  Future<Map<String, dynamic>> completeJson({
    required List<AiMessage> messages,
    String? model,
    String agentId = 'generic',
    int? maxTokens,
    Duration? cacheFor,
  }) async {
    final res = await complete(
      messages: _isAnthropic
          ? [
              const AiMessage.system(
                  'Отвечай СТРОГО одним JSON-объектом, без пояснений и без markdown.'),
              ...messages,
            ]
          : messages,
      model: model,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: maxTokens,
      agentId: agentId,
      cacheFor: cacheFor,
    );
    var text = res.text.trim();
    // Anthropic не поддерживает response_format, поэтому JSON приходит
    // как обычный текст, иногда в блоке ``` — снимаем обёртку.
    if (text.startsWith('```')) {
      text = text.replaceFirst(RegExp(r'^```[a-zA-Z]*\s*'), '').replaceFirst(RegExp(r'```$'), '');
    }
    try {
      return Map<String, dynamic>.from(jsonDecode(text) as Map);
    } catch (_) {
      throw AiException('ИИ вернул не JSON: ${text.substring(0, text.length.clamp(0, 200))}');
    }
  }

  // ---------- СЕРВИС ----------

  Future<List<String>> listModels() async {
    if (_settings.apiKey.isEmpty) return const [];
    if (_isAnthropic) {
      // У Anthropic-шлюзов список моделей обычно недоступен — отдаём
      // актуальные имена, чтобы админ выбрал из списка, а не печатал.
      return const [
        'claude-sonnet-4-5',
        'claude-opus-4-1',
        'claude-3-5-haiku-latest',
        'claude-3-5-sonnet-latest',
      ];
    }
    final resp = await _http.get(_endpoint('models'), headers: _headers);
    if (resp.statusCode >= 400) return const [];
    final data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    return ((data['data'] as List?) ?? const [])
        .map((e) => (e as Map)['id']?.toString() ?? '')
        .where((e) => e.isNotEmpty)
        .toList()
      ..sort();
  }

  Future<String> ping() async {
    final res = await complete(
      messages: const [
        AiMessage.system('Ответь ровно одним словом: OK'),
        AiMessage.user('Проверка связи'),
      ],
      maxTokens: 10,
      agentId: 'ping',
    );
    return res.text;
  }

  void clearCache() => _cache.clear();

  Future<void> _log(String agentId, String model, AiResult res) async {
    try {
      await AppScope.col('aiLogs').add({
        'agentId': agentId,
        'model': model,
        'promptTokens': res.promptTokens,
        'completionTokens': res.completionTokens,
        'totalTokens': res.totalTokens,
        'createdAt': Timestamp.fromDate(DateTime.now()),
      });
    } catch (_) {}
  }
}

class _CacheEntry {
  final AiResult result;
  final DateTime expiresAt;
  _CacheEntry(this.result, this.expiresAt);
}

class AiToolCallTrace {
  final String name;
  final Map<String, dynamic> args;
  final String output;
  AiToolCallTrace(this.name, this.args, this.output);
}

class AiToolRunResult {
  final String text;
  final List<AiToolCallTrace> trace;
  final int totalTokens;
  AiToolRunResult(this.text, {this.trace = const [], this.totalTokens = 0});
}
