import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/session_model.dart';
import '../../services/guest_link_service.dart';
import '../../services/tips_service.dart';
import '../../services/venue_service.dart';
import '../../utils/constants.dart';
import '../theme/kolibri_theme.dart';
import '../../utils/money.dart';

/// Чаевые из приложения гостя.
///
/// Гость выбирает, КОМУ — любому, кто сейчас на смене, или всей смене
/// сразу, — и СКОЛЬКО: процент от счёта или своя сумма. Дальше два пути:
///  • «Добавить к счёту» — касса увидит чаевые на экране оплаты и возьмёт
///    их вместе со счётом (наличными или картой);
///  • «Перевести напрямую» — если у сотрудника есть личная ссылка для
///    чаевых, гость переводит сам, минуя кассу.
class KolibriTipsPanel extends StatefulWidget {
  final String sessionId;
  final String clientUid;
  const KolibriTipsPanel({super.key, required this.sessionId, required this.clientUid});

  @override
  State<KolibriTipsPanel> createState() => _KolibriTipsPanelState();
}

class _KolibriTipsPanelState extends State<KolibriTipsPanel> {
  final _tips = TipsService.instance;
  final _custom = TextEditingController();

  late final Stream<SessionModel?> _session = GuestLinkService().sessionStream(widget.sessionId);
  late final Stream<List<TipTeamMember>> _team = _tips.teamStream();
  late final Stream<List<TipModel>> _mine =
      _tips.sessionTipsStream(widget.sessionId, clientUid: widget.clientUid);

  /// Выбранный получатель: id сотрудника, [_teamKey] — всей смене.
  String? _to;
  static const _teamKey = '__team__';

