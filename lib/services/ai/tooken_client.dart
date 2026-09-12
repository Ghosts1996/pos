import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
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
  final _db = FirebaseFirestore.instance;

  /// Кэш идентичных запросов в пределах запуска приложения: один и тот же
  /// вопрос по неизменившимся данным не тратит токены дважды.
  final _cache = <String, _CacheEntry>{};

  AiSettings get _settings => AiSettingsStore.instance.current;

  Uri _endpoint(String path) =>
      Uri.parse('${_settings.baseUrl.replaceAll(RegExp(r'/+$'), '')}/$path');

  Map<String, String> get _headers => {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ${_settings.apiKey}',
      };

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

    final body = <String, dynamic>{
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
            .post(_endpoint('chat/completions'), headers: _headers, body: payload)
            .timeout(timeout);

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
        final choices = (data['choices'] as List?) ?? const [];
        if (choices.isEmpty) throw AiException('Пустой ответ ИИ');

        final message = (choices.first['message'] as Map?) ?? const {};
        final usage = (data['usage'] as Map?) ?? const {};
        final result = AiResult(
          (message['content'] as String?)?.trim() ?? '',
          promptTokens: (usage['prompt_tokens'] as num?)?.toInt() ?? 0,
          completionTokens: (usage['completion_tokens'] as num?)?.toInt() ?? 0,
          toolCalls: ((message['tool_calls'] as List?) ?? const [])
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList(),
        );

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
  Future<AiToolRunResult> completeWithTools({
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

    final request = http.Request('POST', _endpoint('chat/completions'))
      ..headers.addAll(_headers)
      ..body = jsonEncode({
        'model': model ?? s.model,
        'messages': messages.map((m) => m.toJson()).toList(),
        'temperature': temperature ?? s.temperature,
        'max_tokens': maxTokens ?? s.maxTokens,
        'stream': true,
      });

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
        final delta = ((data['choices'] as List?)?.first as Map?)?['delta'] as Map?;
        final piece = delta?['content'] as String?;
        if (piece != null && piece.isNotEmpty) yield piece;
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
      messages: messages,
      model: model,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: maxTokens,
      agentId: agentId,
      cacheFor: cacheFor,
    );
    var text = res.text.trim();
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
      await _db.collection('aiLogs').add({
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
