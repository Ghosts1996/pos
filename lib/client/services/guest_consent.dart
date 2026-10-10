import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../build_info.dart';
import '../../models/client_models.dart';
import '../../models/venue_models.dart';
import '../../services/app_scope.dart';
import '../../services/pii_gateway_service.dart';
import '../../services/venue_service.dart';

/// Согласия гостя перед первой отправкой имени, телефона или адреса.
///
/// Оператор данных гостей — сервис ZalPOS (оферта, раздел 7): заведение
/// обрабатывает их по его поручению, поэтому заведению не нужно ничего
/// подавать в Роскомнадзор. Согласие на обработку (ст. 9 152-ФЗ) нужно
/// всегда; на трансграничную передачу (ст. 12) — только пока заведение не
/// переведено на хранение в РФ (meta/venueProfile.piiMode = 'rf'): до этого
/// копии профиля, броней и заказов синхронизируются через Google Firebase.
/// С 1 сентября 2025 года согласие оформляется отдельно от других
/// документов — отдельные галочки со своими текстами.
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
  bool _crossBorder = false;

  /// В сборке одного заведения своя политика и свои документы.
  bool _given = !kSaasMode;

  bool get pd => _pd;
  bool get crossBorder => _crossBorder;
  bool get given => _given;

  /// Нужна ли галочка о трансграничной передаче: заведение ещё не
  /// переведено на хранение персональных данных только в РФ.
  bool get needsCrossBorder => VenueService.instance.cached.piiMode != 'rf';

  /// Можно отправлять данные: согласия уже есть или нужные галочки стоят.
  bool get ready => _given || (_pd && (_crossBorder || !needsCrossBorder));

  set pd(bool v) {
    _pd = v;
    notifyListeners();
  }

  set crossBorder(bool v) {
    _crossBorder = v;
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

  /// Записать согласие на сервер в РФ до отправки данных. Без нужных
  /// галочек не пускаем — кнопка и так неактивна, это страховка.
  Future<void> commit(String uid) async {
    if (_given) return;
    final xb = needsCrossBorder;
    if (!_pd || (xb && !_crossBorder)) {
      throw PiiGatewayException(xb
          ? 'Отметьте оба согласия — без них данные не отправить'
          : 'Отметьте согласие — без него данные не отправить');
    }
    await PiiGatewayService().recordGuestConsent(edition, crossBorder: xb);
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
  static const crossBorderTitle = 'Согласие на трансграничную передачу персональных данных';

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
        v.piiMode == 'rf'
            ? 'Имя, телефон и адрес хранятся на сервере в России и за её пределы не передаются.'
            : 'Имя, телефон и адрес сначала записываются на сервер в России.',
        'Согласие действует до его отзыва, но не дольше 3 лет с последнего посещения. Отозвать '
            'согласие и удалить данные можно кнопкой «Удалить мои данные» в профиле, письмом '
            'оператору или через заведение; накопленные бонусы при этом аннулируются.',
      ];

  static List<String> crossBorderText(VenueProfile v) => [
        'Отмечая этот пункт, я даю согласие оператору — ${operatorLine()} — на трансграничную '
            'передачу моих персональных данных компании Google LLC (сервис Firebase): хранение '
            'и синхронизация — в центрах обработки данных в Бельгии и Нидерландах, вход в '
            'приложение и push-уведомления — на серверах в США.',
        'Передаются: имя, номер телефона, день и месяц рождения, адрес доставки, сведения о '
            'бронированиях, заказах, посещениях и бонусах, идентификатор устройства. Первично '
            'данные записываются на сервер в России.',
        'Зачем: чтобы приложение работало вместе с кассой заведения — персонал видел бронь и '
            'заказ, начислял бонусы, а приложение присылало уведомления. Получатель защищает '
            'данные: шифрование при хранении и передаче, сертификаты ISO/IEC 27001, 27017, 27018.',
        'Передача прекращается, когда заведение переводится на хранение данных только в России. '
            'Срок и порядок отзыва — как в согласии на обработку персональных данных.',
      ];
}
