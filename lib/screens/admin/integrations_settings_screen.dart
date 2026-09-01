import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import '../../services/printer_service.dart';
import '../../services/egais_service.dart';
import '../../services/kassa_service.dart';
import '../../services/chestny_znak_api_service.dart';
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
  final _doc = FirebaseFirestore.instance.collection('settings').doc('integrations');

  String _printerType = 'none'; // none | bluetooth | network
  String _btMac = '';
  final _networkIpCtrl = TextEditingController();
  final _utmHostCtrl = TextEditingController();
  String _kassaType = 'mock'; // mock | atol_cloud
  final _kassaBaseUrlCtrl = TextEditingController();
  final _kassaGroupCodeCtrl = TextEditingController();
  final _kassaLoginCtrl = TextEditingController();
  final _kassaPasswordCtrl = TextEditingController();
  String _czCircuit = 'pilot'; // pilot | prod
  final _czTokenCtrl = TextEditingController();
  final _czTestCodeCtrl = TextEditingController();
  bool _loading = true;
  bool _testing = false;
  String? _testResult;
  bool _czTesting = false;
  String? _czTestResult;

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
    _czCircuit = data['czCircuit'] ?? 'pilot';
    _czTokenCtrl.text = data['czToken'] ?? '';
    _applyActivePrinter();
    setState(() => _loading = false);
  }

  void _applyActivePrinter() {
    if (_printerType == 'bluetooth' && _btMac.isNotEmpty) {
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
      'czCircuit': _czCircuit,
      'czToken': _czTokenCtrl.text.trim(),
    }, SetOptions(merge: true));
    _applyActivePrinter();
    _applyActiveKassa();
    _applyActiveEgais();
    _applyActiveChestnyZnak();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
    }
  }

  void _applyActiveKassa() {
    if (_kassaType == 'atol_cloud') {
      kassaService = AtolCloudKassaService(
        baseUrl: _kassaBaseUrlCtrl.text.trim(),
        groupCode: _kassaGroupCodeCtrl.text.trim(),
        login: _kassaLoginCtrl.text.trim(),
        password: _kassaPasswordCtrl.text.trim(),
      );
    } else {
      kassaService = MockKassaService();
    }
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
        _testResult = 'Заполните логин/пароль/group_code кассы';
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

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  void dispose() {
    _networkIpCtrl.dispose();
    _utmHostCtrl.dispose();
    _kassaBaseUrlCtrl.dispose();
    _kassaGroupCodeCtrl.dispose();
    _kassaLoginCtrl.dispose();
    _kassaPasswordCtrl.dispose();
    _czTokenCtrl.dispose();
    _czTestCodeCtrl.dispose();
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
          RadioListTile<String>(
            title: const Text('Не подключён'),
            value: 'none',
            groupValue: _printerType,
            onChanged: (v) => setState(() => _printerType = v!),
          ),
          RadioListTile<String>(
            title: const Text('Bluetooth'),
            subtitle: Text(_btMac.isEmpty ? 'Устройство не выбрано' : _btMac),
            value: 'bluetooth',
            groupValue: _printerType,
            onChanged: (v) => setState(() => _printerType = v!),
            secondary: TextButton(onPressed: _pickBluetoothDevice, child: const Text('Выбрать')),
          ),
          RadioListTile<String>(
            title: const Text('Wi-Fi / LAN (порт 9100)'),
            value: 'network',
            groupValue: _printerType,
            onChanged: (v) => setState(() => _printerType = v!),
          ),
          if (_printerType == 'network')
            Padding(
              padding: const EdgeInsets.only(left: 16, bottom: 8),
              child: TextField(
                controller: _networkIpCtrl,
                decoration: const InputDecoration(labelText: 'IP-адрес принтера', hintText: '192.168.1.100'),
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
          RadioListTile<String>(
            title: const Text('Пилот (тестовый контур)'),
            subtitle: const Text('markirovka.sandbox.crptech.ru — начните с него'),
            value: 'pilot',
            groupValue: _czCircuit,
            onChanged: (v) => setState(() => _czCircuit = v!),
          ),
          RadioListTile<String>(
            title: const Text('Боевой (продуктивный контур)'),
            subtitle: const Text('markirovka.crpt.ru'),
            value: 'prod',
            groupValue: _czCircuit,
            onChanged: (v) => setState(() => _czCircuit = v!),
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
            decoration: const InputDecoration(
              labelText: 'Код для проверки (необязательно)',
              hintText: 'отсканированный DataMatrix целиком',
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
            'проверить весь сценарий, но не заменяет настоящую кассу. '
            'Нужен договор с провайдером облачной кассы и с ОФД.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 8),
          RadioListTile<String>(
            title: const Text('Тестовый режим (имитация)'),
            value: 'mock',
            groupValue: _kassaType,
            onChanged: (v) => setState(() => _kassaType = v!),
          ),
          RadioListTile<String>(
            title: const Text('Облачная касса (протокол АТОЛ Онлайн)'),
            value: 'atol_cloud',
            groupValue: _kassaType,
            onChanged: (v) => setState(() => _kassaType = v!),
          ),
          if (_kassaType == 'atol_cloud') ...[
            Padding(
              padding: const EdgeInsets.only(left: 16),
              child: Column(
                children: [
                  TextField(
                    controller: _kassaBaseUrlCtrl,
                    decoration: const InputDecoration(labelText: 'Адрес API провайдера', hintText: 'https://online.atol.ru'),
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
                  const SizedBox(height: 8),
                ],
              ),
            ),
          ],
          OutlinedButton.icon(
            onPressed: _testing ? null : _testKassa,
            icon: const Icon(Icons.receipt_long),
            label: const Text('Тестовый чек'),
          ),
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