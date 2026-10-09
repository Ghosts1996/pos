import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import '../../services/printer_service.dart';
import '../../services/egais_service.dart';
import '../../services/atol_local_kassa.dart';
import '../../services/kassa_service.dart';
import '../../services/chestny_znak_api_service.dart';
import '../../services/payment_terminal_service.dart';
import '../../services/scanner_service.dart';
import '../../build_info.dart';
import '../../models/fiscal_receipt.dart';
import '../../models/online_pay.dart';
import '../../services/gateway_api.dart';
import '../../utils/human_error.dart';
import '../../utils/adaptive.dart';
import '../../theme/app_colors.dart';

/// Настройки интеграций: чековый принтер (Bluetooth/сеть) и адрес УТМ
/// ЕГАИС. Значения хранятся в Firestore (settings/integrations), чтобы не
/// настраивать заново на каждом планшете и не терять их при обновлении
/// приложения.
class IntegrationsSettingsScreen extends StatefulWidget {
  const IntegrationsSettingsScreen({super.key});

  @override
  State<IntegrationsSettingsScreen> createState() => _IntegrationsSettingsScreenState();
}

class _IntegrationsSettingsScreenState extends State<IntegrationsSettingsScreen> {
  final _doc = AppScope.col('settings').doc('integrations');

