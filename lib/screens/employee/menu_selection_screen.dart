import 'package:flutter/material.dart';
import '../../models/fiscal_receipt.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../../theme/app_colors.dart';
import '../../models/session_model.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../services/scanner_service.dart';
import '../../services/chestny_znak_service.dart';
import '../../services/chestny_znak_api_service.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../utils/adaptive.dart';

/// Выбор позиций меню для добавления в открытый счёт.
///
/// Верхний уровень — сетка плиток категорий с фото (как на плитках
/// "Бургеры" / "Барная карта" / "Вторые блюда" в Restik POS). Тап по
/// плитке открывает список блюд этой категории с фото и степпером
/// количества. Понизу — постоянная чёрная плашка "Перейти к чеку (N)" с
/// живым счётчиком позиций в текущем счёте, как на скриншоте.
class MenuSelectionScreen extends StatefulWidget {
  final SessionModel session;
  const MenuSelectionScreen({super.key, required this.session});

  @override
  State<MenuSelectionScreen> createState() => _MenuSelectionScreenState();
}

class _MenuSelectionScreenState extends State<MenuSelectionScreen> {
  final _fs = FirestoreService();
  final _cz = ChestnyZnakService();
  String _query = '';
  // Подписки создаются один раз на экран, а не в build(): поиск делает
  // setState на каждую букву, и без этого каждая буква заново открывала
  // три подписки на базу (категории, позиции, счёт).
  late final Stream<List<MenuCategory>> _categories = _fs.categoriesStream();
  late final Stream<List<MenuItem>> _items = _fs.menuItemsStream();
  late final Stream<SessionModel?> _sessionUpdates = _fs.sessionStream(widget.session.id);
  bool _scanBusy = false;

  /// Общий обработчик для обоих способов сканирования — HID-сканера
  /// (see [HidScannerListener] в build()) и камеры (см. кнопку в AppBar).
  /// Сначала пробуем распознать код как маркировку «Честного знака»
  /// (DataMatrix), если это не она — ищем позицию склада по обычному
  /// штрихкоду (GTIN) и добавляем связанную позицию меню.
  Future<void> _onScan(String rawCode) async {
    if (_scanBusy) return;
    _scanBusy = true;
    try {
      final marking = _cz.parse(rawCode);
      final gtin = marking?.gtin ?? rawCode;
      MarkingPermit? permit;

      if (marking != null) {
        final alreadySold = await _cz.isAlreadySold(marking);
        if (alreadySold) {
          _showSnack('Этот код маркировки уже был продан ранее — повторно продать нельзя');
          return;
        }
        // Онлайн-проверка в «Честном знаке» ловит код, проданный на другой
        // точке, или подделку. Без токена в Интеграциях checkOnlineStatus
        // вернёт null — остаётся локальная проверка.
        try {
          final online = await _cz.checkOnlineStatus(marking);
          if (online != null) {
            if (!online.valid) {
              _showSnack('Код не найден в системе «Честный знак» — похоже на подделку, продавать нельзя');
              return;
            }
            if (online.alreadyRetired) {
              _showSnack('По данным «Честного знака» этот код уже выведен из оборота — продавать нельзя');
              return;
            }
            if (online.reqId.isNotEmpty) {
              permit = MarkingPermit(reqId: online.reqId, reqTimestamp: online.reqTimestamp);
            }
          }
        } on ChestnyZnakApiException catch (e) {
          // Не блокируем продажу из-за сбоя связи с «Честным знаком» —
          // локальной проверки выше достаточно, чтобы не продать код
          // дважды с этой же кассы; просто предупреждаем.
          _showSnack('Честный знак: онлайн-проверка недоступна (${humanError(e, lower: true)}), код принят по локальной проверке');
        }
      }

      final invItem = await _fs.findInventoryItemByGtin(gtin);
      if (invItem == null) {
        _showSnack('Позиция с этим кодом не найдена на складе');
        return;
      }
      final menuItem = await _fs.findMenuItemByInventoryItemId(invItem.id);
      if (menuItem == null) {
        _showSnack('Для "${invItem.name}" нет связанной позиции меню');
        return;
      }

      await _add(menuItem);
      if (marking != null) {
        await _cz.attachToReceipt(
          marking,
          receiptId: widget.session.id,
          menuItemId: menuItem.id,
          itemName: menuItem.name,
          permit: permit,
        );
      }
    } catch (e) {
      _showSnack('Ошибка сканирования: ${humanError(e, lower: true)}');
    } finally {
      _scanBusy = false;
    }
  }

  void _showSnack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _scanWithCamera() async {
    final code = await showCameraScanner(context, title: 'Сканировать позицию');
    if (code != null) await _onScan(code);
  }

