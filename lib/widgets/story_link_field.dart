import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../utils/story_links.dart';

/// Поле «Текст» карточки ленты со ссылками «как в Telegram»: слово со
/// ссылкой подсвечено и подчёркнуто, адрес рядом — мелким серым.
class StoryTextController extends TextEditingController {
  StoryTextController({super.text});

  @override
  TextSpan buildTextSpan({required BuildContext context, TextStyle? style, required bool withComposing}) {
    // Пока клавиатура подбирает слово — обычный вид (подчёркивание набора).
    if (withComposing && value.composing.isValid && !value.composing.isCollapsed) {
      return super.buildTextSpan(context: context, style: style, withComposing: withComposing);
    }
    final t = text;
    final spans = <InlineSpan>[];
    var at = 0;
    final linkStyle = (style ?? const TextStyle()).copyWith(
      color: AppColors.primary,
      fontWeight: FontWeight.w600,
      decoration: TextDecoration.underline,
      decorationColor: AppColors.primary,
    );
    final urlStyle = (style ?? const TextStyle()).copyWith(color: AppColors.textMuted, fontSize: 12);
    for (final m in storyLinkPattern.allMatches(t)) {
      if (m.start > at) spans.add(TextSpan(text: t.substring(at, m.start)));
      final label = m.group(1)!;
      spans.add(TextSpan(text: '[', style: urlStyle));
      spans.add(TextSpan(text: label, style: linkStyle));
      spans.add(TextSpan(text: '](${m.group(2)})', style: urlStyle));
      at = m.end;
    }
    if (at < t.length) spans.add(TextSpan(text: t.substring(at)));
    return TextSpan(style: style, children: spans);
  }
}

/// Окно «Ссылка»: адрес (и текст ссылки, если ничего не выделено).
/// Ставит `[слово](адрес)` на место выделения.
Future<void> addStoryLink(BuildContext context, TextEditingController body) async {
  final sel = body.selection;
  final hasSel = sel.isValid && !sel.isCollapsed && sel.end <= body.text.length;
  final selected = hasSel ? body.text.substring(sel.start, sel.end).trim() : '';
  final url = TextEditingController();
  final label = TextEditingController(text: selected);
  String? error;
  final ok = await showDialog<String>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setLocal) {
        void done() {
          final u = normalizeStoryUrl(url.text);
          if (u == null) {
            setLocal(() => error = 'Вставьте адрес, например https://t.me/kanal');
            return;
          }
          Navigator.pop(ctx, u);
        }

        return AlertDialog(
          title: const Text('Ссылка'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (hasSel)
                Text('На слово: «$selected»', style: TextStyle(color: AppColors.textMuted))
              else
                TextField(
                  controller: label,
                  decoration: const InputDecoration(
                    labelText: 'Текст ссылки',
                    hintText: 'Например: наш канал',
                    helperText: 'Можно сначала выделить слово в тексте',
                  ),
                ),
              const SizedBox(height: 12),
              TextField(
                controller: url,
                autofocus: true,
                keyboardType: TextInputType.url,
                onSubmitted: (_) => done(),
                decoration: InputDecoration(
                  labelText: 'Адрес',
                  hintText: 'https://…',
                  errorText: error,
                ),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(onPressed: done, child: const Text('Готово')),
          ],
        );
      },
    ),
  );
  if (ok == null) return;
  body.value = insertStoryLink(
    hasSel
        ? body.value
        : body.value.copyWith(selection: sel.isValid ? TextSelection.collapsed(offset: sel.start) : null),
    ok,
    label: hasSel ? null : (label.text.trim().isEmpty ? null : label.text.trim()),
  );
}

/// Меню выделения поля «Текст»: первым пунктом — «Ссылка» (когда выделено
/// слово), дальше обычные «Копировать/Вставить…».
Widget storyTextContextMenu(BuildContext context, EditableTextState state, TextEditingController body) {
  final items = [...state.contextMenuButtonItems];
  final sel = state.textEditingValue.selection;
  if (sel.isValid && !sel.isCollapsed) {
    items.insert(
      0,
      ContextMenuButtonItem(
        label: 'Ссылка',
        onPressed: () {
          ContextMenuController.removeAny();
          addStoryLink(context, body);
        },
      ),
    );
  }
  return AdaptiveTextSelectionToolbar.buttonItems(anchors: state.contextMenuAnchors, buttonItems: items);
}
