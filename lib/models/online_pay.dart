/// Банки, через которые гость платит онлайн — счёт за столом и заказ
/// доставки. Платёж заводит шлюз (saas-gateway/guest-pay.js): реквизиты
/// банка на телефон гостя не попадают, гостю виден только id банка
/// (meta/venueProfile.onlinePay).
class OnlinePayProvider {
  final String id;
  final String label;
  final String loginLabel;
  final String passwordLabel;

  /// Второй пароль (Робокасса: пароль №2 — им подписан ответ банка).
  final String? password2Label;

  /// Есть ли у банка отдельный тестовый контур, который включается флажком.
  final bool hasTestMode;

  /// Где взять реквизиты и что включить у банка.
  final String hint;

  /// Платит ли гость именно через СБП (а не на странице банка с выбором).
  final bool sbpOnly;

  /// Адрес API банка вписывает владелец (другой банк на шлюзе RBS).
  final String? urlLabel;

  const OnlinePayProvider({
    required this.id,
    required this.label,
    required this.loginLabel,
    required this.passwordLabel,
    this.password2Label,
    this.hasTestMode = false,
    required this.hint,
    this.sbpOnly = false,
    this.urlLabel,
  });

  static const _rbsHint = 'СБП включается на стороне банка — тогда гость увидит её на странице оплаты рядом с картой.';

  static const all = [
    OnlinePayProvider(
      id: 'tinkoff',
      label: 'Т-Банк — СБП',
      loginLabel: 'TerminalKey',
      passwordLabel: 'Пароль терминала',
      sbpOnly: true,
      hint: 'Т-Банк Бизнес → Интернет-эквайринг → Магазины → Терминалы: TerminalKey и пароль. '
          'Оплату через СБП включите в настройках магазина. Тестовый терминал — ключ с DEMO на конце.',
    ),
    OnlinePayProvider(
      id: 'tinkoff_form',
      label: 'Т-Банк — карта, СБП и T-Pay',
      loginLabel: 'TerminalKey',
      passwordLabel: 'Пароль терминала',
      hint: 'Гость платит на странице Т-Банка: картой, через СБП или T-Pay. TerminalKey и пароль — '
          'Т-Банк Бизнес → Интернет-эквайринг → Магазины → Терминалы. Тестовый терминал — ключ с DEMO на конце.',
    ),
    OnlinePayProvider(
      id: 'sber',
      label: 'Сбербанк — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API присылает Сбербанк после подключения интернет-эквайринга. $_rbsHint',
    ),
    OnlinePayProvider(
      id: 'alfa',
      label: 'Альфа-Банк — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API присылает Альфа-Банк после подключения интернет-эквайринга. $_rbsHint',
    ),
    OnlinePayProvider(
      id: 'vtb',
      label: 'ВТБ — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API выдаёт ВТБ после подключения интернет-эквайринга (платёжный шлюз '
          'platezh.vtb24.ru). $_rbsHint',
    ),
    OnlinePayProvider(
      id: 'mts',
      label: 'МТС Банк — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API выдаёт МТС Банк после подключения интернет-эквайринга (платёжный шлюз '
          'oplata.mtsbank.ru). $_rbsHint',
    ),
    OnlinePayProvider(
      id: 'raiffeisen',
      label: 'Райффайзенбанк — СБП',
      loginLabel: 'ID партнёра СБП (sbpMerchantId, MA…)',
      passwordLabel: 'Секретный ключ',
      hasTestMode: true,
      sbpOnly: true,
      hint: 'Личный кабинет Райффайзен Бизнес → Приём платежей → СБП: идентификатор партнёра '
          '(начинается с MA) и секретный ключ API. Для тестового контура — тестовые ID и ключ.',
    ),
    OnlinePayProvider(
      id: 'robokassa',
      label: 'Робокасса — СБП и карты',
      loginLabel: 'Идентификатор магазина',
      passwordLabel: 'Пароль №1',
      password2Label: 'Пароль №2',
      hasTestMode: true,
      hint: 'Робокасса → Мои магазины → Технические настройки: идентификатор, пароли №1 и №2, '
          'алгоритм хеша. Туда же впишите адреса ниже. В тестовом режиме — тестовые пароли.',
    ),
    OnlinePayProvider(
      id: 'rbs_custom',
      label: 'Другой банк — платёжный шлюз RBS',
      loginLabel: 'Логин API',
      passwordLabel: 'Пароль API',
      urlLabel: 'Адрес API банка, например https://…/payment/rest',
      hint: 'Многие банки дают интернет-эквайринг на шлюзе RBS: у него методы register.do и '
          'getOrderStatusExtended.do. Спросите у банка адрес API (оканчивается на /payment/rest), '
          'логин и пароль API. Для теста впишите адрес тестового контура банка. $_rbsHint',
    ),
  ];

  static OnlinePayProvider? byId(String? id) {
    for (final p in all) {
      if (p.id == id) return p;
    }
    return null;
  }

  /// Что не так с адресом API «другого банка»; null — годится. Те же
  /// правила проверяет шлюз (rbsCustomUrl в saas-gateway/guest-pay.js).
  static String? urlProblem(String raw) {
    final u = Uri.tryParse(raw.trim());
    if (raw.trim().isEmpty) return 'Впишите адрес API банка';
    if (u == null || u.scheme != 'https' || u.host.isEmpty) return 'Адрес должен начинаться с https://';
    if (u.userInfo.isNotEmpty || (u.hasPort && u.port != 443) || u.hasQuery || u.hasFragment) {
      return 'Без порта, логина и параметров — только адрес';
    }
    if (u.host.contains(':') || RegExp(r'^[\d.]+$').hasMatch(u.host) || !u.host.contains('.')) {
      return 'Нужно доменное имя банка, а не IP-адрес';
    }
    if (!RegExp(r'/payment/rest/?$').hasMatch(u.path)) return 'Адрес должен оканчиваться на /payment/rest';
    return null;
  }

  /// Подпись кнопки у гостя: «по СБП» — только если банк платит именно СБП.
  static String payLabel(String id) => byId(id)?.sbpOnly == true ? 'Оплатить по СБП' : 'Оплатить онлайн';
}
