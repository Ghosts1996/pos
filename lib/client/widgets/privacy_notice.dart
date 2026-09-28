import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../build_info.dart';
import '../theme/kolibri_theme.dart';

/// Уведомление под формами с именем и телефоном гостя (ст. 18.1 152-ФЗ):
/// кто, зачем и где обрабатывает данные, и ссылка на политику. Имя и
/// телефон обрабатываются для исполнения договора (бронь, бонусная
/// программа), поэтому отдельная галочка согласия здесь не нужна —
/// достаточно известить. В одно-арендной сборке своя политика — не
/// показываем.
class PrivacyNotice extends StatelessWidget {
  /// Надпись на кнопке формы — «Сохранить», «Забронировать».
  final String action;

  const PrivacyNotice({super.key, required this.action});

  static const policyUrl = 'https://zalpos.ru/#/legal/privacy';

  @override
  Widget build(BuildContext context) {
    if (!kSaasMode) return const SizedBox.shrink();
    final style = TextStyle(color: KolibriColors.textMuted, fontSize: 12, height: 1.35);
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(
        children: [
          Text('Нажимая «$action», вы соглашаетесь, что заведение обработает ваше имя и телефон '
              'для брони и бонусной программы. Данные хранятся на серверах в России. ',
              style: style),
          GestureDetector(
            onTap: () => launchUrl(Uri.parse(policyUrl), mode: LaunchMode.externalApplication),
            child: Text('Политика обработки данных',
                style: style.copyWith(color: KolibriColors.primary, decoration: TextDecoration.underline)),
          ),
        ],
      ),
    );
  }
}
