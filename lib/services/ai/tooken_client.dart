import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
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

  /// Отказал сервер платформы (ИИ выключен, нет доступа, лимит гостя) —
  /// резервный провайдер тут не поможет.
  final bool fromGateway;
  AiException(this.message, {this.statusCode, this.fromGateway = false});
  @override
  String toString() => message;
}

/// Клиент ИИ: Tooken Club, DarkAPI, Google Gemini или свой шлюз — все
/// через OpenAI-совместимый API (или Anthropic для Claude-шлюзов).
/// Имя класса историческое (сначала был только tooken.club).
///
/// Вызов инструментов (function calling), автоповтор при 429/5xx, кэш
/// повторяющихся запросов, учёт токенов по каждому агенту и резервный
/// провайдер: при любом сбое основного запрос повторяется через него.
class TookenClient {
  TookenClient._();
  static final TookenClient instance = TookenClient._();

  final _http = http.Client();

  /// Кэш идентичных запросов в пределах запуска приложения: один и тот же
  /// вопрос по неизменившимся данным не тратит токены дважды.
  final _cache = <String, _CacheEntry>{};

  AiSettings get _settings => AiSettingsStore.instance.current;

  /// Формат, определённый в режиме 'auto' — по каждому провайдеру
  /// отдельно; живёт до перезапуска приложения.
  final _detected = <String, String>{};

  /// Гостевое приложение в SaaS-режиме ключей не видит (они в
  /// meta/aiSecrets, доступном только персоналу) и ходит к ИИ через
  /// saas-gateway: сервер сам подставляет ключ заведения и следит за
  /// лимитом запросов гостя.
  String? _proxyUrl;
  void useGatewayProxy(String gatewayUrl) {
    _proxyUrl = gatewayUrl.replaceAll(RegExp(r'/+$'), '');
  }

  bool get _viaProxy => (_proxyUrl ?? '').isNotEmpty;

  String _detectKey(AiEndpoint ep) => '${ep.slot}|${ep.vendor.id}|${ep.baseUrl}';

  String _formatOf(AiEndpoint ep) {
    if (ep.format == 'openai' || ep.format == 'anthropic') return ep.format;
    return _detected[_detectKey(ep)] ?? 'openai';
  }

  /// Путь запроса относительно адреса API. Anthropic-шлюзы ждут
  /// /v1/messages: если в адресе уже есть /v1, второй раз его не добавляем
  /// — частая причина 404 на таких прокси.
  String _chatPath(AiEndpoint ep) {
    if (_formatOf(ep) != 'anthropic') return 'chat/completions';
    return ep.baseUrl.endsWith('/v1') ? 'messages' : 'v1/messages';
  }

  Map<String, String> _headersFor(AiEndpoint ep) => _formatOf(ep) == 'anthropic'
      ? {
          'Content-Type': 'application/json; charset=utf-8',
          'x-api-key': ep.apiKey,
          'anthropic-version': '2023-06-01',
          // Часть прокси принимает и Bearer — отправляем оба заголовка,
          // лишний просто игнорируется.
          'Authorization': 'Bearer ${ep.apiKey}',
        }
      : {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer ${ep.apiKey}',
        };