  String _printerType = 'none'; // none | bluetooth | network
  bool _splitHookah = true;
  bool _kitchenTickets = false;
  bool _kitchenAuto = false;
  final _kitchenIpCtrl = TextEditingController();
  final _barIpCtrl = TextEditingController();
  String _btMac = '';
  final _networkIpCtrl = TextEditingController();
  final _utmHostCtrl = TextEditingController();
  final _fsrarIdCtrl = TextEditingController();
  bool _egaisEnabled = false;
  List<EgaisIncomingDoc>? _egaisDocs;
  String _kassaType = 'none'; // none | atol_local | atol_cloud | orange_data
  final _kassaBaseUrlCtrl = TextEditingController();
  final _kassaGroupCodeCtrl = TextEditingController();
  final _kassaLoginCtrl = TextEditingController();
  final _kassaPasswordCtrl = TextEditingController();
  final _kassaInnCtrl = TextEditingController();
  final _kassaEmailCtrl = TextEditingController();
  final _kassaPaymentAddressCtrl = TextEditingController();
  final _kassaCashierCtrl = TextEditingController();
  final _kassaCashierInnCtrl = TextEditingController();
  String _kassaSno = 'osn';
  String _kassaVat = 'none';
  String _kassaApiVersion = 'v5';
  final _kassaOrangeKeyNameCtrl = TextEditingController();
  final _kassaOrangeCertPemCtrl = TextEditingController();
  final _kassaOrangeKeyPemCtrl = TextEditingController();
  final _kassaOrangeKeyPassCtrl = TextEditingController();
  final _kassaOrangeSignKeyPemCtrl = TextEditingController();
  final _kassaOrangeCaPemCtrl = TextEditingController();
  String _czCircuit = 'pilot'; // pilot | prod
  final _czTokenCtrl = TextEditingController();
  final _czTestCodeCtrl = TextEditingController();
  TerminalProvider _terminalProvider = TerminalProvider.manual;
  final _terminalLoginCtrl = TextEditingController();
  final _terminalPasswordCtrl = TextEditingController();
  bool _loading = true;
  bool _testing = false;
  String? _printerResult;
  String? _utmResult;
  String? _kassaResult;
  bool _czTesting = false;
  String? _czTestResult;
  bool _terminalTesting = false;
  String? _terminalTestResult;
  // Онлайн-оплата гостей (счёт за столом и доставка) — через шлюз.
  String _onlineProvider = '';
  final _onlineLoginCtrl = TextEditingController();
  final _onlinePasswordCtrl = TextEditingController();
  final _onlinePassword2Ctrl = TextEditingController();
  bool _onlineTest = false;
  String _onlineHash = 'md5';
  bool _onlineChecking = false;
  String? _onlineCheckResult;
  bool _onlineVerified = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final snap = await _doc.get();
    final data = snap.data() ?? {};
    _printerType = data['printerType'] ?? 'none';
    _splitHookah = data['printSplitHookah'] as bool? ?? true;
    _kitchenTickets = data['printKitchenTickets'] as bool? ?? false;
    _kitchenAuto = data['printKitchenAuto'] as bool? ?? false;
    _kitchenIpCtrl.text = data['kitchenPrinterIp'] as String? ?? '';
    _barIpCtrl.text = data['barPrinterIp'] as String? ?? '';
    _btMac = data['printerBtMac'] ?? '';
    _networkIpCtrl.text = data['printerIp'] ?? '';
    _utmHostCtrl.text = data['utmHost'] ?? '';
    _fsrarIdCtrl.text = data['egaisFsrarId'] ?? '';
    _egaisEnabled = data['egaisEnabled'] as bool? ?? (data['utmHost'] ?? '').toString().trim().isNotEmpty;
    final kassaType = (data['kassaType'] as String?) ?? 'none';
    // Старые «тестовый режим» и CloudKassir ничего не фискализировали.
    _kassaType = const ['atol_local', 'atol_cloud', 'orange_data'].contains(kassaType) ? kassaType : 'none';
    _kassaBaseUrlCtrl.text = data['kassaBaseUrl'] ?? '';
    _kassaGroupCodeCtrl.text = data['kassaGroupCode'] ?? '';
    _kassaLoginCtrl.text = data['kassaLogin'] ?? '';
    _kassaPasswordCtrl.text = data['kassaPassword'] ?? '';
    _kassaInnCtrl.text = data['kassaInn'] ?? '';
    _kassaEmailCtrl.text = data['kassaEmail'] ?? '';
    _kassaPaymentAddressCtrl.text = data['kassaPaymentAddress'] ?? '';
    _kassaCashierCtrl.text = data['kassaCashier'] ?? '';
    _kassaCashierInnCtrl.text = data['kassaCashierInn'] ?? '';
    _kassaSno = data['kassaSno'] ?? 'osn';
    _kassaVat = FiscalVatRateX.fromId(data['kassaVat'] as String?).id;
    _kassaApiVersion = data['kassaApiVersion'] == 'v4' ? 'v4' : 'v5';
    _kassaOrangeKeyNameCtrl.text = data['kassaOrangeKeyName'] ?? '';
    _kassaOrangeCertPemCtrl.text = data['kassaOrangeCertPem'] ?? '';
    _kassaOrangeKeyPemCtrl.text = data['kassaOrangeKeyPem'] ?? '';
    _kassaOrangeKeyPassCtrl.text = data['kassaOrangeKeyPass'] ?? '';
    _kassaOrangeSignKeyPemCtrl.text = data['kassaOrangeSignKeyPem'] ?? '';
    _kassaOrangeCaPemCtrl.text = data['kassaOrangeCaPem'] ?? '';
    _czCircuit = data['czCircuit'] ?? 'pilot';
    _czTokenCtrl.text = data['czToken'] ?? '';
    _terminalProvider = TerminalProvider.fromId(data['terminalProvider'] ?? 'manual');
    _terminalLoginCtrl.text = data['terminalLogin'] ?? '';
    _terminalPasswordCtrl.text = data['terminalPassword'] ?? '';
    _onlineProvider = (data['onlinePayProvider'] as String?) ?? '';
    _onlineLoginCtrl.text = data['onlinePayLogin'] as String? ?? '';
    _onlinePasswordCtrl.text = data['onlinePayPassword'] as String? ?? '';
    _onlinePassword2Ctrl.text = data['onlinePayPassword2'] as String? ?? '';
    _onlineTest = data['onlinePayTest'] as bool? ?? false;
    _onlineHash = data['onlinePayHash'] as String? ?? 'md5';
    // Раньше оплата гостей шла через «терминал» Т-Банка QR СБП — переносим.
    if (_onlineProvider.isEmpty && data['terminalProvider'] == 'tinkoff_sbp') {
      _onlineProvider = 'tinkoff';
      _onlineLoginCtrl.text = data['terminalLogin'] as String? ?? '';
      _onlinePasswordCtrl.text = data['terminalPassword'] as String? ?? '';
    }
    _onlineSaved = _onlineSignature;
    try {
      final profile = await AppScope.col('meta').doc('venueProfile').get();
      _onlineVerified = _onlineProvider.isNotEmpty && profile.data()?['onlinePay'] == _onlineProvider;
    } catch (_) {}
    _applyActivePrinter();
    setState(() => _loading = false);
  }

  void _applyActivePrinter() {
    // На Windows print_bluetooth_thermal работает через BLE-скан
    // (win_ble), а не через classic-SPP, на котором держится подавляющее
    // большинство дешёвых 58/80-мм принтеров (Xprinter/Gprinter/Rongta) —
    // "подключение" на Windows либо не находит принтер вовсе, либо
    // обманчиво "подключается" к чему-то, что не умеет печатать. Настройка
    // принтера общая на всех устройств заведения (один документ settings),
    // поэтому если её включили с Android-планшета, здесь просто не
    // применяем её, а не пытаемся честно воспроизвести — молчаливый
    // отказ печати хуже, чем никакого принтера. Сеть (LAN) работает
    // одинаково на всех платформах.
    if (_printerType == 'bluetooth' && _btMac.isNotEmpty && !isWindowsApp) {
      activeReceiptPrinter = BluetoothReceiptPrinter(macAddress: _btMac);
    } else if (_printerType == 'network' && _networkIpCtrl.text.trim().isNotEmpty) {
      activeReceiptPrinter = NetworkReceiptPrinter(ip: _networkIpCtrl.text.trim());
    } else {
      activeReceiptPrinter = null;
    }
  }

  Future<void> _save() async {
    printHookahSeparately = _splitHookah;
    printKitchenTickets = _kitchenTickets;
    printKitchenAuto = _kitchenAuto;
    kitchenPrinterIp = _kitchenIpCtrl.text.trim();
    barPrinterIp = _barIpCtrl.text.trim();
    await _doc.set({
      'printSplitHookah': _splitHookah,
      'printKitchenTickets': _kitchenTickets,
      'printKitchenAuto': _kitchenAuto,
      'kitchenPrinterIp': _kitchenIpCtrl.text.trim(),
      'barPrinterIp': _barIpCtrl.text.trim(),
      'printerType': _printerType,
      'printerBtMac': _btMac,
      'printerIp': _networkIpCtrl.text.trim(),
      'utmHost': _utmHostCtrl.text.trim(),
      'egaisEnabled': _egaisEnabled,
      'egaisFsrarId': _fsrarIdCtrl.text.trim(),
      'kassaType': _kassaType,
      'kassaBaseUrl': _kassaBaseUrlCtrl.text.trim(),
      'kassaGroupCode': _kassaGroupCodeCtrl.text.trim(),
      'kassaLogin': _kassaLoginCtrl.text.trim(),
      'kassaPassword': _kassaPasswordCtrl.text.trim(),
      'kassaInn': _kassaInnCtrl.text.trim(),
      'kassaEmail': _kassaEmailCtrl.text.trim(),
      'kassaPaymentAddress': _kassaPaymentAddressCtrl.text.trim(),
      'kassaCashier': _kassaCashierCtrl.text.trim(),
      'kassaCashierInn': _kassaCashierInnCtrl.text.trim(),
      'kassaSno': _kassaSno,
      'kassaVat': _kassaVat,
      'kassaApiVersion': _kassaApiVersion,
      'kassaOrangeKeyName': _kassaOrangeKeyNameCtrl.text.trim(),
      'kassaOrangeCertPem': _kassaOrangeCertPemCtrl.text.trim(),
      'kassaOrangeKeyPem': _kassaOrangeKeyPemCtrl.text.trim(),
      'kassaOrangeKeyPass': _kassaOrangeKeyPassCtrl.text,
      'kassaOrangeSignKeyPem': _kassaOrangeSignKeyPemCtrl.text.trim(),
      'kassaOrangeCaPem': _kassaOrangeCaPemCtrl.text.trim(),
      'czCircuit': _czCircuit,
      'czToken': _czTokenCtrl.text.trim(),
      'terminalProvider': _terminalProvider.id,
      'terminalLogin': _terminalLoginCtrl.text.trim(),
      'terminalPassword': _terminalPasswordCtrl.text.trim(),
      'onlinePayProvider': _onlineProvider,
      'onlinePayLogin': _onlineLoginCtrl.text.trim(),
      'onlinePayPassword': _onlinePasswordCtrl.text.trim(),
      'onlinePayPassword2': _onlinePassword2Ctrl.text.trim(),
      'onlinePayTest': _onlineTest,
      'onlinePayHash': _onlineHash,
    }, SetOptions(merge: true));
    // Гостю — только какой банк подключён (без ключей): по нему приложение
    // показывает кнопку оплаты. Ставит его шлюз, когда банк подтвердил
    // реквизиты (onlinePayCheck). Реквизиты поменяли или убрали — кнопку
    // прячем до новой проверки.
    if (_onlineSignature != _onlineSaved || !_onlineReady) {
      await AppScope.col('meta').doc('venueProfile').set({'onlinePay': ''}, SetOptions(merge: true));
      _onlineVerified = false;
    }
    _onlineSaved = _onlineSignature;
    _applyActivePrinter();
    _applyActiveKassa();
    _applyActiveEgais();
    _applyActiveChestnyZnak();
    _applyActiveTerminal();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
    }
  }

  /// Реквизиты онлайн-оплаты, с которыми их последний раз сохранили.
  String _onlineSaved = '';
  String get _onlineSignature => [
        _onlineProvider,
        _onlineLoginCtrl.text.trim(),
        _onlinePasswordCtrl.text.trim(),
        _onlinePassword2Ctrl.text.trim(),
        _onlineTest,
        _onlineHash,
      ].join('\u0001');

  bool get _onlineReady {
    final p = OnlinePayProvider.byId(_onlineProvider);
    if (p == null) return false;
    if (_onlineLoginCtrl.text.trim().isEmpty || _onlinePasswordCtrl.text.trim().isEmpty) return false;
    return p.password2Label == null || _onlinePassword2Ctrl.text.trim().isNotEmpty;
  }

  /// Проверка реквизитов банком — без списания денег (см. guest-pay.js checkCreds).
  Future<void> _checkOnlinePay() async {
    setState(() {
      _onlineChecking = true;
      _onlineCheckResult = null;
    });
    try {
      await _save();
      final r = await GatewayApi.post('onlinePayCheck');
      final ok = r['ok'] == true;
      final enabled = r['enabled'] == true;
      final seller = r['sellerReady'] == true;
      _onlineVerified = ok;
      _onlineCheckResult = '${ok ? '✓' : '✗'} ${r['message'] ?? ''}'
          '${ok && !enabled ? '\nВключите «Гость оплачивает онлайн» в Профиле заведения — тогда гости увидят кнопку оплаты.' : ''}'
          '${ok && !seller ? '\nЗаполните реквизиты продавца в Профиле заведения — без них кнопки оплаты у гостей не будет.' : ''}';
    } catch (e) {
      _onlineCheckResult = '✗ $e';
    }
    if (mounted) setState(() => _onlineChecking = false);
  }

  /// «Т-Банк — СБП» → «Т-Банк» и «СБП»: название крупно, способ — подписью.
  static String _bankName(OnlinePayProvider p) => p.label.split(' — ').first;
  static String _bankKind(OnlinePayProvider p) {
    final kind = p.label.contains(' — ') ? p.label.split(' — ').last : '';
    return kind.isEmpty ? '' : kind[0].toUpperCase() + kind.substring(1);
  }

  Widget _onlinePaySection() {
    final p = OnlinePayProvider.byId(_onlineProvider);
    const base = kSaasGatewayUrl;
    final verified = p != null && _onlineVerified && _onlineSignature == _onlineSaved;
    return _Section(
      icon: Icons.qr_code_2,
      title: 'Онлайн-оплата гостей',
      status: p == null ? 'Не подключена' : '${_bankName(p)} · ${verified ? 'банк подтвердил' : 'не проверено'}',
      active: verified,
      children: [
        const _Hint('Гость оплачивает из приложения счёт за столом и заказ с собой или доставку. '
            'Деньги приходят на счёт заведения, касса видит «Оплачено онлайн». Кнопка оплаты '
            'у гостей появится, когда банк подтвердит подключение, а в Профиле заведения '
            'включена онлайн-оплата и заполнены реквизиты продавца.'),
        _Choice<String>(
          value: p == null ? '' : _onlineProvider,
          options: [
            const _Opt('', 'Не подключена'),
            for (final x in OnlinePayProvider.all) _Opt(x.id, _bankName(x), _bankKind(x)),
          ],
          onChanged: (v) => setState(() {
            _onlineProvider = v;
            _onlineCheckResult = null;
          }),
        ),
        if (p != null) ...[
          _Hint(p.hint),
          TextField(controller: _onlineLoginCtrl, decoration: InputDecoration(labelText: p.loginLabel)),
          TextField(
            controller: _onlinePasswordCtrl,
            obscureText: true,
            decoration: InputDecoration(labelText: p.passwordLabel),
          ),
          if (p.password2Label != null)
            TextField(
              controller: _onlinePassword2Ctrl,
              obscureText: true,
              decoration: InputDecoration(labelText: p.password2Label),
            ),
          if (p.id == 'robokassa') ...[
            const _Label('Алгоритм хеша — как в магазине Робокассы'),
            _Choice<String>(
              compact: true,
              value: const ['md5', 'sha1', 'sha256', 'sha384', 'sha512'].contains(_onlineHash) ? _onlineHash : 'md5',
              options: const [
                _Opt('md5', 'MD5'),
                _Opt('sha1', 'SHA1'),
                _Opt('sha256', 'SHA256'),
                _Opt('sha384', 'SHA384'),
                _Opt('sha512', 'SHA512'),
              ],
              onChanged: (v) => setState(() => _onlineHash = v),
            ),
            const _CodeBox('Технические настройки магазина Робокассы:\n'
                'Result URL — $base/guestPayRobokassa (POST или GET)\n'
                'Success URL и Fail URL — $base/guestPayDone (GET)'),
          ],
          if (p.hasTestMode)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Тестовый режим'),
              subtitle: Text(p.id == 'robokassa'
                  ? 'Деньги не списываются; нужны тестовые пароли магазина'
                  : 'Тестовый контур банка; нужны тестовые логин и пароль'),
              value: _onlineTest,
              onChanged: (v) => setState(() => _onlineTest = v),
            ),
          OutlinedButton.icon(
            onPressed: _onlineChecking ? null : _checkOnlinePay,
            icon: const Icon(Icons.verified_outlined),
            label: Text(_onlineChecking ? 'Проверяем…' : 'Сохранить и проверить подключение'),
          ),
          if (_onlineCheckResult != null) _Result(_onlineCheckResult!),
        ],
      ],
    );
  }

  void _applyActiveKassa() {
    kassaService = buildKassaService({
      'kassaType': _kassaType,
      'kassaBaseUrl': _kassaBaseUrlCtrl.text.trim(),
      'kassaGroupCode': _kassaGroupCodeCtrl.text.trim(),
      'kassaLogin': _kassaLoginCtrl.text.trim(),
      'kassaPassword': _kassaPasswordCtrl.text.trim(),
      'kassaInn': _kassaInnCtrl.text.trim(),
      'kassaEmail': _kassaEmailCtrl.text.trim(),
      'kassaPaymentAddress': _kassaPaymentAddressCtrl.text.trim(),
      'kassaCashier': _kassaCashierCtrl.text.trim(),
      'kassaCashierInn': _kassaCashierInnCtrl.text.trim(),
      'kassaSno': _kassaSno,
      'kassaVat': _kassaVat,
      'kassaApiVersion': _kassaApiVersion,
      'kassaOrangeKeyName': _kassaOrangeKeyNameCtrl.text.trim(),
      'kassaOrangeCertPem': _kassaOrangeCertPemCtrl.text.trim(),
      'kassaOrangeKeyPem': _kassaOrangeKeyPemCtrl.text.trim(),
      'kassaOrangeKeyPass': _kassaOrangeKeyPassCtrl.text,
      'kassaOrangeSignKeyPem': _kassaOrangeSignKeyPemCtrl.text.trim(),
      'kassaOrangeCaPem': _kassaOrangeCaPemCtrl.text.trim(),
    });
  }

  void _applyActiveTerminal() {
    paymentTerminalService = buildTerminalService({
      'terminalProvider': _terminalProvider.id,
      'terminalLogin': _terminalLoginCtrl.text.trim(),
      'terminalPassword': _terminalPasswordCtrl.text.trim(),
    });
  }

  void _applyActiveEgais() {
    activeEgaisService = buildEgaisService({
      'utmHost': _utmHostCtrl.text.trim(),
      'egaisEnabled': _egaisEnabled,
      'egaisFsrarId': _fsrarIdCtrl.text.trim(),
    });
  }

  void _applyActiveChestnyZnak() {
    final token = _czTokenCtrl.text.trim();
    activeChestnyZnakApi = token.isNotEmpty ? ChestnyZnakApiService(token: token, isPilot: _czCircuit != 'prod') : null;
  }

  Future<void> _pickBluetoothDevice() async {
    List<BluetoothInfo> devices;
    try {
      devices = await BluetoothReceiptPrinter.pairedDevices();
    } catch (e) {
      _showSnack('Не удалось получить список Bluetooth-устройств: ${humanError(e, lower: true)}');
      return;
    }
    if (!mounted) return;
    if (devices.isEmpty) {
      _showSnack('Нет сопряжённых Bluetooth-устройств — сначала свяжите принтер '
          'в системных настройках Bluetooth телефона/планшета');
      return;
    }
    final chosen = await showModalBottomSheet<BluetoothInfo>(
      context: context,
      builder: (_) => ListView(
        shrinkWrap: true,
        children: devices
            .map((d) => ListTile(
                  title: Text(d.name),
                  subtitle: Text(d.macAdress),
                  onTap: () => Navigator.of(context).pop(d),
                ))
            .toList(),
      ),
    );
    if (chosen != null) {
      setState(() {
        _printerType = 'bluetooth';
        _btMac = chosen.macAdress;
      });
    }
  }

  Future<void> _testPrinter() async {
    setState(() {
      _testing = true;
      _printerResult = null;
    });
    _applyActivePrinter();
    final printer = activeReceiptPrinter;
    if (printer == null) {
      setState(() {
        _testing = false;
        _printerResult = 'Принтер не выбран';
      });
      return;
    }
    try {
      await printer.printReceipt(ReceiptData(
        venueName: 'Тестовая печать',
        tableName: '—',
        employeeName: '—',
        closedAt: DateTime.now(),
        items: const [ReceiptLine('Тестовая строка', right: '0')],
        total: 0,
        paymentMethod: '—',
        footerNote: 'Если вы это видите — принтер настроен верно',
      ));
      if (mounted) setState(() => _printerResult = 'Чек отправлен на печать');
    } catch (e) {
      if (mounted) setState(() => _printerResult = 'Ошибка печати: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _testUtm() async {
    setState(() {
      _testing = true;
      _utmResult = null;
    });
    final host = _utmHostCtrl.text.trim();
    if (host.isEmpty) {
      setState(() {
        _testing = false;
        _utmResult = 'Укажите адрес компьютера с УТМ';
      });
      return;
    }
    final service = EgaisUtmService(utmHost: host, fsrarId: _fsrarIdCtrl.text.trim());
    final status = await service.checkConnection();
    List<EgaisIncomingDoc>? docs;
    if (status.ok) {
      try {
        docs = await service.incomingDocuments();
      } catch (_) {}
    }
    if (!mounted) return;
    setState(() {
      _testing = false;
      _utmResult = status.message;
      _egaisDocs = docs;
    });
  }

  Future<void> _testKassa() async {
    setState(() {
      _testing = true;
      _kassaResult = null;
    });
    _applyActiveKassa();
    final local = kassaService;
    if (local is AtolLocalKassaService) {
      // Регистратору не шлём тестовый чек — он был бы настоящим
      // фискальным документом. Спрашиваем только состояние.
      final status = await local.checkStatus();
      if (!mounted) return;
      setState(() {
        _testing = false;
        _kassaResult = status;
      });
      return;
    }
    if (!kassaService.isAvailable) {
      setState(() {
        _testing = false;
        _kassaResult = _kassaType == 'orange_data'
            ? 'Заполните ИНН, клиентский сертификат и его ключ'
            : 'Заполните логин, пароль, group code и ИНН';
      });
      return;
    }
    final result = await kassaService.sendReceipt(FiscalReceipt(
      receiptId: 'test-${DateTime.now().millisecondsSinceEpoch}',
      items: const [FiscalReceiptItem(name: 'Тестовая позиция', price: 1, quantity: 1)],
      payments: const [FiscalPayment('cash', 1)],
    ));
    if (!mounted) return;
    setState(() {
      _testing = false;
      _kassaResult =
          result.success ? 'Чек принят, ФД: ${result.fiscalDocumentNumber ?? '—'}' : 'Ошибка: ${result.errorMessage}';
    });
  }

  /// Какие поля показывать под выбранным провайдером терминала — у каждого
  /// банка свои названия учётных данных, а у ручного терминала их нет
  /// вовсе. null/null — полей не показываем.
  ({String? first, String? second}) _terminalFields(TerminalProvider p) {
    switch (p) {
      case TerminalProvider.manual:
        return (first: null, second: null);
      case TerminalProvider.tinkoffSbp:
        return (first: 'TerminalKey', second: 'Пароль терминала');
      case TerminalProvider.sberUpos:
        return (first: r'Папка UPOS с sb_pilot.exe (пусто — C:\sc552)', second: null);
    }
  }

  /// Пробный платёж на 1 ₽ — для Т-Банка это реальный запрос Init+GetQr к
  /// боевому API (тестовых сумм там не бывает, зато рубль не жалко).
  /// Ручной терминал ничего не запрашивает у банка — проверять нечего.
  Future<void> _testTerminal() async {
    if (_terminalProvider == TerminalProvider.manual) {
      setState(() => _terminalTestResult = 'Этот режим ничего не запрашивает у банка — '
          'проверять нечего, он «доступен» всегда.');
      return;
    }
    setState(() {
      _terminalTesting = true;
      _terminalTestResult = null;
    });
    _applyActiveTerminal();
    if (!paymentTerminalService.isAvailable) {
      setState(() {
        _terminalTesting = false;
        _terminalTestResult = _terminalProvider == TerminalProvider.sberUpos
            ? 'Терминал через UPOS подключается к Windows-кассе — проверьте с неё'
            : 'Заполните логин/пароль терминала';
      });
      return;
    }
    final result = await paymentTerminalService.pay(1, context: mounted ? context : null);
    if (!mounted) return;
    setState(() {
      _terminalTesting = false;
      _terminalTestResult =
          result.success ? 'Готово: ${result.operationId ?? 'оплата подтверждена'}' : 'Ошибка: ${result.errorMessage}';
    });
  }

  /// Проверяет один код через реальный метод `codes/check` выбранного
  /// контура «Честного знака» — удобно, чтобы прямо из настроек убедиться,
  /// что токен и контур подобраны верно, до того как проверка заработает
  /// на кассе при сканировании.
  Future<void> _testChestnyZnak() async {
    final code = _czTestCodeCtrl.text.trim();
    if (code.isEmpty) {
      setState(() => _czTestResult = 'Вставьте отсканированный код для проверки');
      return;
    }
    final token = _czTokenCtrl.text.trim();
    if (token.isEmpty) {
      setState(() => _czTestResult = 'Укажите токен «Честного знака»');
      return;
    }
    setState(() {
      _czTesting = true;
      _czTestResult = null;
    });
    try {
      final api = ChestnyZnakApiService(token: token, isPilot: _czCircuit != 'prod');
      final results = await api.checkCodes([code]);
      if (!mounted) return;
      if (results.isEmpty) {
        setState(() => _czTestResult = 'Пустой ответ от «Честного знака»');
      } else {
        final r = results.first;
        setState(() => _czTestResult = !r.valid
            ? 'Код не найден в системе (возможна подделка)'
            : r.alreadyRetired
                ? 'Код найден, но уже выведен из оборота ранее'
                : 'Код найден и не продан — можно продавать');
      }
    } catch (e) {
      if (mounted) setState(() => _czTestResult = 'Ошибка: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _czTesting = false);
    }
  }

  /// Открывает камеру и подставляет отсканированный код в поле проверки —
  /// чтобы не набирать длинную строку DataMatrix руками. HID-сканер тоже
  /// работает сразу в это поле (можно просто кликнуть в поле и отсканировать
  /// "пистолетом" — он печатает как клавиатура), кнопка нужна именно для
  /// сканирования камерой телефона/планшета.
  Future<void> _scanTestCode() async {
    final code = await showCompactCameraScanner(context, title: 'Сканирование кода');
    if (code != null && mounted) {
      setState(() => _czTestCodeCtrl.text = code);
    }
  }

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  void dispose() {
    _onlineLoginCtrl.dispose();
    _onlinePasswordCtrl.dispose();
    _onlinePassword2Ctrl.dispose();
    _kitchenIpCtrl.dispose();
    _barIpCtrl.dispose();
    _networkIpCtrl.dispose();
    _utmHostCtrl.dispose();
    _fsrarIdCtrl.dispose();
    _kassaBaseUrlCtrl.dispose();
    _kassaOrangeKeyPassCtrl.dispose();
    _kassaOrangeSignKeyPemCtrl.dispose();
    _kassaOrangeCaPemCtrl.dispose();
    _kassaGroupCodeCtrl.dispose();
    _kassaLoginCtrl.dispose();
    _kassaPasswordCtrl.dispose();
    _kassaInnCtrl.dispose();
    _kassaEmailCtrl.dispose();
    _kassaPaymentAddressCtrl.dispose();
    _kassaCashierCtrl.dispose();
    _kassaCashierInnCtrl.dispose();
    _kassaOrangeKeyNameCtrl.dispose();
    _kassaOrangeCertPemCtrl.dispose();
    _kassaOrangeKeyPemCtrl.dispose();
    _czTokenCtrl.dispose();
    _czTestCodeCtrl.dispose();
    _terminalLoginCtrl.dispose();
    _terminalPasswordCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Интеграции')),
      body: CenteredBody(
        maxWidth: Breakpoints.form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: _Hint('Нажмите на раздел, чтобы открыть настройки. Они общие для всех касс заведения.'),
            ),
            _printerSection(),
            _kassaSection(),
            _terminalSection(),
            _onlinePaySection(),
            _egaisSection(),
            _czSection(),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Center(
            heightFactor: 1,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: Breakpoints.form - 32),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _save,
                  child: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('Сохранить'),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _printerSection() {
    final ip = _networkIpCtrl.text.trim();
    return _Section(
      icon: Icons.print_outlined,
      title: 'Чековый принтер',
      status: switch (_printerType) {
        'bluetooth' => _btMac.isEmpty ? 'Bluetooth · устройство не выбрано' : 'Bluetooth · $_btMac',
        'network' => 'Wi-Fi / LAN · ${ip.isEmpty ? 'IP не указан' : ip}',
        _ => 'Не подключён',
      },
      active: _printerType != 'none',
      children: [
        const _Hint('Печатает пречек и бегунки — это не фискальный чек. '
            'Чек по 54-ФЗ — в разделе «Онлайн-касса».'),
        // На Windows Bluetooth нет: print_bluetooth_thermal там работает
        // через BLE, а дешёвые принтеры — через classic SPP, и
        // «подключённый» принтер не печатал бы.
        _Choice<String>(
          value: _printerType,
          options: [
            const _Opt('none', 'Не подключён'),
            if (!isWindowsApp) _Opt('bluetooth', 'Bluetooth', _btMac.isEmpty ? 'Устройство не выбрано' : _btMac),
            const _Opt('network', 'Wi-Fi / LAN', 'Сетевой принтер, порт 9100'),
          ],
          onChanged: (v) => setState(() => _printerType = v),
        ),
        if (_printerType == 'bluetooth' && !isWindowsApp)
          OutlinedButton.icon(
            onPressed: _pickBluetoothDevice,
            icon: const Icon(Icons.bluetooth_searching, size: 18),
            label: const Text('Выбрать устройство'),
          ),
        if (_printerType == 'network')
          TextField(
            controller: _networkIpCtrl,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(labelText: 'IP-адрес принтера', hintText: '192.168.1.100'),
          ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _splitHookah,
          onChanged: (v) => setState(() => _splitHookah = v),
          title: const Text('Кальяны — отдельным чеком'),
          subtitle: const Text('Два чека: «Кальяны» и «Кухня и бар». Кассир может переключить при оплате. '
              'Что считается кальяном — по категории в «Меню».'),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _kitchenTickets,
          onChanged: (v) => setState(() => _kitchenTickets = v),
          title: const Text('Бегунки на кухню и бар'),
          subtitle: const Text('Кнопка «На кухню» в счёте печатает новые позиции отдельно для кухни, '
              'бара и кальянов. Не нужны, если на кухне есть экран «Кухня и бар».'),
        ),
        if (_kitchenTickets) ...[
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _kitchenAuto,
            onChanged: (v) => setState(() => _kitchenAuto = v),
            title: const Text('Отправлять сразу'),
            subtitle: const Text('Бегунок печатается сам, когда официант вернулся из меню в счёт.'),
          ),
          TextField(
            controller: _kitchenIpCtrl,
            decoration: const InputDecoration(
              labelText: 'Принтер кухни — IP (необязательно)',
              hintText: '192.168.1.101',
              helperText: 'Пусто — бегунки кухни печатает чековый принтер',
              helperMaxLines: 2,
            ),
          ),
          TextField(
            controller: _barIpCtrl,
            decoration: const InputDecoration(
              labelText: 'Принтер бара и кальянов — IP (необязательно)',
              hintText: '192.168.1.102',
              helperText: 'Пусто — печатает чековый принтер',
              helperMaxLines: 2,
            ),
          ),
        ],
        OutlinedButton.icon(
          onPressed: _testing ? null : _testPrinter,
          icon: const Icon(Icons.print),
          label: const Text('Тестовая печать'),
        ),
        if (_printerResult != null) _Result(_printerResult!),
      ],
    );
  }

  static const _kassaNames = {
    'atol_local': 'АТОЛ в заведении',
    'atol_cloud': 'Облачная · АТОЛ Онлайн',
    'orange_data': 'Облачная · OrangeData',
  };

  Widget _kassaSection() => _Section(
        icon: Icons.receipt_long_outlined,
        title: 'Онлайн-касса (54-ФЗ)',
        status: _kassaNames[_kassaType] ?? 'Не подключена',
        active: _kassaType != 'none',
        children: [
          const _Hint('Чек по 54-ФЗ нужен при каждой оплате: нужны договор с ОФД и ККТ, '
              'зарегистрированная в налоговой. Пока касса не подключена, пробивайте чеки на своей ККТ.'),
          _Choice<String>(
            value: _kassaType,
            options: const [
              _Opt('none', 'Не подключена', 'Чек пробиваете на своей ККТ отдельно'),
              _Opt('atol_local', 'Регистратор АТОЛ в заведении',
                  'Работает без интернета: «Веб-сервер ККТ» из драйвера АТОЛ 10 в локальной сети'),
              _Opt('atol_cloud', 'Облачная касса — АТОЛ Онлайн',
                  'Тот же протокол у Ferma, OFD.ru и других — со своим адресом API'),
              _Opt('orange_data', 'Облачная касса — OrangeData', 'ФФД 1.2, подходит для маркированных товаров'),
            ],
            onChanged: (v) => setState(() => _kassaType = v),
          ),
          if (_kassaType == 'atol_local') ...[
            TextField(
              controller: _kassaBaseUrlCtrl,
              decoration: const InputDecoration(
                labelText: 'Адрес веб-сервера АТОЛ',
                hintText: '192.168.1.50',
                helperText: 'IP компьютера или смарт-кассы с драйвером АТОЛ; порт по умолчанию 16732',
                helperMaxLines: 2,
              ),
            ),
            const _Label('Формат документов'),
            _Choice<String>(
              compact: true,
              value: _kassaApiVersion,
              options: const [_Opt('v5', 'ФФД 1.2 — рекомендуется'), _Opt('v4', 'ФФД 1.05')],
              onChanged: (v) => setState(() => _kassaApiVersion = v),
            ),
            TextField(
              controller: _kassaCashierCtrl,
              decoration: const InputDecoration(
                labelText: 'Кассир в чеке (необязательно)',
                helperText: 'Пусто — кассир из настроек регистратора',
              ),
            ),
            TextField(
              controller: _kassaCashierInnCtrl,
              decoration: const InputDecoration(labelText: 'ИНН кассира (необязательно)'),
              keyboardType: TextInputType.number,
            ),
          ],
          if (_kassaType == 'atol_cloud') ...[
            TextField(
              controller: _kassaBaseUrlCtrl,
              decoration: const InputDecoration(
                labelText: 'Адрес API провайдера (необязательно)',
                hintText: 'https://online.atol.ru',
                helperText: 'Пусто — АТОЛ Онлайн. Тестовый контур: https://testonline.atol.ru',
                helperMaxLines: 2,
              ),
            ),
            TextField(controller: _kassaGroupCodeCtrl, decoration: const InputDecoration(labelText: 'Group code')),
            TextField(controller: _kassaLoginCtrl, decoration: const InputDecoration(labelText: 'Логин')),
            TextField(
              controller: _kassaPasswordCtrl,
              decoration: const InputDecoration(labelText: 'Пароль'),
              obscureText: true,
            ),
            const _Label('Протокол'),
            _Choice<String>(
              compact: true,
              value: _kassaApiVersion,
              options: const [_Opt('v5', 'v5 · ФФД 1.2 — рекомендуется'), _Opt('v4', 'v4 · ФФД 1.05')],
              onChanged: (v) => setState(() => _kassaApiVersion = v),
            ),
            TextField(
              controller: _kassaEmailCtrl,
              decoration: const InputDecoration(
                labelText: 'E-mail продавца (для чека)',
                helperText: 'Если гость не оставил контакт, электронный чек уйдёт на этот адрес',
                helperMaxLines: 2,
              ),
            ),
            TextField(
              controller: _kassaPaymentAddressCtrl,
              decoration: const InputDecoration(labelText: 'Место расчётов', hintText: 'г. Москва, ул. ...'),
            ),
          ],
          if (_kassaType == 'orange_data') ...[
            TextField(
              controller: _kassaBaseUrlCtrl,
              decoration: const InputDecoration(
                labelText: 'Адрес API (необязательно)',
                hintText: OrangeDataKassaService.defaultBaseUrl,
                helperText: 'Пусто — боевой контур. Тестовый: ${OrangeDataKassaService.testBaseUrl}',
                helperMaxLines: 2,
              ),
            ),
            TextField(
              controller: _kassaGroupCodeCtrl,
              decoration: const InputDecoration(labelText: 'Группа устройств (group)'),
            ),
            TextField(
              controller: _kassaOrangeKeyNameCtrl,
              decoration: const InputDecoration(labelText: 'Имя ключа подписи (key, необязательно)'),
            ),
            TextField(
              controller: _kassaOrangeCertPemCtrl,
              decoration: const InputDecoration(labelText: 'Клиентский сертификат (client.crt)'),
              maxLines: 4,
            ),
            TextField(
              controller: _kassaOrangeKeyPemCtrl,
              decoration: const InputDecoration(labelText: 'Ключ сертификата (client.key)'),
              maxLines: 4,
            ),
            TextField(
              controller: _kassaOrangeKeyPassCtrl,
              decoration: const InputDecoration(labelText: 'Пароль ключа сертификата (если есть)'),
              obscureText: true,
            ),
            TextField(
              controller: _kassaOrangeSignKeyPemCtrl,
              decoration: const InputDecoration(
                labelText: 'Ключ подписи запросов (private_key.pem)',
                helperText: 'Отдельный от client.key; его открытую часть загружают в ЛК OrangeData',
                helperMaxLines: 2,
              ),
              maxLines: 4,
            ),
            TextField(
              controller: _kassaOrangeCaPemCtrl,
              decoration: const InputDecoration(labelText: 'Корневой сертификат OrangeData (cacert.pem)'),
              maxLines: 4,
            ),
          ],
          if (_kassaType != 'none') ...[
            if (_kassaType != 'atol_local')
              TextField(controller: _kassaInnCtrl, decoration: const InputDecoration(labelText: 'ИНН организации')),
            const _Label('Система налогообложения'),
            _Choice<String>(
              compact: true,
              value: _kassaSno,
              options: const [
                _Opt('osn', 'ОСН'),
                _Opt('usn_income', 'УСН доход'),
                _Opt('usn_income_outcome', 'УСН доход − расход'),
                _Opt('envd', 'ЕНВД'),
                _Opt('esn', 'ЕСН'),
                _Opt('patent', 'Патент'),
              ],
              onChanged: (v) => setState(() => _kassaSno = v),
            ),
            const _Label('Ставка НДС по умолчанию — для позиций меню без своей ставки'),
            _Choice<String>(
              compact: true,
              value: _kassaVat,
              options: [for (final v in FiscalVatRate.values) _Opt(v.id, v.label)],
              onChanged: (v) => setState(() => _kassaVat = v),
            ),
          ],
          OutlinedButton.icon(
            onPressed: _testing ? null : _testKassa,
            icon: const Icon(Icons.receipt_long),
            label: Text(_kassaType == 'atol_local' ? 'Проверить связь с регистратором' : 'Тестовый чек'),
          ),
          if (_kassaResult != null) _Result(_kassaResult!),
        ],
      );

  Widget _terminalSection() {
    final fields = _terminalFields(_terminalProvider);
    return _Section(
      icon: Icons.credit_card,
      title: 'Терминал оплаты',
      status: _terminalProvider.label,
      active: true,
      children: [
        const _Hint('Как касса принимает карты у стойки. Оплата гостями из приложения — '
            'в разделе «Онлайн-оплата гостей».'),
        _Choice<TerminalProvider>(
          value: _terminalProvider,
          options: const [
            _Opt(TerminalProvider.manual, 'Ручной терминал — любой банк',
                'Сумму набирают на терминале, касса спрашивает, прошла ли оплата'),
            _Opt(TerminalProvider.tinkoffSbp, 'Т-Банк — QR СБП на экране кассы', 'Без терминала'),
            _Opt(TerminalProvider.sberUpos, 'Сбер — терминал на кассе',
                'Сумма уходит на терминал сама: Windows-касса с кабелем, UPOS'),
          ],
          onChanged: (v) => setState(() => _terminalProvider = v),
        ),
        if (fields.first != null)
          TextField(controller: _terminalLoginCtrl, decoration: InputDecoration(labelText: fields.first)),
        if (fields.second != null)
          TextField(
            controller: _terminalPasswordCtrl,
            decoration: InputDecoration(labelText: fields.second),
            obscureText: true,
          ),
        OutlinedButton.icon(
          onPressed: _terminalTesting ? null : _testTerminal,
          icon: const Icon(Icons.point_of_sale),
          label: Text(_terminalProvider == TerminalProvider.tinkoffSbp ? 'Тест: показать QR на 1 ₽' : 'Проверить'),
        ),
        if (_terminalTestResult != null) _Result(_terminalTestResult!),
      ],
    );
  }

  Widget _egaisSection() => _Section(
        icon: Icons.liquor_outlined,
        title: 'ЕГАИС (алкоголь)',
        status: !_egaisEnabled
            ? 'Выключен — алкоголь не продаётся'
            : _utmHostCtrl.text.trim().isEmpty
                ? 'Включён · не указан УТМ'
                : 'Включён · УТМ ${_utmHostCtrl.text.trim()}',
        active: _egaisEnabled && _utmHostCtrl.text.trim().isNotEmpty,
        children: [
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _egaisEnabled,
            onChanged: (v) => setState(() => _egaisEnabled = v),
            title: const Text('В заведении продаётся алкоголь (включая пиво)'),
            subtitle: const Text('Без алкоголя ЕГАИС не нужен — оставьте выключенным.'),
          ),
          if (_egaisEnabled) ...[
            const _Hint('Общепит не отправляет в ЕГАИС каждую продажу: принимает накладные поставщиков, '
                'переводит продукцию в зал и в день вскрытия бутылки крепкого алкоголя отмечает её. '
                'Документы подписываются в УТМ на компьютере заведения. Здесь — связь с УТМ и '
                'входящие документы: касса покажет, что пришла новая накладная.'),
            TextField(
              controller: _fsrarIdCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'ФСРАР ИД организации', hintText: '030000000000'),
            ),
            TextField(
              controller: _utmHostCtrl,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'IP компьютера с УТМ', hintText: '192.168.1.50'),
            ),
            OutlinedButton.icon(
              onPressed: _testing ? null : _testUtm,
              icon: const Icon(Icons.wifi_tethering),
              label: const Text('Проверить связь и входящие документы'),
            ),
            if (_utmResult != null) _Result(_utmResult!),
            if (_egaisDocs != null && _egaisDocs!.isNotEmpty)
              Column(
                children: [
                  for (final d in _egaisDocs!.take(20))
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(d.isWaybill ? Icons.local_shipping_outlined : Icons.description_outlined,
                          color: d.isWaybill ? AppColors.warning : null),
                      title: Text(d.label),
                      subtitle: Text(d.type, style: const TextStyle(fontSize: 11)),
                    ),
                ],
              ),
          ],
        ],
      );

  Widget _czSection() {
    final token = _czTokenCtrl.text.trim().isNotEmpty;
    return _Section(
      icon: Icons.qr_code_scanner,
      title: 'Честный ЗНАК (маркировка)',
      status: !token
          ? 'Онлайн-проверка выключена'
          : _czCircuit == 'prod'
              ? 'Боевой контур'
              : 'Пилот (тестовый контур)',
      active: token,
      children: [
        const _Hint('Онлайн-проверка кода при сканировании: подлинность и выбытие — в ИС МП. '
            'Защита от повторной продажи работает и без токена. Списание кода при продаже — '
            'через онлайн-кассу (тег 1162).'),
        _Choice<String>(
          value: _czCircuit,
          options: const [
            _Opt('pilot', 'Пилот (тестовый контур)', 'markirovka.sandbox.crptech.ru — начните с него'),
            _Opt('prod', 'Боевой контур', 'markirovka.crpt.ru'),
          ],
          onChanged: (v) => setState(() => _czCircuit = v),
        ),
        TextField(
          controller: _czTokenCtrl,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: 'Токен для ККТ',
            hintText: 'честныйзнак.рф → профиль',
          ),
          obscureText: true,
        ),
        TextField(
          controller: _czTestCodeCtrl,
          decoration: InputDecoration(
            labelText: 'Код для проверки (необязательно)',
            hintText: 'отсканированный DataMatrix целиком',
            // На Windows нет камеры для сканера — поле по-прежнему
            // принимает HID-сканер ("пистолет") и ручной ввод, см.
            // комментарий у _scanTestCode.
            suffixIcon: isWindowsApp
                ? null
                : IconButton(
                    icon: const Icon(Icons.camera_alt),
                    tooltip: 'Сканировать камерой',
                    onPressed: _scanTestCode,
                  ),
          ),
        ),
        OutlinedButton.icon(
          onPressed: _czTesting ? null : _testChestnyZnak,
          icon: const Icon(Icons.qr_code_scanner),
          label: const Text('Проверить код'),
        ),
        if (_czTestResult != null) _Result(_czTestResult!),
      ],
    );
  }
}