  /// Выбранный процент (5/10/15) или сумма без процента; -1 — своя сумма.
  int _preset = 10;
  bool _busy = false;

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  static const _percents = [5, 10, 15];
  static const _fixed = [100, 200, 500];

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<SessionModel?>(
      stream: _session,
      builder: (context, sessionSnap) {
        final session = sessionSnap.data;
        return StreamBuilder<List<TipTeamMember>>(
          stream: _team,
          builder: (context, teamSnap) {
            final team = _recipients(teamSnap.data ?? const [], session);
            return _body(session, team);
          },
        );
      },
    );
  }

  /// Кто на смене. Если смену никто не отмечал, у гостя всё равно должен
  /// быть получатель — тот, кто открыл его стол.
  List<TipTeamMember> _recipients(List<TipTeamMember> onShift, SessionModel? s) {
    if (onShift.isNotEmpty) return onShift;
    if (s != null && s.employeeName.trim().isNotEmpty) {
      return [TipTeamMember(id: s.employeeId, name: s.employeeName.trim())];
    }
    return const [];
  }

  Widget _body(SessionModel? session, List<TipTeamMember> team) {
    final venue = VenueService.instance.cached;
    final teamAllowed = venue.tipsTeamEnabled && team.length != 1;
    final bill = session?.totalWithDiscount ?? 0;

    // По умолчанию — тот, кто открыл стол, если он на смене; иначе первый.
    if (_to == null || (_to != _teamKey && !team.any((m) => m.id == _to))) {
      final opener = team.where((m) => m.id.isNotEmpty && m.id == session?.employeeId);
      _to = opener.isNotEmpty
          ? opener.first.id
          : team.isNotEmpty
              ? team.first.id
              : (teamAllowed ? _teamKey : null);
    }
    if (_to == _teamKey && !teamAllowed && team.isNotEmpty) _to = team.first.id;

    final selected = _to == _teamKey ? null : team.where((m) => m.id == _to).firstOrNull;
    final preset = _effectivePreset(bill);
    final amount = _amount(bill, preset);
    final link = selected?.tipsLink.trim() ?? '';
    final canLink = link.startsWith('https://');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _label('Кому'),
        if (team.isEmpty && !teamAllowed)
          Text('Смена ещё не отмечена — чаевые получит смена целиком.',
              style: TextStyle(color: KolibriColors.textMuted, fontSize: 13))
        else
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final m in team)
                _chip(
                  label: _memberLabel(m),
                  selected: _to == m.id,
                  onTap: () => setState(() => _to = m.id),
                ),
              if (teamAllowed)
                _chip(
                  label: 'Всей смене',
                  selected: _to == _teamKey,
                  onTap: () => setState(() => _to = _teamKey),
                ),
            ],
          ),
        const SizedBox(height: 14),
        _label('Сколько'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (bill > 0)
              for (final p in _percents)
                _chip(
                  label: '$p% · ${rub(tipFromPercent(bill, p))}',
                  selected: preset == p,
                  onTap: () => setState(() => _preset = p),
                )
            else
              for (final v in _fixed)
                _chip(
                  label: '$v ₽',
                  selected: preset == 1000 + v,
                  onTap: () => setState(() => _preset = 1000 + v),
                ),
            _chip(
              label: 'Своя сумма',
              selected: preset == -1,
              onTap: () => setState(() => _preset = -1),
            ),
          ],
        ),
        if (preset == -1) ...[
          const SizedBox(height: 10),
          SizedBox(
            width: 180,
            child: TextField(
              controller: _custom,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(isDense: true, hintText: 'Сумма', suffixText: '₽'),
            ),
          ),
        ],
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy || amount <= 0 || (_to == null && !teamAllowed && team.isNotEmpty)
                ? null
                : () => _leave(amount, selected, team, session, method: 'bill'),
            child: Text(amount > 0
                ? 'Добавить к счёту · ${rub(amount)}'
                : 'Добавить к счёту'),
          ),
        ),
        if (canLink) ...[
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _busy || amount <= 0
                  ? null
                  : () => _leave(amount, selected, team, session, method: 'link', link: link),
              icon: const Icon(Icons.open_in_new, size: 18),
              label: Text('Перевести напрямую: ${selected!.name}'),
            ),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          'Чаевые не входят в счёт заведения — их получит '
          '${selected == null ? 'смена, поровну' : selected.name}.',
          style: TextStyle(color: KolibriColors.textMuted, fontSize: 12),
        ),
        _myTips(),
      ],
    );
  }

  String _memberLabel(TipTeamMember m) {
    final role = AppConstants.positionGuestLabel(m.position);
    return role.isEmpty ? m.name : '${m.name} · $role';
  }

  /// Выбор суммы с поправкой на счёт: проценты есть только у непустого
  /// счёта, фиксированные суммы — только у пустого. Счёт может наполниться
  /// прямо на глазах, пока открыт экран.
  int _effectivePreset(double bill) {
    if (_preset == -1) return -1;
    if (bill > 0 && _preset > 1000) return 10;
    if (bill <= 0 && _preset < 1000) return 1000 + _fixed[1];
    return _preset;
  }

  double _amount(double bill, int preset) {
    if (preset == -1) return double.tryParse(_custom.text.trim()) ?? 0;
    if (preset > 1000) return (preset - 1000).toDouble();
    return tipFromPercent(bill, preset);
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text, style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
      );

  Widget _chip({required String label, required bool selected, required VoidCallback onTap}) =>
      ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) => onTap(),
        showCheckmark: false,
        selectedColor: KolibriColors.primary.withValues(alpha: 0.22),
        side: BorderSide(color: selected ? KolibriColors.primary : KolibriColors.border),
        labelStyle: TextStyle(
          color: selected ? KolibriColors.textPrimary : KolibriColors.textMuted,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
        ),
      );

  Future<void> _leave(
    double amount,
    TipTeamMember? to,
    List<TipTeamMember> team,
    SessionModel? session, {
    required String method,
    String link = '',
  }) async {
    if (amount > 100000) {
      _snack('Слишком большая сумма — проверьте, пожалуйста');
      return;
    }
    setState(() => _busy = true);
    try {
      if (method == 'link') {
        // Сначала ссылка: если телефон её не открыл, записи о переводе
        // быть не должно.
        final ok = await launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication);
        if (!ok) {
          _snack('Не удалось открыть ссылку');
          return;
        }
      }
      await _tips.leaveTip(
        amount: amount,
        to: to,
        team: to == null ? team.where((m) => m.id.isNotEmpty).toList() : const [],
        sessionId: widget.sessionId,
        tableName: session?.tableName ?? '',
        clientUid: widget.clientUid,
        method: method,
      );
      if (!mounted) return;
      _custom.clear();
      _snack(method == 'link'
          ? 'Спасибо! ${to?.name ?? 'Сотрудник'} увидит, что вы перевели чаевые'
          : 'Спасибо! ${rub(amount)} добавим к счёту — '
              '${VenueService.instance.terms.staff} возьмёт их при оплате');
    } catch (_) {
      _snack('Не удалось отправить — проверьте связь');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _myTips() => StreamBuilder<List<TipModel>>(
        stream: _mine,
        builder: (context, snap) {
          final list = (snap.data ?? const <TipModel>[]).where((t) => t.status != 'cancelled').toList();
          if (list.isEmpty) return const SizedBox.shrink();
          return Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _label('Ваши чаевые за этот визит'),
                for (final t in list)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${rub(t.amount)} — ${t.recipientLabel} · ${_status(t)}',
                            style: TextStyle(
                              fontSize: 13,
                              color: t.status == 'paid' ? KolibriColors.success : KolibriColors.textPrimary,
                            ),
                          ),
                        ),
                        if (t.onBill)
                          TextButton(
                            style: TextButton.styleFrom(minimumSize: const Size(0, 36)),
                            onPressed: () => _tips.cancel(t.id),
                            child: const Text('Отменить'),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          );
        },
      );

  String _status(TipModel t) {
    if (t.isLink) return 'переведено напрямую';
    if (t.status == 'paid') return 'оплачено, спасибо!';
    return 'добавим к счёту';
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }
}
