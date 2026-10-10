import 'package:flutter/widgets.dart';

import '../services/people_directory.dart';

/// Перерисовывает приложение, когда справочник людей (People) получил
/// имена, которых на экране ещё не было: модели берут их через `Pd.*` в
/// момент отрисовки, поэтому достаточно перестроить виджеты. Справочник
/// сообщает об изменениях не чаще четырёх раз в секунду, а без новых имён
/// не сообщает вовсе — лишней работы нет.
class PeopleRefresh extends StatefulWidget {
  final Widget child;
  const PeopleRefresh({super.key, required this.child});

  @override
  State<PeopleRefresh> createState() => _PeopleRefreshState();
}

class _PeopleRefreshState extends State<PeopleRefresh> {
  People? _people;

  @override
  void initState() {
    super.initState();
    _attach();
  }

  void _attach() {
    _people?.removeListener(_rebuildAll);
    _people = People.instance..addListener(_rebuildAll);
  }

  @override
  void didUpdateWidget(PeopleRefresh oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(_people, People.instance)) _attach();
  }

  @override
  void dispose() {
    _people?.removeListener(_rebuildAll);
    super.dispose();
  }

  void _rebuildAll() {
    if (!mounted) return;
    void mark(Element e) {
      e.markNeedsBuild();
      e.visitChildren(mark);
    }

    (context as Element).visitChildren(mark);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