/// Раздел экрана: карточка с иконкой, названием и строкой состояния.
/// Свёрнута, пока её не открыли, — экран читается как список подключений,
/// а не как простыня из полей.
class _Section extends StatefulWidget {
  final IconData icon;
  final String title;
  final String status;
  final bool active;
  final List<Widget> children;

  const _Section({
    required this.icon,
    required this.title,
    required this.status,
    required this.active,
    required this.children,
  });

  @override
  State<_Section> createState() => _SectionState();
}

class _SectionState extends State<_Section> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _open ? AppColors.primary.withValues(alpha: 0.5) : AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(color: AppColors.selection, borderRadius: BorderRadius.circular(12)),
                    child: Icon(widget.icon, color: AppColors.brass, size: 22),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.title,
                            style: const TextStyle(
                                color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 3),
                        Row(
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: widget.active ? AppColors.success : AppColors.disabledText,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                widget.status,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    color: widget.active ? AppColors.success : AppColors.textMuted, fontSize: 13),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  AnimatedRotation(
                    turns: _open ? 0.5 : 0,
                    duration: const Duration(milliseconds: 200),
                    child: const Icon(Icons.expand_more, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: !_open
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Divider(height: 1),
                        const SizedBox(height: 14),
                        for (var i = 0; i < widget.children.length; i++) ...[
                          if (i > 0) const SizedBox(height: 12),
                          widget.children[i],
                        ],
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _Opt<T> {
  final T value;
  final String title;
  final String subtitle;
  const _Opt(this.value, this.title, [this.subtitle = '']);
}

/// Выбор одного варианта карточками. Выпадающий список на планшете
/// раскрывался поверх всего экрана и выглядел чужеродно; карточки видно
/// сразу, и выбранная выделена. [compact] — короткие подписи в строку.
class _Choice<T> extends StatelessWidget {
  final T value;
  final List<_Opt<T>> options;
  final ValueChanged<T> onChanged;
  final bool compact;

  const _Choice({required this.value, required this.options, required this.onChanged, this.compact = false});

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return Wrap(spacing: 8, runSpacing: 8, children: [for (final o in options) _chip(o)]);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < options.length; i++) ...[
          if (i > 0) const SizedBox(height: 8),
          _tile(options[i]),
        ],
      ],
    );
  }

  BoxDecoration _box(bool on, double radius) => BoxDecoration(
        color: on ? AppColors.selection : AppColors.surfaceElevated,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: on ? AppColors.primary : AppColors.border, width: on ? 1.5 : 1),
      );

  Widget _tile(_Opt<T> o) {
    final on = o.value == value;
    return Semantics(
      inMutuallyExclusiveGroup: true,
      checked: on,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => onChanged(o.value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          padding: const EdgeInsets.all(12),
          decoration: _box(on, 12),
          child: Row(
            children: [
              Icon(on ? Icons.radio_button_checked : Icons.radio_button_off,
                  size: 20, color: on ? AppColors.primary : AppColors.textMuted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(o.title,
                        style: TextStyle(
                            color: AppColors.textPrimary, fontWeight: on ? FontWeight.w600 : FontWeight.w500)),
                    if (o.subtitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(o.subtitle,
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.3)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chip(_Opt<T> o) {
    final on = o.value == value;
    return Semantics(
      inMutuallyExclusiveGroup: true,
      checked: on,
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => onChanged(o.value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: _box(on, 10),
          child: Text(o.title,
              style: TextStyle(
                  color: on ? AppColors.textPrimary : AppColors.textMuted,
                  fontWeight: on ? FontWeight.w600 : FontWeight.w500,
                  fontSize: 13.5)),
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4));
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);

  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(color: AppColors.textPrimary, fontSize: 13, fontWeight: FontWeight.w600));
}

/// Адреса и значения, которые переписывают в кабинет банка, — моноширинно
/// и с возможностью выделить и скопировать.
class _CodeBox extends StatelessWidget {
  final String text;
  const _CodeBox(this.text);

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.background,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.border),
        ),
        child: SelectableText(text,
            style: const TextStyle(
                color: AppColors.textPrimary, fontSize: 12.5, height: 1.5, fontFamily: 'monospace')),
      );
}

/// Итог проверки подключения — рамкой зелёной при успехе и красной при ошибке.
class _Result extends StatelessWidget {
  final String text;
  const _Result(this.text);

  @override
  Widget build(BuildContext context) {
    final bad = text.startsWith('✗') || text.startsWith('Ошибка');
    final good = text.startsWith('✓');
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: bad ? AppColors.danger : good ? AppColors.success : AppColors.border),
      ),
      child: SelectableText(text, style: const TextStyle(color: AppColors.textPrimary, height: 1.4)),
    );
  }
}
