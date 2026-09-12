import 'package:flutter/material.dart';
import '../services/ai/ai_agents.dart';
import '../services/ai/ai_settings.dart';
import '../services/ai/tooken_client.dart';
import '../theme/app_colors.dart';

/// Универсальная панель диалога с ИИ-агентом.
///
/// Одна и та же панель используется везде в POS: зал, стол, меню, склад,
/// отчёты, брони. Разница — агент и стартовый контекст, которые передаются
/// снаружи. Ответ печатается потоком (SSE), поэтому первые слова видны
/// почти сразу и сотрудник не ждёт «крутилку».
class AiAssistantSheet extends StatefulWidget {
  final AiAgent agent;

  /// Данные, которые агент получит в system-сообщении (срез зала, чек,
  /// склад и т.д.). Собирается на вызывающем экране — он лучше знает контекст.
  final String Function()? contextBuilder;

  /// Асинхронный сбор контекста, если нужны запросы в Firestore.
  final Future<String> Function()? asyncContextBuilder;

  /// Быстрые кнопки-подсказки над полем ввода.
  final List<String> quickPrompts;

  /// Автоматически отправить этот вопрос при открытии панели.
  final String? initialQuestion;

  const AiAssistantSheet({
    super.key,
    required this.agent,
    this.contextBuilder,
    this.asyncContextBuilder,
    this.quickPrompts = const [],
    this.initialQuestion,
  });

  /// Удобный вызов: `AiAssistantSheet.show(context, agent: AiAgents.hall)`.
  static Future<void> show(
    BuildContext context, {
    required AiAgent agent,
    String Function()? contextBuilder,
    Future<String> Function()? asyncContextBuilder,
    List<String> quickPrompts = const [],
    String? initialQuestion,
  }) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: FractionallySizedBox(
          heightFactor: 0.88,
          child: AiAssistantSheet(
            agent: agent,
            contextBuilder: contextBuilder,
            asyncContextBuilder: asyncContextBuilder,
            quickPrompts: quickPrompts,
            initialQuestion: initialQuestion,
          ),
        ),
      ),
    );
  }

  @override
  State<AiAssistantSheet> createState() => _AiAssistantSheetState();
}

class _ChatLine {
  final bool mine;
  String text;
  _ChatLine(this.mine, this.text);
}

class _AiAssistantSheetState extends State<AiAssistantSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _lines = <_ChatLine>[];
  final _history = <AiMessage>[];

  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.initialQuestion != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _send(widget.initialQuestion!));
    }
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<String> _buildContext() async {
    if (widget.asyncContextBuilder != null) return widget.asyncContextBuilder!();
    if (widget.contextBuilder != null) return widget.contextBuilder!();
    return '';
  }

  Future<void> _send(String text) async {
    final question = text.trim();
    if (question.isEmpty || _busy) return;

    setState(() {
      _error = null;
      _busy = true;
      _lines.add(_ChatLine(true, question));
      _lines.add(_ChatLine(false, ''));
      _input.clear();
    });
    _scrollToEnd();

    final reply = _lines.last;
    try {
      final ctx = await _buildContext();
      final stream = AiService.instance.askStream(
        widget.agent,
        question,
        extraContext: ctx,
        history: List.of(_history),
      );
      await for (final piece in stream) {
        if (!mounted) return;
        setState(() => reply.text += piece);
        _scrollToEnd();
      }
      _history
        ..add(AiMessage.user(question))
        ..add(AiMessage.assistant(reply.text));
      // Храним только последние 6 реплик — длинная история дорого стоит
      // в токенах и редко нужна.
      while (_history.length > 6) {
        _history.removeAt(0);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is AiException ? e.message : e.toString();
          if (reply.text.isEmpty) _lines.remove(reply);
        });
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final ready = AiSettingsStore.instance.current.isReady;

    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
        children: [
          _header(),
          if (!ready) _notConfigured(),
          Expanded(
            child: _lines.isEmpty
                ? _emptyState()
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                    itemCount: _lines.length,
                    itemBuilder: (_, i) => _bubble(_lines[i]),
                  ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 13)),
            ),
          if (widget.quickPrompts.isNotEmpty) _quickPrompts(),
          _inputBar(ready),
        ],
      ),
    );
  }

  Widget _header() => Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 8, 14),
        decoration: const BoxDecoration(
          color: AppColors.surfaceElevated,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: Row(
          children: [
            const CircleAvatar(
              radius: 16,
              backgroundColor: AppColors.primary,
              child: Icon(Icons.auto_awesome, size: 18, color: Colors.white),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.agent.title,
                      style: const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w600)),
                  Text(widget.agent.description,
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                ],
              ),
            ),
            IconButton(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close, color: AppColors.textMuted),
            ),
          ],
        ),
      );

  Widget _notConfigured() => Container(
        width: double.infinity,
        color: AppColors.warning.withValues(alpha: 0.15),
        padding: const EdgeInsets.all(12),
        child: const Text(
          'ИИ не подключён. Админ → Настройки ИИ → ключ tooken.club.',
          style: TextStyle(color: AppColors.warning, fontSize: 13),
        ),
      );

  Widget _emptyState() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            'Спросите что угодно по работе зала — ассистент видит актуальные данные.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.textMuted),
          ),
        ),
      );

  Widget _bubble(_ChatLine line) {
    final isMine = line.mine;
    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: isMine ? AppColors.primary : AppColors.surfaceElevated,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: line.text.isEmpty
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : SelectableText(
                line.text,
                style: TextStyle(
                  color: isMine ? Colors.white : AppColors.textPrimary,
                  fontSize: 14,
                  height: 1.35,
                ),
              ),
      ),
    );
  }

  Widget _quickPrompts() => SizedBox(
        height: 44,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          itemCount: widget.quickPrompts.length,
          separatorBuilder: (_, __) => const SizedBox(width: 8),
          itemBuilder: (_, i) => ActionChip(
            backgroundColor: AppColors.selection,
            side: const BorderSide(color: AppColors.border),
            label: Text(widget.quickPrompts[i],
                style: const TextStyle(color: AppColors.textPrimary, fontSize: 12)),
            onPressed: _busy ? null : () => _send(widget.quickPrompts[i]),
          ),
        ),
      );

  Widget _inputBar(bool ready) => Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
        decoration: const BoxDecoration(
          color: AppColors.surfaceElevated,
          border: Border(top: BorderSide(color: AppColors.border)),
        ),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _input,
                enabled: ready && !_busy,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: _send,
                style: const TextStyle(color: AppColors.textPrimary),
                decoration: const InputDecoration(
                  hintText: 'Ваш вопрос…',
                  filled: true,
                  fillColor: AppColors.surface,
                  border: OutlineInputBorder(borderSide: BorderSide.none),
                  contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: ready && !_busy ? () => _send(_input.text) : null,
              style: FilledButton.styleFrom(
                minimumSize: const Size(52, 48),
                backgroundColor: AppColors.primary,
              ),
              child: const Icon(Icons.send, size: 20),
            ),
          ],
        ),
      );
}
