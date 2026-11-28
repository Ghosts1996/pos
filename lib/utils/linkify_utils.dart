import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../build_info.dart';
import '../services/app_lock.dart';
import '../theme/app_colors.dart';
import 'story_links.dart';

final RegExp _urlPattern = RegExp(
  r'(https?://[^\s]+|www\.[^\s]+)',
  caseSensitive: false,
);

final RegExp _trailingPunctuation = RegExp(r'[.,!?;:)\]}"”»]+$');

void _open(String href) =>
    AppLock.instance.whileAway(() => launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication));

/// Разбивает текст на span'ы, превращая ссылки (http/https/www) в кликабельные.
/// В ZalPOS ещё и `[слово](адрес)` — слово-ссылка (так ставит ссылку
/// редактор ленты, как в Telegram).
///
/// Хвостовая пунктуация («...канал.», «(сайт)») в ссылку не включается,
/// иначе точка или скобка в конце фразы улетит в URL при открытии.
List<InlineSpan> linkifySpans(String text, {TextStyle? style, TextStyle? linkStyle}) {
  final ls = linkStyle ?? style?.copyWith(color: AppColors.brass, decoration: TextDecoration.underline);
  if (!kSaasMode || !text.contains('](')) return _bare(text, style, ls);
  final spans = <InlineSpan>[];
  var at = 0;
  for (final m in storyLinkPattern.allMatches(text)) {
    if (m.start > at) spans.addAll(_bare(text.substring(at, m.start), style, ls));
    final url = m.group(2)!;
    final href = url.toLowerCase().startsWith('http') ? url : 'https://$url';
    spans.add(TextSpan(
      text: m.group(1),
      style: ls,
      recognizer: TapGestureRecognizer()..onTap = () => _open(href),
    ));
    at = m.end;
  }
  if (at < text.length) spans.addAll(_bare(text.substring(at), style, ls));
  return spans;
}

List<InlineSpan> _bare(String text, TextStyle? style, TextStyle? linkStyle) {
  final spans = <InlineSpan>[];
  var start = 0;
  for (final match in _urlPattern.allMatches(text)) {
    if (match.start > start) {
      spans.add(TextSpan(text: text.substring(start, match.start), style: style));
    }
    var url = match.group(0)!;
    var trail = '';
    final trailMatch = _trailingPunctuation.firstMatch(url);
    if (trailMatch != null) {
      trail = trailMatch.group(0)!;
      url = url.substring(0, url.length - trail.length);
    }
    if (url.isEmpty) {
      spans.add(TextSpan(text: match.group(0), style: style));
      start = match.end;
      continue;
    }
    final href = url.toLowerCase().startsWith('http') ? url : 'https://$url';
    spans.add(TextSpan(
      text: url,
      style: linkStyle,
      recognizer: TapGestureRecognizer()..onTap = () => _open(href),
    ));
    if (trail.isNotEmpty) {
      spans.add(TextSpan(text: trail, style: style));
    }
    start = match.end;
  }
  if (start < text.length) {
    spans.add(TextSpan(text: text.substring(start), style: style));
  }
  return spans;
}
