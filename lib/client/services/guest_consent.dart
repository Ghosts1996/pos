import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../build_info.dart';
import '../../models/client_models.dart';
import '../../models/venue_models.dart';
import '../../services/app_scope.dart';
import '../../services/pii_gateway_service.dart';

/// Согласие гостя перед первой отправкой имени, телефона или адреса.
///
/// Оператор данных гостей — сервис ZalPOS (оферта, раздел 7): заведение
/// обрабатывает их по его поручению, поэтому заведению не нужно ничего
/// подавать в Роскомнадзор. Согласие на обработку (ст. 9 152-ФЗ) — одна
/// галочка: имена, телефоны и адреса хранятся только на сервере в России
/// (у всех заведений платформы), трансграничной передачи нет. С 1 сентября
/// 2025 года согласие оформляется отдельно от других документов — своя
/// галочка со своим текстом.
///
/// Спрашиваем один раз на редакцию текста: отметка хранится на сервере в
/// РФ (доказательство), её номер — в профиле гостя (другие устройства) и
/// на этом устройстве (заказ без профиля).
class GuestConsent extends ChangeNotifier {
  GuestConsent() {
    _platformLoad ??= _loadPlatform();
  }

  /// Меняется вместе с текстами ниже — тогда гостя спросят заново.
  static const edition = '2026-10-10';
  static const editionLabel = 'Редакция от 10 октября 2026 г.';

  bool _pd = false;

  /// В сборке одного заведения своя политика и свои документы.
  bool _given = !kSaasMode;

  bool get pd => _pd;
  bool get given => _given;

  /// Можно отправлять данные: согласие уже есть или галочка стоит.
  bool get ready => _given || _pd;

  set pd(bool v) {
    _pd = v;
    notifyListeners();
  }

  static String _key(String uid) => 'guest_consent:${AppScope.tenantId ?? ''}:$uid';

  /// Согласие этой редакции уже было — в профиле или на этом устройстве.
  Future<void> load(String uid, [ClientProfile? profile]) async {
    if (_given) return;
    if (profile?.consentEdition == edition) {
      _markGiven();
      return;
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getString(_key(uid)) == edition) _markGiven();
    } catch (_) {}
  }

  /// Профиль пришёл позже (стрим) — подхватываем отметку из него.
  void sync(ClientProfile? profile) {
    if (!_given && profile?.consentEdition == edition) _markGiven();
  }

  void _markGiven() {
    _given = true;
    notifyListeners();
  }

  /// Записать согласие на сервер в РФ до отправки данных. Без галочки не
  /// пускаем — кнопка и так неактивна, это страховка.
  Future<void> commit(String uid) async {
    if (_given) return;
    if (!_pd) {
      throw PiiGatewayException('Отметьте согласие — без него данные не отправить');
    }
    await PiiGatewayService().recordGuestConsent(edition);
    try {
      await (await SharedPreferences.getInstance()).setString(_key(uid), edition);
    } catch (_) {}
    _markGiven();
  }

  // ---------------------------------------------------------------- оператор

  /// Реквизиты ZalPOS (platformConfig/legal — открыты для чтения). Пока
  /// не загрузились — в тексте ссылка на политику, где они опубликованы.
  static Map<String, dynamic> _platform = const {};
  static Future<void>? _platformLoad;

  static Future<void> _loadPlatform() async {
    try {
      final d = await FirebaseFirestore.instance.collection('platformConfig').doc('legal').get();
      _platform = d.data() ?? const {};
    } catch (_) {
      _platformLoad = null; // попробуем при следующем показе
    }
  }

  @visibleForTesting
  static set platformForTest(Map<String, dynamic> v) => _platform = v;

  /// Кто оператор: правообладатель платформы ZalPOS с реквизитами.
  static String operatorLine([Map<String, dynamic>? legal]) {
    final l = legal ?? _platform;
    final raw = '${l['fullName'] ?? ''}'.trim();
    final ogrn = '${l['ogrnip'] ?? ''}'.trim();
    final inn = '${l['inn'] ?? ''}'.trim();
    final address = '${l['address'] ?? ''}'.trim();
    if (raw.isEmpty || inn.isEmpty) {
      return 'сервис ZalPOS — индивидуальный предприниматель, правообладатель платформы ZalPOS '
          '(реквизиты — в политике конфиденциальности на zalpos.ru)';
    }
    final isOrg = !RegExp(r'^ИП\s|индивидуальн', caseSensitive: false).hasMatch(raw) && ogrn.length == 13;
    var who = raw;
    if (!isOrg) {
      var name = raw.replaceFirst(RegExp(r'^(ИП|индивидуальный\s+предприниматель)\s+', caseSensitive: false), '').trim();
      if (name == name.toUpperCase()) {
        name = name.toLowerCase().splitMapJoin(RegExp(r'[\s\-.]+'),
            onNonMatch: (w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1));
      }
      who = 'индивидуальный предприниматель $name';
    }
    final parts = [
      'ИНН $inn',
      if (ogrn.isNotEmpty) '${isOrg ? 'ОГРН' : 'ОГРНИП'} $ogrn',
      if (address.isNotEmpty) 'адрес: $address',
    ];
    return 'сервис ZalPOS — $who (${parts.join(', ')})';
  }

  /// «работники заведения «Лаунж»» — в родительном падеже.
  static String _venue(VenueProfile v) {
    final name = v.name.trim();
    return name.isEmpty ? 'заведения' : 'заведения «$name»';
  }

  // ---------------------------------------------------------------- тексты

  static const pdTitle = 'Согласие на обработку персональных данных';

  static List<String> pdText(VenueProfile v) => [
        'Отмечая этот пункт, я свободно, своей волей и в своём интересе даю согласие '
            'оператору — ${operatorLine()} — на обработку моих персональных данных на условиях ниже.',
        'Какие данные: имя; номер телефона; день и месяц рождения, если я их укажу; адрес доставки, '
            'если я оформлю доставку; сведения о бронированиях, заказах, посещениях, бонусах '
            'и отзывах; идентификатор устройства.',
        'Зачем: бронирование столов и лист ожидания; приём, оплата и доставка заказов; программа '
            'лояльности (бонусы, уровни, скидки) в заведениях, работающих на ZalPOS; связь со мной '
            'по брони и заказу; уведомления в приложении.',
        'Что с ними делают: сбор, запись, систематизация, накопление, хранение, уточнение, '
            'извлечение, использование, передача (предоставление, доступ), блокирование, удаление '
            'и уничтожение — с использованием средств автоматизации.',
        'По поручению оператора мои данные обрабатывают работники ${_venue(v)}, в котором я '
            'бронирую или делаю заказ, — только в программе ZalPOS и только чтобы меня обслужить.',
        'Имя, телефон и адрес хранятся на сервере в России и за её пределы не передаются.',
        'Согласие действует до его отзыва, но не дольше 3 лет с последнего посещения. Отозвать '
            'согласие и удалить данные можно кнопкой «Удалить мои данные» в профиле, письмом '
            'оператору или через заведение; накопленные бонусы при этом аннулируются.',
      ];
}
