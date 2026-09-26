import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_settings.dart';
import '../../services/ai/tooken_client.dart';
import '../../services/guest_link_service.dart';
import '../theme/kolibri_theme.dart';

/// ИИ-консьерж гостя в «Colibri Lounge».
///
/// Работает поверх того же ключа tooken.club, что и POS: агент `concierge`
/// видит актуальное меню (без стоп-листа) и обезличенный портрет гостя,
/// поэтому советует то, что реально есть в зале прямо сейчас.
class KolibriAiChat extends StatefulWidget {
  final String guestUid;

  /// Открыть чат сразу с готовым вопросом (например, «подбери мне кальян»).
  final String? initialQuestion;

  /// Если true — отвечает агент «Кальянный сомелье», иначе консьерж.
  final bool sommelierMode;

  const KolibriAiChat({
    super.key,
    required this.guestUid,
    this.initialQuestion,
    this.sommelierMode = false,
  });

  static Future<void> show(
    BuildContext context, {
    required String guestUid,
    String? initialQuestion,
    bool sommelierMode = false,
  }) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: FractionallySizedBox(
          heightFactor: 0.9,
          child: KolibriAiChat(
            guestUid: guestUid,
            initialQuestion: initialQuestion,
            sommelierMode: sommelierMode,
          ),
        ),
      ),
    );
  }

  @override
  State<KolibriAiChat> createState() => _KolibriAiChatState();
}

class _Msg {
  final bool mine;
  String text;
  _Msg(this.mine, this.text);
}

class _KolibriAiChatState extends State<KolibriAiChat> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _msgs = <_Msg>[];
  final _history = <AiMessage>[];
  final _link = GuestLinkService();
  bool _busy = false;
  String? _error;

  List<String> get _quick => widget.sommelierMode
      ? const [
          'Хочу что-то кисло-фруктовое',
          'Покрепче, но без горечи',
          'Мы вчетвером, что взять?',
        ]
      : const [
          'Что у вас есть сегодня?',
          'Как работают бонусы?',
          'До скольки вы работаете?',
        ];

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

  Future<void> _send(String raw) async {
    final text = raw.trim();
    if (text.isEmpty || _busy) return;

    setState(() {
      _error = null;
      _busy = true;
      _msgs.add(_Msg(true, text));
      _input.clear();
    });

    // Каждый вопрос стоит денег на шлюзе ИИ, поэтому доступ ограничен:
    // нужен указанный телефон, реальное присутствие за столом (QR) и не
    // больше 10 вопросов в день — иначе показываем причину и на ИИ не идём.
    final quota = await _link.consumeAiQuota(widget.guestUid);
    if (!quota.allowed) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = quota.reason ?? 'ИИ-консьерж сейчас недоступен.';
        });
      }
      return;
    }

    try {
      final reply = widget.sommelierMode
          ? await AiService.instance.sommelier(text, guestUid: widget.guestUid)
          : await AiService.instance.conciergeReply(
              text,
              guestUid: widget.guestUid,
              history: List.of(_history),
            );
      if (!mounted) return;
      setState(() => _msgs.add(_Msg(false, reply)));
      _history
        ..add(AiMessage.user(text))
        ..add(AiMessage.assistant(reply));
      while (_history.length > 6) {
        _history.removeAt(0);
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = e is AiException
            ? e.message
            : 'Консьерж сейчас недоступен, позовите кальянщика в зале.');
      }
    }

    if (mounted) setState(() => _busy = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final ready = AiSettingsStore.instance.current.isReady;

    return Container(
      decoration: BoxDecoration(
        color: KolibriColors.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 8, 12),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 18,
                  backgroundColor: KolibriColors.primary,
                  child: Icon(Icons.auto_awesome, color: KolibriColors.onPrimary, size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.sommelierMode ? 'Кальянный сомелье' : 'Консьерж Colibri',
                          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                      Text('Подскажу по меню, броням и бонусам',
                          style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: Icon(Icons.close, color: KolibriColors.textMuted),
                ),
              ],
            ),
          ),
          if (!ready)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 20, vertical: 8),
              child: Text(
                'Консьерж временно недоступен. Позовите кальянщика — он поможет.',
                style: TextStyle(color: KolibriColors.warning, fontSize: 13),
              ),
            ),
          Expanded(
            child: _msgs.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Text(
                        'Спросите, что взять сегодня — подберу под ваш вкус и настроение.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: KolibriColors.textMuted),
                      ),
                    ),
                  )
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    itemCount: _msgs.length,
                    itemBuilder: (_, i) {
                      final m = _msgs[i];
                      return Align(
                        alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 5),
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                          constraints: BoxConstraints(
                              maxWidth: MediaQuery.of(context).size.width * 0.8),
                          decoration: BoxDecoration(
                            color: m.mine
                                ? KolibriColors.primary
                                : KolibriColors.surfaceElevated,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: SelectableText(
                            m.text,
                            style: TextStyle(
                              color: m.mine ? KolibriColors.onPrimary : KolibriColors.textPrimary,
                              height: 1.35,
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
          if (_busy)
            const Padding(
              padding: EdgeInsets.all(8),
              child: SizedBox(
                  height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
              child: Text(_error!,
                  style: const TextStyle(color: KolibriColors.danger, fontSize: 13)),
            ),
          SizedBox(
            height: 44,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: _quick.length,
              separatorBuilder: (_, __) => const SizedBox(width: 8),
              itemBuilder: (_, i) => ActionChip(
                backgroundColor: KolibriColors.surfaceElevated,
                side: BorderSide(color: KolibriColors.border),
                label: Text(_quick[i], style: const TextStyle(fontSize: 12)),
                onPressed: _busy ? null : () => _send(_quick[i]),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    enabled: ready && !_busy,
                    minLines: 1,
                    maxLines: 3,
                    onSubmitted: _send,
                    decoration: const InputDecoration(hintText: 'Ваш вопрос…'),
                  ),
                ),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: ready && !_busy ? () => _send(_input.text) : null,
                  style: FilledButton.styleFrom(minimumSize: const Size(56, 52)),
                  child: const Icon(Icons.send, size: 20),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
