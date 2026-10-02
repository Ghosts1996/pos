import 'package:cached_network_image/cached_network_image.dart';
import '../../services/venue_service.dart';
import 'package:flutter/material.dart';
import '../../models/client_models.dart';
import '../../models/menu_models.dart';
import '../../models/inventory_models.dart' show InventoryUnitX;
import '../../models/session_model.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import '../../utils/human_error.dart';
import '../../utils/table_label.dart';
import '../../utils/money.dart';
import '../../utils/promo_policy.dart';

/// Живое меню заведения для гостя — как в кассе: сначала плитки категорий
/// с фото (и «Популярное» лентой), внутри категории — карточки позиций
/// сеткой, поиск — плоским списком по всему меню. Позиции без категории
/// собираются в «Прочее», а не теряются.
///
/// Табак по закону № 15-ФЗ нельзя рекламировать и продавать дистанционно,
/// а в месте продажи его показывают списком без изображений. Поэтому
/// табачные позиции видны только гостю за столом и всегда без фото.
class KolibriMenuScreen extends StatefulWidget {
  /// Режим предзаказа: корзина отдаётся наружу (экран брони), а не
  /// отправляется на кухню.
  final bool preOrderMode;

  /// Открыто кнопкой «Сделать заказ» с экрана «Мой стол»: после отправки
  /// гость возвращается к своему столу и видит там статус заказа.
  final bool tableOrderMode;

  const KolibriMenuScreen({super.key, this.preOrderMode = false, this.tableOrderMode = false});

  @override
  State<KolibriMenuScreen> createState() => _KolibriMenuScreenState();
}

class _KolibriMenuScreenState extends State<KolibriMenuScreen> {
  final _link = GuestLinkService();
  final _auth = KolibriAuthService();

  final Map<String, OrderItem> _cart = {};
  String _categoryId = '';
  String _search = '';
  bool _sending = false;
  // Подписки — одни на весь экран: корзина, чипы категорий и поиск делают
  // setState, и подписка в build() переоткрывалась бы на каждое нажатие.
  late final Stream<List<MenuCategory>> _categories = _link.publicCategoriesStream();
  late final Stream<List<MenuItem>> _menu = _link.publicMenuStream();
  late final Stream<ClientProfile?> _profile = _link.profileStream(_auth.uid);

  double get _cartTotal => _cart.values.fold(0.0, (s, i) => s + i.total);

  @override
  Widget build(BuildContext context) => StreamBuilder<ClientProfile?>(
        stream: _profile,
        // Предзаказ к брони — заказ не из заведения: табак в него нельзя.
        builder: (context, snap) => _menuBody(
            atTable: !widget.preOrderMode && (snap.data?.activeSessionId.isNotEmpty ?? false)),
      );

  /// Табак, кальяны и принадлежности — не плиткой с фото, а отдельной
  /// «категорией» со строгим перечнем (ст. 19 закона № 15-ФЗ).
  static const _tobaccoKey = '__tobacco';
  static const _otherKey = '__other';

  static int _byName(MenuItem a, MenuItem b) => _alphaKey(a.name).compareTo(_alphaKey(b.name));

