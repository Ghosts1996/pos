import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import '../../build_info.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../services/notification_service.dart';
import '../../models/client_models.dart';
import '../../services/guest_link_service.dart';
import '../../utils/phone_utils.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import 'kolibri_extras_screen.dart';

/// Профиль гостя: имя, телефон, бонусы, история операций.
///
/// Бесплатный вариант без SMS-подтверждения (Firebase Phone Auth требует
/// платный тариф Blaze). Поэтому: один номер — один профиль на уровне
/// приложения (нельзя сохранить номер, уже занятый другим устройством),
/// а перенос истории с одного устройства на другое делает кальянщик на
/// кассе в один клик — гость называет номер и показывает свой «ID
/// устройства» с этого экрана.
class KolibriProfileScreen extends StatefulWidget {
  final ClientProfile? profile;
  const KolibriProfileScreen({super.key, required this.profile});

  @override
  State<KolibriProfileScreen> createState() => _KolibriProfileScreenState();
}

class _KolibriProfileScreenState extends State<KolibriProfileScreen> {
  final _auth = KolibriAuthService();
  final _link = GuestLinkService();
  final _name = TextEditingController();
  final _phone = TextEditingController();

  String _shortDeviceId = '…';

  /// Номер уже привязан — редактировать его гость не может.
  bool get _phoneLocked => (widget.profile?.phone ?? '').isNotEmpty;
  bool _saving = false;

  /// Разрешены ли уведомления на уровне системы.
  ///
  /// Начиная с Android 13 отказ от уведомлений ничем не проявляется:
  /// приложение их «показывает», а на экране не появляется ничего. Гость
  /// при этом уверен, что приложение сломано. Поэтому спрашиваем систему
  /// и, если выключено, говорим об этом прямым текстом с кнопкой.
  bool _notificationsOn = true;

  @override
  void initState() {
    super.initState();
    _name.text = widget.profile?.name ?? '';
    _phone.text = widget.profile?.phone ?? '';
    _initShortId();
    _checkNotifications();
  }

  Future<void> _checkNotifications() async {
    final on = await NotificationService.instance.areEnabled();
    if (mounted) setState(() => _notificationsOn = on);
  }

