import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../../build_info.dart';
import '../../services/app_scope.dart';
import '../../utils/money.dart';
import '../theme/kolibri_theme.dart';

/// «Оплатить по СБП» со стола. Сумму считает сервер по счёту (вместе с
/// чаевыми «к счёту»), гость подтверждает перевод в своём банке, а
/// официант получает «Стол оплатил». Пароль терминала Т-Банка на телефон
/// гостя не попадает — платёж заводит шлюз (saas-gateway/guest-pay.js).
class GuestSbpPayCard extends StatefulWidget {
  final String sessionId;
  final double paidAlready;
  const GuestSbpPayCard({super.key, required this.sessionId, this.paidAlready = 0});

  @override
  State<GuestSbpPayCard> createState() => _GuestSbpPayCardState();
}

class _GuestSbpPayCardState extends State<GuestSbpPayCard> {
  bool _busy = false;
  String? _paymentId;
  String? _link;
  double _amount = 0;
  String _status = '';
  Timer? _poll;
  DateTime? _startedAt;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (kSaasGatewayUrl.isEmpty || token == null) throw StateError('Оплата сейчас недоступна');
    final resp = await http
        .post(
          Uri.parse('$kSaasGatewayUrl/$path'),
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
          body: jsonEncode({'tenantId': AppScope.tenantId, ...body}),
        )
        .timeout(const Duration(seconds: 20));
    final json = jsonDecode(utf8.decode(resp.bodyBytes)) as Map<String, dynamic>;
    if (resp.statusCode != 200) throw StateError((json['error'] ?? 'Сервис оплаты недоступен').toString());
    return json;
  }

  Future<void> _start() async {
    setState(() => _busy = true);
    try {
      final r = await _post('guestPayStart', {'sessionId': widget.sessionId});
      _paymentId = r['paymentId'] as String?;
      _link = r['payload'] as String?;
      _amount = (r['amount'] as num?)?.toDouble() ?? 0;
      _status = 'pending';
      _startedAt = DateTime.now();
      await _openBank();
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 3), (_) => _check());
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString().replaceFirst('Bad state: ', ''))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openBank() async {
    final link = _link;
    if (link == null || link.isEmpty) return;
    await launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication);
  }

  bool _checking = false;
  Future<void> _check() async {
    if (_checking || _paymentId == null) return;
    if (_startedAt != null && DateTime.now().difference(_startedAt!) > const Duration(minutes: 16)) {
      _poll?.cancel();
      return;
    }
    _checking = true;
    try {
      final r = await _post('guestPayStatus', {'paymentId': _paymentId});
      final st = (r['status'] ?? '').toString();
      if (st != _status && mounted) setState(() => _status = st);
      if (st == 'paid' || st == 'failed') _poll?.cancel();
    } catch (_) {
      // Сеть моргнула — следующий опрос.
    } finally {
      _checking = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_status == 'paid') {
      body = const Row(children: [
        Icon(Icons.check_circle, color: Colors.green),
        SizedBox(width: 10),
        Expanded(child: Text('Оплата прошла — спасибо! Счёт отмечен как оплаченный.')),
      ]);
    } else if (_status == 'pending' || _status == 'failed') {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('К оплате ${rub(_amount)}. Подтвердите перевод в приложении банка — оплату мы увидим сами.',
              style: TextStyle(color: KolibriColors.textMuted)),
          const SizedBox(height: 10),
          if (_status == 'failed')
            FilledButton(onPressed: _busy ? null : _start, child: const Text('Платёж не прошёл — оплатить заново'))
          else
            FilledButton.icon(
              onPressed: _openBank,
              icon: const Icon(Icons.account_balance),
              label: const Text('Открыть приложение банка'),
            ),
        ],
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Оплатите счёт сами через СБП — без ожидания официанта и терминала. '
              'Чаевые, добавленные к счёту, войдут в сумму.',
              style: TextStyle(color: KolibriColors.textMuted)),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: _busy ? null : _start,
            icon: _busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.qr_code_2),
            label: const Text('Оплатить по СБП'),
          ),
        ],
      );
    }
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: KolibriColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: KolibriColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (widget.paidAlready > 0)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text('Уже оплачено по СБП: ${rub(widget.paidAlready)}',
                  style: TextStyle(color: KolibriColors.gold)),
            ),
          body,
        ],
      ),
    );
  }
}
