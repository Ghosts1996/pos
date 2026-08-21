import '../../theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../../models/menu_models.dart';
import '../../services/firestore_service.dart';
import '../../services/storage_service.dart';

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
  final _storage = StorageService();

  // Пока идёт загрузка фото конкретной категории/позиции — блокируем именно
  // её строку, а не весь экран, чтобы админ мог продолжать редактировать
  // остальное меню без ожидания.
  final Set<String> _uploadingIds = {};

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
      body: StreamBuilder<List<MenuCategory>>(
        stream: _fs.categoriesStream(),
        builder: (context, catSnap) {
          if (!catSnap.hasData) return const Center(child: CircularProgressIndicator());
          final categories = catSnap.data!;
          return StreamBuilder<List<MenuItem>>(
            stream: _fs.menuItemsStream(),
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
                    subtitle: Text('${catItems.length} позиций'),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
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
                              onTap: () => _pickAndUploadItemImage(item),
                            ),
                            title: Text(item.name),
                            subtitle: Text('${item.price.toStringAsFixed(0)} ₽'),
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
    );
  }

  Future<void> _pickAndUploadCategoryImage(MenuCategory cat) async {
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null) return;
    setState(() => _uploadingIds.add(cat.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'categories', entityId: cat.id);
      await _fs.updateCategoryImage(cat.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: $e')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(cat.id));
    }
  }

  Future<void> _pickAndUploadItemImage(MenuItem item) async {
    final source = await _pickSource(context);
    if (source == null) return;
    final file = await _storage.pickImage(source: source);
    if (file == null) return;
    setState(() => _uploadingIds.add(item.id));
    try {
      final url = await _storage.uploadMenuImage(file: file, folder: 'items', entityId: item.id);
      await _fs.updateMenuItemImage(item.id, url);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Не удалось загрузить фото: $e')));
      }
    } finally {
      if (mounted) setState(() => _uploadingIds.remove(item.id));
    }
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
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(item == null ? 'Новая позиция' : 'Редактировать'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Название')),
            TextField(
              controller: priceCtrl,
              decoration: const InputDecoration(labelText: 'Цена, ₽'),
              keyboardType: TextInputType.number,
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Сохранить')),
        ],
      ),
    );
    if (ok != true || nameCtrl.text.trim().isEmpty) return;
    final price = double.tryParse(priceCtrl.text.replaceAll(',', '.')) ?? 0;
    if (item == null) {
      await _fs.addMenuItem(
          MenuItem(id: '', categoryId: categoryId!, name: nameCtrl.text.trim(), price: price));
    } else {
      await _fs.updateMenuItem(item.copyWith(name: nameCtrl.text.trim(), price: price));
    }
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
    return InkWell(
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
                    : Image.network(
                        imageUrl,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Container(
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
    );
  }
}