  Widget _menuBody({required bool atTable}) {
    return StreamBuilder<List<MenuCategory>>(
      stream: _categories,
      builder: (context, catSnap) {
        final allCategories = catSnap.data ?? const <MenuCategory>[];
        final catNames = {for (final c in allCategories) c.id: c.name};
        bool tobacco(MenuItem i) => PromoPolicy.menuTobacco(i, catNames[i.categoryId] ?? '');

        return StreamBuilder<List<MenuItem>>(
          stream: _menu,
          builder: (context, itemSnap) {
            if (itemSnap.hasError) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Text('Не удалось загрузить меню. Проверьте интернет.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: KolibriColors.textMuted)),
                ),
              );
            }
            if (!itemSnap.hasData) {
              return const Center(child: CircularProgressIndicator());
            }

            final items = itemSnap.data!;
            final regular = items.where((i) => !tobacco(i)).toList();
            // Табак — только гостю за столом: продавать его дистанционно нельзя.
            final tobaccoItems = atTable ? (items.where(tobacco).toList()..sort(_byName)) : <MenuItem>[];
            final hidden = atTable ? 0 : items.length - regular.length;

            // Категории — плитками, как в кассе, в порядке справочника;
            // позиции без категории собираются в «Прочее», а не теряются.
            final sections = <_MenuSection>[];
            final known = <String>{};
            for (final c in allCategories) {
              known.add(c.id);
              final list = regular.where((i) => i.categoryId == c.id).toList()..sort(_byName);
              if (list.isNotEmpty) sections.add(_MenuSection(c.id, c.name, c.imageUrl, list));
            }
            final rest = regular.where((i) => !known.contains(i.categoryId)).toList()..sort(_byName);
            if (rest.isNotEmpty) sections.add(_MenuSection(_otherKey, 'Прочее', '', rest));

            final q = _search.trim().toLowerCase();
            final Widget body;
            if (q.isNotEmpty) {
              bool match(MenuItem i) => i.name.toLowerCase().contains(q) || i.description.toLowerCase().contains(q);
              body = _searchResults(regular.where(match).toList()..sort(_byName), tobaccoItems.where(match).toList());
            } else if (_categoryId == _tobaccoKey && tobaccoItems.isNotEmpty) {
              body = _categoryPage(
                'Табак и кальяны',
                ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 140),
                  children: [_tobaccoList(tobaccoItems, first: true)],
                ),
              );
            } else {
              final open = sections.where((s) => s.id == _categoryId).firstOrNull;
              body = open != null
                  ? _categoryPage(open.name, _itemsGrid(open.items))
                  : _categoryGrid(sections, regular, hasTobacco: tobaccoItems.isNotEmpty, hidden: hidden);
            }

            return PopScope(
              // «Назад» из категории возвращает к плиткам, а не закрывает меню.
              canPop: _categoryId.isEmpty,
              onPopInvokedWithResult: (didPop, _) {
                if (!didPop) setState(() => _categoryId = '');
              },
              child: Column(
                children: [
                  _searchBar(),
                  Expanded(child: body),
                  if (_cart.isNotEmpty) _cartBar(),
                ],
              ),
            );
          },
        );
      },
    );
  }

  /// Главный экран меню: «Популярное» лентой и плитки категорий с фото.
  Widget _categoryGrid(List<_MenuSection> sections, List<MenuItem> regular,
      {required bool hasTobacco, required int hidden}) {
    if (sections.isEmpty && !hasTobacco) {
      return Center(child: Text('Меню пока пустое', style: TextStyle(color: KolibriColors.textMuted)));
    }
    final hits = regular.where((i) => i.isHit).toList()..sort((a, b) => a.popularRank.compareTo(b.popularRank));
    return CustomScrollView(
      slivers: [
        if (hits.isNotEmpty) ...[
          SliverToBoxAdapter(child: _heading('Популярное')),
          SliverToBoxAdapter(
            child: SizedBox(
              height: 232,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: hits.length,
                separatorBuilder: (_, __) => const SizedBox(width: 12),
                itemBuilder: (_, i) => SizedBox(width: 156, child: _itemCard(hits[i])),
              ),
            ),
          ),
        ],
        if (sections.isNotEmpty) SliverToBoxAdapter(child: _heading('Категории')),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
          sliver: SliverGrid(
            // Ширина плитки, а не число колонок: на телефоне 2–3 плитки в
            // ряд, на планшете больше, как в кассе.
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 190,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              childAspectRatio: 0.92,
            ),
            delegate: SliverChildBuilderDelegate((_, i) => _categoryTile(sections[i]), childCount: sections.length),
          ),
        ),
        if (hasTobacco) SliverToBoxAdapter(child: _tobaccoTile()),
        if (hidden > 0)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
              child: Text('Часть позиций (18+) видна только в заведении, когда вы за столом.',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13)),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 140)),
      ],
    );
  }

  Widget _heading(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Text(text, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
      );

  Widget _categoryTile(_MenuSection s) {
    // Своего фото у категории нет — берём фото первой позиции с фото.
    final image = s.imageUrl.isNotEmpty
        ? s.imageUrl
        : s.items.firstWhere((i) => i.imageUrl.isNotEmpty, orElse: () => s.items.first).imageUrl;
    return Material(
      color: KolibriColors.surface,
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => setState(() => _categoryId = s.id),
        child: Stack(
          fit: StackFit.expand,
          children: [
            _photo(image, width: 190),
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Color(0x00000000), Color(0xD9000000)],
                  stops: [0.4, 1],
                ),
              ),
            ),
            Positioned(
              left: 12,
              right: 12,
              bottom: 10,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(s.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text('${s.items.length} ${pluralRu(s.items.length, 'позиция', 'позиции', 'позиций')}',
                      style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Вход в перечень табака — такой же строгий: чёрные буквы на белом,
  /// без изображений.
  Widget _tobaccoTile() {
    const style = TextStyle(color: Colors.black, fontSize: 15, fontWeight: FontWeight.w400, height: 1.35);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Material(
        color: Colors.white,
        child: InkWell(
          onTap: () => setState(() => _categoryId = _tobaccoKey),
          child: const Padding(
            padding: EdgeInsets.all(14),
            child: Text('Табачная и никотинсодержащая продукция, кальяны — перечень. '
                'Продажа лицам младше 18 лет запрещена.', style: style),
          ),
        ),
      ),
    );
  }

  Widget _categoryPage(String title, Widget child) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 16, 4),
            child: Row(
              children: [
                IconButton(
                  tooltip: 'Все категории',
                  icon: const Icon(Icons.arrow_back),
                  onPressed: () => setState(() => _categoryId = ''),
                ),
                Expanded(
                  child: Text(title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ),
          Expanded(child: child),
        ],
      );

  Widget _itemsGrid(List<MenuItem> items) => GridView.builder(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 140),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 240,
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
          childAspectRatio: 0.64,
        ),
        itemCount: items.length,
        itemBuilder: (_, i) => _itemCard(items[i]),
      );

  /// Карточка позиции: фото, название, состав, цена и «+» / «− N +».
  /// Нажатие на карточку — подробности (крупное фото и полный состав).
  Widget _itemCard(MenuItem item) {
    final inCart = _cart[item.id]?.qty ?? 0;
    return Material(
      color: KolibriColors.surface,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: inCart > 0 ? KolibriColors.primary : KolibriColors.border),
      ),
      child: InkWell(
        onTap: () => _showItem(item),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  _photo(item.imageUrl, width: 240),
                  // «Хит» — топ продаж за 30 дней (сервер не ставит его табаку).
                  if (item.isHit) Positioned(left: 8, top: 8, child: _hitBadge(onPhoto: true)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: Text(item.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, height: 1.25)),
            ),
            if (item.description.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 3, 12, 0),
                child: Text(item.description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 2, 4),
              child: Row(
                children: [
                  // Цена не переносится на две строки рядом с «− N +».
                  Expanded(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(rub(item.price),
                          maxLines: 1,
                          style: TextStyle(color: KolibriColors.primary, fontSize: 15, fontWeight: FontWeight.w700)),
                    ),
                  ),
                  _qtyControls(item, inCart, compact: true),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _qtyControls(MenuItem item, int inCart, {bool compact = false}) {
    final density = compact ? VisualDensity.compact : VisualDensity.standard;
    // В карточке кнопки поуже — иначе на узком телефоне не хватает места цене.
    final small = compact ? const BoxConstraints(minWidth: 34, minHeight: 34) : null;
    final pad = compact ? EdgeInsets.zero : null;
    if (inCart == 0) {
      return IconButton(
        visualDensity: density,
        constraints: small,
        padding: pad,
        tooltip: 'Добавить',
        onPressed: () => _add(item),
        icon: Icon(Icons.add_circle, color: KolibriColors.primary, size: compact ? 28 : 30),
      );
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          visualDensity: density,
          constraints: small,
          padding: pad,
          onPressed: () => _remove(item),
          icon: Icon(Icons.remove_circle_outline, color: KolibriColors.textMuted),
        ),
        Text('$inCart', style: const TextStyle(fontWeight: FontWeight.w700)),
        IconButton(
          visualDensity: density,
          constraints: small,
          padding: pad,
          onPressed: () => _add(item),
          icon: Icon(Icons.add_circle, color: KolibriColors.primary),
        ),
      ],
    );
  }

  Widget _hitBadge({bool onPhoto = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: onPhoto ? KolibriColors.gold : KolibriColors.gold.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text('Хит',
            style: TextStyle(
                color: onPhoto ? Colors.black : KolibriColors.gold, fontSize: 11, fontWeight: FontWeight.w800)),
      );

  /// Фото позиции или категории с запасной плашкой, если фото нет.
  Widget _photo(String url, {required double width}) {
    Widget fallback() => Container(
          color: KolibriColors.surfaceElevated,
          alignment: Alignment.center,
          child: Icon(Icons.restaurant, color: KolibriColors.textMuted, size: 32),
        );
    if (url.isEmpty) return fallback();
    return CachedNetworkImage(
      imageUrl: url,
      fit: BoxFit.cover,
      // Декодируем под размер плитки, а не всё фото: иначе длинное меню
      // дёргается при прокрутке и съедает память на слабых телефонах.
      memCacheWidth: (width * MediaQuery.of(context).devicePixelRatio).round(),
      fadeInDuration: const Duration(milliseconds: 150),
      placeholder: (_, __) => Container(color: KolibriColors.surfaceElevated),
      errorWidget: (_, __, ___) => fallback(),
    );
  }

  /// Подробности позиции: крупное фото, полный состав, вес и кнопка.
  void _showItem(MenuItem item) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: KolibriColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) {
          final inCart = _cart[item.id]?.qty ?? 0;
          void change(void Function() f) {
            f();
            setSheet(() {});
          }

          return SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (item.imageUrl.isNotEmpty)
                  ClipRRect(
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
                    child: AspectRatio(aspectRatio: 16 / 10, child: _photo(item.imageUrl, width: 480)),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(item.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                      ),
                      if (item.isHit) _hitBadge(),
                    ],
                  ),
                ),
                if (item.description.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                    child: Text(item.description,
                        style: TextStyle(color: KolibriColors.textMuted, fontSize: 14, height: 1.4)),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${rub(item.price)}'
                          '${item.weight > 0 ? ' · ${item.weight.toStringAsFixed(0)} ${item.weightUnit.label}' : ''}',
                          style: TextStyle(color: KolibriColors.primary, fontSize: 18, fontWeight: FontWeight.w700),
                        ),
                      ),
                      if (inCart == 0)
                        FilledButton.icon(
                          onPressed: () => change(() => _add(item)),
                          icon: const Icon(Icons.add),
                          label: const Text('Добавить'),
                        )
                      else
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              onPressed: () => change(() => _remove(item)),
                              icon: Icon(Icons.remove_circle_outline, color: KolibriColors.textMuted),
                            ),
                            Text('$inCart', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                            IconButton(
                              onPressed: () => change(() => _add(item)),
                              icon: Icon(Icons.add_circle, color: KolibriColors.primary, size: 30),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// Поиск — плоским списком по всему меню, как в кассе.
  Widget _searchResults(List<MenuItem> found, List<MenuItem> tobaccoFound) {
    if (found.isEmpty && tobaccoFound.isEmpty) {
      return Center(child: Text('Ничего не найдено', style: TextStyle(color: KolibriColors.textMuted)));
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 140),
      children: [
        for (final item in found)
          Padding(padding: const EdgeInsets.only(bottom: 10), child: _itemTile(item)),
        if (tobaccoFound.isNotEmpty) _tobaccoList(tobaccoFound, first: found.isEmpty),
      ],
    );
  }

  Widget _searchBar() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                onChanged: (v) => setState(() => _search = v),
                decoration: InputDecoration(
                  hintText: 'Поиск по меню',
                  prefixIcon: Icon(Icons.search, color: KolibriColors.textMuted),
                ),
              ),
            ),
          ],
        ),
      );

  /// Алфавитный порядок для перечня табака: без учёта регистра, «ё» как «е».
  static String _alphaKey(String s) => s.toLowerCase().replaceAll('ё', 'е');

  /// Перечень табака, кальянов и принадлежностей по ст. 19 закона № 15-ФЗ:
  /// буквы одного размера, чёрные на белом, по алфавиту, с ценой и без
  /// изображений — даже кнопки заказа здесь текстом, без иконок.
  Widget _tobaccoList(List<MenuItem> items, {required bool first}) {
    const style = TextStyle(color: Colors.black, fontSize: 15, fontWeight: FontWeight.w400, height: 1.35);
    return Container(
      margin: EdgeInsets.only(top: first ? 4 : 22),
      padding: const EdgeInsets.fromLTRB(14, 12, 4, 12),
      color: Colors.white,
      child: DefaultTextStyle(
        style: style,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.only(right: 10, bottom: 6),
              child: Text('Табачная и никотинсодержащая продукция, кальяны. '
                  'Продажа лицам младше 18 лет запрещена.'),
            ),
            for (final item in items) _tobaccoRow(item, style),
          ],
        ),
      ),
    );
  }

  Widget _tobaccoRow(MenuItem item, TextStyle style) {
    final inCart = _cart[item.id]?.qty ?? 0;
    Widget button(String label, VoidCallback onTap) => TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(
            foregroundColor: Colors.black,
            textStyle: style,
            minimumSize: const Size(44, 40),
            padding: const EdgeInsets.symmetric(horizontal: 10),
          ),
          child: Text(label),
        );
    return Row(
      children: [
        // Неразрывные пробелы — цена не рвётся на «1 200» и «₽».
        Expanded(child: Text('${item.name} — ${rub(item.price).replaceAll(' ', '\u00A0')}')),
        if (inCart > 0) ...[button('−', () => _remove(item)), Text('$inCart')],
        button(inCart > 0 ? '+' : 'Добавить', () => _add(item)),
      ],
    );
  }

  Widget _itemTile(MenuItem item) {
    final inCart = _cart[item.id]?.qty ?? 0;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: KolibriColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: inCart > 0 ? KolibriColors.primary : KolibriColors.border,
        ),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              width: 72,
              height: 72,
              child: item.imageUrl.isEmpty
                  ? Container(
                      color: KolibriColors.surfaceElevated,
                      child: Icon(
                          VenueService.instance.terms.isHookah
                              ? Icons.local_fire_department
                              : Icons.restaurant,
                          color: KolibriColors.textMuted),
                    )
                  : CachedNetworkImage(
                      imageUrl: item.imageUrl,
                      fit: BoxFit.cover,
                      // Декодируем под размер миниатюры, а не всё фото
                      // (до 1600px): иначе длинное меню дёргается при
                      // прокрутке и съедает память на слабых телефонах.
                      memCacheWidth: (72 * MediaQuery.of(context).devicePixelRatio).round(),
                      placeholder: (_, __) =>
                          Container(color: KolibriColors.surfaceElevated),
                      errorWidget: (_, __, ___) => Container(
                        color: KolibriColors.surfaceElevated,
                        child: Icon(Icons.image_not_supported,
                            color: KolibriColors.textMuted),
                      ),
                    ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Flexible(
                    child: Text(item.name,
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  ),
                  // «Хит» — топ продаж за 30 дней (сервер не ставит его табаку).
                  if (item.isHit) ...[
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: KolibriColors.gold.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text('Хит',
                          style: TextStyle(color: KolibriColors.gold, fontSize: 11, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ]),
                if (item.description.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(item.description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: KolibriColors.textMuted, fontSize: 12.5, height: 1.3)),
                ],
                const SizedBox(height: 4),
                Text(
                  '${rub(item.price)}'
                  '${item.weight > 0 ? ' · ${item.weight.toStringAsFixed(0)} ${item.weightUnit.label}' : ''}',
                  style: TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                ),
              ],
            ),
          ),
          if (inCart == 0)
            IconButton(
              onPressed: () => _add(item),
              icon: Icon(Icons.add_circle, color: KolibriColors.primary, size: 30),
            )
          else
            Row(
              children: [
                IconButton(
                  onPressed: () => _remove(item),
                  icon: Icon(Icons.remove_circle_outline,
                      color: KolibriColors.textMuted),
                ),
                Text('$inCart', style: const TextStyle(fontWeight: FontWeight.w600)),
                IconButton(
                  onPressed: () => _add(item),
                  icon: Icon(Icons.add_circle, color: KolibriColors.primary),
                ),
              ],
            ),
        ],
      ),
    );
  }

  void _add(MenuItem item) {
    setState(() {
      final existing = _cart[item.id];
      _cart[item.id] = OrderItem(
        menuItemId: item.id,
        name: item.name,
        price: item.price,
        qty: (existing?.qty ?? 0) + 1,
      );
    });
  }

  void _remove(MenuItem item) {
    setState(() {
      final existing = _cart[item.id];
      if (existing == null) return;
      if (existing.qty <= 1) {
        _cart.remove(item.id);
      } else {
        _cart[item.id] = existing.copyWith(qty: existing.qty - 1);
      }
    });
  }

  /// Панель корзины закреплена внизу — единственное место в клиентском
  /// приложении, где плавающая кнопка ИИ-консьержа может что-то перекрыть.
  /// Справа оставляем под неё место, чтобы кнопка «Заказать» не пряталась
  /// под кружком консьержа.
  Widget _cartBar() => Container(
        padding: EdgeInsets.fromLTRB(16, 12, widget.tableOrderMode ? 16 : 72, 24),
        decoration: BoxDecoration(
          color: KolibriColors.surfaceElevated,
          border: Border(top: BorderSide(color: KolibriColors.border)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${_cart.length} ${pluralRu(_cart.length, 'позиция', 'позиции', 'позиций')}',
                      style: TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
                  Text(rub(_cartTotal),
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
            if (widget.preOrderMode)
              FilledButton(
                onPressed: () => Navigator.pop(context, _cart.values.toList()),
                child: const Text('В предзаказ'),
              )
            else
              FilledButton(
                onPressed: _sending ? null : _sendOrder,
                child: _sending
                    ? const SizedBox(
                        height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Заказать за стол'),
              ),
          ],
        ),
      );

  /// Отправка заказа на POS. Заказ не попадает в чек автоматически —
  /// кальянщик подтверждает его на планшете.
  Future<void> _sendOrder() async {
    final profile = await _link.profileStream(_auth.uid).first;
    if (profile == null || profile.activeSessionId.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Сначала откройте свой стол на вкладке «Мой стол»')),
      );
      return;
    }

    setState(() => _sending = true);
    try {
      await _link.placeGuestOrder(
        sessionId: profile.activeSessionId,
        tableId: profile.activeTableId,
        tableName: '',
        items: _cart.values.toList(),
        clientUid: profile.uid,
        guestName: profile.name,
      );
      if (!mounted) return;
      setState(_cart.clear);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Заказ отправлен — ${VenueService.instance.terms.staff} подтвердит его')),
      );
      if (widget.tableOrderMode) {
        Navigator.of(context).pop(true);
        return;
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    }
    if (mounted) setState(() => _sending = false);
  }
}

/// «Сделать заказ» с экрана «Мой стол»: меню с корзиной поверх стола.
/// true — заказ отправлен.
Future<bool> openTableOrder(BuildContext context, {String tableName = ''}) async {
  final sent = await Navigator.push<bool>(
    context,
    MaterialPageRoute(
      builder: (_) => Scaffold(
        appBar: AppBar(title: Text(tableName.isEmpty ? 'Заказ за стол' : 'Заказ · ${tableLabel(tableName)}')),
        body: const KolibriMenuScreen(tableOrderMode: true),
      ),
    ),
  );
  return sent == true;
}

/// Открыть меню как выбор предзаказа к брони.
Future<List<OrderItem>?> pickPreOrder(BuildContext context) {
  return Navigator.push<List<OrderItem>>(
    context,
    MaterialPageRoute(
      builder: (_) => Scaffold(
        appBar: AppBar(title: const Text('Предзаказ')),
        body: const KolibriMenuScreen(preOrderMode: true),
      ),
    ),
  );
}

/// Категория меню для плитки: id, название, фото и её позиции.
class _MenuSection {
  final String id;
  final String name;
  final String imageUrl;
  final List<MenuItem> items;
  const _MenuSection(this.id, this.name, this.imageUrl, this.items);
}