  Future<void> _add(MenuItem item) async {
    try {
      await _fs.addOrderItem(widget.session.id, item);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Добавлено: ${item.name}'), duration: const Duration(seconds: 1)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Не удалось добавить: ${humanError(e, lower: true)}')));
      }
    }
  }

  void _openCategory(MenuCategory category, List<MenuItem> items) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _CategoryItemsScreen(
        session: widget.session,
        category: category,
        items: items,
        onAdd: _add,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return HidScannerListener(
      // HID-сканер (USB/BT "пистолет") работает в фоне на всём экране меню
      // без отдельной кнопки — просто сканируешь, пока курсор ввода нигде
      // не открыт в текстовом поле.
      onCode: _onScan,
      child: Scaffold(
      appBar: AppBar(
        title: const Text('Меню'),
        actions: [
          // На Windows нет камеры для превью сканера (mobile_scanner её не
          // поддерживает) — кнопка вела бы только к ошибке. HID-сканер
          // (USB/Bluetooth "пистолет", эмулирующий клавиатуру) продолжает
          // работать одинаково на всех платформах без этой кнопки — она
          // только для сканирования именно КАМЕРОЙ устройства.
          if (!isWindowsApp)
            IconButton(
              tooltip: 'Сканировать камерой',
              icon: const Icon(Icons.qr_code_scanner),
              onPressed: _scanWithCamera,
            ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Поиск по меню…',
                prefixIcon: Icon(Icons.search),
                filled: true,
                isDense: true,
                border: OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
              ),
              onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
            ),
          ),
        ),
      ),
      body: StreamBuilder<List<MenuCategory>>(
        stream: _categories,
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: _items,
            builder: (context, itemSnap) {
              if (!itemSnap.hasData) return const Center(child: CircularProgressIndicator());
              final allAvailable = itemSnap.data!.where((i) => i.available).toList();

              if (categories.isEmpty) {
                return const Center(child: Text('Меню пока пустое'));
              }

              // Пока идёт поиск — плоский список найденных блюд из всех
              // категорий вместо сетки плиток, как в большинстве POS-систем.
              if (_query.isNotEmpty) {
                final found = allAvailable
                    .where((i) => i.name.toLowerCase().contains(_query))
                    .toList();
                return _SearchResultsList(items: found, onAdd: _add);
              }

              return GridView.builder(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                // Ширина плитки, а не число колонок: на телефоне так же 3
                // колонки, а на планшете кассы — 7–8, а не три плитки во
                // весь экран.
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 160,
                  crossAxisSpacing: 10,
                  mainAxisSpacing: 10,
                  childAspectRatio: 0.82,
                ),
                itemCount: categories.length,
                itemBuilder: (context, index) {
                  final cat = categories[index];
                  final catItems = allAvailable.where((i) => i.categoryId == cat.id).toList();
                  return _CategoryTile(
                    category: cat,
                    itemCount: catItems.length,
                    onTap: catItems.isEmpty ? null : () => _openCategory(cat, catItems),
                  );
                },
              );
            },
          );
        },
      ),
      bottomNavigationBar: _CheckoutBar(updates: _sessionUpdates),
      ),
    );
  }
}

/// Живая чёрная плашка "Перейти к чеку (N)" внизу — N считается по сумме
/// количеств всех позиций текущего счёта. Тап возвращает на экран стола,
/// где виден весь счёт целиком (аналог перехода к чеку в Restik POS).
class _CheckoutBar extends StatelessWidget {
  final Stream<SessionModel?> updates;

