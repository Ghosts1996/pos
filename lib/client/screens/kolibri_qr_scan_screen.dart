import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../../services/guest_link_service.dart';
import '../widgets/check_picker_sheet.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';

/// Сканер QR-кода стола.
///
/// На столе наклейка с кодом `kolibri://table/{tableId}` (генерируется в
/// админке POS, экран «QR-коды столов»). Сканирование сразу привязывает
/// гостя к открытому за этим столом чеку — дальше он видит счёт и таймер.
///
/// Возвращает id чека через Navigator.pop, либо null.
class KolibriQrScanScreen extends StatefulWidget {
  const KolibriQrScanScreen({super.key});

  @override
  State<KolibriQrScanScreen> createState() => _KolibriQrScanScreenState();
}

class _KolibriQrScanScreenState extends State<KolibriQrScanScreen> {
  final _controller = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);
  final _link = GuestLinkService();
  final _auth = KolibriAuthService();

  bool _handling = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// Из кода достаём tableId. Поддерживаем и схему kolibri://table/xxx,
  /// и обычную ссылку с параметром ?table=xxx, и «голый» id — чтобы старые
  /// наклейки продолжали работать.
  String? _extractTableId(String raw) {
    final value = raw.trim();
    if (value.isEmpty) return null;
    final uri = Uri.tryParse(value);
    if (uri != null) {
      if (uri.scheme == 'kolibri' && uri.pathSegments.isNotEmpty) {
        return uri.pathSegments.last;
      }
      final param = uri.queryParameters['table'];
      if (param != null && param.isNotEmpty) return param;
      if (uri.pathSegments.length >= 2 && uri.pathSegments[uri.pathSegments.length - 2] == 'table') {
        return uri.pathSegments.last;
      }
    }
    return value.contains(' ') ? null : value;
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_handling) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;

    final tableId = _extractTableId(raw);
    if (tableId == null) {
      setState(() => _error = 'Это не код стола');
      return;
    }

    setState(() {
      _handling = true;
      _error = null;
    });

    try {
      await _auth.ensureGuest();
      final result = await _link.bindToTable(_auth.uid, tableId);
      if (!mounted) return;
      if (result.isEmpty) {
        setState(() {
          _handling = false;
          _error = 'За этим столом сейчас нет открытого счёта — попросите кальянщика начать сеанс';
        });
        return;
      }
      // За столом несколько счетов — гость выбирает свой, иначе он увидел
      // бы чужой заказ и чужую сумму.
      if (result.needsChoice) {
        final picked = await CheckPickerSheet.show(
          context,
          tableName: result.tableName,
          checks: result.choices,
        );
        if (!mounted) return;
        if (picked == null) {
          setState(() => _handling = false);
          return;
        }
        await _link.bindToSession(_auth.uid, tableId, picked.id);
        if (!mounted) return;
        Navigator.pop(context, picked.id);
        return;
      }
      Navigator.pop(context, result.sessionId);
    } catch (e) {
      if (mounted) {
        setState(() {
          _handling = false;
          _error = '$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Код стола')),
      body: Stack(
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          // Рамка прицела — гостю понятно, куда наводить.
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: KolibriColors.primary, width: 3),
                borderRadius: BorderRadius.circular(24),
              ),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 48,
            child: Column(
              children: [
                if (_handling)
                  const CircularProgressIndicator()
                else
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    decoration: BoxDecoration(
                      color: KolibriColors.surface.withValues(alpha: 0.92),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      _error ?? 'Наведите камеру на код, наклеенный на столе',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: _error == null ? KolibriColors.textPrimary : KolibriColors.warning,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
