import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/employee.dart';
import '../../models/shift_model.dart';
import '../../services/atol_local_kassa.dart';
import '../../services/firestore_service.dart';
import '../../services/kassa_service.dart';
import '../../services/printer_service.dart';
import '../../services/venue_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../utils/z_report.dart';
import '../../widgets/shift_flow.dart';

/// Админ → «Z-отчёт»: снять Z-отчёт (он же закрывает смену заведения и,
/// если касса — регистратор АТОЛ в заведении, смену на ККТ) и архив
/// Z-отчётов прошлых смен с печатью и копией. X-отчёт — для середины
/// смены, без закрытия.
class ZReportScreen extends StatefulWidget {
  final Employee employee;
  const ZReportScreen({super.key, required this.employee});

  @override
  State<ZReportScreen> createState() => _ZReportScreenState();
}

class _ZReportScreenState extends State<ZReportScreen> {
  final _fs = FirestoreService();
  late Future<ShiftModel?> _open;
  late Future<List<ShiftModel>> _archive;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    setState(() {
      _open = _fs.currentOpenShift();
      _archive = _fs.closedShifts();
    });
  }

  Future<void> _takeZ(ShiftModel shift) async {
    setState(() => _busy = true);
    final closed = await closeVenueShift(context, shift: shift, me: widget.employee);
    if (!mounted) return;
    setState(() => _busy = false);
    // Снятый Z-отчёт показало само закрытие (closeShiftWithCashCount).
    _reload();
    if (!closed) return;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Z-отчёт')),
      body: CenteredBody(
        maxWidth: 760,
        child: RefreshIndicator(
          onRefresh: () async => _reload(),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              FutureBuilder<ShiftModel?>(
                future: _open,
                builder: (context, snap) {
                  if (snap.connectionState == ConnectionState.waiting) {
                    return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
                  }
                  final shift = snap.data;
                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(shift == null ? 'Смена заведения закрыта' : 'Смена открыта',
                              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 4),
                          Text(
                            shift == null
                                ? 'Новая смена откроется, когда сотрудник начнёт работу. Отчёты закрытых смен — ниже.'
                                : 'С ${ZReport.formatDate(shift.openedAt)} · ${shift.openedBy}. Z-отчёт подводит итог '
                                    'смены и закрывает её: пересчёт кассы, инкассация'
                                    '${kassaService is AtolLocalKassaService ? ', закрытие смены на ККТ' : ''}.',
                            style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                          ),
                          if (shift != null) ...[
                            const SizedBox(height: 12),
                            FilledButton.icon(
                              style: FilledButton.styleFrom(backgroundColor: AppColors.danger, minimumSize: const Size.fromHeight(52)),
                              onPressed: _busy ? null : () => _takeZ(shift),
                              icon: const Icon(Icons.summarize_outlined),
                              label: const Text('Снять Z-отчёт и закрыть смену'),
                            ),
                          ],
                        ],
                      ),
                    ),
                  );
                },
              ),
              const SizedBox(height: 16),
              const Text('Архив Z-отчётов', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              FutureBuilder<List<ShiftModel>>(
                future: _archive,
                builder: (context, snap) {
                  if (snap.connectionState == ConnectionState.waiting) return const SizedBox.shrink();
                  if (snap.hasError) {
                    return Text('Не удалось загрузить: ${humanError(snap.error, lower: true)}',
                        style: TextStyle(color: AppColors.danger));
                  }
                  final list = snap.data ?? const [];
                  if (list.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text('Закрытых смен пока нет', style: TextStyle(color: AppColors.textMuted)),
                    );
                  }
                  return Column(children: [
                    for (final s in list)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.receipt_long_outlined,
                            color: s.zFiscal != null && !s.zFiscal!.ok ? AppColors.warning : null),
                        title: Text(s.z?.title ?? 'Смена без номера'),
                        subtitle: Text('${ZReport.formatDate(s.openedAt)} — '
                            '${s.closedAt == null ? '' : ZReport.formatDate(s.closedAt!)}'
                            '${s.zFiscal != null && !s.zFiscal!.ok ? ' · ККТ не закрыта' : ''}'),
                        trailing: s.z == null
                            ? const Icon(Icons.chevron_right)
                            : Text(rub(s.z!.revenue), style: const TextStyle(fontWeight: FontWeight.w700)),
                        onTap: () async {
                          await Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) => ZReportDetailScreen(shift: s, employee: widget.employee)));
                          if (mounted) _reload();
                        },
                      ),
                  ]);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ZReportDetailScreen extends StatefulWidget {
  final ShiftModel shift;
  final Employee employee;
  final bool justClosed;
  const ZReportDetailScreen({super.key, required this.shift, required this.employee, this.justClosed = false});

  @override
  State<ZReportDetailScreen> createState() => _ZReportDetailScreenState();
}

class _ZReportDetailScreenState extends State<ZReportDetailScreen> {
  final _fs = FirestoreService();
  late final Future<ZReport> _report = _fs.zReportOf(widget.shift);
  late ZFiscal? _fiscal = widget.shift.zFiscal;
  bool _busy = false;

