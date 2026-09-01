import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../../theme/app_colors.dart';
import '../../models/session_model.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../services/scanner_service.dart';
import '../../services/chestny_znak_service.dart';
import '../../utils/constants.dart';

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

      if (marking != null) {
        final alreadySold = await _cz.isAlreadySold(marking);
        if (alreadySold) {
          _showSnack('Этот код маркировки уже был продан ранее — повторно продать нельзя');
          return;
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
        await _cz.attachToReceipt(marking, receiptId: widget.session.id);
      }
    } catch (e) {
      _showSnack('Ошибка сканирования: $e');
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
            const SnackBar(content: Text('Не удалось добавить — проверьте интернет')));
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
      backgroundColor: const Color(0xFFF2F2F2),
      appBar: AppBar(
        title: const Text('Меню'),
        actions: [
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
        stream: _fs.categoriesStream(),
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: _fs.menuItemsStream(),
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
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
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
      bottomNavigationBar: _CheckoutBar(session: widget.session),
      ),
    );
  }
}

/// Живая чёрная плашка "Перейти к чеку (N)" внизу — N считается по сумме
/// количеств всех позиций текущего счёта. Тап возвращает на экран стола,
/// где виден весь счёт целиком (аналог перехода к чеку в Restik POS).
class _CheckoutBar extends StatelessWidget {
  final SessionModel session;
  const _CheckoutBar({required this.session});

  @override
  Widget build(BuildContext context) {
    final fs = FirestoreService();
    return StreamBuilder<SessionModel?>(
      stream: fs.sessionStream(session.id),
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
              onPressed: () => Navigator.of(context).pop(),
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
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
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
                onRemoveOne: () => fs.changeOrderItemQty(session.id, item.id, -1),
              );
            },
          );
        },
      ),
      bottomNavigationBar: _CheckoutBar(session: session),
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
                    '${item.price.toStringAsFixed(0)} ${AppConstants.currencySymbol}',
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
            subtitle: Text('${item.price.toStringAsFixed(0)} ${AppConstants.currencySymbol}'),
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
    // CachedNetworkImage вместо Image.network — фото кладутся в дисковый
    // кэш (см. ImagePreloadScreen/ImagePreloadService, прогревающие его при
    // запуске приложения), поэтому повторные открытия экрана меню читают
    // фото с диска, а не качают их заново по сети — раньше именно повторные
    // сетевые запросы на каждое открытие были причиной зависаний.
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