import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/online_pay.dart';
import '../../models/session_model.dart';
import '../../models/venue_models.dart';
import '../../services/venue_service.dart';
import '../../utils/money.dart';
import '../../utils/phone_utils.dart';
import '../services/delivery_order_service.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/privacy_notice.dart';
import 'kolibri_order_screen.dart';

/// Оформление доставки или «заберу сам». Заказ уходит на сервер: тот
/// сверяет цены с меню, записывает контакт в базу в РФ и передаёт заказ
/// кассе. Заведение звонит гостю и подтверждает — только тогда готовят и,
/// если гость выбрал онлайн, открывается оплата.
///
/// [items] — корзина, [banned] — позиции из неё, которые нельзя продать
/// навынос (табак, кальяны, алкоголь): их показываем и не отправляем.
/// Возвращает true, если заказ оформлен.
class KolibriCheckoutScreen extends StatefulWidget {
  final List<OrderItem> items;
  final Set<String> banned;
  final String defaultName;
  final String defaultPhone;

  const KolibriCheckoutScreen({
    super.key,
    required this.items,
    this.banned = const {},
    this.defaultName = '',
    this.defaultPhone = '',
  });

  @override
  State<KolibriCheckoutScreen> createState() => _KolibriCheckoutScreenState();
}

class _KolibriCheckoutScreenState extends State<KolibriCheckoutScreen> {
  static const _prefsKey = 'delivery_contact_v1';

  bool _delivery = true;
  bool _online = false;
  bool _sending = false;
  String? _phoneError;
  String? _addressError;
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _street = TextEditingController();
  final _flat = TextEditingController();
  final _entrance = TextEditingController();
  final _floor = TextEditingController();
  final _intercom = TextEditingController();
  final _comment = TextEditingController();

  List<OrderItem> get _allowed => widget.items.where((i) => !widget.banned.contains(i.menuItemId)).toList();
  List<OrderItem> get _skipped => widget.items.where((i) => widget.banned.contains(i.menuItemId)).toList();
  double get _total => _allowed.fold(0, (a, i) => a + i.total);

  @override
  void initState() {
    super.initState();
    _name.text = widget.defaultName;
    _phone.text = widget.defaultPhone.isEmpty ? '' : formatPhone(widget.defaultPhone);
    _restore();
  }

