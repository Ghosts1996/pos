import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../../models/menu_models.dart';
import '../../models/session_model.dart';
import '../../services/guest_link_service.dart';
import '../services/kolibri_auth_service.dart';
import '../theme/kolibri_theme.dart';
import '../widgets/kolibri_ai_chat.dart';

/// Живое меню заведения для гостя.
///
/// Позиции сгруппированы по категориям с заголовками — сплошной список
/// вперемешку читать невозможно. Категории, которых нет в справочнике
/// (позиция без categoryId или с удалённой категорией), собираются в
/// блок «Прочее», а не теряются.
class KolibriMenuScreen extends StatefulWidget {
  /// Режим предзаказа: корзина отдаётся наружу (экран брони), а не
  /// отправляется на кухню.
  final bool preOrderMode;

  const KolibriMenuScreen({super.key, this.preOrderMode = false});

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

  double get _cartTotal => _cart.values.fold(0.0, (s, i) => s + i.total);

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<MenuCategory>>(
      stream: _link.publicCategoriesStream(),
      builder: (context, catSnap) {
        final categories = catSnap.data ?? const <MenuCategory>[];

        return StreamBuilder<List<MenuItem>>(
          stream: _link.publicMenuStream(),
          builder: (context, itemSnap) {
            if (itemSnap.hasError) {
              return const Center(
                child: Padding(
                  padding: EdgeInsets.all(32),
                  child: Text('Не удалось загрузить меню. Проверьте интернет.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: KolibriColors.textMuted)),
                ),
              );
            }
            if (!itemSnap.hasData) {
              return const Center(child: CircularProgressIndicator());
            }

            final all = itemSnap.data!;
            final filtered = all.where((i) {
              final okCat = _categoryId.isEmpty || i.categoryId == _categoryId;
              final okSearch =
                  _search.isEmpty || i.name.toLowerCase().contains(_search.toLowerCase());
              return okCat && okSearch;
            }).toList();

            // Группируем по категориям в порядке справочника, остаток — в «Прочее».
            final sections = <({String title, List<MenuItem> items})>[];
            final used = <String>{};
            for (final c in categories) {
              final items = filtered.where((i) => i.categoryId == c.id).toList()
                ..sort((a, b) => a.name.compareTo(b.name));
              if (items.isEmpty) continue;
              used.add(c.id);
              sections.add((title: c.name, items: items));
            }
            final rest = filtered.where((i) => !used.contains(i.categoryId)).toList()
              ..sort((a, b) => a.name.compareTo(b.name));
            if (rest.isNotEmpty) sections.add((title: 'Прочее', items: rest));

            return Column(
              children: [
                _searchBar(),
                if (categories.isNotEmpty) _categoryChips(categories),
                Expanded(
                  child: sections.isEmpty
                      ? const Center(
                          child: Text('Ничего не найдено',
                              style: TextStyle(color: KolibriColors.textMuted)))
                      : ListView.builder(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 140),
                          itemCount: sections.length,
                          itemBuilder: (_, s) {
                            final section = sections[s];
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Padding(
                                  padding: EdgeInsets.only(top: s == 0 ? 4 : 22, bottom: 10),
                                  child: Row(
                                    children: [
                                      Container(
                                        width: 3,
                                        height: 18,
                                        decoration: BoxDecoration(
                                          color: KolibriColors.primary,
                                          borderRadius: BorderRadius.circular(2),
                                        ),
                                      ),
                                      const SizedBox(width: 10),
                                      Text(
                                        section.title,
                                        style: const TextStyle(
                                            fontSize: 18, fontWeight: FontWeight.w700),
                                      ),
                                      const SizedBox(width: 8),
                                      Text('${section.items.length}',
                                          style: const TextStyle(
                                              color: KolibriColors.textMuted, fontSize: 13)),
                                    ],
                                  ),
                                ),
                                ...section.items.map((item) => Padding(
                                      padding: const EdgeInsets.only(bottom: 10),
                                      child: _itemTile(item),
                                    )),
                              ],
                            );
                          },
                        ),
                ),
                if (_cart.isNotEmpty) _cartBar(),
              ],
            );
          },
        );
      },
    );
  }

  Widget _searchBar() => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                onChanged: (v) => setState(() => _search = v),
                decoration: const InputDecoration(
                  hintText: 'Поиск по меню',
                  prefixIcon: Icon(Icons.search, color: KolibriColors.textMuted),
                ),
              ),
            ),
            const SizedBox(width: 10),
            IconButton.filled(
              style: IconButton.styleFrom(backgroundColor: KolibriColors.gold),
              icon: const Icon(Icons.auto_awesome, color: Colors.black87),
              tooltip: 'Подобрать через ИИ-сомелье',
              onPressed: () => KolibriAiChat.show(
                context,
                guestUid: _auth.uid,
                sommelierMode: true,
              ),
            ),
          ],
        ),
      );

  Widget _categoryChips(List<MenuCategory> categories) => SizedBox(
        height: 44,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          children: [
            _chip('Всё', _categoryId.isEmpty, () => setState(() => _categoryId = '')),
            ...categories.map((c) =>
                _chip(c.name, _categoryId == c.id, () => setState(() => _categoryId = c.id))),
          ],
        ),
      );

  Widget _chip(String label, bool selected, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          label: Text(label),
          selected: selected,
          onSelected: (_) => onTap(),
          backgroundColor: KolibriColors.surface,
          selectedColor: KolibriColors.primary.withValues(alpha: 0.22),
          side: const BorderSide(color: KolibriColors.border),
        ),
      );

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
                      child: const Icon(Icons.local_fire_department,
                          color: KolibriColors.textMuted),
                    )
                  : CachedNetworkImage(
                      imageUrl: item.imageUrl,
                      fit: BoxFit.cover,
                      placeholder: (_, __) =>
                          Container(color: KolibriColors.surfaceElevated),
                      errorWidget: (_, __, ___) => Container(
                        color: KolibriColors.surfaceElevated,
                        child: const Icon(Icons.image_not_supported,
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
                Text(item.name,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(
                  '${item.price.toStringAsFixed(0)} ₽'
                  '${item.weight > 0 ? ' · ${item.weight.toStringAsFixed(0)} ${item.weightUnit.name}' : ''}',
                  style: const TextStyle(color: KolibriColors.textMuted, fontSize: 13),
                ),
              ],
            ),
          ),
          if (inCart == 0)
            IconButton(
              onPressed: () => _add(item),
              icon: const Icon(Icons.add_circle, color: KolibriColors.primary, size: 30),
            )
          else
            Row(
              children: [
                IconButton(
                  onPressed: () => _remove(item),
                  icon: const Icon(Icons.remove_circle_outline,
                      color: KolibriColors.textMuted),
                ),
                Text('$inCart', style: const TextStyle(fontWeight: FontWeight.w600)),
                IconButton(
                  onPressed: () => _add(item),
                  icon: const Icon(Icons.add_circle, color: KolibriColors.primary),
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

  Widget _cartBar() => Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        decoration: const BoxDecoration(
          color: KolibriColors.surfaceElevated,
          border: Border(top: BorderSide(color: KolibriColors.border)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${_cart.length} позиции',
                      style: const TextStyle(color: KolibriColors.textMuted, fontSize: 12)),
                  Text('${_cartTotal.toStringAsFixed(0)} ₽',
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
        const SnackBar(content: Text('Заказ отправлен — кальянщик подтвердит его')),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
    if (mounted) setState(() => _sending = false);
  }
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
