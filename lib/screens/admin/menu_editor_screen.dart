import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import '../../models/fiscal_receipt.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:image_picker/image_picker.dart';
import '../../models/inventory_models.dart';
import '../../models/menu_models.dart';
import '../../utils/sale_kind.dart';
import '../../services/firestore_service.dart';
import '../../services/storage_service.dart';
import '../../utils/table_label.dart';
import '../../utils/human_error.dart';
import '../../utils/money.dart';
import '../../utils/promo_policy.dart';
import '../../utils/adaptive.dart';

/// Админ-редактор меню: категории, позиции и загрузка фото для них.
/// Фото загружается через системный выбор (галерея/камера) и хранится в
/// Firebase Storage — сразу видно на плитке категории и в списке позиций.
class MenuEditorScreen extends StatefulWidget {
  const MenuEditorScreen({super.key});

  @override
  State<MenuEditorScreen> createState() => _MenuEditorScreenState();
}

class _MenuEditorScreenState extends State<MenuEditorScreen> {
  final _fs = FirestoreService();
  late final Stream<List<MenuCategory>> _categories = _fs.categoriesStream();
  late final Stream<List<MenuItem>> _items = _fs.menuItemsStream();
  final _storage = StorageService();

  // Пока идёт загрузка фото конкретной категории/позиции — блокируем именно
  // её строку, а не весь экран, чтобы админ мог продолжать редактировать
  // остальное меню без ожидания.
  final Set<String> _uploadingIds = {};

  // Список активных позиций склада для дропдауна привязки в диалоге позиции.
  List<InventoryItem> _inventoryItems = [];