  /// Адрес и имя прошлого заказа — на этом телефоне, никуда не уходят.
  Future<void> _restore() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_prefsKey);
      if (raw == null || !mounted) return;
      final m = jsonDecode(raw) as Map<String, dynamic>;
      setState(() {
        if (_name.text.isEmpty) _name.text = (m['name'] ?? '').toString();
        if (_phone.text.isEmpty) _phone.text = (m['phone'] ?? '').toString();
        _street.text = (m['street'] ?? '').toString();
        _flat.text = (m['flat'] ?? '').toString();
        _entrance.text = (m['entrance'] ?? '').toString();
        _floor.text = (m['floor'] ?? '').toString();
        _intercom.text = (m['intercom'] ?? '').toString();
      });
    } catch (_) {}
  }

  Future<void> _remember() async {
    try {
      await (await SharedPreferences.getInstance()).setString(
          _prefsKey,
          jsonEncode({
            'name': _name.text.trim(),
            'phone': _phone.text.trim(),
            'street': _street.text.trim(),
            'flat': _flat.text.trim(),
            'entrance': _entrance.text.trim(),
            'floor': _floor.text.trim(),
            'intercom': _intercom.text.trim(),
          }));
    } catch (_) {}
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _street, _flat, _entrance, _floor, _intercom, _comment]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit(VenueProfile venue) async {
    final phoneProblemText = phoneProblem(_phone.text);
    setState(() {
      _phoneError = phoneProblemText;
      _addressError = _delivery && _street.text.trim().length < 5 ? 'Укажите улицу и дом' : null;
    });
    if (_name.text.trim().length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Как к вам обращаться? Укажите имя')));
      return;
    }
    if (_phoneError != null || _addressError != null || _allowed.isEmpty) return;
    setState(() => _sending = true);
    try {
      final r = await DeliveryOrderService.instance.place({
        'orderType': _delivery ? 'delivery' : 'takeaway',
        'name': _name.text.trim(),
        'phone': normalizePhone(_phone.text.trim()),
        if (_delivery)
          'address': {
            'street': _street.text.trim(),
            'flat': _flat.text.trim(),
            'entrance': _entrance.text.trim(),
            'floor': _floor.text.trim(),
            'intercom': _intercom.text.trim(),
          },
        'comment': _comment.text.trim(),
        'payMethod': _online && venue.onlinePayReady ? 'online' : 'on_receipt',
        'items': [
          for (final i in _allowed) {'menuItemId': i.menuItemId, 'qty': i.qty, if (i.mods.isNotEmpty) 'mods': i.mods},
        ],
      });
      await _remember();
      if (!mounted) return;
      final id = (r['sessionId'] ?? '').toString();
      Navigator.of(context).pop(true);
      if (id.isNotEmpty) {
        Navigator.of(context).push(MaterialPageRoute(builder: (_) => KolibriOrderScreen(sessionId: id)));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<VenueProfile>(
      valueListenable: VenueService.instance.notifier,
      builder: (context, venue, _) {
        final muted = TextStyle(color: KolibriColors.textMuted, fontSize: 13, height: 1.4);
        return Scaffold(
          appBar: AppBar(title: const Text('Оформление заказа')),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
            children: [
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: true, icon: Icon(Icons.delivery_dining_rounded), label: Text('Доставка')),
                  ButtonSegment(value: false, icon: Icon(Icons.storefront_outlined), label: Text('Заберу сам')),
                ],
                selected: {_delivery},
                onSelectionChanged: (v) => setState(() => _delivery = v.first),
              ),
              if (!_delivery && venue.address.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text('Забрать: ${venue.address}', style: muted),
                ),
              const SizedBox(height: 16),
              TextField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(labelText: 'Как к вам обращаться'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: 'Телефон',
                  helperText: 'Заведение позвонит, чтобы подтвердить заказ',
                  errorText: _phoneError,
                  errorMaxLines: 3,
                ),
              ),
              if (_delivery) ...[
                const SizedBox(height: 10),
                TextField(
                  controller: _street,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(labelText: 'Улица и дом', errorText: _addressError),
                ),
                Row(
                  children: [
                    Expanded(child: TextField(controller: _flat, decoration: const InputDecoration(labelText: 'Кв./офис'))),
                    const SizedBox(width: 10),
                    Expanded(
                        child: TextField(
                            controller: _entrance,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(labelText: 'Подъезд'))),
                  ],
                ),
                Row(
                  children: [
                    Expanded(
                        child: TextField(
                            controller: _floor,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(labelText: 'Этаж'))),
                    const SizedBox(width: 10),
                    Expanded(child: TextField(controller: _intercom, decoration: const InputDecoration(labelText: 'Домофон'))),
                  ],
                ),
              ],
              const SizedBox(height: 10),
              TextField(
                controller: _comment,
                maxLength: 300,
                decoration: InputDecoration(
                  labelText: _delivery ? 'Комментарий курьеру и кухне' : 'Комментарий к заказу',
                  hintText: 'Например: без лука, позвонить за 10 минут',
                ),
              ),
              const SizedBox(height: 8),
              Text('Оплата', style: KolibriFonts.display(22)),
              RadioGroup<bool>(
                groupValue: _online && venue.onlinePayReady,
                onChanged: (v) => setState(() => _online = v ?? false),
                child: Column(
                  children: [
                    RadioListTile<bool>(
                      contentPadding: EdgeInsets.zero,
                      value: false,
                      title: const Text('При получении'),
                      subtitle: Text(_delivery ? 'Наличными или картой курьеру' : 'На кассе заведения'),
                    ),
                    if (venue.onlinePayReady)
                      RadioListTile<bool>(
                        contentPadding: EdgeInsets.zero,
                        value: true,
                        title: Text(OnlinePayProvider.byId(venue.onlinePay)?.sbpOnly == true
                            ? 'Онлайн по СБП'
                            : 'Онлайн — СБП или картой'),
                        subtitle: const Text('После подтверждения заказа — кнопка оплаты появится здесь же'),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: KolibriColors.surface,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: KolibriColors.border),
                ),
                child: Column(
                  children: [
                    for (final i in _allowed)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Row(children: [
                          Expanded(child: Text('${i.displayName} ×${i.qty}')),
                          Text(rub(i.total), style: TextStyle(color: KolibriColors.textMuted)),
                        ]),
                      ),
                    const Divider(height: 20),
                    Row(children: [
                      const Expanded(child: Text('Итого', style: TextStyle(fontWeight: FontWeight.w700))),
                      Text(rub(_total), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
                    ]),
                  ],
                ),
              ),
              if (_skipped.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    'Не продаются с собой и с доставкой: ${_skipped.map((i) => i.name).join(', ')}. '
                    'Табак, кальяны и алкоголь — только в заведении (законы № 15-ФЗ и № 171-ФЗ).',
                    style: muted.copyWith(color: Colors.orangeAccent),
                  ),
                ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _sending || _allowed.isEmpty ? null : () => _submit(venue),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: _sending
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text('Оформить заказ · ${rub(_total)}'),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                'Имя, телефон и адрес нужны заведению, чтобы подтвердить и передать заказ, '
                'и хранятся на сервере в России. Через 30 дней после выполнения заказа они обезличиваются.',
                style: muted.copyWith(fontSize: 12),
                textAlign: TextAlign.center,
              ),
              const PrivacyNotice(),
            ],
          ),
        );
      },
    );
  }
}
