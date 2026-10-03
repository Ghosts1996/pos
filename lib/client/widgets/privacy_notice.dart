import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../build_info.dart';
import '../theme/kolibri_theme.dart';

/// Ссылка на политику обработки данных под формами с именем и телефоном
/// гостя (ст. 18.1 152-ФЗ): кто, зачем и где обрабатывает данные, описано
/// в самой политике. В одно-арендной сборке своя политика — не показываем.
class PrivacyNotice extends StatelessWidget {
  const PrivacyNotice({super.key});

  static const policyUrl = 'https://zalpos.ru/#/legal/privacy';

  @override
  Widget build(BuildContext context) {
    if (!kSaasMode) return const SizedBox.shrink();
    return Align(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => launchUrl(Uri.parse(policyUrl), mode: LaunchMode.externalApplication),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
          child: Text('Политика обработки данных',
              style: TextStyle(color: KolibriColors.textMuted, fontSize: 12, height: 1.35)),
        ),
      ),
    );
  }
}
