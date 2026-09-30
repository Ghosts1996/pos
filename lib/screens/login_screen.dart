import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../build_info.dart';
import '../models/employee.dart';
import '../services/app_lock.dart';
import '../services/app_scope.dart';
import '../services/demo_gate.dart';
import '../services/firestore_service.dart';
import '../services/guest_link_service.dart';
import '../services/push_service.dart';
import '../services/reservation_service.dart';
import '../services/staff_device_service.dart';
import '../services/staff_session_store.dart';
import '../services/table_key_service.dart';
import '../services/hall_watch_service.dart';
import '../utils/constants.dart';
import '../widgets/pin_pad.dart';
import '../widgets/shift_open_dialog.dart';
import 'admin/admin_home_screen.dart';
import 'employee/floor_plan_screen.dart';
import 'saas/saas_device_pairing_screen.dart';
import 'staff_device_setup_screen.dart';

/// Вход по PIN-коду сотрудника. Длина кода зависит от роли — 4 цифры у
/// сотрудника, 6 у администратора (см. AppConstants.pinLengthForRole) —
/// поэтому, в отличие от прежней версии, роль здесь выбирается ЯВНО
/// переключателем над клавиатурой, а не определяется по факту совпадения
/// кода: at PIN-entry time не знаем заранее, сколько цифр ждать, чтобы
/// сработал автовход после последней. Сотрудник — режим по умолчанию (это
/// частый вход в течение смены), администратор — редкий, отдельным тапом.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _fs = FirestoreService();
  final _staffDevice = StaffDeviceService();
  final _session = StaffSessionStore.instance;
  String _pin = '';
  bool _loading = false;
  String? _error;
  bool _adminMode = false;

  int get _requiredPinLength => _adminMode
      ? AppConstants.adminPinLength
      : AppConstants.employeePinLength;

  /// Проверяем, отмечен ли планшет рабочим устройством, — показываем
  /// ожидание вместо клавиатуры, чтобы не мигать экраном ввода PIN.
  bool _restoring = true;

  /// Неверный PIN — точки вздрагивают (см. PinDots).
  int _errorTick = 0;

  /// Планшет ещё не отмечен как рабочее устройство — до регистрации база не
  /// отдаёт ему ни сотрудников, ни столы, ни чеки (см. firestore.rules).
  /// null — пока проверяем.
  bool? _deviceRegistered;

  @override
  void initState() {
    super.initState();
    // Экран входа — в кассе никто не работает, блокировать нечего.
    AppLock.instance.signedOut();
    _start();
  }

  Future<void> _start() async {
    final registered = await _staffDevice.isRegistered();
    if (!mounted) return;
    setState(() {
      _deviceRegistered = registered;
      _restoring = false;
    });
    if (registered) unawaited(_preselectLastRole());
  }

  /// После закрытия кассы PIN спрашиваем всегда (AppLock), но роль
  /// прошлого сотрудника выбираем сами: администратору не нужно каждый раз
  /// переключаться на шестизначный PIN.
  Future<void> _preselectLastRole() async {
    final id = await _session.savedEmployeeId();
    if (id.isEmpty) return;
    try {
      final employee = await _fs.employeeById(id);
      if (!mounted || employee == null || _pin.isNotEmpty) return;
      _setAdminMode(employee.role == AppConstants.roleAdmin);
    } catch (_) {
      // Нет связи — останется «Сотрудник», вход сам сообщит о сети.
    }
  }

  Future<void> _submit() async {
    if (_pin.length < _requiredPinLength || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    Employee? employee;
    try {
      employee = await _fs.findByPin(_pin);
    } on FirebaseException catch (e) {
      if (!mounted) return;
      // permission-denied — не сеть: правила не отдают сотрудников
      // незарегистрированному устройству. Показываем настоящую причину.
      if (e.code == 'permission-denied') {
        setState(() {
          _loading = false;
          _deviceRegistered = false;
          _pin = '';
        });
        return;
      }
      setState(() {
        _loading = false;
        _error = 'Нет связи с сервером. Проверьте интернет и попробуйте снова';
        _pin = '';
      });
      return;
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Нет связи с сервером. Проверьте интернет и попробуйте снова';
        _pin = '';
      });
      return;
    }
    if (!mounted) return;
    setState(() => _loading = false);
    if (employee == null) {
      setState(() {
        _error = 'Неверный PIN-код';
        _pin = '';
        _errorTick++;
      });
      return;
    }
    final loggedInEmployee = employee;
    // Запоминаем вошедшего (только id, не PIN) и сообщаем фоновой службе:
    // вызовы и напоминания — по специализации этого сотрудника.
    unawaited(_session
        .remember(loggedInEmployee.id)
        .then((_) => HallWatchService.instance.identityChanged()));
    // Смену открывает _enter(): там спрашиваем, кто именно выходит в зал.
    // Разовая достройка обезличенного зеркала занятости столов — нужна
    // заведениям, которые обновились с версии без reservationSlots.
    // Проверка стоит один документ и ничего не делает, если всё на месте.
    unawaited(ReservationService().ensureSlotMirror());
    unawaited(_fs.backfillTablesBusyUntil());
    // Секреты столов для QR-наклеек — столам, у которых их ещё нет.
    unawaited(TableKeyService.instance.ensureKeys().catchError((_) => 0));
    unawaited(GuestLinkService().backfillGuestIndexes());
    await _enter(loggedInEmployee);
  }

  Future<void> _enter(Employee employee) async {
    if (!mounted) return;
    // Свернули кассу — вернёт её только PIN этого сотрудника.
    AppLock.instance.signedIn(employee);
    // Переподписка на топики специализации ПОСЛЕ входа — до этого момента
    // приложение не знает, кто именно работает на этом планшете. Сюда же
    // общий планшет, на котором сотрудники сменяют друг друга по PIN, всегда
    // переподписан на того, кто сейчас вошёл (см.
    // PushService.updateStaffPositionSubscription).
    unawaited(PushService.instance.updateStaffPositionSubscription(employee));
    // Если открытой смены нет — спрашиваем, кто выходит в зал, и открываем
    // её на него: ночная смена к утру уже закрыта — иначе дневной
    // кальянщик остался бы без смены и без уведомлений.
    await ensureShiftOpen(context, me: employee);
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => employee.role == AppConstants.roleAdmin
            ? AdminHomeScreen(employee: employee)
            : FloorPlanScreen(employee: employee),
      ),
    );
  }

  void _tap(String digit) {
    if (_pin.length >= _requiredPinLength) return;
    setState(() => _pin += digit);
    if (_pin.length == _requiredPinLength) _submit();
  }

  void _setAdminMode(bool value) {
    if (_adminMode == value) return;
    setState(() {
      _adminMode = value;
      _pin = '';
      _error = null;
    });
  }

  void _backspace() {
    if (_pin.isEmpty) return;
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  // Под экраном входа в стеке только заставка запуска: системный жест
  // «Назад» закрывал вход и оставлял пустую заставку, откуда не выйти.
  // «Назад» здесь сворачивает кассу, как любое приложение на главном экране.
  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) SystemNavigator.pop();
        },
        child: _content(context),
      );

  Widget _content(BuildContext context) {
    if (_restoring) {
      return const Scaffold(
        backgroundColor: BrandPalette.night,
        body: BrandBackdrop(child: Center(child: CircularProgressIndicator(color: BrandPalette.sky))),
      );
    }

    if (_deviceRegistered == false) {
      // В SaaS планшет привязывают к заведению кодом приглашения (или
      // открывают демо), секрета meta/staffSecret там нет. Сюда касса
      // попадает, когда планшет отключили в кабинете или демо удалилось.
      if (kSaasMode) {
        final lost = (AppScope.branding?.appName ?? '').trim();
        return SaasDevicePairingScreen(
          lostVenueName: lost.startsWith('ZalPOS') ? null : lost,
          lostDemo: AppScope.isDemo,
        );
      }
      return StaffDeviceSetupScreen(
        onRegistered: () => setState(() {
          _deviceRegistered = true;
          _error = null;
        }),
      );
    }

    // Касса у всех заведений в фирменном стиле ZalPOS (см. main.dart):
    // знак и название платформы. Название заведения — мелкой подписью,
    // чтобы было видно, к какому заведению привязан планшет.
    final venue = (AppScope.branding?.appName ?? '').trim();

    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        BrandMark(caption: venue.startsWith('ZalPOS') ? null : venue),
        const SizedBox(height: 22),
        // Сотрудник — режим по умолчанию (частый вход в течение смены,
        // PIN короче), администратор выбирается явно: пока не знаем,
        // сколько цифр наберут, автовход после последней цифры не может
        // сработать сам по себе.
        RoleSwitch(admin: _adminMode, enabled: !_loading, onChanged: _setAdminMode),
        const SizedBox(height: 22),
        PinDots(length: _requiredPinLength, filled: _pin.length, errorTick: _errorTick),
        SizedBox(
          height: 26,
          child: _error == null
              ? null
              : Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Color(0xFFFF7A86), fontSize: 13, fontWeight: FontWeight.w600)),
                ),
        ),
        // PIN демо-сотрудников задаёт createDemoTenant (saas-gateway).
        if (AppScope.isDemo) ...[
          Text(
            _adminMode
                ? 'Демо: администратор — 111111'
                : 'Демо: кальянщик — 1111, официант — 2222, бармен — 3333',
            textAlign: TextAlign.center,
            style: const TextStyle(color: BrandPalette.muted, fontSize: 12),
          ),
          // Демо живёт 3 дня, потом сбрасывается в исходный вид (DemoGate).
          if (DemoGate.remainingText() case final left?)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Демо сбросится в исходный вид $left',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white38, fontSize: 11.5),
              ),
            ),
        ],
      ],
    );

    return Scaffold(
      backgroundColor: BrandPalette.night,
      body: BrandBackdrop(
        child: SafeArea(
          child: LayoutBuilder(builder: (context, box) {
            // Невысокий широкий экран (планшет или окно Windows в альбомной
            // ориентации, телефон на боку) — шапка слева, цифры справа, иначе
            // клавиатура уходит за нижний край. Клавиши — квадраты в три
            // колонки: ширина подбирается под высоту экрана.
            final side = box.maxWidth > box.maxHeight && box.maxHeight < 600;
            final keypadWidth = pinKeypadWidth(box, side: side, headerHeight: AppScope.isDemo ? 340 : 300);
            final keypad = _loading
                ? const Padding(
                    padding: EdgeInsets.all(24),
                    child: CircularProgressIndicator(color: BrandPalette.sky),
                  )
                : PinKeypad(width: keypadWidth, onDigit: _tap, onBackspace: _backspace);
            return Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: side
                    ? Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Flexible(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 340), child: header)),
                          const SizedBox(width: 48),
                          keypad,
                        ],
                      )
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [header, const SizedBox(height: 18), keypad],
                      ),
              ),
            );
          }),
        ),
      ),
    );
  }
}