import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../build_info.dart';

bool _fontLicensesAdded = false;

// Лицензии пакетов Flutter собирает сам, а шрифты из assets/fonts — нет:
// их тексты OFL лежат рядом со шрифтами и добавляются здесь.
Stream<LicenseEntry> fontLicenses() async* {
  for (final (name, file) in const [('Onest', 'OFL-Onest.txt'), ('Cormorant Garamond', 'OFL-CormorantGaramond.txt')]) {
    yield LicenseEntryWithLineBreaks([name], await rootBundle.loadString('assets/fonts/$file'));
  }
}

void _addFontLicenses() {
  if (_fontLicensesAdded) return;
  _fontLicensesAdded = true;
  LicenseRegistry.addLicense(fontLicenses);
}

/// Экран «Лицензии открытого ПО»: библиотеки и шрифты, на которых работает
/// приложение, с текстами их лицензий.
void showOpenSourceLicenses(BuildContext context, {required String appName}) {
  _addFontLicenses();
  final build = int.tryParse(kBuildNumber) ?? 0;
  showLicensePage(
    context: context,
    applicationName: appName,
    applicationVersion: build > 0 ? 'Сборка $build' : null,
    applicationLegalese: 'Приложение использует открытые библиотеки и шрифты. Ниже — их лицензии.',
  );
}