  /// Сколько экранов закрыть, чтобы оказаться на экране стола: из меню — 1,
  /// из категории — 2 (иначе кнопку приходилось нажимать дважды).
  final int depth;
  const _CheckoutBar({required this.updates, this.depth = 1});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<SessionModel?>(
      stream: updates,
      builder: (context, snap) {
        final count = snap.data?.orderItems.fold<int>(0, (sum, i) => sum + i.qty) ?? 0;
        return SafeArea(
          minimum: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: SizedBox(
            height: 52,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.textPrimary,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onPressed: () {
                final nav = Navigator.of(context);
                for (var i = 0; i < depth && nav.canPop(); i++) {
                  nav.pop();
                }
              },
              child: Text(
                count > 0 ? 'Перейти к чеку ($count)' : 'Перейти к чеку',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Плитка категории: фото сверху, название снизу на белой подложке —
/// повторяет визуальный стиль плиток "Бургеры" / "Десерты" в Restik POS.
class _CategoryTile extends StatelessWidget {
  final MenuCategory category;
  final int itemCount;
  final VoidCallback? onTap;

  const _CategoryTile({required this.category, required this.itemCount, this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      child: InkWell(
        onTap: onTap,
        child: Opacity(
          opacity: onTap == null ? 0.4 : 1,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _MenuImage(url: category.imageUrl, icon: Icons.restaurant_menu)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                child: Text(
                  category.name,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Экран блюд одной категории: сетка карточек с фото, ценой и степпером
/// количества (+/-), который живьём отражает то, что уже добавлено в счёт.
class _CategoryItemsScreen extends StatelessWidget {
  final SessionModel session;
  final MenuCategory category;
  final List<MenuItem> items;
  final ValueChanged<MenuItem> onAdd;

  const _CategoryItemsScreen({
    required this.session,
    required this.category,
    required this.items,
    required this.onAdd,
  });

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return Scaffold(
      appBar: AppBar(title: Text(category.name)),
      body: StreamBuilder<SessionModel?>(
        stream: fs.sessionStream(session.id),
        builder: (context, snap) {
          final orderItems = snap.data?.orderItems ?? const [];
          int qtyOf(String menuItemId) => orderItems
              .where((o) => o.menuItemId == menuItemId)
              .fold<int>(0, (sum, o) => sum + o.qty);

          return GridView.builder(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
            // На телефоне 2 колонки, на планшете 4–5.
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 260,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
              childAspectRatio: 0.78,
            ),
            itemCount: items.length,
            itemBuilder: (context, index) {
              final item = items[index];
              return _MenuItemCard(
                item: item,
                qty: qtyOf(item.id),
                onAdd: () => onAdd(item),
                onRemoveOne: () => fs.changeOrderItemQty(session.id, item.id, -1).catchError((Object e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
                  }
                }),
              );
            },
          );
        },
      ),
      bottomNavigationBar: _CheckoutBar(updates: fs.sessionStream(session.id), depth: 2),
    );
  }
}

class _MenuItemCard extends StatelessWidget {
  final MenuItem item;
  final int qty;
  final VoidCallback onAdd;
  final VoidCallback onRemoveOne;

  const _MenuItemCard({
    required this.item,
    required this.qty,
    required this.onAdd,
    required this.onRemoveOne,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      child: InkWell(
        onTap: onAdd,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: _MenuImage(url: item.imageUrl, icon: Icons.fastfood_outlined)),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
              child: Text(
                item.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 6, 8),
              child: Row(
                children: [
                  Text(
                    rub(item.price),
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                  ),
                  const Spacer(),
                  if (qty == 0)
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.add_circle, color: AppColors.primary),
                      onPressed: onAdd,
                    )
                  else
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.remove_circle_outline),
                          onPressed: onRemoveOne,
                        ),
                        Text('$qty', style: const TextStyle(fontWeight: FontWeight.bold)),
                        IconButton(
                          visualDensity: VisualDensity.compact,
                          icon: const Icon(Icons.add_circle, color: AppColors.primary),
                          onPressed: onAdd,
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchResultsList extends StatelessWidget {
  final List<MenuItem> items;
  final ValueChanged<MenuItem> onAdd;

  const _SearchResultsList({required this.items, required this.onAdd});

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return const Center(child: Text('Ничего не найдено'));
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final item = items[index];
        return Material(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(10),
          child: ListTile(
            leading: SizedBox(
              width: 48,
              height: 48,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: _MenuImage(url: item.imageUrl, icon: Icons.fastfood_outlined),
              ),
            ),
            title: Text(item.name),
            subtitle: Text(rub(item.price)),
            trailing: const Icon(Icons.add_circle_outline),
            onTap: () => onAdd(item),
          ),
        );
      },
    );
  }
}

/// Общий виджет фото с заглушкой — используется и для категорий, и для
/// блюд. Если imageUrl пуст или загрузка не удалась, рисует нейтральную
/// серую плашку с иконкой вместо сломанной картинки.
class _MenuImage extends StatelessWidget {
  final String url;
  final IconData icon;
  const _MenuImage({required this.url, required this.icon});

  @override
  Widget build(BuildContext context) {
    if (url.isEmpty) {
      return _placeholder();
    }
    // Плитки на экране маленькие (доли ширины экрана), а исходники после
    // загрузки могут доходить до 1600×1600 (см. StorageService.pickImage).
    // Без memCacheWidth Flutter декодирует и держит в памяти картинку в
    // полном разрешении на КАЖДУЮ плитку сетки — на слабых POS-планшетах
    // это и есть основная причина лагов/фризов при скролле меню. Декодируем
    // сразу под реальный размер плитки с учётом плотности экрана.
    final cacheWidth = (MediaQuery.of(context).devicePixelRatio * 220).round();
    // CachedNetworkImage: фото с дискового кэша (его прогревает
    // ImagePreloadService), а не из сети при каждом открытии меню.
    return CachedNetworkImage(
      imageUrl: url,
      fit: BoxFit.cover,
      width: double.infinity,
      memCacheWidth: cacheWidth,
      // Не показываем плейсхолдер поверх уже загруженной картинки при
      // перерисовке виджета (например, при каждом обновлении стрима меню) —
      // без этого фото на плитках заметно мигали.
      useOldImageOnUrlChange: true,
      fadeInDuration: Duration.zero,
      fadeOutDuration: Duration.zero,
      placeholder: (context, url) => Container(
        color: AppColors.surfaceElevated,
        child: const Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      ),
      errorWidget: (context, url, error) => _placeholder(),
    );
  }

  Widget _placeholder() {
    return Container(
      color: AppColors.surfaceElevated,
      alignment: Alignment.center,
      child: Icon(icon, color: AppColors.textMuted, size: 28),
    );
  }
}