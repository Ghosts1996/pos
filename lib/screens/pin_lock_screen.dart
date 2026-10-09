import 'dart:async';

import 'package:flutter/material.dart';

import '../utils/pin_hash.dart';
import '../models/employee.dart';
import '../services/app_lock.dart';
import '../services/app_scope.dart';
import '../services/demo_gate.dart';
import '../services/firestore_service.dart';
import '../services/staff_session_store.dart';
import '../utils/constants.dart';
import '../theme/app_theme.dart';
import '../widgets/pin_pad.dart';
import 'login_screen.dart';

/// Касса свернули — при возвращении поверх того же экрана ввод PIN
/// (AppLock). Вернуть кассу может только тот, кто в ней работал: экран под
/// блокировкой остаётся как был. Другой сотрудник входит через «Сменить
/// сотрудника».
class PinLockScreen extends StatefulWidget {
  const PinLockScreen({super.key, required this.employee});

  final Employee employee;

  @override
  State<PinLockScreen> createState() => _PinLockScreenState();
}

class _PinLockScreenState extends State<PinLockScreen> {
  String _pin = '';
  bool _checking = false;
  String? _error;
  int _errorTick = 0;

  Employee get _employee => widget.employee;

  int get _length =>
      _employee.role == AppConstants.roleAdmin ? AppConstants.adminPinLength : AppConstants.employeePinLength;

  String get _who {
    if (_employee.role == AppConstants.roleAdmin) return 'Администратор';
    final p = AppConstants.normalizePosition(_employee.position);
    return p == AppConstants.positionUniversal ? 'Сотрудник' : AppConstants.positionLabel(p);
  }

  void _tap(String digit) {
    if (_checking || _pin.length >= _length) return;
    setState(() {
      _pin += digit;
      _error = null;
    });
    if (_pin.length == _length) _check();
  }

  void _backspace() {
    if (_checking || _pin.isEmpty) return;
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  Future<void> _check() async {
    final pin = _pin;
    String? hash;
    Future<bool> matches(Employee e) async {
      if (e.pinHash.isEmpty) return e.pinCode.isNotEmpty && e.pinCode == pin;
      return e.pinHash == (hash ??= await PinHash.of(pin));
    }

    var ok = await matches(_employee);
    Employee? fresh;
    if (!ok) {
      // PIN могли поменять, пока касса работала, — сверяем со свежей
      // записью. Нет сети — остаётся проверка по записи в памяти.
      setState(() => _checking = true);
      try {
        fresh = await FirestoreService().employeeById(_employee.id).timeout(const Duration(seconds: 5));
        ok = fresh != null && await matches(fresh);
      } catch (_) {}
      if (!mounted) return;
    }
    if (ok) {
      AppLock.instance.signedIn(fresh ?? _employee);
      return;
    }
    setState(() {
      _checking = false;
      _pin = '';
      _errorTick++;
      _error = 'Неверный PIN-код';
    });
  }

  Future<void> _switchEmployee() async {
    await StaffSessionStore.instance.forget();
    appNavigatorKey.currentState
        ?.pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const LoginScreen()), (_) => false);
    AppLock.instance.signedOut();
  }

  @override
  Widget build(BuildContext context) {
    final venue = (AppScope.branding?.appName ?? '').trim();
    final header = Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: const Color(0x66CFA567)),
        ),
        child: const Icon(Icons.lock_outline_rounded, color: BrandPalette.brass, size: 24),
      ),
      const SizedBox(height: 18),
      Text(
        'Касса заблокирована',
        textAlign: TextAlign.center,
        style: AppFonts.display(32, color: BrandPalette.ivory),
      ),
      const SizedBox(height: 10),
      Text(
        _employee.name,
        textAlign: TextAlign.center,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: BrandPalette.ivory, fontSize: 16, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 2),
      Text(
        [_who, if (venue.isNotEmpty && !venue.startsWith('ZalPOS')) venue].join(' · ').toUpperCase(),
        textAlign: TextAlign.center,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppFonts.overline.copyWith(color: BrandPalette.muted),
      ),
      const SizedBox(height: 22),
      PinDots(length: _length, filled: _pin.length, errorTick: _errorTick),
      SizedBox(
        height: 30,
        child: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(
            _error ?? 'Введите PIN, чтобы продолжить',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: _error == null ? BrandPalette.muted : BrandPalette.error,
              fontSize: 13,
              fontWeight: _error == null ? FontWeight.w400 : FontWeight.w600,
            ),
          ),
        ),
      ),
      // PIN демо-сотрудников задаёт createDemoTenant (saas-gateway).
      if (AppScope.isDemo)
        Text(
          _employee.role == AppConstants.roleAdmin ? AppScope.demoPins.adminHint : AppScope.demoPins.staffHint,
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white38, fontSize: 11.5),
        ),
    ]);

    final switchButton = TextButton.icon(
      onPressed: _checking ? null : _switchEmployee,
      style: TextButton.styleFrom(foregroundColor: BrandPalette.brass),
      icon: const Icon(Icons.swap_horiz_rounded, size: 20),
      label: const Text('Сменить сотрудника', style: TextStyle(fontWeight: FontWeight.w600)),
    );

    // Непрозрачный экран поверх кассы — касания до неё не доходят;
    // «Назад» забирает AppLock.
    return Scaffold(
      backgroundColor: BrandPalette.ink,
      body: BrandBackdrop(
        child: SafeArea(
          child: LayoutBuilder(builder: (context, box) {
            final side = box.maxWidth > box.maxHeight && box.maxHeight < 600;
            final keypadWidth = pinKeypadWidth(box, side: side, headerHeight: 360);
            final keypad = _checking
                ? const Padding(
                    padding: EdgeInsets.all(24),
                    child: CircularProgressIndicator(color: BrandPalette.brass),
                  )
                : PinKeypad(width: keypadWidth, onDigit: _tap, onBackspace: _backspace);
            return Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: side
                    ? Row(mainAxisSize: MainAxisSize.min, children: [
                        Flexible(
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 340),
                            child: Column(mainAxisSize: MainAxisSize.min, children: [header, switchButton]),
                          ),
                        ),
                        const SizedBox(width: 48),
                        keypad,
                      ])
                    : Column(mainAxisSize: MainAxisSize.min, children: [
                        header,
                        const SizedBox(height: 14),
                        keypad,
                        const SizedBox(height: 8),
                        switchButton,
                      ]),
              ),
            );
          }),
        ),
      ),
    );
  }
}
