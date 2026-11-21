import 'package:cloud_firestore/cloud_firestore.dart' show SetOptions;
import 'package:flutter/material.dart';

import '../../models/fiscal_receipt.dart';
import '../../services/app_scope.dart';
import '../../services/atol_local_kassa.dart';
import '../../services/kassa_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/human_error.dart';
import '../../utils/sale_kind.dart';

/// SaaS: второе юрлицо в заведении — например, кальяны пробиваются на
/// другое ИП, кухня и бар на основное. Своя касса (АТОЛ в зале или АТОЛ
/// Онлайн), своя система налогообложения и ставка НДС. Касса делит чек по
/// цехам: позиции отмеченных цехов уходят отдельным чеком на эту кассу,
/// оплата делится в той же пропорции. Настройки — `settings/integrations.kassa2`.
class SecondLegalEntityScreen extends StatefulWidget {
  const SecondLegalEntityScreen({super.key});

  @override
  State<SecondLegalEntityScreen> createState() => _SecondLegalEntityScreenState();
}

class _SecondLegalEntityScreenState extends State<SecondLegalEntityScreen> {
  bool _loading = true;
  bool _saving = false;
  bool _testing = false;
  String? _result;
  String? _loadError;

  bool _enabled = false;
  String _type = 'atol_local';
  String _sno = 'usn_income';
  String _vat = 'none';
  String _apiVersion = 'v5';
  final Set<String> _kinds = {SaleKind.hookah};
  final _name = TextEditingController();
  final _baseUrl = TextEditingController();
  final _group = TextEditingController();
  final _login = TextEditingController();
  final _password = TextEditingController();
  final _inn = TextEditingController();
  final _email = TextEditingController();
  final _address = TextEditingController();
  final _cashier = TextEditingController();
  final _cashierInn = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _baseUrl, _group, _login, _password, _inn, _email, _address, _cashier, _cashierInn]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = (await AppScope.col('settings').doc('integrations').get()).data() ?? const {};
      final m = d['kassa2'] is Map ? Map<String, dynamic>.from(d['kassa2'] as Map) : const <String, dynamic>{};
      String s(String k) => m[k] as String? ?? '';
      setState(() {
        _enabled = m['enabled'] == true;
        _type = const ['atol_local', 'atol_cloud'].contains(m['kassaType']) ? m['kassaType'] as String : 'atol_local';
        _sno = (m['kassaSno'] as String?) ?? 'usn_income';
        _vat = FiscalVatRateX.fromId(m['kassaVat'] as String?).id;
        _apiVersion = m['kassaApiVersion'] == 'v4' ? 'v4' : 'v5';
        if (m['kinds'] is List) {
          _kinds
            ..clear()
            ..addAll([for (final k in m['kinds'] as List) if (k is String) k]);
        }
        _name.text = s('name');
        _baseUrl.text = s('kassaBaseUrl');
        _group.text = s('kassaGroupCode');
        _login.text = s('kassaLogin');
        _password.text = s('kassaPassword');
        _inn.text = s('kassaInn');
        _email.text = s('kassaEmail');
        _address.text = s('kassaPaymentAddress');
        _cashier.text = s('kassaCashier');
        _cashierInn.text = s('kassaCashierInn');
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _loadError = humanError(e);
      });
    }
  }

  Map<String, dynamic> get _data => {
        'enabled': _enabled,
        'name': _name.text.trim(),
        'kinds': _kinds.toList()..sort(),
        'kassaType': _type,
        'kassaBaseUrl': _baseUrl.text.trim(),
        'kassaGroupCode': _group.text.trim(),
        'kassaLogin': _login.text.trim(),
        'kassaPassword': _password.text.trim(),
        'kassaInn': _inn.text.trim(),
        'kassaEmail': _email.text.trim(),
        'kassaPaymentAddress': _address.text.trim(),
        'kassaCashier': _cashier.text.trim(),
        'kassaCashierInn': _cashierInn.text.trim(),
        'kassaSno': _sno,
        'kassaVat': _vat,
        'kassaApiVersion': _apiVersion,
      };

  Future<void> _save() async {
    if (_enabled && _kinds.isEmpty) {
      setState(() => _result = 'Отметьте цеха, которые пробиваются на второе юрлицо');
      return;
    }
    if (_enabled && _kinds.length == SaleKind.all.length) {
      setState(() => _result = 'Все цеха на второе юрлицо — тогда это просто основная касса. Оставьте хотя бы один цех основному.');
      return;
    }
    setState(() => _saving = true);
    try {
      await AppScope.col('settings').doc('integrations').set({'kassa2': _data}, SetOptions(merge: true));
      applySecondEntity(_data);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Сохранено')));
      Navigator.pop(context);
    } catch (e) {
      if (mounted) setState(() => _result = 'Не сохранилось: ${humanError(e, lower: true)}');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _test() async {
    setState(() {
      _testing = true;
      _result = null;
    });
    final kassa = kassaProviderFrom(_data);
    String text;
    try {
      if (kassa is AtolLocalKassaService) {
        // Регистратору тестовый чек не шлём — он был бы настоящим.
        text = await kassa.checkStatus();
      } else if (!kassa.isAvailable) {
        text = 'Заполните логин, пароль, group code и ИНН';
      } else {
        final r = await kassa.sendReceipt(FiscalReceipt(
          receiptId: 'test2-${DateTime.now().millisecondsSinceEpoch}',
          items: const [FiscalReceiptItem(name: 'Тестовая позиция', price: 1, quantity: 1)],
          payments: const [FiscalPayment('cash', 1)],
        ));
        text = r.success ? 'Чек принят, ФД: ${r.fiscalDocumentNumber ?? '—'}' : 'Ошибка: ${r.errorMessage}';
      }
    } catch (e) {
      text = 'Ошибка: ${humanError(e, lower: true)}';
    }
    if (mounted) {
      setState(() {
        _testing = false;
        _result = text;
      });
    }
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 6),
        child: Text(t, style: TextStyle(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600)),
      );

  Widget _chips<T>(List<(T, String)> opts, T value, ValueChanged<T> onChanged) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final o in opts)
            ChoiceChip(label: Text(o.$2), selected: value == o.$1, onSelected: (_) => setState(() => onChanged(o.$1))),
        ],
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Второе юрлицо')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _loadError != null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('Не загрузилось: $_loadError')))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    Text(
                      'Если часть продаж оформлена на другое ИП или ООО (например, кальяны), '
                      'касса сама разделит чек: позиции отмеченных цехов уйдут отдельным чеком на кассу '
                      'второго юрлица, оплата разделится в той же пропорции. Возврат — тоже двумя чеками.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 13.5, height: 1.4),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _enabled,
                      onChanged: (v) => setState(() => _enabled = v),
                      title: const Text('Второе юрлицо включено'),
                    ),
                    if (_enabled) ...[
                      TextField(
                        controller: _name,
                        decoration: const InputDecoration(labelText: 'Название для себя', hintText: 'ИП Петров — кальяны'),
                      ),
                      _label('Какие цеха пробиваются на второе юрлицо'),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final k in SaleKind.all)
                          FilterChip(
                            label: Text(SaleKind.label(k)),
                            selected: _kinds.contains(k),
                            onSelected: (on) => setState(() => on ? _kinds.add(k) : _kinds.remove(k)),
                          ),
                      ]),
                      _label('Касса второго юрлица'),
                      _chips<String>(const [
                        ('atol_local', 'Регистратор АТОЛ в заведении'),
                        ('atol_cloud', 'АТОЛ Онлайн (облако)'),
                      ], _type, (v) => _type = v),
                      if (_type == 'atol_local') ...[
                        TextField(
                          controller: _baseUrl,
                          decoration: const InputDecoration(
                            labelText: 'Адрес «Веб-сервера ККТ»',
                            hintText: 'http://192.168.1.50:16732',
                            helperText: 'Второй регистратор — свой адрес или свой порт',
                          ),
                        ),
                        TextField(controller: _cashier, decoration: const InputDecoration(labelText: 'Кассир (необязательно)')),
                        TextField(controller: _cashierInn, decoration: const InputDecoration(labelText: 'ИНН кассира (необязательно)')),
                      ] else ...[
                        TextField(
                          controller: _baseUrl,
                          decoration: const InputDecoration(labelText: 'Адрес API (пусто — АТОЛ Онлайн)'),
                        ),
                        TextField(controller: _group, decoration: const InputDecoration(labelText: 'Group code')),
                        TextField(controller: _login, decoration: const InputDecoration(labelText: 'Логин')),
                        TextField(controller: _password, decoration: const InputDecoration(labelText: 'Пароль'), obscureText: true),
                        TextField(controller: _inn, decoration: const InputDecoration(labelText: 'ИНН второго юрлица')),
                        TextField(controller: _email, decoration: const InputDecoration(labelText: 'E-mail продавца (для чека)')),
                        TextField(controller: _address, decoration: const InputDecoration(labelText: 'Место расчётов')),
                      ],
                      _label('Протокол'),
                      _chips<String>(const [('v5', 'ФФД 1.2'), ('v4', 'ФФД 1.05')], _apiVersion, (v) => _apiVersion = v),
                      _label('Система налогообложения'),
                      _chips<String>(const [
                        ('osn', 'ОСН'),
                        ('usn_income', 'УСН доход'),
                        ('usn_income_outcome', 'УСН доход − расход'),
                        ('esn', 'ЕСН'),
                        ('patent', 'Патент'),
                      ], _sno, (v) => _sno = v),
                      _label('Ставка НДС по умолчанию'),
                      _chips<String>([for (final v in FiscalVatRate.values) (v.id, v.label)], _vat, (v) => _vat = v),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: _testing ? null : _test,
                        icon: const Icon(Icons.receipt_long),
                        label: Text(_type == 'atol_local' ? 'Проверить связь с регистратором' : 'Тестовый чек на 1 ₽'),
                      ),
                    ],
                    if (_result != null)
                      Padding(padding: const EdgeInsets.only(top: 12), child: Text(_result!)),
                    const SizedBox(height: 20),
                    FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Сохраняю…' : 'Сохранить')),
                  ],
                ),
    );
  }
}
