import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/venue_service.dart';
import '../services/guest_consent.dart';
import '../theme/kolibri_theme.dart';
import 'privacy_notice.dart';

/// Галочки согласий над кнопкой, которая отправляет имя или телефон: на
/// обработку и, пока заведение не переведено на хранение в РФ, на
/// трансграничную передачу. Пока нужные не отмечены, экран держит кнопку
/// неактивной (GuestConsent.ready). Согласия уже даны — ссылка на политику.
class GuestConsentChecks extends StatelessWidget {
  final GuestConsent consent;
  const GuestConsentChecks({super.key, required this.consent});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: consent,
      builder: (context, _) {
        if (consent.given) return const PrivacyNotice();
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _ConsentTile(
                value: consent.pd,
                onChanged: (v) => consent.pd = v,
                parts: [
                  const _Plain('Даю '),
                  _Link('согласие на обработку персональных данных',
                      () => showGuestConsentText(context, crossBorder: false)),
                  const _Plain(' и принимаю '),
                  _Link(
                      'политику конфиденциальности',
                      () => launchUrl(Uri.parse(PrivacyNotice.policyUrl),
                          mode: LaunchMode.externalApplication)),
                ],
              ),
              if (consent.needsCrossBorder) ...[
                const SizedBox(height: 4),
                _ConsentTile(
                  value: consent.crossBorder,
                  onChanged: (v) => consent.crossBorder = v,
                  parts: [
                    const _Plain('Даю '),
                    _Link('согласие на трансграничную передачу',
                        () => showGuestConsentText(context, crossBorder: true)),
                    const _Plain(' данных (сервис Google Firebase)'),
                  ],
                ),
              ],
              if (!consent.ready) ...[
                const SizedBox(height: 6),
                Text(
                    consent.needsCrossBorder
                        ? 'Отметьте оба пункта, чтобы продолжить'
                        : 'Отметьте пункт, чтобы продолжить',
                    style: TextStyle(
                        color: KolibriColors.textMuted, fontSize: 12)),
              ],
            ],
          ),
        );
      },
    );
  }
}

sealed class _Part {
  const _Part();
}

class _Plain extends _Part {
  final String text;
  const _Plain(this.text);
}

class _Link extends _Part {
  final String text;
  final VoidCallback onTap;
  const _Link(this.text, this.onTap);
}

class _ConsentTile extends StatelessWidget {
  final bool value;
  final ValueChanged<bool> onChanged;
  final List<_Part> parts;
  const _ConsentTile(
      {required this.value, required this.onChanged, required this.parts});

  @override
  Widget build(BuildContext context) {
    final base = TextStyle(
        color: KolibriColors.textPrimary, fontSize: 13.5, height: 1.4);
    return Semantics(
      checked: value,
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => onChanged(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 32,
                height: 24,
                child: Checkbox(
                  value: value,
                  onChanged: (v) => onChanged(v ?? false),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    for (final p in parts)
                      switch (p) {
                        _Plain(:final text) => TextSpan(text: text),
                        // WidgetSpan, а не recognizer: ссылку не надо
                        // освобождать, и нажатие на неё не ставит галочку.
                        _Link(:final text, :final onTap) => WidgetSpan(
                            alignment: PlaceholderAlignment.baseline,
                            baseline: TextBaseline.alphabetic,
                            child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: onTap,
                              child: Text(text,
                                  style: base.copyWith(
                                      color: KolibriColors.primary,
                                      decoration: TextDecoration.underline,
                                      decorationColor: KolibriColors.primary
                                          .withValues(alpha: 0.5))),
                            ),
                          ),
                      },
                  ]),
                  style: base,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Полный текст согласия — оператор ZalPOS с реквизитами платформы.
Future<void> showGuestConsentText(BuildContext context,
    {required bool crossBorder}) {
  final venue = VenueService.instance.cached;
  final title =
      crossBorder ? GuestConsent.crossBorderTitle : GuestConsent.pdTitle;
  final paragraphs = crossBorder
      ? GuestConsent.crossBorderText(venue)
      : GuestConsent.pdText(venue);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: KolibriColors.surface,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (ctx) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      maxChildSize: 0.95,
      builder: (ctx, scroll) => ListView(
        controller: scroll,
        padding: EdgeInsets.fromLTRB(
            20, 16, 20, 24 + MediaQuery.paddingOf(ctx).bottom),
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                  color: KolibriColors.border,
                  borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const SizedBox(height: 16),
          Text(title,
              style: const TextStyle(
                  fontSize: 18, fontWeight: FontWeight.w700, height: 1.3)),
          const SizedBox(height: 4),
          Text(GuestConsent.editionLabel,
              style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
          const SizedBox(height: 14),
          for (final p in paragraphs) ...[
            Text(p,
                style: TextStyle(
                    color: KolibriColors.textPrimary,
                    fontSize: 14,
                    height: 1.5)),
            const SizedBox(height: 12),
          ],
          const SizedBox(height: 8),
          FilledButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Понятно')),
        ],
      ),
    ),
  );
}

/// Согласия ещё нет, а действие отправит данные из профиля (лист
/// ожидания): спрашиваем отдельным окном. true — можно продолжать.
Future<bool> ensureGuestConsent(
    BuildContext context, GuestConsent consent, String uid) async {
  if (consent.given) return true;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      backgroundColor: KolibriColors.surface,
      title: const Text('Нужно ваше согласие'),
      content: GuestConsentChecks(consent: consent),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Отмена')),
        ListenableBuilder(
          listenable: consent,
          builder: (ctx, _) => FilledButton(
            onPressed: consent.ready ? () => Navigator.pop(ctx, true) : null,
            child: const Text('Продолжить'),
          ),
        ),
      ],
    ),
  );
  if (ok != true) return false;
  try {
    await consent.commit(uid);
    return true;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.toString())));
    }
    return false;
  }
}
