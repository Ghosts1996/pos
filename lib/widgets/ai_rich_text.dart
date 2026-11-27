import 'package:flutter/material.dart';

import '../build_info.dart';

/// Ответ ИИ — как обычный аккуратный текст, без «звёздочек и решёток».
///
/// Модели отвечают разметкой Markdown: «### Главное», «**6430 ₽**»,
/// «- пункт», «1. шаг». Раньше она показывалась как есть, и владелец видел
/// символы. Здесь разметка превращается в оформление: заголовки — жирным и
/// крупнее, **жирное** — жирным, списки — с точкой или номером, «---» —
/// разделитель; обратные кавычки, лишние # и * убираются. В hookah-pos —
/// как раньше, простым текстом.
class AiRichText extends StatelessWidget {
  final String text;
  final TextStyle? style;
  final bool selectable;
  const AiRichText(this.text, {super.key, this.style, this.selectable = true});

  @override
  Widget build(BuildContext context) {
    final base = (style ?? DefaultTextStyle.of(context).style).copyWith(height: style?.height ?? 1.4);
    if (!kSaasMode) {
      return selectable ? SelectableText(text, style: base) : Text(text, style: base);
    }
    final blocks = parseAiBlocks(text);
    final children = <Widget>[];
    for (final b in blocks) {
      switch (b.kind) {
        case AiBlockKind.heading:
          children.add(Padding(
            padding: EdgeInsets.only(top: children.isEmpty ? 0 : 12, bottom: 4),
            child: _rich(b.text, base.copyWith(fontWeight: FontWeight.w700, fontSize: (base.fontSize ?? 14) + 2)),
          ));
        case AiBlockKind.bullet:
        case AiBlockKind.numbered:
          children.add(Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: b.kind == AiBlockKind.numbered ? 24 : 16,
                  child: Text(b.kind == AiBlockKind.numbered ? '${b.number}.' : '•',
                      style: base.copyWith(fontWeight: FontWeight.w600)),
                ),
                Expanded(child: _rich(b.text, base)),
              ],
            ),
          ));
        case AiBlockKind.divider:
          children.add(Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Divider(height: 1, color: (base.color ?? Colors.grey).withValues(alpha: 0.25)),
          ));
        case AiBlockKind.gap:
          if (children.isNotEmpty) children.add(const SizedBox(height: 6));
        case AiBlockKind.paragraph:
          children.add(Padding(
            padding: const EdgeInsets.only(top: 2),
            child: _rich(b.text, base),
          ));
      }
    }
    final column = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: children);
    return selectable ? SelectionArea(child: column) : column;
  }

  Widget _rich(String line, TextStyle base) =>
      Text.rich(TextSpan(children: aiInlineSpans(line, base)), style: base);
}

enum AiBlockKind { heading, bullet, numbered, paragraph, divider, gap }

class AiBlock {
  final AiBlockKind kind;
  final String text;
  final int number;
  const AiBlock(this.kind, this.text, {this.number = 0});
}

final _heading = RegExp(r'^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$');
final _bullet = RegExp(r'^\s*[-*•–]\s+(.+)$');
final _numbered = RegExp(r'^\s*(\d{1,2})[.)]\s+(.+)$');
final _divider = RegExp(r'^\s*([-*_]\s*){3,}$');
final _boldLine = RegExp(r'^\s*\*\*(.+?)\*\*\s*:?\s*$');

/// Разбор ответа ИИ на блоки (заголовки, пункты, абзацы).
List<AiBlock> parseAiBlocks(String raw) {
  final out = <AiBlock>[];
  for (var line in raw.replaceAll('\r', '').split('\n')) {
    // Строки таблиц: «| a | b |» → «a · b»; разделитель «|---|» — пропуск.
    if (line.trim().startsWith('|')) {
      if (RegExp(r'^\s*\|?[\s:|-]+\|?\s*$').hasMatch(line)) continue;
      line = line.split('|').map((c) => c.trim()).where((c) => c.isNotEmpty).join(' · ');
    }
    if (line.trim().isEmpty) {
      if (out.isNotEmpty && out.last.kind != AiBlockKind.gap) out.add(const AiBlock(AiBlockKind.gap, ''));
      continue;
    }
    if (_divider.hasMatch(line)) {
      out.add(const AiBlock(AiBlockKind.divider, ''));
      continue;
    }
    var m = _heading.firstMatch(line);
    if (m != null) {
      out.add(AiBlock(AiBlockKind.heading, m.group(1)!));
      continue;
    }
    // «**Главное за сутки:**» отдельной строкой — тоже заголовок.
    m = _boldLine.firstMatch(line);
    if (m != null && m.group(1)!.length <= 60) {
      out.add(AiBlock(AiBlockKind.heading, m.group(1)!));
      continue;
    }
    m = _numbered.firstMatch(line);
    if (m != null) {
      out.add(AiBlock(AiBlockKind.numbered, m.group(2)!, number: int.parse(m.group(1)!)));
      continue;
    }
    m = _bullet.firstMatch(line);
    if (m != null) {
      out.add(AiBlock(AiBlockKind.bullet, m.group(1)!));
      continue;
    }
    out.add(AiBlock(AiBlockKind.paragraph, line.trim()));
  }
  while (out.isNotEmpty && out.last.kind == AiBlockKind.gap) {
    out.removeLast();
  }
  return out;
}

/// Строка с **жирным** → куски текста; остальные знаки разметки убираются.
List<TextSpan> aiInlineSpans(String line, TextStyle base) {
  final spans = <TextSpan>[];
  final re = RegExp(r'\*\*(.+?)\*\*|__(.+?)__');
  var at = 0;
  for (final m in re.allMatches(line)) {
    if (m.start > at) spans.add(TextSpan(text: _strip(line.substring(at, m.start))));
    spans.add(TextSpan(text: _strip(m.group(1) ?? m.group(2) ?? ''), style: const TextStyle(fontWeight: FontWeight.w700)));
    at = m.end;
  }
  if (at < line.length) spans.add(TextSpan(text: _strip(line.substring(at))));
  return spans;
}

String _strip(String s) => s
    .replaceAll('`', '')
    .replaceAll(RegExp(r'(?<![\p{L}\d])\*(?=\S)|(?<=\S)\*(?![\p{L}\d])', unicode: true), '')
    .replaceAll(RegExp(r'\*{2,}'), '')
    .replaceAll(RegExp(r'#{2,}'), '');

/// Тот же ответ простым текстом — для уведомлений, копирования и
/// мест, где оформление невозможно: без #, *, `, с «•» у пунктов.
String plainAiText(String raw) {
  final b = StringBuffer();
  for (final x in parseAiBlocks(raw)) {
    final t = aiInlineSpans(x.text, const TextStyle()).map((s) => s.text ?? '').join();
    switch (x.kind) {
      case AiBlockKind.heading:
      case AiBlockKind.paragraph:
        b.writeln(t);
      case AiBlockKind.bullet:
        b.writeln('• $t');
      case AiBlockKind.numbered:
        b.writeln('${x.number}. $t');
      case AiBlockKind.divider:
      case AiBlockKind.gap:
        b.writeln();
    }
  }
  return b.toString().trim();
}