  @override
  void initState() {
    super.initState();
    _fs.inventoryItemsStream().first.then((items) {
      if (mounted) {
        setState(() {
          _inventoryItems = items.where((i) => i.active).toList()
            ..sort((a, b) => a.name.compareTo(b.name));
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Меню'),
        actions: [
          IconButton(
            icon: const Icon(Icons.create_new_folder_outlined),
            tooltip: 'Новая категория',
            onPressed: () async {
              final name = await _promptText(context, 'Новая категория', 'Название');
              if (name != null && name.isNotEmpty) {
                await _fs.addCategory(name);
              }
            },
          ),
        ],
      ),
      body: CenteredBody(
        maxWidth: 900,
        child: StreamBuilder<List<MenuCategory>>(
          stream: _categories,
          builder: (context, catSnap) {
            if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
            final categories = catSnap.data!;
            return StreamBuilder<List<MenuItem>>(
              stream: _items,
              builder: (context, itemSnap) {
                final items = itemSnap.data ?? [];
                if (categories.isEmpty) {
                  return const Center(child: Text('Добавьте первую категорию (значок папки вверху)'));
                }
                return ListView(
                  children: categories.map((cat) {
                    final catItems = items.where((i) => i.categoryId == cat.id).toList();
                    return ExpansionTile(
                      leading: _EditableThumb(
                        imageUrl: cat.imageUrl,
                        uploading: _uploadingIds.contains(cat.id),
                        icon: Icons.restaurant_menu,
                        onTap: () => _pickAndUploadCategoryImage(cat),
                      ),
                      title: Text(cat.name),
                      subtitle: Text('${catItems.length} ${pluralRu(catItems.length, 'позиция', 'позиции', 'позиций')}'
                          ' · ${SaleKind.label(cat.effectiveKind)}${cat.kind.isEmpty ? ' (по названию)' : ''}'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // Что в категории — для процентов кальянщику и
                          // бармену и для раздельной печати чеков.
                          PopupMenuButton<String>(
                            tooltip: 'Что в категории',
                            icon: Icon(
                              switch (cat.effectiveKind) {
                                SaleKind.hookah => Icons.local_fire_department_outlined,
                                SaleKind.bar => Icons.local_bar_outlined,
                                _ => Icons.restaurant_outlined,
                              },
                              size: 20,
                            ),
                            onSelected: (k) => _fs.setCategoryKind(cat.id, k == 'auto' ? '' : k),
                            itemBuilder: (_) => [
                              const PopupMenuItem(enabled: false, child: Text('Что в категории')),
                              for (final k in SaleKind.all)
                                CheckedPopupMenuItem(
                                    value: k, checked: cat.kind == k, child: Text(SaleKind.label(k))),
                              CheckedPopupMenuItem(
                                  value: 'auto', checked: cat.kind.isEmpty, child: const Text('По названию')),
                            ],
                          ),
                          IconButton(
                            icon: const Icon(Icons.edit_outlined, size: 20),
                            tooltip: 'Переименовать',
                            onPressed: () async {
                              final name = await _promptText(
                                  context, 'Переименовать категорию', 'Название',
                                  initial: cat.name);
                              if (name != null && name.isNotEmpty) {
                                await _fs.renameCategory(cat.id, name);
                              }
                            },
                          ),
                          const Icon(Icons.expand_more),
                        ],
                      ),
                      children: [
                        ...catItems.map((item) => ListTile(
                              leading: _EditableThumb(
                                imageUrl: item.imageUrl,
                                uploading: _uploadingIds.contains(item.id),
                                icon: Icons.fastfood_outlined,
                                onTap: () => _pickAndUploadItemImage(item, cat.name),
                              ),
                              title: Text(item.name),
                              subtitle: Text(_buildItemSubtitle(item)),
                              trailing: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Switch(
                                    value: item.available,
                                    onChanged: (v) => _fs.updateMenuItem(item.copyWith(available: v)),
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.delete_outline),
                                    onPressed: () => _confirmDelete(
                                      context,
                                      title: 'Удалить позицию?',
                                      message: '«${item.name}» будет удалена без возможности отмены.',
                                      onConfirm: () => _fs.deleteMenuItem(item.id),
                                    ),
                                  ),
                                ],
                              ),
                              onTap: () => _editItem(context, item, categoryId: cat.id),
                            )),
                        ListTile(
                          leading: const Icon(Icons.add),
                          title: const Text('Добавить позицию'),
                          onTap: () => _editItem(context, null, categoryId: cat.id),
                        ),
                        ListTile(
                          leading: const Icon(Icons.delete_forever, color: AppColors.danger),
                          title: const Text('Удалить категорию', style: TextStyle(color: AppColors.danger)),
                          onTap: () => _confirmDelete(
                            context,
                            title: 'Удалить категорию?',
                            message: catItems.isEmpty
                                ? 'Категория «${cat.name}» будет удалена.'
                                : 'Категория «${cat.name}» и все её позиции (${catItems.length} шт.) будут удалены без возможности отмены.',
                            onConfirm: () => _fs.deleteCategoryCascade(cat.id),
                          ),
                        ),
                      ],
                    );
                  }).toList(),
                );
              },
            );
          },
        ),
      ),
    );
  }

  String _buildItemSubtitle(MenuItem item) => [_buildItemSubtitleBase(item), _costLine(item)].where((s) => s.isNotEmpty).join(' · ');

  /// «себест. 112 ₽ · фудкост 28%» — по ценам закупки склада.
  String _costLine(MenuItem item) {
    final stock = {for (final i in _inventoryItems) i.id: i};
    final cost = item.costPrice(stock);
    if (cost == null) return '';
    final fc = item.foodCostPercent(stock);
    return 'себест. ${rub(cost)}${fc == null ? '' : ' · фудкост ${fc.toStringAsFixed(0)}%'}';
  }

  String _buildItemSubtitleBase(MenuItem item) {
    final priceStr = rub(item.price);
    if (item.isComposite) {
      // Составная позиция: показываем суммарный вес всех компонентов
      final totalWeight = item.components.fold<double>(0, (sum, c) => sum + c.weight);
      final unit = item.components.isNotEmpty ? item.components.first.weightUnit : InventoryUnit.g;
      return '$priceStr · ${unit.formatWithLabel(totalWeight)} (микс 📦)';
    }
    if (item.weight > 0) {
      return '$priceStr · ${item.weightUnit.formatWithLabel(item.weight)}'
          '${item.inventoryItemId.isNotEmpty ? ' · 📦' : ''}';
    }
    return priceStr;
  }

  Future<void> _pickAndUploadCategoryImage(MenuCategory cat) async {
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null || !mounted) return;
    setState(() => _uploadingIds.add(cat.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'categories', entityId: cat.id);
      await _fs.updateCategoryImage(cat.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: ${humanError(e, lower: true)}')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(cat.id));
    }
  }

  Future<void> _pickAndUploadItemImage(MenuItem item, String categoryName) async {
    // Табак, кальяны и принадлежности гостю можно показывать только списком
    // без изображений (ст. 19 закона № 15-ФЗ), фото — лишь для персонала.
    if (PromoPolicy.menuTobacco(item, categoryName) && !await _confirmTobaccoPhoto()) return;
    if (!mounted) return;
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null || !mounted) return;
    setState(() => _uploadingIds.add(item.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'items', entityId: item.id);
      await _fs.updateMenuItemImage(item.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: ${humanError(e, lower: true)}')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(item.id));
    }
  }

  Future<bool> _confirmTobaccoPhoto() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Фото табачной позиции'),
        content: const Text(
          'Фото увидят только сотрудники в кассе. Гостям закон разрешает показывать табак, '
          'кальяны, чаши и другие принадлежности только списком — названием и ценой, без '
          'изображений (ст. 19 закона № 15-ФЗ), поэтому в меню гостя такие позиции идут '
          'отдельным чёрно-белым перечнем по алфавиту, без фото. '
          'За нарушение штрафуют заведение.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Понятно, загрузить')),
        ],
      ),
    );
    return ok == true;
  }

  Future<ImageSource?> _pickSource(BuildContext context) {
    return showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Выбрать из галереи'),
              onTap: () => Navigator.pop(ctx, ImageSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Сделать фото'),
              onTap: () => Navigator.pop(ctx, ImageSource.camera),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _editItem(BuildContext context, MenuItem? item, {String? categoryId}) async {
    final nameCtrl = TextEditingController(text: item?.name ?? '');
    final priceCtrl = TextEditingController(text: item?.price.toStringAsFixed(0) ?? '');
    final descCtrl = TextEditingController(text: item?.description ?? '');
    final weightCtrl = TextEditingController(
        text: (item != null && item.weight > 0) ? item.weightUnit.format(item.weight) : '');
    var weightUnit = item?.weightUnit ?? InventoryUnit.g;
    String? linkedInventoryId =
        (item?.inventoryItemId.isNotEmpty == true) ? item!.inventoryItemId : null;

    // Для составной позиции — рабочая копия списка компонентов
    final components = List<MenuItemComponent>.from(item?.components ?? []);
    // Режим: false = простая, true = составная (микс)
    bool isComposite = item?.isComposite ?? false;
    // Фискальные реквизиты позиции (54-ФЗ)
    var vat = item?.vat ?? '';
    var fiscalSubject = item?.fiscalSubject ?? 'commodity';
    var tobacco = item?.tobacco ?? false;
    final groups = List<ModifierGroup>.from(item?.modifierGroups ?? const []);

    final result = await showDialog<_ItemDialogResult>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(item == null ? 'Новая позиция' : 'Редактировать'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                    controller: nameCtrl,
                    decoration: const InputDecoration(labelText: 'Название')),
                TextField(
                  controller: priceCtrl,
                  decoration: const InputDecoration(labelText: 'Цена, ₽'),
                  keyboardType: TextInputType.number,
                ),
                TextField(
                  controller: descCtrl,
                  maxLines: 3,
                  minLines: 1,
                  maxLength: 300,
                  decoration: const InputDecoration(
                    labelText: 'Состав / описание',
                    hintText: 'Что входит в блюдо — видит гость и ИИ-помощник',
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: tobacco,
                  onChanged: (v) => setDialogState(() => tobacco = v),
                  title: const Text('Табак / никотин'),
                  subtitle: const Text(
                    'Кальян, табак, вейп: без скидок, бонусов и «Хита», гость '
                    'видит позицию только за столом (закон № 15-ФЗ)',
                    style: TextStyle(fontSize: 11),
                  ),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: fiscalSubject,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'В чеке это'),
                  items: const [
                    FiscalPaymentObject.commodity,
                    FiscalPaymentObject.service,
                    FiscalPaymentObject.excise,
                  ].map((o) => DropdownMenuItem(value: o.id, child: Text(o.label))).toList(),
                  onChanged: (v) => setDialogState(() => fiscalSubject = v ?? 'commodity'),
                ),
                DropdownButtonFormField<String>(
                  initialValue: vat,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Ставка НДС'),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('Как у заведения')),
                    ...FiscalVatRate.values.map((v) => DropdownMenuItem(value: v.id, child: Text(v.label))),
                  ],
                  onChanged: (v) => setDialogState(() => vat = v ?? ''),
                ),
                const SizedBox(height: 12),

                // ---- Переключатель простая / составная ----
                Row(
                  children: [
                    const Expanded(child: Text('Составная позиция (микс)', style: TextStyle(fontSize: 13))),
                    Switch(
                      value: isComposite,
                      onChanged: (v) => setDialogState(() {
                        isComposite = v;
                        if (v) {
                          // Сбрасываем простую привязку
                          weightCtrl.clear();
                          linkedInventoryId = null;
                        } else {
                          // Сбрасываем компоненты
                          components.clear();
                        }
                      }),
                    ),
                  ],
                ),
                const SizedBox(height: 4),

                if (!isComposite) ...[
                  // ---- Простая позиция ----
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: weightCtrl,
                          decoration:
                              const InputDecoration(labelText: 'Граммовка (необязательно)'),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        ),
                      ),
                      const SizedBox(width: 12),
                      DropdownButton<InventoryUnit>(
                        value: weightUnit,
                        items: InventoryUnit.values
                            .map((u) => DropdownMenuItem(value: u, child: Text(u.label)))
                            .toList(),
                        onChanged: (u) {
                          if (u != null) setDialogState(() => weightUnit = u);
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  const Text('Склад (автосписание)',
                      style: TextStyle(fontSize: 12, color: Colors.grey)),
                  const SizedBox(height: 4),
                  if (_inventoryItems.isEmpty)
                    const Text('Нет позиций склада',
                        style: TextStyle(fontSize: 13, color: Colors.grey))
                  else
                    DropdownButton<String?>(
                      value: linkedInventoryId,
                      isExpanded: true,
                      hint: const Text('— не привязано —'),
                      items: [
                        const DropdownMenuItem<String?>(
                          value: null,
                          child: Text('— не привязано —'),
                        ),
                        ..._inventoryItems.map((inv) => DropdownMenuItem<String?>(
                              value: inv.id,
                              child: Text('${inv.name} (${inv.unit.label})'),
                            )),
                      ],
                      onChanged: (v) => setDialogState(() => linkedInventoryId = v),
                    ),
                  if (linkedInventoryId != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        'При продаже спишется: граммовка × количество',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                    ),
                ] else ...[
                  // ---- Составная позиция ----
                  const Text('Компоненты микса',
                      style: TextStyle(fontSize: 12, color: Colors.grey)),
                  const SizedBox(height: 4),
                  if (components.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 4),
                      child: Text('Нет компонентов — добавьте ниже',
                          style: TextStyle(fontSize: 13, color: Colors.grey)),
                    ),
                  ...components.asMap().entries.map((entry) {
                    final idx = entry.key;
                    final comp = entry.value;
                    final invName = _inventoryItems
                        .firstWhere((i) => i.id == comp.inventoryItemId,
                            orElse: () => InventoryItem(
                                id: '', name: '—', unit: InventoryUnit.g))
                        .name;
                    return ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text(invName,
                          style: const TextStyle(fontSize: 13)),
                      subtitle: Text(
                          comp.weightUnit.formatWithLabel(comp.weight),
                          style: const TextStyle(fontSize: 12)),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline, size: 18),
                        onPressed: () =>
                            setDialogState(() => components.removeAt(idx)),
                      ),
                    );
                  }),
                  const SizedBox(height: 4),
                  OutlinedButton.icon(
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Добавить компонент'),
                    onPressed: () async {
                      final comp = await _editComponent(ctx);
                      if (comp != null) {
                        setDialogState(() => components.add(comp));
                      }
                    },
                  ),
                  if (components.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        'При продаже каждый компонент спишется отдельно × количество',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                    ),
                ],

                // ---- Модификаторы ----
                const SizedBox(height: 16),
                const Text('Модификаторы', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                Text('Молоко, сиропы, прожарка, соус — официант выбирает при добавлении',
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                ...groups.asMap().entries.map((e) => ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text(e.value.name, style: const TextStyle(fontSize: 13)),
                      subtitle: Text(
                        '${e.value.required ? 'обязательно' : 'по желанию'} · '
                        '${e.value.options.map((o) => o.price > 0 ? '${o.name} +${o.price.toStringAsFixed(0)}' : o.name).join(', ')}',
                        style: const TextStyle(fontSize: 12),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: () async {
                        final g = await _editModifierGroup(ctx, e.value);
                        if (g != null) setDialogState(() => groups[e.key] = g);
                      },
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline, size: 18),
                        onPressed: () => setDialogState(() => groups.removeAt(e.key)),
                      ),
                    )),
                OutlinedButton.icon(
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('Добавить группу модификаторов'),
                  onPressed: () async {
                    final g = await _editModifierGroup(ctx, null);
                    if (g != null) setDialogState(() => groups.add(g));
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            FilledButton(
              onPressed: () => Navigator.pop(
                  ctx,
                  _ItemDialogResult(
                    name: nameCtrl.text.trim(),
                    price: double.tryParse(priceCtrl.text.replaceAll(',', '.')) ?? 0,
                    weight: isComposite
                        ? 0
                        : (double.tryParse(weightCtrl.text.replaceAll(',', '.')) ?? 0),
                    weightUnit: weightUnit,
                    inventoryItemId: isComposite ? '' : (linkedInventoryId ?? ''),
                    components: isComposite ? List.from(components) : [],
                    vat: vat,
                    fiscalSubject: fiscalSubject,
                    description: descCtrl.text.trim(),
                    tobacco: tobacco,
                    modifierGroups: List.from(groups),
                  )),
              child: const Text('Сохранить'),
            ),
          ],
        ),
      ),
    );
    if (result == null || result.name.isEmpty) return;
    if (item == null) {
      await _fs.addMenuItem(MenuItem(
        id: '',
        categoryId: categoryId!,
        name: result.name,
        price: result.price,
        weight: result.weight,
        weightUnit: result.weightUnit,
        inventoryItemId: result.inventoryItemId,
        components: result.components,
        vat: result.vat,
        fiscalSubject: result.fiscalSubject,
        description: result.description,
        tobacco: result.tobacco,
        modifierGroups: result.modifierGroups,
      ));
    } else {
      await _fs.updateMenuItem(item.copyWith(
        name: result.name,
        price: result.price,
        weight: result.weight,
        weightUnit: result.weightUnit,
        inventoryItemId: result.inventoryItemId,
        components: result.components,
        vat: result.vat,
        fiscalSubject: result.fiscalSubject,
        description: result.description,
        tobacco: result.tobacco,
        modifierGroups: result.modifierGroups,
      ));
    }
  }

  /// Группа модификаторов: название, обязательность, сколько можно выбрать
  /// и варианты с доплатой и (по желанию) списанием со склада.
  Future<ModifierGroup?> _editModifierGroup(BuildContext ctx, ModifierGroup? group) {
    final nameCtrl = TextEditingController(text: group?.name ?? '');
    var required = group?.required ?? false;
    var multi = group != null && !group.single;
    final maxCtrl = TextEditingController(text: (group != null && group.max > 1) ? '${group.max}' : '');
    final options = List<ModifierOption>.from(group?.options ?? const []);
    return showDialog<ModifierGroup>(
      context: ctx,
      builder: (ctx2) => StatefulBuilder(
        builder: (ctx2, setSt) => AlertDialog(
          title: Text(group == null ? 'Группа модификаторов' : 'Изменить группу'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Название', hintText: 'Молоко, Сироп, Прожарка'),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: required,
                  onChanged: (v) => setSt(() => required = v),
                  title: const Text('Обязательный выбор'),
                  subtitle: const Text('Без него позицию не добавить', style: TextStyle(fontSize: 11)),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: multi,
                  onChanged: (v) => setSt(() => multi = v),
                  title: const Text('Можно выбрать несколько'),
                ),
                if (multi)
                  TextField(
                    controller: maxCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Не больше (пусто — без ограничения)'),
                  ),
                const SizedBox(height: 10),
                const Text('Варианты', style: TextStyle(fontSize: 12, color: Colors.grey)),
                ...options.asMap().entries.map((e) => ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text(e.value.name, style: const TextStyle(fontSize: 13)),
                      subtitle: Text(
                        [
                          e.value.price > 0 ? '+${e.value.price.toStringAsFixed(0)} ₽' : 'бесплатно',
                          if (e.value.hasInventoryLink) 'склад: ${e.value.weightUnit.formatWithLabel(e.value.weight)}',
                        ].join(' · '),
                        style: const TextStyle(fontSize: 12),
                      ),
                      onTap: () async {
                        final o = await _editModifierOption(ctx2, e.value);
                        if (o != null) setSt(() => options[e.key] = o);
                      },
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline, size: 18),
                        onPressed: () => setSt(() => options.removeAt(e.key)),
                      ),
                    )),
                OutlinedButton.icon(
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('Добавить вариант'),
                  onPressed: () async {
                    final o = await _editModifierOption(ctx2, null);
                    if (o != null) setSt(() => options.add(o));
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx2), child: const Text('Отмена')),
            FilledButton(
              onPressed: () {
                final name = nameCtrl.text.trim();
                if (name.isEmpty || options.isEmpty) return;
                final max = multi ? (int.tryParse(maxCtrl.text.trim()) ?? 0) : 1;
                Navigator.pop(
                    ctx2, ModifierGroup(name: name, min: required ? 1 : 0, max: max < 0 ? 0 : max, options: options));
              },
              child: const Text('Готово'),
            ),
          ],
        ),
      ),
    );
  }

  /// Вариант модификатора: название, доплата, списание со склада.
  Future<ModifierOption?> _editModifierOption(BuildContext ctx, ModifierOption? option) {
    final nameCtrl = TextEditingController(text: option?.name ?? '');
    final priceCtrl = TextEditingController(text: (option != null && option.price > 0) ? option.price.toStringAsFixed(0) : '');
    final weightCtrl =
        TextEditingController(text: (option != null && option.weight > 0) ? option.weightUnit.format(option.weight) : '');
    String? invId = (option?.inventoryItemId.isNotEmpty == true) ? option!.inventoryItemId : null;
    var unit = option?.weightUnit ?? InventoryUnit.g;
    return showDialog<ModifierOption>(
      context: ctx,
      builder: (ctx2) => StatefulBuilder(
        builder: (ctx2, setSt) => AlertDialog(
          title: const Text('Вариант'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameCtrl,
                  decoration: const InputDecoration(labelText: 'Название', hintText: 'Кокосовое молоко'),
                ),
                TextField(
                  controller: priceCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Доплата, ₽ (пусто — бесплатно)'),
                ),
                const SizedBox(height: 8),
                if (_inventoryItems.isNotEmpty)
                  DropdownButton<String?>(
                    value: invId,
                    isExpanded: true,
                    hint: const Text('Склад — не списывать'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('Склад — не списывать')),
                      ..._inventoryItems.map((inv) =>
                          DropdownMenuItem<String?>(value: inv.id, child: Text('${inv.name} (${inv.unit.label})'))),
                    ],
                    onChanged: (v) => setSt(() {
                      invId = v;
                      if (v != null) unit = _inventoryItems.firstWhere((i) => i.id == v).unit;
                    }),
                  ),
                if (invId != null)
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: weightCtrl,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'Сколько списать'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      DropdownButton<InventoryUnit>(
                        value: unit,
                        items: InventoryUnit.values.map((u) => DropdownMenuItem(value: u, child: Text(u.label))).toList(),
                        onChanged: (u) {
                          if (u != null) setSt(() => unit = u);
                        },
                      ),
                    ],
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx2), child: const Text('Отмена')),
            FilledButton(
              onPressed: () {
                final name = nameCtrl.text.trim();
                if (name.isEmpty) return;
                final price = double.tryParse(priceCtrl.text.replaceAll(',', '.')) ?? 0;
                final w = double.tryParse(weightCtrl.text.replaceAll(',', '.')) ?? 0;
                Navigator.pop(
                    ctx2,
                    ModifierOption(
                      name: name,
                      price: price < 0 ? 0 : price,
                      inventoryItemId: invId != null && w > 0 ? invId! : '',
                      weight: invId != null && w > 0 ? w : 0,
                      weightUnit: unit,
                    ));
              },
              child: const Text('Готово'),
            ),
          ],
        ),
      ),
    );
  }

  /// Диалог добавления одного компонента составной позиции.
  Future<MenuItemComponent?> _editComponent(BuildContext ctx) async {
    String? selectedInvId;
    var unit = InventoryUnit.g;
    final weightCtrl = TextEditingController();

    return showDialog<MenuItemComponent>(
      context: ctx,
      builder: (ctx2) => StatefulBuilder(
        builder: (ctx2, setSt) => AlertDialog(
          title: const Text('Компонент микса'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_inventoryItems.isEmpty)
                const Text('Нет позиций склада',
                    style: TextStyle(color: Colors.grey))
              else
                DropdownButton<String?>(
                  value: selectedInvId,
                  isExpanded: true,
                  hint: const Text('Выберите позицию склада'),
                  items: _inventoryItems
                      .map((inv) => DropdownMenuItem<String?>(
                            value: inv.id,
                            child: Text('${inv.name} (${inv.unit.label})'),
                          ))
                      .toList(),
                  onChanged: (v) {
                    setSt(() {
                      selectedInvId = v;
                      // Автоматически ставим единицу склада
                      if (v != null) {
                        final inv = _inventoryItems.firstWhere((i) => i.id == v);
                        unit = inv.unit;
                      }
                    });
                  },
                ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: weightCtrl,
                      decoration: const InputDecoration(labelText: 'Количество'),
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                    ),
                  ),
                  const SizedBox(width: 12),
                  DropdownButton<InventoryUnit>(
                    value: unit,
                    items: InventoryUnit.values
                        .map((u) =>
                            DropdownMenuItem(value: u, child: Text(u.label)))
                        .toList(),
                    onChanged: (u) {
                      if (u != null) setSt(() => unit = u);
                    },
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx2), child: const Text('Отмена')),
            FilledButton(
              onPressed: () {
                final w = double.tryParse(weightCtrl.text.replaceAll(',', '.')) ?? 0;
                if (selectedInvId == null || w <= 0) return;
                Navigator.pop(
                    ctx2,
                    MenuItemComponent(
                      inventoryItemId: selectedInvId!,
                      weight: w,
                      weightUnit: unit,
                    ));
              },
              child: const Text('Добавить'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDelete(
    BuildContext context, {
    required String title,
    required String message,
    required VoidCallback onConfirm,
  }) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Удалить'),
          ),
        ],
      ),
    );
    if (confirm == true) onConfirm();
  }

  Future<String?> _promptText(BuildContext context, String title, String label, {String? initial}) {
    final ctrl = TextEditingController(text: initial ?? '');
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        scrollable: true,
        title: Text(title),
        content: TextField(controller: ctrl, decoration: InputDecoration(labelText: label), autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text(initial == null ? 'Создать' : 'Сохранить')),
        ],
      ),
    );
  }
}

