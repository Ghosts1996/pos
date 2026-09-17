import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

final RegExp _urlPattern = RegExp(
  r'(https?://[^\s]+|www\.[^\s]+)',
  caseSensitive: false,
);

final RegExp _trailingPunctuation = RegExp(r'[.,!?;:)\]}"”»]+$');

/// Разбивает текст на span'ы, превращая ссылки (http/https/www) в кликабельные.
///
/// Хвостовая пунктуация («...канал.», «(сайт)») в ссылку не включается,
/// иначе точка или скобка в конце фразы улетит в URL при открытии.
List<InlineSpan> linkifySpans(String text, {TextStyle? style, TextStyle? linkStyle}) {
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
      style: linkStyle ?? style?.copyWith(
        color: Colors.blueAccent,
        decoration: TextDecoration.underline,
      ),
      recognizer: TapGestureRecognizer()
        ..onTap = () => launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication),
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
