import 'dart:async';
import 'net_status.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/client_models.dart';
import '../utils/constants.dart';
import 'hall_watch_service.dart';
import 'printer_service.dart';
import 'kassa_service.dart';
import 'payment_terminal_service.dart';
import 'egais_service.dart';
import 'chestny_znak_api_service.dart';
import 'push_service.dart';
import 'gift_card_service.dart';
import 'venue_service.dart';
import 'firestore_service.dart';
import 'auto_stoplist_service.dart';
import 'session_alerts_service.dart';
import 'ai/ai_settings.dart';
import 'ai/ai_scheduler.dart';
import 'background_jobs_service.dart';
import '../utils/startup_log.dart';

/// Всё, что не блокирует старт приложения — принтер/касса/ИИ подтянутся
/// чуть позже, если настроены, а не настроены — ничего не сломается.
///
/// Вызывается один раз: сразу при старте (одно-арендная сборка и уже
/// присоединённое SaaS-устройство, см. main.dart) либо сразу после
/// успешного присоединения к заведению (SaasDevicePairingScreen). Вынесено
/// из main.dart отдельным файлом, чтобы экран присоединения мог вызвать её,
/// не создавая циклический импорт main.dart ↔ экран.
void startBackgroundServices() {
  StartupLog.step('фон: настройки оборудования, ИИ, push');
  NetStatus.start();
  unawaited(loadSavedPrinterSettings());
  unawaited(loadSavedKassaSettings());
  unawaited(loadSavedTerminalSettings());
  unawaited(loadSavedEgaisSettings());
  unawaited(loadSavedChestnyZnakSettings());
  unawaited(AiSettingsStore.instance.init());
  unawaited(PushService.instance.initStaff());
  // Пороги/кешбек программы лояльности (см. settings/loyalty и
  // lib/screens/admin/loyalty_settings_screen.dart) — без них касса
  // начисляет бонусы по дефолтным цифрам ClientProfile.tiers.
  unawaited(loadLoyaltyTierSettings());
  // Длительность сеанса (см. settings/sessionDuration и
  // lib/screens/admin/session_settings_screen.dart) — без неё касса
  // продолжает открывать сеансы на дефолтные 1.5 часа.
  unawaited(loadSessionDurationSettings());

  // Локальные уведомления зала: брони, вызовы гостей, угли через 35 минут,
  // конец сеанса через 10. Слежение ведёт фоновая служба (HallWatchService):
  // она живёт в своём изоляте и переживает смахивание приложения. Если
  // службу запустить не дали — следим сами, пока приложение живо.
  //
  // Старт не привязан к результату init(): запрос точных будильников на
  // части прошивок бросает исключение и не должен отменять слежение.
  StartupLog.step('фон: слежение за залом');
  unawaited(HallWatchService.instance.start().then((ok) {
    if (!ok) unawaited(SessionAlertsService.instance.start());
  }));
  StartupLog.step('фон: заведение, смена, сертификаты');
  VenueService.instance.watch();

  // Кто сейчас на смене — для выбора «кому чаевые» у гостя. Чинит смены,
  // открытые до появления этого списка, и дозакрытые вручную в табеле.
  unawaited(FirestoreService().syncTipsTeam().catchError((_) {}));

  // Сертификаты из Telegram-канала: гость вводит код у себя, а
  // начисляет бонусы касса — сам себе гость их начислить не может, и
  // правила базы этого не разрешают. Пока заведение работает,
  // начисление занимает секунды.
  GiftCardService.instance.watchClaims();

  // Автостоп-лист следит за остатками и сам убирает из меню то, чего
  // нет в зале, — иначе гость закажет это в приложении.
  StartupLog.step('фон: автостоп-лист');
  AutoStopListService.instance.start();

  // Фоновые ИИ-задания. Замок внутри планировщика гарантирует, что
  // работу выполнит только одно устройство в зале.
  final uid = FirebaseAuth.instance.currentUser?.uid;
  StartupLog.step('фон: ИИ-задания и дежурное устройство');
  if (uid != null) AiScheduler.instance.start(deviceId: uid);

  // Снятие неявок и поздравления с днём рождения ведёт касса под замком
  // «дежурного устройства»: Cloud Functions у проектов нет.
  if (uid != null) BackgroundJobsService.instance.start(deviceId: uid);
}