  Future<void> _retryKkt() async {
    final kkt = kassaService;
    if (kkt is! AtolLocalKassaService) return;
    setState(() => _busy = true);
    final f = await kkt.closeShift(uuid: 'z-${widget.shift.id}-${DateTime.now().millisecondsSinceEpoch}');
    await _fs.saveZFiscal(widget.shift.id, f).catchError((Object _) {});
    if (!mounted) return;
    setState(() {
      _busy = false;
      _fiscal = f;
    });
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(f.ok ? 'Смена на ККТ закрыта' : 'ККТ: ${f.error}')));
  }

  Future<void> _print(ZReport z) async {
    final printer = activeReceiptPrinter;
    if (printer == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Чековый принтер не подключён (Админ → Интеграции). Отчёт можно скопировать')));
      return;
    }
    final venue = VenueService.instance.cached.name;
    final lines = <ReportLine>[];
    for (final sec in z.sections()) {
      lines.add(const ReportLine.separator());
      lines.add(ReportLine(sec.title.toUpperCase(), bold: true));
      for (final r in sec.rows) {
        lines.add(ReportLine(r.label, right: r.value, bold: r.bold));
      }
    }
    if (z.items.isNotEmpty) {
      lines.add(const ReportLine.separator());
      lines.add(const ReportLine('ПОЗИЦИИ', bold: true));
      for (final i in z.items) {
        lines.add(ReportLine(i.name));
        lines.add(ReportLine('  ${i.qty} x ${rub(i.price)}', right: rub(i.total)));
      }
    }
    final f = _fiscal;
    if (f != null && f.ok && f.shiftNumber > 0) {
      lines.add(const ReportLine.separator());
      lines.add(ReportLine('Смена ККТ №${f.shiftNumber}', right: f.documentNumber.isEmpty ? '' : 'ФД ${f.documentNumber}'));
    }
    try {
      await printer.printReport(ReportPrint(
        title: z.number > 0 ? 'Z-ОТЧЁТ №${z.number}' : 'ЗАКРЫТИЕ СМЕНЫ',
        subtitle: [
          if (venue.isNotEmpty) venue,
          '${ZReport.formatDate(z.openedAt)} — ${ZReport.formatDate(z.closedAt)}',
          if (z.closedBy.isNotEmpty) 'Закрыл(а): ${z.closedBy}',
        ],
        lines: lines,
        footer: 'Печать: ${widget.employee.name}, ${ZReport.formatDate(DateTime.now())}',
      ));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Отчёт отправлен на принтер')));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось напечатать: ${humanError(e, lower: true)}')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.shift.z?.title ?? 'Отчёт о закрытии смены')),
      body: CenteredBody(
        maxWidth: 760,
        child: FutureBuilder<ZReport>(
          future: _report,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) {
              return Center(
                  child: Text('Не удалось собрать отчёт: ${humanError(snap.error, lower: true)}',
                      style: TextStyle(color: AppColors.danger)));
            }
            final z = snap.data!;
            final f = _fiscal;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                Text('${ZReport.formatDate(z.openedAt)} — ${ZReport.formatDate(z.closedAt)}'
                    '${z.closedBy.isNotEmpty ? ' · закрыл(а) ${z.closedBy}' : ''}',
                    style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                if (z.number == 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Смена закрыта без номера Z-отчёта (до обновления или без связи). Итоги собраны по чекам.',
                        style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
                  ),
                if (f != null) ...[
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: (f.ok ? AppColors.success : AppColors.warning).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(
                        f.ok
                            ? 'Смена на ККТ закрыта${f.shiftNumber > 0 ? ' · смена №${f.shiftNumber}' : ''}'
                                '${f.documentNumber.isNotEmpty ? ' · ФД ${f.documentNumber}' : ''}'
                                '${f.error.isNotEmpty ? ' (${f.error})' : ''}'
                            : 'Смена на ККТ не закрыта: ${f.error}',
                        style: const TextStyle(fontSize: 13.5),
                      ),
                      if (!f.ok && kassaService is AtolLocalKassaService)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: OutlinedButton.icon(
                            onPressed: _busy ? null : _retryKkt,
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('Закрыть смену на ККТ'),
                          ),
                        ),
                    ]),
                  ),
                ],
                for (final sec in z.sections()) ...[
                  const SizedBox(height: 14),
                  Text(sec.title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                  const Divider(height: 12),
                  for (final r in sec.rows)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(child: Text(r.label, style: TextStyle(fontWeight: r.bold ? FontWeight.w700 : null))),
                        const SizedBox(width: 12),
                        Text(r.value, style: TextStyle(fontWeight: r.bold ? FontWeight.w700 : null)),
                      ]),
                    ),
                ],
                if (z.items.isNotEmpty)
                  ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    title: Text('Позиции · ${z.items.length}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    children: [
                      for (final i in z.items)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(children: [
                            Expanded(child: Text(i.name)),
                            Text('${i.qty} шт. · ${rub(i.total)}'),
                          ]),
                        ),
                    ],
                  ),
                const SizedBox(height: 20),
                Row(children: [
                  Expanded(
                    child: SizedBox(
                      height: 52,
                      child: OutlinedButton.icon(
                        onPressed: () => _print(z),
                        icon: const Icon(Icons.print_outlined, size: 20),
                        label: const Text('Распечатать'),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: SizedBox(
                      height: 52,
                      child: FilledButton.tonalIcon(
                        onPressed: () {
                          Clipboard.setData(ClipboardData(text: z.copyText(venue: VenueService.instance.cached.name)));
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Отчёт скопирован')));
                        },
                        icon: const Icon(Icons.copy_rounded, size: 20),
                        label: const Text('Скопировать'),
                      ),
                    ),
                  ),
                ]),
              ],
            );
          },
        ),
      ),
    );
  }
}