  /// Проверка уведомлений: показывает тестовое и объясняет результат.
  /// Нужна потому, что молчание уведомлений ничем не отличается от
  /// «всё работает, просто событий не было».
  Future<void> _testNotifications() async {
    final report = await NotificationService.instance.diagnose();
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: KolibriColors.surface,
        title: const Text('Проверка уведомлений'),
        content: SingleChildScrollView(child: Text(report)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Понятно'),
          ),
        ],
      ),
    );
    await _checkNotifications();
  }

  /// Гость пришёл в ДРУГОЕ заведение той же сети — сбрасывает
  /// кэшированный выбор точки (см. _KolibriChainBootstrap в
  /// kolibri_main.dart) и просит перезапустить приложение, чтобы снова
  /// показался экран выбора заведения. Полноценный live-переход без
  /// перезапуска потребовал бы аккуратно остановить все активные подписки
  /// текущей точки (VenueService, вызовы персонала и т.д.) и поднять их
  /// заново на новой — риск незакрытых стримов ощутимо выше пользы одного
  /// лишнего перезапуска, который и так уже случается у гостя каждый день.
  Future<void> _switchChainVenue() async {
    // Профиль гостя общий на всю сеть, а activeSessionId — это ссылка на
    // стол именно в ТЕКУЩЕМ заведении: после смены точки касса нового
    // заведения о нём не знает, а на старом счёт останется открытым, но
    // невидимым в приложении (перестанет находиться экраном "Мой стол"
    // после перезапуска, т.к. тот смотрит уже в новую точку). Сам счёт
    // при этом никуда не пропадает — кальянщик закроет его как обычно,
    // просто гость об этом не узнает через приложение. Предупреждаем,
    // чтобы это не было неожиданностью для гостя, который забыл отвязать
    // стол перед тем как нажать эту кнопку.
    final hasOpenTable = (widget.profile?.activeSessionId ?? '').isNotEmpty;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: KolibriColors.surface,
        title: const Text('Сменить заведение сети'),
        content: Text(
          hasOpenTable
              ? 'У вас сейчас открыт стол в этом заведении. Приложение '
                  'забудет текущее заведение и после перезапуска перестанет '
                  'его показывать — сам счёт при этом останется открытым, '
                  'закрыть его сможет кальянщик. Сменить всё равно?'
              : 'Приложение забудет текущее заведение и после перезапуска снова '
                  'спросит, в каком заведении сети вы находитесь.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сменить')),
        ],
      ),
    );
    if (confirmed != true) return;

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(kChainLocationCacheKey);
    await prefs.remove(kChainIdCacheKey);
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: KolibriColors.surface,
        title: const Text('Готово'),
        content: const Text('Закройте и снова откройте приложение, чтобы выбрать заведение.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Понятно'))],
      ),
    );
  }

  Future<void> _enableNotifications() async {
    final granted = await NotificationService.instance.requestPermission();
    if (!granted) {
      // Система показывает диалог только один раз: если гость уже
      // отказывал, включить можно лишь в настройках приложения.
      await openAppSettings();
    }
    await _checkNotifications();
  }

  Future<void> _initShortId() async {
    final id = await _auth.getShortDeviceId();
    if (mounted) setState(() => _shortDeviceId = id);
    // Записываем shortDeviceId в Firestore при каждом открытии профиля —
    // кассир сможет найти устройство по 6-значному коду сразу.
    if (_auth.uid.isNotEmpty) {
      await _link.updateProfile(_auth.uid, {'shortDeviceId': id});
    }
  }

  @override
  void didUpdateWidget(covariant KolibriProfileScreen old) {
    super.didUpdateWidget(old);
    if (_name.text.isEmpty && (widget.profile?.name ?? '').isNotEmpty) {
      _name.text = widget.profile!.name;
    }
    if (_phone.text.isEmpty && (widget.profile?.phone ?? '').isNotEmpty) {
      _phone.text = widget.profile!.phone;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _save() async {
    final rawPhone = _phone.text.trim();
    final phone = rawPhone.isNotEmpty ? normalizePhone(rawPhone) : '';
    setState(() => _saving = true);

    // try/finally обязателен. Раньше его не было, и любая ошибка внутри
    // (а проверка занятости номера падала с permission-denied всегда)
    // просто улетала наружу: _saving оставался true, и кнопка навсегда
    // застревала на «Сохраняем…», не показывая никакой причины.
    try {
      // Номер новый (ещё не был занят этим профилем) — проверяем, не занят
      // ли он уже ДРУГИМ устройством, прежде чем сохранять.
      if (!_phoneLocked && phone.isNotEmpty) {
        if (!isValidRuPhone(phone)) {
          _snack('Введите корректный номер (например, 79995061580)');
          return;
        }

        // Проверка идёт по обезличенному указателю phoneIndex, а не
        // запросом по коллекции clients: запрос гостю запрещён правилами,
        // и именно он раньше ронял сохранение.
        if (await _link.isPhoneTakenByOther(phone, _auth.uid)) {
          if (!mounted) return;
          await showDialog(
            context: context,
            builder: (_) => AlertDialog(
              title: const Text('Номер уже зарегистрирован'),
              // Про чужой профиль не рассказываем ничего — ни имени, ни
              // баланса: раньше здесь показывался бонусный счёт другого
              // человека любому, кто угадал его номер телефона.
              content: const Text(
                'На этот номер уже есть профиль. Чтобы его бонусы и история '
                'появились на этом устройстве, назовите кальянщику номер и '
                '«ID устройства» ниже — он объединит профили на кассе за пару '
                'секунд.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Понятно'),
                ),
              ],
            ),
          );
          return;
        }
      }

      await _link.registerGuestProfile(
        _auth.uid,
        name: _name.text.trim(),
        phone: (!_phoneLocked && phone.isNotEmpty) ? phone : null,
      );
      _snack('Сохранено');
    } catch (e) {
      _snack('Не удалось сохранить: проверьте интернет и попробуйте снова');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Человеческая подпись к бонусной операции.
  ///
  /// Раньше любое начисление подписывалось «за визит» — и бонусы за
  /// сертификат или за приведённого друга выглядели как поход в кальянную,
  /// которого не было.
  String _bonusReason(String? reason, bool accrual) {
    switch (reason) {
      case 'giftCard':
        return 'Сертификат активирован';
      case 'referral_invitee':
        return 'Бонус за код друга';
      case 'referral_inviter':
        return 'Друг дошёл до нас';
      default:
        return accrual ? 'Начисление за визит' : 'Списание бонусов';
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.profile;
    final tier = p?.tier ?? 'Бронза';
    final tierColor = KolibriColors.tierColor(tier);

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 120),
      children: [
        const Text('Профиль', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
        const SizedBox(height: 20),

        if (!_notificationsOn) ...[
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: KolibriColors.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: KolibriColors.warning),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.notifications_off, color: KolibriColors.warning, size: 20),
                    SizedBox(width: 8),
                    Text('Уведомления выключены',
                        style: TextStyle(fontWeight: FontWeight.w600)),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'Вы не узнаете, что бронь подтвердили, заказ готов или '
                  'начислены бонусы. Включается одной кнопкой.',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _enableNotifications,
                    child: const Text('Включить уведомления'),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
        ],

        // ---- Карта лояльности ----
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: tierColor.withValues(alpha: 0.5)),
            gradient: LinearGradient(
              colors: [tierColor.withValues(alpha: 0.16), KolibriColors.surface],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Уровень «$tier»',
                  style: TextStyle(color: tierColor, fontWeight: FontWeight.w600)),
              const SizedBox(height: 10),
              Text('${(p?.bonusBalance ?? 0).toStringAsFixed(0)} бонусов',
                  style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(
                'Визитов: ${p?.visits ?? 0} · потрачено '
                '${(p?.totalSpent ?? 0).toStringAsFixed(0)} ₽ · кешбэк '
                '${(p?.cashbackPercent ?? 3).toStringAsFixed(0)}%',
                style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
              ),
              // Прогресс до следующего уровня: без него гость видит только
              // текущий статус и не понимает, что до следующего осталось
              // немного — а это главный смысл уровней.
              if (p != null) ...[
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: p.tierProgress,
                    minHeight: 6,
                    backgroundColor: KolibriColors.surfaceElevated,
                    valueColor: AlwaysStoppedAnimation(tierColor),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  p.nextTier == null
                      ? 'Максимальный уровень — спасибо, что вы с нами'
                      : 'До уровня «${p.nextTier!.name}» осталось '
                          '${p.toNextTier.toStringAsFixed(0)} ₽ '
                          '(кешбэк вырастет до ${p.nextTier!.cashback.toStringAsFixed(0)}%)',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 12),
                ),
              ],
              if ((p?.discountPercent ?? 0) > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('Дисконтная карта: −${p!.discountPercent.toStringAsFixed(0)}%',
                      style: TextStyle(color: tierColor, fontSize: 13)),
                ),
            ],
          ),
        ),

        const SizedBox(height: 24),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Как к вам обращаться'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          readOnly: _phoneLocked,
          decoration: InputDecoration(
            labelText: 'Телефон',
            helperText: _phoneLocked
                ? 'Сменить номер можно только через администратора'
                : 'Укажите номер в любом формате: +7, 8 или просто 9...',
            suffixIcon: _phoneLocked
                ? Icon(Icons.lock_outline, size: 18, color: KolibriColors.textMuted)
                : null,
          ),
          onTap: _phoneLocked
              ? () => _snack('Номер уже привязан. Попросите администратора '
                  'изменить его на кассе.')
              : null,
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Сохраняем…' : 'Сохранить'),
        ),

        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: KolibriColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: KolibriColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, color: KolibriColors.gold, size: 20),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Бонусы копятся на этом устройстве и находятся по вашему номеру '
                      'на кассе. Сменили телефон — назовите номер и покажите ID '
                      'устройства ниже кальянщику, и мы перенесём историю визитов.',
                      style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              // Короткий ID устройства — 6 символов, легко продиктовать
              InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () async {
                  await Clipboard.setData(ClipboardData(text: _shortDeviceId));
                  _snack('ID устройства скопирован');
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: KolibriColors.inset,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.badge_outlined, size: 16, color: KolibriColors.textMuted),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'ID устройства: $_shortDeviceId',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: KolibriColors.textMuted,
                            letterSpacing: 2,
                          ),
                        ),
                      ),
                      Icon(Icons.copy, size: 14, color: KolibriColors.textMuted),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 24),
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => Scaffold(
                appBar: AppBar(title: const Text('Ещё')),
                body: KolibriExtrasScreen(profile: widget.profile),
              ),
            ),
          ),
          icon: const Icon(Icons.more_horiz),
          label: const Text('Чаевые, сертификат, очередь, пригласить друга'),
        ),

        const SizedBox(height: 28),
        _visitsSection(),

        const SizedBox(height: 28),
        const Text('История бонусов',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        StreamBuilder<QuerySnapshot>(
          // orderBy обязателен: limit(50) без сортировки отдаёт первые
          // пятьдесят документов в порядке id, то есть случайные. У
          // постоянного гостя свежие начисления в такую выборку просто не
          // попадали, и «история» показывала произвольный срез за все годы.
          // Сортировка на клиенте это не чинила — она сортировала уже не те
          // записи. Составной индекс добавлен в firestore.indexes.json.
          stream: AppScope.loyaltyCol('bonusOperations')
              .where('clientUid', isEqualTo: _auth.uid)
              .orderBy('createdAt', descending: true)
              .limit(50)
              .snapshots(),
          builder: (context, snap) {
            if (snap.hasError) {
              return Text('Не удалось загрузить историю',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            if (!snap.hasData) return const LinearProgressIndicator();

            final docs = snap.data!.docs;
            if (docs.isEmpty) {
              return Text('Операций пока нет',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            return Column(
              children: docs.map((d) {
                final data = d.data() as Map<String, dynamic>;
                final accrual = data['type'] == 'accrual';
                final amount = (data['amount'] ?? 0).toDouble();
                final ts = data['createdAt'];
                final date = ts is Timestamp ? ts.toDate() : DateTime.now();
                return ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    accrual ? Icons.add_circle_outline : Icons.remove_circle_outline,
                    color: accrual ? KolibriColors.success : KolibriColors.warning,
                  ),
                  title: Text(_bonusReason(data['reason'] as String?, accrual)),
                  subtitle: Text(
                    '${date.day.toString().padLeft(2, '0')}.'
                    '${date.month.toString().padLeft(2, '0')}.${date.year}',
                    style: const TextStyle(fontSize: 12),
                  ),
                  trailing: Text('${amount.toStringAsFixed(0)} ₽'),
                );
              }).toList(),
            );
          },
        ),

        const SizedBox(height: 24),
        Center(
          child: TextButton.icon(
            onPressed: _testNotifications,
            icon: const Icon(Icons.notifications_active_outlined, size: 18),
            label: const Text('Проверить уведомления'),
          ),
        ),

        // Только в гостевой сборке для сети заведений (см. AppScope.chainId) —
        // у одиночного заведения точка одна и меняться ей не на что.
        if (AppScope.chainId != null)
          Center(
            child: TextButton.icon(
              onPressed: _switchChainVenue,
              icon: const Icon(Icons.storefront_outlined, size: 18),
              label: const Text('Сменить заведение сети'),
            ),
          ),

        const SizedBox(height: 8),
        // Номер сборки: приложение ставится файлом, и без него нельзя
        // понять, свежая ли версия стоит на конкретном телефоне.
        Text(
          '${KolibriColors.appName} · приложение гостя · сборка $kBuildNumber',
          textAlign: TextAlign.center,
          style: TextStyle(color: KolibriColors.textMuted, fontSize: 12),
        ),
      ],
    );
  }

  /// История визитов — то, из чего складывается уровень лояльности.
  ///
  /// Берётся из подколлекции clients/{uid}/visits: сами чеки гостю читать
  /// нельзя (в коллекции sessions лежат счета всех столов), поэтому касса
  /// при закрытии чека пишет гостю его собственную копию визита. Она не
  /// меняется и не удаляется — история живёт столько же, сколько профиль.
  Widget _visitsSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('История визитов',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        StreamBuilder<List<GuestVisit>>(
          stream: _link.visitsStream(_auth.uid),
          builder: (context, snap) {
            if (snap.hasError) {
              return Text('Не удалось загрузить историю',
                  style: TextStyle(color: KolibriColors.textMuted));
            }
            if (!snap.hasData) return const LinearProgressIndicator();
            final visits = snap.data!;
            if (visits.isEmpty) {
              return Text(
                'Визитов пока нет. Отсканируйте QR-код на столе — визит '
                'зачтётся автоматически, и сумма чека пойдёт в ваш уровень.',
                style: TextStyle(color: KolibriColors.textMuted),
              );
            }
            return Column(children: visits.map(_visitTile).toList());
          },
        ),
      ],
    );
  }

  Widget _visitTile(GuestVisit v) {
    final items = v.items.map((i) => '${i.name} ×${i.qty}').join(', ');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: KolibriColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: KolibriColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${v.date.day.toString().padLeft(2, '0')}.'
                  '${v.date.month.toString().padLeft(2, '0')}.${v.date.year}'
                  '${v.tableName.isEmpty ? '' : ' · стол ${v.tableName}'}',
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                ),
              ),
              Text('${v.total.toStringAsFixed(0)} ₽',
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            ],
          ),
          if (items.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(items,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
          ],
          if (v.bonusEarned > 0 || v.bonusSpent > 0) ...[
            const SizedBox(height: 6),
            Text(
              [
                if (v.bonusEarned > 0) '+${v.bonusEarned.toStringAsFixed(0)} бонусов',
                if (v.bonusSpent > 0) 'списано ${v.bonusSpent.toStringAsFixed(0)} ₽ бонусами',
              ].join(' · '),
              style: const TextStyle(color: KolibriColors.success, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }
}
