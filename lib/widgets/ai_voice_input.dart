import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Кнопка голосового ввода для чатов с ИИ.
///
/// В зале руки заняты: кальянщику проще сказать «что предложить гостю за
/// третьим столом», чем набирать. Работает офлайн-движком системы, ничего
/// никуда не отправляет сама — распознанный текст отдаётся наружу через
/// [onResult], а уже экран решает, что с ним делать.
///
/// Если распознавание недоступно (нет разрешения, нет движка), кнопка
/// просто становится неактивной и не мешает.
class AiVoiceInput extends StatefulWidget {
  final void Function(String text) onResult;

  /// Вызывается на каждое промежуточное распознавание — можно показывать
  /// текст прямо в поле ввода, пока человек говорит.
  final void Function(String partial)? onPartial;

  final Color color;
  final String localeId;

  const AiVoiceInput({
    super.key,
    required this.onResult,
    this.onPartial,
    this.color = Colors.blue,
    this.localeId = 'ru_RU',
  });

  @override
  State<AiVoiceInput> createState() => _AiVoiceInputState();
}

class _AiVoiceInputState extends State<AiVoiceInput> {
  final _speech = SpeechToText();
  bool _available = false;
  bool _listening = false;
  String _buffer = '';

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final ok = await _speech.initialize(
        onStatus: (status) {
          if (status == 'done' || status == 'notListening') {
            if (mounted) setState(() => _listening = false);
            if (_buffer.trim().isNotEmpty) {
              widget.onResult(_buffer.trim());
              _buffer = '';
            }
          }
        },
        onError: (_) {
          if (mounted) setState(() => _listening = false);
        },
      );
      if (mounted) setState(() => _available = ok);
    } catch (_) {
      if (mounted) setState(() => _available = false);
    }
  }

  Future<void> _toggle() async {
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      return;
    }
    _buffer = '';
    setState(() => _listening = true);
    await _speech.listen(
      localeId: widget.localeId,
      listenOptions: SpeechListenOptions(partialResults: true, cancelOnError: true),
      onResult: (r) {
        _buffer = r.recognizedWords;
        widget.onPartial?.call(_buffer);
        if (r.finalResult && _buffer.trim().isNotEmpty) {
          widget.onResult(_buffer.trim());
          _buffer = '';
          if (mounted) setState(() => _listening = false);
        }
      },
    );
  }

  @override
  void dispose() {
    _speech.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: _listening ? 'Идёт запись — нажмите, чтобы остановить' : 'Сказать голосом',
      onPressed: _available ? _toggle : null,
      icon: Icon(
        _listening ? Icons.mic : Icons.mic_none,
        color: _listening ? Colors.redAccent : widget.color,
      ),
    );
  }
}
