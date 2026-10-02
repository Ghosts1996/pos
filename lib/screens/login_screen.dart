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
import '../services/saas_device_join_service.dart';
import '../services/staff_device_service.dart';
import '../services/staff_session_store.dart';
import '../services/table_key_service.dart';
import '../services/hall_watch_service.dart';
import '../services/tenant_join_flow.dart';
import '../utils/human_error.dart';
import '../utils/constants.dart';
import '../theme/app_theme.dart';
import '../widgets/pin_pad.dart';
import '../widgets/shift_open_dialog.dart';
import 'admin/admin_home_screen.dart';
import 'employee/floor_plan_screen.dart';
import 'saas/saas_device_pairing_screen.dart';
import 'staff_device_setup_screen.dart';
import '../utils/startup_log.dart';

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

  /// Касса точки сети: при запуске приложения она спрашивает, в кассу
  /// какой точки войти, — у каждой точки свои сотрудники и PIN-коды. Один
  /// раз за запуск; дальше точку меняют кнопкой «Другая точка сети» над
  /// клавиатурой.
  static bool _pointAskedThisRun = false;
  List<ChainPoint>? _points;
  bool _choosingPoint = false;
  String? _switchingTo;
  String? _pointError;
  bool _loadingPoints = false;
  String? _pointsLoadError;

  bool get _hasPoints => (_points?.length ?? 0) >= 2;

  /// Кнопка «Другая точка сети» видна у любой точки сети, пока список точек
  /// не загрузился (плохая связь — загрузим по нажатию), и пропадает, только
  /// если в сети действительно одна точка.
  bool get _showPointSwitch =>
      kSaasMode && AppScope.chainId != null && (_points == null || _hasPoints);

  /// Планшет ещё не отмечен как рабочее устройство — до регистрации база не
  /// отдаёт ему ни сотрудников, ни столы, ни чеки (см. firestore.rules).
  /// null — пока проверяем.
  bool? _deviceRegistered;

  @override
  void initState() {
    super.initState();
    StartupLog.step('экран входа');
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
    if (registered) {
      unawaited(_preselectLastRole());
      unawaited(_loadPoints());
    }
  }

  /// Точки сети с сервера. Нет сети — касса остаётся в своей точке, а по
  /// нажатию «Другая точка сети» ([open]) пробуем ещё раз и говорим, что не так.
  Future<void> _loadPoints({bool open = false}) async {
    final chainId = AppScope.chainId;
    if (!kSaasMode || chainId == null || _loadingPoints) return;
    setState(() {
      _loadingPoints = true;
      _pointsLoadError = null;
    });
    try {
      final points = await SaasDeviceJoinService().chainPoints(chainId).timeout(const Duration(seconds: 12));
      if (!mounted) return;
      setState(() {
        _loadingPoints = false;
        _points = points;
        if (points.length >= 2 && (open || !_pointAskedThisRun)) _choosingPoint = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingPoints = false;
        if (open) _pointsLoadError = 'Не удалось загрузить точки сети: ${humanError(e, lower: true)}';
      });
    }
  }

  void _openPointSwitch() {
    if (_hasPoints) {
      setState(() {
        _pointError = null;
        _choosingPoint = true;
      });
    } else {
      _loadPoints(open: true);
    }
  }

  Future<void> _choosePoint(ChainPoint point) async {
    if (_switchingTo != null) return;
    if (point.tenantId == AppScope.tenantId) {
      _pointAskedThisRun = true;
      setState(() {
        _choosingPoint = false;
        _pointError = null;
      });
      return;
    }
    setState(() {
      _switchingTo = point.tenantId;
      _pointError = null;
    });
    try {
      await switchChainPoint(point.tenantId);
      if (!mounted) return;
      _pointAskedThisRun = true;
      setState(() {
        _switchingTo = null;
        _choosingPoint = false;
        _pin = '';
        _error = null;
        _adminMode = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _switchingTo = null;
        _pointError = 'Не удалось открыть кассу «${point.name}»: ${humanError(e, lower: true)}';
      });
    }
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
        backgroundColor: BrandPalette.ink,
        body: BrandBackdrop(child: Center(child: CircularProgressIndicator(color: BrandPalette.brass))),
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

    if (_choosingPoint && _hasPoints) return _pointPicker();

    // Касса у всех заведений в фирменном стиле ZalPOS (см. main.dart):
    // знак и название платформы. Название заведения — мелкой подписью,
    // чтобы было видно, к какому заведению привязан планшет.
    final venue = (AppScope.branding?.appName ?? '').trim();
    // Точка сети — её название: видно, в кассу какой точки входят.
    final point = _points?.where((p) => p.tenantId == AppScope.tenantId).firstOrNull;
    final caption = (point?.name ?? '').isNotEmpty ? point!.name : (venue.startsWith('ZalPOS') ? null : venue);

    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        BrandMark(caption: caption),
        if (_showPointSwitch) ...[
          const SizedBox(height: 10),
          TextButton.icon(
            onPressed: _loading || _loadingPoints ? null : _openPointSwitch,
            style: TextButton.styleFrom(foregroundColor: BrandPalette.brass, visualDensity: VisualDensity.compact),
            icon: _loadingPoints
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.storefront_rounded, size: 18),
            label: const Text('Другая точка сети', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
          if (_pointsLoadError != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(_pointsLoadError!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: BrandPalette.error, fontSize: 12.5, fontWeight: FontWeight.w600)),
            ),
        ],
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
                      style: const TextStyle(color: BrandPalette.error, fontSize: 13, fontWeight: FontWeight.w600)),
                ),
        ),
        // PIN демо-сотрудников задаёт createDemoTenant (saas-gateway).
        if (AppScope.isDemo) ...[
          Text(
            _adminMode ? AppScope.demoPins.adminHint : AppScope.demoPins.staffHint,
            textAlign: TextAlign.center,
            style: const TextStyle(color: BrandPalette.muted, fontSize: 12),
          ),
          // Демо-сеть открывается и в демо-приложении гостя — по этому коду.
          if (AppScope.demoCode.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Код демо для приложения гостя: ${AppScope.demoCode}',
                textAlign: TextAlign.center,
                style: const TextStyle(color: BrandPalette.brass, fontSize: 12, fontWeight: FontWeight.w700),
              ),
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
      backgroundColor: BrandPalette.ink,
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
                    child: CircularProgressIndicator(color: BrandPalette.brass),
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

  /// «В какую кассу войти?» — точки сети карточками.
  Widget _pointPicker() {
    final points = _points ?? const <ChainPoint>[];
    return Scaffold(
      backgroundColor: BrandPalette.ink,
      body: BrandBackdrop(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const BrandMark(caption: 'Сеть заведений'),
                    const SizedBox(height: 22),
                    Text(
                      'В какую кассу войти?',
                      textAlign: TextAlign.center,
                      style: AppFonts.display(30, color: BrandPalette.ivory),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'У каждой точки свои столы, чеки, сотрудники и PIN-коды. Сменить точку можно на экране входа.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: BrandPalette.muted, fontSize: 13.5),
                    ),
                    const SizedBox(height: 18),
                    for (final p in points) ...[
                      _PointCard(
                        point: p,
                        current: p.tenantId == AppScope.tenantId,
                        busy: _switchingTo == p.tenantId,
                        enabled: _switchingTo == null && p.status != 'suspended',
                        onTap: () => _choosePoint(p),
                      ),
                      const SizedBox(height: 10),
                    ],
                    if (_pointError != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(_pointError!,
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: BrandPalette.error, fontSize: 13, fontWeight: FontWeight.w600)),
                      ),
                    if (AppScope.isDemo)
                      const Padding(
                        padding: EdgeInsets.only(top: 6),
                        child: Text(
                          'Демо-сеть из двух точек: у каждой свои сотрудники и PIN-коды — подсказка на экране входа.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.white38, fontSize: 12),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PointCard extends StatelessWidget {
  const _PointCard({
    required this.point,
    required this.current,
    required this.busy,
    required this.enabled,
    required this.onTap,
  });

  final ChainPoint point;
  final bool current;
  final bool busy;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final suspended = point.status == 'suspended';
    return Material(
      color: current ? const Color(0x1FB35C30) : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: current ? const Color(0x99B35C30) : BrandPalette.hairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 12, 16),
          child: Row(children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: current ? BrandPalette.copper : null,
                border: current ? null : Border.all(color: BrandPalette.hairline),
              ),
              child: Icon(Icons.storefront_outlined, color: current ? BrandPalette.ivory : BrandPalette.brass, size: 21),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(point.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        color: enabled || current ? BrandPalette.ivory : Colors.white38,
                        fontSize: 16,
                        fontWeight: FontWeight.w600)),
                if (current || suspended)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      suspended ? 'Точка приостановлена владельцем' : 'Эта касса сейчас здесь',
                      style: const TextStyle(color: BrandPalette.muted, fontSize: 12),
                    ),
                  ),
              ]),
            ),
            if (busy)
              const SizedBox(
                  width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: BrandPalette.brass))
            else
              Icon(Icons.chevron_right_rounded, color: enabled ? BrandPalette.brass : Colors.white24),
          ]),
        ),
      ),
    );
  }
}
