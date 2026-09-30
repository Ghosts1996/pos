import 'dart:async';
import 'dart:math' as math;
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../build_info.dart';
import '../models/employee.dart';
import '../services/app_scope.dart';
import '../services/firestore_service.dart';
import '../services/guest_link_service.dart';
import '../services/push_service.dart';
import '../services/reservation_service.dart';
import '../services/staff_device_service.dart';
import '../services/staff_session_store.dart';
import '../services/table_key_service.dart';
import '../services/hall_watch_service.dart';
import '../utils/constants.dart';
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

  /// Идёт восстановление прошлого входа — показываем ожидание вместо
  /// клавиатуры, чтобы не мигать экраном ввода PIN на секунду.
  bool _restoring = true;

  /// Планшет ещё не отмечен как рабочее устройство — до регистрации база не
  /// отдаёт ему ни сотрудников, ни столы, ни чеки (см. firestore.rules).
  /// null — пока проверяем.
  bool? _deviceRegistered;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final registered = await _staffDevice.isRegistered();
    if (!mounted) return;
    setState(() => _deviceRegistered = registered);
    if (registered) {
      await _restoreLastLogin();
    }
    if (mounted) setState(() => _restoring = false);
  }

  /// Восстанавливает вход того, кто работал на планшете в прошлый раз:
  /// Android сам выгружает свёрнутое приложение, и PIN спрашивался бы после
  /// каждого такого перезапуска. Снова — только после «Сменить сотрудника».
  Future<void> _restoreLastLogin() async {
    final id = await _session.savedEmployeeId();
    if (id.isEmpty) return;
    try {
      final employee = await _fs.employeeById(id);
      // Сотрудника удалили или переименовали роль — спокойно спрашиваем PIN.
      if (employee == null) {
        await _session.forget();
        return;
      }
      if (!mounted) return;
      // Ждём: _enter может спросить, кто на смене, и до ответа экран
      // должен оставаться ожиданием, а не мигать клавиатурой PIN
      // за спиной у диалога.
      await _enter(employee);
    } catch (_) {
      // Нет связи — покажем обычный вход, он сообщит об этом понятнее.
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
    // Переподписка на топики специализации ПОСЛЕ входа — до этого момента
    // приложение не знает, кто именно работает на этом планшете. Сюда же
    // приходит и восстановленный вход, поэтому общий планшет, на котором
    // сотрудники сменяют друг друга по PIN, всегда переподписан на того,
    // кто сейчас вошёл (см. PushService.updateStaffPositionSubscription).
    unawaited(PushService.instance.updateStaffPositionSubscription(employee));
    // Если открытой смены нет — спрашиваем, кто выходит в зал, и открываем
    // её на него. Спрашиваем именно здесь, а не после ввода PIN: сюда
    // приходит и восстановленный вход (PIN сохраняется на планшете), а
    // ночная смена к утру уже закрыта — иначе дневной кальянщик остался бы
    // без смены и без уведомлений.
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
        backgroundColor: Color(0xFF1B1B1F),
        body: Center(child: CircularProgressIndicator()),
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
    // логотип и название платформы. Название заведения — мелкой подписью,
    // чтобы было видно, к какому заведению привязан планшет.
    final venue = (AppScope.branding?.appName ?? '').trim();

    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Image.asset('assets/icon/icon.png', width: 56, height: 56),
        const SizedBox(height: 12),
        const Text('ZalPOS',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
        if (venue.isNotEmpty && !venue.startsWith('ZalPOS')) ...[
          const SizedBox(height: 4),
          Text(venue,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.white60, fontSize: 14)),
        ],
        const SizedBox(height: 16),
        // Сотрудник — режим по умолчанию (частый вход в течение
        // смены, PIN короче), администратор выбирается явно отдельным
        // тапом: пока не знаем, сколько цифр наберут, автовход после
        // последней цифры не может сработать сам по себе.
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 8,
          runSpacing: 8,
          children: [
            ChoiceChip(
              label: const Text('Сотрудник'),
              selected: !_adminMode,
              onSelected: _loading ? null : (_) => _setAdminMode(false),
            ),
            ChoiceChip(
              label: const Text('Администратор'),
              selected: _adminMode,
              onSelected: _loading ? null : (_) => _setAdminMode(true),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(_requiredPinLength, (i) {
            final filled = i < _pin.length;
            return Container(
              margin: const EdgeInsets.all(6),
              width: 16,
              height: 16,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: filled ? Colors.purpleAccent : Colors.white24,
              ),
            );
          }),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.redAccent)),
        ],
        // PIN демо-сотрудников задаёт createDemoTenant (saas-gateway).
        if (AppScope.isDemo) ...[
          const SizedBox(height: 8),
          Text(
            _adminMode
                ? 'Демо: администратор — 111111'
                : 'Демо: кальянщик — 1111, официант — 2222, бармен — 3333',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white54, fontSize: 12),
          ),
        ],
      ],
    );

    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: LayoutBuilder(builder: (context, box) {
          // Невысокий широкий экран (планшет или окно Windows в альбомной
          // ориентации, телефон на боку) — шапка слева, цифры справа, иначе
          // клавиатура уходит за нижний край. Кнопки клавиатуры — квадраты
          // в три колонки: ширина подбирается под высоту экрана.
          final side = box.maxWidth > box.maxHeight && box.maxHeight < 600;
          final maxKeypad = math.max(160.0, math.min(300.0, box.maxWidth - 32));
          final keypadWidth = side
              ? ((box.maxHeight - 32) * 3 / 4).clamp(math.min(180.0, maxKeypad), maxKeypad).toDouble()
              : ((box.maxHeight - 290) * 3 / 4).clamp(math.min(210.0, maxKeypad), maxKeypad).toDouble();
          final keypad = _loading
              ? const Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())
              : _buildKeypad(keypadWidth);
          return Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: side
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 320), child: header)),
                        const SizedBox(width: 40),
                        keypad,
                      ],
                    )
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [header, const SizedBox(height: 24), keypad],
                    ),
            ),
          );
        }),
      ),
    );
  }

  Widget _buildKeypad(double width) {
    final keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return SizedBox(
      width: width,
      child: GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: keys.map((k) {
          if (k.isEmpty) return const SizedBox.shrink();
          return Padding(
            padding: const EdgeInsets.all(4),
            child: Material(
              color: Colors.white10,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () => k == '⌫' ? _backspace() : _tap(k),
                child: Center(
                  child: Text(k, style: TextStyle(color: Colors.white, fontSize: width >= 260 ? 22 : 20)),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}