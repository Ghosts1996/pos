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

  const OnlinePayProvider({
    required this.id,
    required this.label,
    required this.loginLabel,
    required this.passwordLabel,
    this.password2Label,
    this.hasTestMode = false,
    required this.hint,
    this.sbpOnly = false,
  });

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
      id: 'sber',
      label: 'Сбербанк — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API присылает Сбербанк после подключения интернет-эквайринга. '
          'СБП включается на стороне банка — тогда гость увидит её на странице оплаты.',
    ),
    OnlinePayProvider(
      id: 'alfa',
      label: 'Альфа-Банк — интернет-эквайринг',
      loginLabel: 'Логин API (оканчивается на -api)',
      passwordLabel: 'Пароль API',
      hasTestMode: true,
      hint: 'Логин и пароль API присылает Альфа-Банк после подключения интернет-эквайринга. '
          'СБП включается на стороне банка — тогда гость увидит её на странице оплаты.',
    ),
  ];

  static OnlinePayProvider? byId(String? id) {
    for (final p in all) {
      if (p.id == id) return p;
    }
    return null;
  }

  /// Подпись кнопки у гостя: «по СБП» — только если банк платит именно СБП.
  static String payLabel(String id) => byId(id)?.sbpOnly == true ? 'Оплатить по СБП' : 'Оплатить онлайн';
}
