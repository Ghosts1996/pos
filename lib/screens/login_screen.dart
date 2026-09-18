import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../models/employee.dart';
import '../services/app_scope.dart';
import '../services/firestore_service.dart';
import '../services/guest_link_service.dart';
import '../services/reservation_service.dart';
import '../services/staff_device_service.dart';
import '../services/staff_session_store.dart';
import '../utils/constants.dart';
import '../widgets/shift_open_dialog.dart';
import 'admin/admin_home_screen.dart';
import 'employee/floor_plan_screen.dart';
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

  /// Восстанавливает вход того, кто работал на этом планшете в прошлый раз.
  ///
  /// PIN спрашивался при каждом запуске, а запускается приложение чаще, чем
  /// кажется: свёрнутое приложение Android выгружает сам, освобождая
  /// память. Сотрудник возвращался к планшету и снова набирал код, хотя
  /// смена не менялась. Теперь код нужен один раз — и снова только после
  /// «Сменить сотрудника».
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
      // permission-denied — это НЕ проблема сети. Правила безопасности не
      // отдают список сотрудников устройству, которое не зарегистрировано
      // как рабочее. Раньше здесь для любой ошибки показывалось «Нет связи
      // с сервером», и настоящая причина была не видна: кассир проверял
      // интернет, а дело было в регистрации планшета.
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
    // Запоминаем вошедшего на этом устройстве — при следующем запуске PIN
    // спрашиваться не будет. Хранится только id, сам PIN — нет.
    unawaited(_session.remember(loggedInEmployee.id));
    // Смену открывает _enter(): там спрашиваем, кто именно выходит в зал.
    // Разовая достройка обезличенного зеркала занятости столов — нужна
    // заведениям, которые обновились с версии без reservationSlots.
    // Проверка стоит один документ и ничего не делает, если всё на месте.
    unawaited(ReservationService().ensureSlotMirror());
    unawaited(_fs.backfillTablesBusyUntil());
    unawaited(GuestLinkService().backfillGuestIndexes());
    await _enter(loggedInEmployee);
  }

  Future<void> _enter(Employee employee) async {
    if (!mounted) return;
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

  @override
  Widget build(BuildContext context) {
    if (_restoring) {
      return const Scaffold(
        backgroundColor: Color(0xFF1B1B1F),
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_deviceRegistered == false) {
      return StaffDeviceSetupScreen(
        onRegistered: () => setState(() {
          _deviceRegistered = true;
          _error = null;
        }),
      );
    }

    // Экран входа рисует свои цвета литералами, а не через Theme.of(context)
    // (см. AppTheme.branded для остальных экранов) — здесь важна не полная
    // фирменная палитра, а само имя и логотип заведения (TOR §17/§18), и
    // именно это единственное, что тянем из AppScope.branding. В
    // одно-арендной сборке branding всегда null — экран не меняется.
    final branding = AppScope.branding;
    final appName = branding?.appName ?? 'Hookah POS';
    final logoUrl = branding?.logoUrl ?? '';

    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              logoUrl.isNotEmpty
                  ? ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: Image.network(
                        logoUrl,
                        width: 56,
                        height: 56,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) =>
                            const Icon(Icons.smoking_rooms, color: Colors.white70, size: 56),
                      ),
                    )
                  : const Icon(Icons.smoking_rooms, color: Colors.white70, size: 56),
              const SizedBox(height: 12),
              Text(appName,
                  style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
              const SizedBox(height: 16),
              // Сотрудник — режим по умолчанию (частый вход в течение
              // смены, PIN короче), администратор выбирается явно отдельным
              // тапом: пока не знаем, сколько цифр наберут, автовход после
              // последней цифры не может сработать сам по себе.
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ChoiceChip(
                    label: const Text('Сотрудник'),
                    selected: !_adminMode,
                    onSelected: _loading ? null : (_) => _setAdminMode(false),
                  ),
                  const SizedBox(width: 8),
                  ChoiceChip(
                    label: const Text('Администратор'),
                    selected: _adminMode,
                    onSelected: _loading ? null : (_) => _setAdminMode(true),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
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
                Text(_error!, style: const TextStyle(color: Colors.redAccent)),
              ],
              const SizedBox(height: 24),
              if (_loading) const CircularProgressIndicator(),
              if (!_loading) _buildKeypad(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildKeypad() {
    final keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return SizedBox(
      width: 260,
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
                  child: Text(k, style: const TextStyle(color: Colors.white, fontSize: 20)),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}