/// Результат диалога создания/редактирования позиции меню.
class _ItemDialogResult {
  final String name;
  final double price;
  final double weight;
  final InventoryUnit weightUnit;
  final String inventoryItemId;
  final List<MenuItemComponent> components;
  final String vat;
  final String fiscalSubject;
  final String description;
  final bool tobacco;
  final List<ModifierGroup> modifierGroups;

  _ItemDialogResult({
    required this.name,
    required this.price,
    required this.weight,
    required this.weightUnit,
    this.inventoryItemId = '',
    this.components = const [],
    this.vat = '',
    this.fiscalSubject = 'commodity',
    this.description = '',
    this.tobacco = false,
    this.modifierGroups = const [],
  });
}

/// Круглая миниатюра фото с кликабельным оверлеем-камерой поверх — тап
/// открывает выбор источника (галерея/камера) и загружает новое фото.
class _EditableThumb extends StatelessWidget {
  final String imageUrl;
  final bool uploading;
  final IconData icon;
  final VoidCallback onTap;

  const _EditableThumb({
    required this.imageUrl,
    required this.uploading,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Отдельный узел доступности: иначе нажатие миниатюры сливалось с
    // нажатием всей строки, и для экранного диктора (TalkBack) двойной тап
    // по категории открывал выбор фото вместо списка позиций.
    return Semantics(
      container: true,
      button: true,
      label: 'Изменить фото',
      child: InkWell(
      borderRadius: BorderRadius.circular(24),
      onTap: uploading ? null : onTap,
      child: SizedBox(
        width: 44,
        height: 44,
        child: Stack(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: SizedBox(
                width: 44,
                height: 44,
                child: imageUrl.isEmpty
                    ? Container(
                        color: AppColors.surfaceElevated,
                        child: Icon(icon, size: 20, color: AppColors.textMuted),
                      )
                    : CachedNetworkImage(
                        imageUrl: imageUrl,
                        fit: BoxFit.cover,
                        memCacheWidth: (MediaQuery.of(context).devicePixelRatio * 44).round(),
                        useOldImageOnUrlChange: true,
                        fadeInDuration: Duration.zero,
                        fadeOutDuration: Duration.zero,
                        errorWidget: (_, __, ___) => Container(
                          color: AppColors.surfaceElevated,
                          child: Icon(icon, size: 20, color: AppColors.textMuted),
                        ),
                      ),
              ),
            ),
            if (uploading)
              Container(
                color: Colors.black38,
                child: const Center(
                  child: SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  ),
                ),
              )
            else
              Positioned(
                right: -2,
                bottom: -2,
                child: Container(
                  padding: const EdgeInsets.all(2),
                  decoration: const BoxDecoration(color: Colors.black, shape: BoxShape.circle),
                  child: const Icon(Icons.camera_alt, size: 10, color: Colors.white),
                ),
              ),
          ],
        ),
      ),
      ),
    );
  }
}