  Future<http.Response> _post(AiEndpoint ep, String path, Map<String, dynamic> body, Duration timeout) async {
    if (_viaProxy) {
      final token = await FirebaseAuth.instance.currentUser?.getIdToken();
      return _http
          .post(
            Uri.parse('$_proxyUrl/aiProxy'),
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              if (token != null) 'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'tenantId': AppScope.tenantId,
              'slot': ep.slot,
              'format': _formatOf(ep),
              'path': path,
              'body': body,
            }),
          )
          .timeout(timeout);
    }
    return _http
        .post(Uri.parse('${ep.baseUrl}/$path'), headers: _headersFor(ep), body: jsonEncode(body))
        .timeout(timeout);
  }

  /// Отказ самого saas-gateway (ИИ выключен, нет доступа, лимит гостя), а
  /// не провайдера — такой ответ не повод менять формат или провайдера.
  bool _isGatewayError(http.Response resp) =>
      _viaProxy && resp.statusCode >= 400 && utf8.decode(resp.bodyBytes, allowMalformed: true).contains('"gateway":true');

  /// Понятная ошибка по ответу провайдера или saas-gateway.
  AiException _errorFor(AiEndpoint ep, http.Response resp) {
    final body = utf8.decode(resp.bodyBytes, allowMalformed: true);
    Map<String, dynamic>? json;
    try {
      json = jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {}
    if (json != null && json['gateway'] == true) {
      return AiException(json['error']?.toString() ?? 'Сервер платформы отклонил запрос к ИИ',
          statusCode: resp.statusCode, fromGateway: true);
    }
    final name = ep.vendor.title;
    if (body.contains('location is not supported') || body.contains('User location')) {
      return AiException(
          '$name недоступен из вашего региона (Google не пускает к Gemini API из России). '
          'Укажите прокси в поле «Адрес API» или выберите резервный провайдер.',
          statusCode: resp.statusCode);
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      return AiException('$name: ключ отклонён (${resp.statusCode}). Проверьте ключ и баланс.',
          statusCode: resp.statusCode);
    }
    if (resp.statusCode == 402) {
      return AiException('$name: закончился баланс — пополните его в кабинете провайдера.',
          statusCode: resp.statusCode);
    }
    if (resp.statusCode == 404) {
      return AiException('$name: адрес API или модель не найдены (404). Проверьте «Адрес API» и имя модели.',
          statusCode: resp.statusCode);
    }
    if (resp.statusCode == 429) {
      return AiException('$name: лимит запросов или баланс исчерпан.', statusCode: resp.statusCode);
    }
    if (resp.statusCode >= 500) {
      return AiException('$name временно недоступен (${resp.statusCode}).', statusCode: resp.statusCode);
    }
    return AiException('$name: ошибка ${resp.statusCode}: ${body.length > 300 ? body.substring(0, 300) : body}',
        statusCode: resp.statusCode);
  }

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

  /// Провайдеры по порядку: основной и (если задан) резервный.
  List<AiEndpoint> _endpoints() {
    final s = _settings;
    return [s.primary, if (s.fallback != null) s.fallback!];
  }

  /// Агенты просят «модель по умолчанию» или «модель аналитики» основного
  /// провайдера — у резервного берём его соответствующую модель, а не имя
  /// чужой модели, которой у него может не быть.
  String _modelOn(AiEndpoint ep, String? requested) {
    final p = _settings.primary;
    if (requested == null || requested.isEmpty) return ep.model;
    if (ep.slot == 'primary') return requested;
    if (requested == p.analyticsModel) return ep.analyticsModel;
    if (requested == p.model) return ep.model;
    return ep.model;
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
    if (!_settings.isReady) {
      throw AiException('ИИ не настроен: выберите провайдера и укажите ключ в «Админ → Настройки ИИ».');
    }
    final eps = _endpoints();
    AiException? primaryError;
    for (var i = 0; i < eps.length; i++) {
      final ep = eps[i];
      try {
        return await completeOn(
          ep,
          messages: messages,
          model: _modelOn(ep, model),
          temperature: temperature,
          maxTokens: maxTokens,
          jsonMode: jsonMode,
          tools: tools,
          agentId: agentId,
          timeout: timeout,
          cacheFor: cacheFor,
        );
      } on AiException catch (e) {
        if (e.fromGateway) rethrow;
        if (i == eps.length - 1) {
          if (primaryError != null) {
            throw AiException('Основной провайдер (${eps.first.vendor.title}): ${primaryError.message} '
                'Резервный (${ep.vendor.title}): ${e.message}',
                statusCode: e.statusCode);
          }
          rethrow;
        }
        primaryError = e; // пробуем резервного провайдера
      }
    }
    throw AiException('Не удалось получить ответ ИИ');
  }

  /// Запрос к конкретному провайдеру — без перехода на резервный (им же
  /// пользуются «Проверить связь» в настройках).
  Future<AiResult> completeOn(
    AiEndpoint ep, {
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
    final isAnthropic = _formatOf(ep) == 'anthropic';
    final useModel = (model == null || model.isEmpty) ? ep.model : model;
    final body = isAnthropic
        ? _anthropicBody(
            messages: messages,
            model: useModel,
            temperature: temperature ?? s.temperature,
            maxTokens: maxTokens ?? s.maxTokens,
            tools: tools,
          )
        : <String, dynamic>{
            'model': useModel,
            'messages': messages.map((m) => m.toJson()).toList(),
            'temperature': temperature ?? s.temperature,
            'max_tokens': maxTokens ?? s.maxTokens,
            if (jsonMode) 'response_format': {'type': 'json_object'},
            if (tools != null && tools.isNotEmpty) 'tools': tools,
            if (tools != null && tools.isNotEmpty) 'tool_choice': 'auto',
          };

    final cacheKey = cacheFor == null ? null : '${ep.vendor.id}|${jsonEncode(body)}';
    if (cacheKey != null) {
      final hit = _cache[cacheKey];
      if (hit != null && DateTime.now().isBefore(hit.expiresAt)) return hit.result;
    }

    AiException? lastError;

    // Три попытки: шлюз и мобильная сеть иногда моргают, и показывать
    // кассиру ошибку из-за одной неудачной попытки не стоит.
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        final resp = await _post(ep, _chatPath(ep), body, timeout);

        // Режим 'auto': шлюз не понял OpenAI-формат — значит он Anthropic.
        // Переключаемся один раз и повторяем запрос уже правильно.
        if (ep.format == 'auto' &&
            !_detected.containsKey(_detectKey(ep)) &&
            !isAnthropic &&
            !_isGatewayError(resp) &&
            (resp.statusCode == 404 || resp.statusCode == 400 || resp.statusCode == 405)) {
          _detected[_detectKey(ep)] = 'anthropic';
          // await обязателен: без него ошибка повторного запроса улетает
          // мимо catch-веток этого же цикла.
          return await completeOn(
            ep,
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

        if (resp.statusCode == 429 || resp.statusCode >= 500) {
          lastError = _errorFor(ep, resp);
          // Лимит сервера платформы на гостя повторять бессмысленно.
          if (_viaProxy && resp.statusCode == 429) throw lastError;
          await Future.delayed(Duration(milliseconds: 600 * (attempt + 1)));
          continue;
        }
        if (resp.statusCode >= 400) throw _errorFor(ep, resp);

        final data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;

        late final AiResult result;
        if (isAnthropic) {
          result = _parseAnthropic(data);
          if (ep.format == 'auto') _detected[_detectKey(ep)] = 'anthropic';
        } else {
          final choices = (data['choices'] as List?) ?? const [];
          if (choices.isEmpty) throw AiException('${ep.vendor.title}: пустой ответ');
          final choice = (choices.first as Map?) ?? const {};
          final message = (choice['message'] as Map?) ?? const {};
          final usage = (data['usage'] as Map?) ?? const {};
          result = AiResult(
            (message['content'] as String?)?.trim() ?? '',
            promptTokens: (usage['prompt_tokens'] as num?)?.toInt() ?? 0,
            completionTokens: (usage['completion_tokens'] as num?)?.toInt() ?? 0,
            toolCalls: ((message['tool_calls'] as List?) ?? const [])
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList(),
          );
          // «Думающие» модели (Gemini, DeepSeek-reasoner) тратят лимит
          // ответа на размышления — при маленьком лимите текст пустой.
          if (result.text.isEmpty && !result.wantsTools && choice['finish_reason'] == 'length') {
            throw AiException('${ep.vendor.title}: модель израсходовала лимит ответа на размышления — '
                'увеличьте «Лимит ответа» в настройках ИИ.');
          }
          if (ep.format == 'auto') _detected[_detectKey(ep)] = 'openai';
        }

        if (cacheKey != null) {
          _cache[cacheKey] = _CacheEntry(result, DateTime.now().add(cacheFor!));
        }
        unawaited(_log(agentId, ep, useModel, result));
        return result;
      } on TimeoutException {
        lastError = AiException('${ep.vendor.title} не ответил за ${timeout.inSeconds} c.');
      } on AiException {
        rethrow;
      } catch (e) {
        lastError = AiException('Нет связи с ${_viaProxy ? 'сервером платформы' : ep.vendor.title}: $e');
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
  ///
  /// Часть шлюзов (особенно Claude-прокси) не поддерживает function calling
  /// и отвечает ошибкой на поле tools. Тогда повторяем запрос без
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
    if (!_settings.isReady) {
      throw AiException('ИИ не настроен: выберите провайдера и укажите ключ в «Админ → Настройки ИИ».');
    }
    // Через сервер платформы — без потока, целым ответом.
    if (_viaProxy) {
      final res = await complete(messages: messages, model: model, temperature: temperature, maxTokens: maxTokens, agentId: agentId);
      if (res.text.isNotEmpty) yield res.text;
      return;
    }
    final eps = _endpoints();
    for (var i = 0; i < eps.length; i++) {
      final ep = eps[i];
      var yielded = false;
      try {
        await for (final piece in _streamOn(ep,
            messages: messages, model: _modelOn(ep, model), temperature: temperature, maxTokens: maxTokens)) {
          yielded = true;
          yield piece;
        }
        return;
      } catch (e) {
        // Резервный провайдер — только если основной не успел ничего
        // напечатать, иначе ответ склеился бы из двух разных.
        if (yielded || i == eps.length - 1) rethrow;
      }
    }
  }

  Stream<String> _streamOn(
    AiEndpoint ep, {
    required List<AiMessage> messages,
    String? model,
    double? temperature,
    int? maxTokens,
  }) async* {
    final s = _settings;
    final isAnthropic = _formatOf(ep) == 'anthropic';
    final request = http.Request('POST', Uri.parse('${ep.baseUrl}/${_chatPath(ep)}'))
      ..headers.addAll(_headersFor(ep))
      ..body = jsonEncode(
        isAnthropic
            ? _anthropicBody(
                messages: messages,
                model: model ?? ep.model,
                temperature: temperature ?? s.temperature,
                maxTokens: maxTokens ?? s.maxTokens,
                stream: true,
              )
            : {
                'model': model ?? ep.model,
                'messages': messages.map((m) => m.toJson()).toList(),
                'temperature': temperature ?? s.temperature,
                'max_tokens': maxTokens ?? s.maxTokens,
                'stream': true,
              },
      );

    final resp = await _http.send(request);
    if (resp.statusCode >= 400) {
      final bytes = await resp.stream.toBytes();
      throw _errorFor(ep, http.Response.bytes(bytes, resp.statusCode));
    }

    await for (final chunk
        in resp.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      if (!chunk.startsWith('data:')) continue;
      final payload = chunk.substring(5).trim();
      if (payload.isEmpty || payload == '[DONE]') continue;
      try {
        final data = jsonDecode(payload) as Map<String, dynamic>;
        if (isAnthropic) {
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
    // Инструкцию «строго JSON» добавляем всегда: Anthropic не знает
    // response_format, а часть OpenAI-совместимых шлюзов его молча
    // игнорирует — без неё модель могла ответить текстом.
    final res = await complete(
      messages: [
        const AiMessage.system('Отвечай СТРОГО одним JSON-объектом, без пояснений и без markdown.'),
        ...messages,
      ],
      model: model,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: maxTokens,
      agentId: agentId,
      cacheFor: cacheFor,
    );
    var text = res.text.trim();
    // JSON иногда приходит в блоке ``` — снимаем обёртку.
    if (text.startsWith('```')) {
      text = text.replaceFirst(RegExp(r'^```[a-zA-Z]*\s*'), '').replaceFirst(RegExp(r'```$'), '').trim();
    }
    try {
      return Map<String, dynamic>.from(jsonDecode(text) as Map);
    } catch (_) {
      throw AiException('ИИ вернул не JSON: ${text.substring(0, text.length.clamp(0, 200))}');
    }
  }

  // ---------- СЕРВИС ----------

  /// Список моделей провайдера (по умолчанию — основного). Для экрана
  /// настроек: можно передать ещё не сохранённый [endpoint].
  Future<List<String>> listModels({AiEndpoint? endpoint}) async {
    final ep = endpoint ?? _settings.primary;
    if (ep.apiKey.isEmpty) return const [];
    if (_formatOf(ep) == 'anthropic') {
      // У Anthropic-шлюзов список моделей обычно недоступен — отдаём
      // актуальные имена, чтобы админ выбрал из списка, а не печатал.
      return const [
        'claude-sonnet-4-5',
        'claude-opus-4-1',
        'claude-3-5-haiku-latest',
        'claude-3-5-sonnet-latest',
      ];
    }
    final resp = await _http.get(Uri.parse('${ep.baseUrl}/models'), headers: _headersFor(ep));
    if (resp.statusCode >= 400) throw _errorFor(ep, resp);
    final data = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    return ((data['data'] as List?) ?? const [])
        .map((e) => (e as Map)['id']?.toString() ?? '')
        // Gemini отдаёт id вида «models/gemini-…» и заодно модели для
        // эмбеддингов, картинок, видео и речи — для чата они не годятся.
        .map((id) => id.startsWith('models/') ? id.substring(7) : id)
        .where((id) => id.isNotEmpty &&
            !RegExp(r'embed|imagen|veo|tts|aqa|image-generation|live', caseSensitive: false).hasMatch(id))
        .toSet()
        .toList()
      ..sort();
  }

  /// Проверка связи: основной провайдер или переданный [endpoint]. Лимит
  /// с запасом — «думающим» моделям нужно место на размышления.
  Future<String> ping({AiEndpoint? endpoint}) async {
    final res = await completeOn(
      endpoint ?? _settings.primary,
      messages: const [
        AiMessage.system('Ответь ровно одним словом: OK'),
        AiMessage.user('Проверка связи'),
      ],
      maxTokens: 256,
      agentId: 'ping',
      timeout: const Duration(seconds: 30),
    );
    return res.text.isEmpty ? 'OK' : res.text;
  }

  void clearCache() => _cache.clear();

  Future<void> _log(String agentId, AiEndpoint ep, String model, AiResult res) async {
    try {
      await AppScope.col('aiLogs').add({
        'agentId': agentId,
        'vendor': ep.vendor.id,
        'slot': ep.slot,
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
