import 'dart:io' show Platform;
import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import '../../services/printer_service.dart';
import '../../services/egais_service.dart';
import '../../services/kassa_service.dart';
import '../../services/chestny_znak_api_service.dart';
import '../../services/payment_terminal_service.dart';
import '../../services/scanner_service.dart';
import '../../models/fiscal_receipt.dart';

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
  String _btMac = '';
  final _networkIpCtrl = TextEditingController();
  final _utmHostCtrl = TextEditingController();
  String _kassaType = 'mock'; // mock | atol_cloud | orange_data | cloud_kassir
  final _kassaBaseUrlCtrl = TextEditingController();
  final _kassaGroupCodeCtrl = TextEditingController();
  final _kassaLoginCtrl = TextEditingController();
  final _kassaPasswordCtrl = TextEditingController();
  final _kassaInnCtrl = TextEditingController();
  final _kassaEmailCtrl = TextEditingController();
  final _kassaPaymentAddressCtrl = TextEditingController();
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
  String? _testResult;
  bool _czTesting = false;
  String? _czTestResult;
  bool _terminalTesting = false;
  String? _terminalTestResult;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final snap = await _doc.get();
    final data = snap.data() ?? {};
    _printerType = data['printerType'] ?? 'none';
    _btMac = data['printerBtMac'] ?? '';
    _networkIpCtrl.text = data['printerIp'] ?? '';
    _utmHostCtrl.text = data['utmHost'] ?? '';
    _kassaType = data['kassaType'] ?? 'mock';
    _kassaBaseUrlCtrl.text = data['kassaBaseUrl'] ?? '';
    _kassaGroupCodeCtrl.text = data['kassaGroupCode'] ?? '';
    _kassaLoginCtrl.text = data['kassaLogin'] ?? '';
    _kassaPasswordCtrl.text = data['kassaPassword'] ?? '';
    _kassaInnCtrl.text = data['kassaInn'] ?? '';
    _kassaEmailCtrl.text = data['kassaEmail'] ?? '';
    _kassaPaymentAddressCtrl.text = data['kassaPaymentAddress'] ?? '';
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
    if (_printerType == 'bluetooth' && _btMac.isNotEmpty && !Platform.isWindows) {
      activeReceiptPrinter = BluetoothReceiptPrinter(macAddress: _btMac);
    } else if (_printerType == 'network' && _networkIpCtrl.text.trim().isNotEmpty) {
      activeReceiptPrinter = NetworkReceiptPrinter(ip: _networkIpCtrl.text.trim());
    } else {
      activeReceiptPrinter = null;
    }
  }

  Future<void> _save() async {
    await _doc.set({
      'printerType': _printerType,
      'printerBtMac': _btMac,
      'printerIp': _networkIpCtrl.text.trim(),
      'utmHost': _utmHostCtrl.text.trim(),
      'kassaType': _kassaType,
      'kassaBaseUrl': _kassaBaseUrlCtrl.text.trim(),
      'kassaGroupCode': _kassaGroupCodeCtrl.text.trim(),
      'kassaLogin': _kassaLoginCtrl.text.trim(),
      'kassaPassword': _kassaPasswordCtrl.text.trim(),
      'kassaInn': _kassaInnCtrl.text.trim(),
      'kassaEmail': _kassaEmailCtrl.text.trim(),
      'kassaPaymentAddress': _kassaPaymentAddressCtrl.text.trim(),
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
    }, SetOptions(merge: true));
    _applyActivePrinter();
    _applyActiveKassa();
    _applyActiveEgais();
    _applyActiveChestnyZnak();
    _applyActiveTerminal();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
    }
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
    final host = _utmHostCtrl.text.trim();
    activeEgaisService = host.isNotEmpty ? EgaisUtmService(utmHost: host) : null;
  }

  void _applyActiveChestnyZnak() {
    final token = _czTokenCtrl.text.trim();
    activeChestnyZnakApi =
        token.isNotEmpty ? ChestnyZnakApiService(token: token, isPilot: _czCircuit != 'prod') : null;
  }

  Future<void> _pickBluetoothDevice() async {
    List<BluetoothInfo> devices;
    try {
      devices = await BluetoothReceiptPrinter.pairedDevices();
    } catch (e) {
      _showSnack('Не удалось получить список Bluetooth-устройств: $e');
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
      _testResult = null;
    });
    _applyActivePrinter();
    final printer = activeReceiptPrinter;
    if (printer == null) {
      setState(() {
        _testing = false;
        _testResult = 'Принтер не выбран';
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
      setState(() => _testResult = 'Чек отправлен на печать');
    } catch (e) {
      setState(() => _testResult = 'Ошибка печати: $e');
    } finally {
      setState(() => _testing = false);
    }
  }

  Future<void> _testUtm() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final host = _utmHostCtrl.text.trim();
    if (host.isEmpty) {
      setState(() {
        _testing = false;
        _testResult = 'Укажите адрес компьютера с УТМ';
      });
      return;
    }
    final status = await EgaisUtmService(utmHost: host).checkConnection();
    setState(() {
      _testing = false;
      _testResult = status.message;
    });
  }

  Future<void> _testKassa() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    _applyActiveKassa();
    if (!kassaService.isAvailable) {
      setState(() {
        _testing = false;
        _testResult = _kassaType == 'orange_data'
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
    setState(() {
      _testing = false;
      _testResult = result.success
          ? 'Чек принят, ФД: ${result.fiscalDocumentNumber ?? '—'}'
          : 'Ошибка: ${result.errorMessage}';
    });
  }

  /// Какие поля показывать под выбранным провайдером терминала — у каждого
  /// банка свои названия учётных данных, а у ручного терминала их нет
  /// вовсе. null/null — полей не показываем.
  ({String? first, String? second}) _terminalFields(TerminalProvider p) {
    switch (p) {
      case TerminalProvider.manual:
      case TerminalProvider.mock:
        return (first: null, second: null);
      case TerminalProvider.tinkoffSbp:
        return (first: 'TerminalKey', second: 'Пароль терминала');
      case TerminalProvider.sber:
        return (first: 'Логин', second: 'Пароль');
      case TerminalProvider.vtb:
        return (first: 'Merchant ID', second: 'Секретный ключ');
      case TerminalProvider.alfa:
        return (first: 'Логин', second: 'Пароль');
      case TerminalProvider.tochka:
        return (first: 'Merchant ID', second: 'API-токен');
      case TerminalProvider.mpos:
        return (first: 'API-ключ', second: null);
      case TerminalProvider.ingenico:
      case TerminalProvider.verifone:
        return (first: 'Сопряжение (MAC/серийный номер)', second: null);
    }
  }

  /// Пробный платёж на 1 ₽ — для Т-Банка это реальный запрос Init+GetQr к
  /// боевому API (тестовых сумм там не бывает, зато рубль не жалко), для
  /// остальных провайдеров без реализации просто покажет, что дальше
  /// нужна их документация. Ручной терминал и заглушку тестировать
  /// незачем — они по определению «доступны».
  Future<void> _testTerminal() async {
    if (_terminalProvider == TerminalProvider.manual || _terminalProvider == TerminalProvider.mock) {
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
        _terminalTestResult = 'Заполните логин/пароль терминала';
      });
      return;
    }
    final result = await paymentTerminalService.pay(1, context: mounted ? context : null);
    if (!mounted) return;
    setState(() {
      _terminalTesting = false;
      _terminalTestResult = result.success
          ? 'Готово: ${result.operationId ?? 'оплата подтверждена'}'
          : 'Ошибка: ${result.errorMessage}';
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
      setState(() => _czTestResult = 'Ошибка: $e');
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
    _networkIpCtrl.dispose();
    _utmHostCtrl.dispose();
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
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Чековый принтер', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'Печатается информационный чек (не фискальный). Для фискального '
            'чека по 54-ФЗ нужна отдельная онлайн-касса — см. README проекта.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 12),
          RadioGroup<String>(
            groupValue: _printerType,
            onChanged: (v) => setState(() => _printerType = v!),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const RadioListTile<String>(
                  title: Text('Не подключён'),
                  value: 'none',
                ),
                // Кнопка выбора устройства стоит ОТДЕЛЬНОЙ строкой, а не в
                // secondary у самой плитки. В secondary она забирала себе всю
                // нужную ей ширину, а заголовку с подписью не оставалось почти
                // ничего — на телефоне «Bluetooth» и «Устройство не выбрано»
                // печатались по одной букве в строку.
                //
                // На Windows этого варианта нет вовсе (не серая недоступная
                // плитка, а полностью скрыт) — print_bluetooth_thermal там
                // работает через BLE, а не classic-SPP, на котором держится
                // подавляющее большинство дешёвых принтеров: выбор без
                // объяснений привёл бы к "принтер как будто подключён, но
                // не печатает". См. _applyActivePrinter/loadSavedPrinterSettings.
                if (!Platform.isWindows) ...[
                  RadioListTile<String>(
                    title: const Text('Bluetooth'),
                    subtitle: Text(
                      _btMac.isEmpty ? 'Устройство не выбрано' : _btMac,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    value: 'bluetooth',
                  ),
                  if (_printerType == 'bluetooth')
                    Padding(
                      padding: const EdgeInsets.only(left: 16, bottom: 8),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: _pickBluetoothDevice,
                          icon: const Icon(Icons.bluetooth_searching, size: 18),
                          label: const Text('Выбрать устройство'),
                        ),
                      ),
                    ),
                ],
                const RadioListTile<String>(
                  title: Text('Wi-Fi / LAN (порт 9100)'),
                  value: 'network',
                ),
                if (_printerType == 'network')
                  Padding(
                    padding: const EdgeInsets.only(left: 16, bottom: 8),
                    child: TextField(
                      controller: _networkIpCtrl,
                      decoration: const InputDecoration(labelText: 'IP-адрес принтера', hintText: '192.168.1.100'),
                    ),
                  ),
              ],
            ),
          ),
          OutlinedButton.icon(
            onPressed: _testing ? null : _testPrinter,
            icon: const Icon(Icons.print),
            label: const Text('Тестовая печать'),
          ),
          const Divider(height: 40),
          const Text('ЕГАИС (УТМ)', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'Укажите IP-адрес компьютера, на котором установлен и запущен УТМ '
            'с подключённым крипто-ключом организации. Приложение обращается к '
            'нему по локальной сети — само по себе оно ничего не подписывает.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _utmHostCtrl,
            decoration: const InputDecoration(labelText: 'IP компьютера с УТМ', hintText: '192.168.1.50'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _testing ? null : _testUtm,
            icon: const Icon(Icons.wifi_tethering),
            label: const Text('Проверить связь с УТМ'),
          ),
          if (_testResult != null) ...[
            const SizedBox(height: 12),
            Text(_testResult!, style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
          const Divider(height: 40),
          const Text('Честный ЗНАК (маркировка)', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'Онлайн-проверка кода при сканировании (подлинность и статус выбытия '
            'напрямую в ИС МП) — дополнительно к локальной защите от повторной '
            'продажи, которая работает уже сейчас и без токена. Официальное '
            'списание кода при продаже всё равно происходит через онлайн-кассу '
            '(тег ОФД 1162) — см. раздел «Онлайн-касса» ниже.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 8),
          RadioGroup<String>(
            groupValue: _czCircuit,
            onChanged: (v) => setState(() => _czCircuit = v!),
            child: const Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                RadioListTile<String>(
                  title: Text('Пилот (тестовый контур)'),
                  subtitle: Text('markirovka.sandbox.crptech.ru — начните с него'),
                  value: 'pilot',
                ),
                RadioListTile<String>(
                  title: Text('Боевой (продуктивный контур)'),
                  subtitle: Text('markirovka.crpt.ru'),
                  value: 'prod',
                ),
              ],
            ),
          ),
          TextField(
            controller: _czTokenCtrl,
            decoration: const InputDecoration(
              labelText: 'Токен для ККТ',
              hintText: 'из личного кабинета честныйзнак.рф → профиль',
            ),
            obscureText: true,
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _czTestCodeCtrl,
            decoration: InputDecoration(
              labelText: 'Код для проверки (необязательно)',
              hintText: 'отсканированный DataMatrix целиком',
              // На Windows нет камеры для сканера — поле по-прежнему
              // принимает HID-сканер ("пистолет") и ручной ввод, см.
              // комментарий у _scanTestCode.
              suffixIcon: Platform.isWindows
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.camera_alt),
                      tooltip: 'Сканировать камерой',
                      onPressed: _scanTestCode,
                    ),
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _czTesting ? null : _testChestnyZnak,
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Проверить код'),
          ),
          if (_czTestResult != null) ...[
            const SizedBox(height: 12),
            Text(_czTestResult!, style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
          const Divider(height: 40),
          const Text('Онлайн-касса (54-ФЗ)', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'Без подключённого провайдера чек фискализируется имитационно '
            '(в налоговую ничего не уходит) — этого достаточно, чтобы '
            'проверить весь сценарий, но не заменяет настоящую кассу. Ниже — '
            'два реально работающих протокола: подключаются сразу, как '
            'только заключён договор с провайдером и с ОФД и получены '
            'реквизиты — дописывать код не нужно.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 8),
          RadioGroup<String>(
            groupValue: _kassaType,
            onChanged: (v) => setState(() => _kassaType = v!),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const RadioListTile<String>(
                  title: Text('Тестовый режим (имитация)'),
                  value: 'mock',
                ),
                const RadioListTile<String>(
                  title: Text('Облачная касса — протокол «АТОЛ Онлайн»'),
                  subtitle: Text('Тем же протоколом говорят и некоторые реселлеры (Ferma/OFD.ru и т.п.) — просто со своим адресом API'),
                  value: 'atol_cloud',
                ),
                if (_kassaType == 'atol_cloud') ...[
                  Padding(
                    padding: const EdgeInsets.only(left: 16),
                    child: Column(
                      children: [
                        TextField(
                          controller: _kassaBaseUrlCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Адрес API провайдера (необязательно)',
                            hintText: 'https://online.atol.ru',
                            helperText: 'Пусто — АТОЛ Онлайн. Тестовый контур: https://testonline.atol.ru',
                          ),
                        ),
                        TextField(
                          controller: _kassaGroupCodeCtrl,
                          decoration: const InputDecoration(labelText: 'Group code'),
                        ),
                        TextField(
                          controller: _kassaLoginCtrl,
                          decoration: const InputDecoration(labelText: 'Логин'),
                        ),
                        TextField(
                          controller: _kassaPasswordCtrl,
                          decoration: const InputDecoration(labelText: 'Пароль'),
                          obscureText: true,
                        ),
                        DropdownButtonFormField<String>(
                          initialValue: _kassaApiVersion,
                          decoration: const InputDecoration(labelText: 'Протокол'),
                          items: const [
                            DropdownMenuItem(value: 'v5', child: Text('v5 — ФФД 1.2 (рекомендуется, нужен для маркировки)')),
                            DropdownMenuItem(value: 'v4', child: Text('v4 — ФФД 1.05 (старые кассы)')),
                          ],
                          onChanged: (v) => setState(() => _kassaApiVersion = v ?? 'v5'),
                        ),
                        TextField(
                          controller: _kassaEmailCtrl,
                          decoration: const InputDecoration(
                            labelText: 'E-mail продавца (для чека)',
                            helperText: 'Если гость не оставил контакт, электронный чек уйдёт на этот адрес',
                          ),
                        ),
                        TextField(
                          controller: _kassaPaymentAddressCtrl,
                          decoration: const InputDecoration(labelText: 'Место расчётов', hintText: 'г. Москва, ул. ...'),
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
                  ),
                ],
                const RadioListTile<String>(
                  title: Text('Облачная касса — OrangeData'),
                  subtitle: Text('Отдельный протокол (mTLS + подпись запроса), ФФД 1.2 — с маркированными товарами'),
                  value: 'orange_data',
                ),
                if (_kassaType == 'orange_data') ...[
                  Padding(
                    padding: const EdgeInsets.only(left: 16),
                    child: Column(
                      children: [
                        TextField(
                          controller: _kassaBaseUrlCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Адрес API (необязательно)',
                            hintText: OrangeDataKassaService.defaultBaseUrl,
                            helperText: 'Пусто — боевой контур. Тестовый: ${OrangeDataKassaService.testBaseUrl}',
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
                          ),
                          maxLines: 4,
                        ),
                        TextField(
                          controller: _kassaOrangeCaPemCtrl,
                          decoration: const InputDecoration(labelText: 'Корневой сертификат OrangeData (cacert.pem)'),
                          maxLines: 4,
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
                  ),
                ],
                if (_kassaType == 'atol_cloud' || _kassaType == 'orange_data')
                  Padding(
                    padding: const EdgeInsets.only(left: 16),
                    child: Column(
                      children: [
                        TextField(
                          controller: _kassaInnCtrl,
                          decoration: const InputDecoration(labelText: 'ИНН организации'),
                        ),
                        DropdownButtonFormField<String>(
                          initialValue: _kassaSno,
                          decoration: const InputDecoration(labelText: 'Система налогообложения'),
                          items: const [
                            DropdownMenuItem(value: 'osn', child: Text('ОСН')),
                            DropdownMenuItem(value: 'usn_income', child: Text('УСН доход')),
                            DropdownMenuItem(value: 'usn_income_outcome', child: Text('УСН доход − расход')),
                            DropdownMenuItem(value: 'envd', child: Text('ЕНВД')),
                            DropdownMenuItem(value: 'esn', child: Text('ЕСН')),
                            DropdownMenuItem(value: 'patent', child: Text('Патент')),
                          ],
                          onChanged: (v) => setState(() => _kassaSno = v!),
                        ),
                        DropdownButtonFormField<String>(
                          initialValue: _kassaVat,
                          decoration: const InputDecoration(
                            labelText: 'Ставка НДС по умолчанию',
                            helperText: 'Для позиций меню без своей ставки (её можно задать в редакторе меню)',
                          ),
                          items: FiscalVatRate.values
                              .map((v) => DropdownMenuItem(value: v.id, child: Text(v.label)))
                              .toList(),
                          onChanged: (v) => setState(() => _kassaVat = v ?? 'none'),
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
                  ),
                const RadioListTile<String>(
                  title: Text('CloudKassir'),
                  subtitle: Text('Заготовка: в открытом доступе нет полного протокола фискализации — уточняется у CloudKassir после договора'),
                  value: 'cloud_kassir',
                ),
              ],
            ),
          ),
          OutlinedButton.icon(
            onPressed: _testing ? null : _testKassa,
            icon: const Icon(Icons.receipt_long),
            label: const Text('Тестовый чек'),
          ),
          const Divider(height: 40),
          const Text('Терминал оплаты', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'Ручной терминал работает уже сейчас с ЛЮБЫМ банком и ЛЮБЫМ '
            'физическим терминалом (Ingenico, Verifone, mPOS, фирменный '
            'терминал банка) — приложение просто спрашивает у сотрудника, '
            'прошла ли оплата на самом терминале. Т-Банк по QR СБП вообще '
            'обходится без терминала: гость платит сам со своего телефона. '
            'Остальные банки ниже — это заготовки настроек: сама интеграция '
            'ждёт технической документации по вашему договору эквайринга '
            '(у каждого банка свой протокол, угадывать его нельзя).',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 8),
          RadioGroup<TerminalProvider>(
            groupValue: _terminalProvider,
            onChanged: (v) => setState(() => _terminalProvider = v!),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: TerminalProvider.values.where((p) => p != TerminalProvider.mock).map(
                    (p) => RadioListTile<TerminalProvider>(
                      title: Text(p.label),
                      value: p,
                    ),
                  ).toList(),
            ),
          ),
          if (_terminalFields(_terminalProvider).first != null)
            Padding(
              padding: const EdgeInsets.only(left: 16),
              child: Column(
                children: [
                  TextField(
                    controller: _terminalLoginCtrl,
                    decoration: InputDecoration(labelText: _terminalFields(_terminalProvider).first),
                  ),
                  if (_terminalFields(_terminalProvider).second != null)
                    TextField(
                      controller: _terminalPasswordCtrl,
                      decoration: InputDecoration(labelText: _terminalFields(_terminalProvider).second),
                      obscureText: true,
                    ),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _terminalTesting ? null : _testTerminal,
            icon: const Icon(Icons.point_of_sale),
            label: Text(_terminalProvider == TerminalProvider.tinkoffSbp
                ? 'Тест: показать QR на 1 ₽'
                : 'Проверить'),
          ),
          if (_terminalTestResult != null) ...[
            const SizedBox(height: 12),
            Text(_terminalTestResult!, style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 32),
          FilledButton(onPressed: _save, child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('Сохранить'),
          )),
        ],
      ),
    );
  }
}