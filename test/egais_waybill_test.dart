// ЕГАИС: накладная поставщика + справка FORM2REGINFO из УТМ → акт приёмки
// WayBillAct_v4 (принять, расхождения, отказ). УТМ — поддельный HTTP-сервер.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/egais_service.dart';

const _waybill = '''<?xml version="1.0" encoding="UTF-8"?>
<ns:Documents xmlns:ns="http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01" xmlns:wb="http://fsrar.ru/WEGAIS/TTNSingle_v4" xmlns:oref="http://fsrar.ru/WEGAIS/ClientRef_v2" xmlns:pref="http://fsrar.ru/WEGAIS/ProductRef_v2">
 <ns:Document><ns:WayBill_v4>
  <wb:Identity>WB-777</wb:Identity>
  <wb:Header>
   <wb:NUMBER>Н-15</wb:NUMBER><wb:Date>2026-11-14</wb:Date>
   <wb:Shipper><oref:UL><oref:ClientRegId>030000111111</oref:ClientRegId><oref:FullName>ООО «Вина и Ко»</oref:FullName><oref:ShortName>Вина и Ко</oref:ShortName></oref:UL></wb:Shipper>
  </wb:Header>
  <wb:Content>
   <wb:Position><wb:Identity>1</wb:Identity><wb:Product><pref:FullName>Вино красное сухое 0,75</pref:FullName></wb:Product><wb:Quantity>12</wb:Quantity></wb:Position>
   <wb:Position><wb:Identity>2</wb:Identity><wb:Product><pref:FullName>Коньяк 0,5</pref:FullName></wb:Product><wb:Quantity>6</wb:Quantity></wb:Position>
  </wb:Content>
 </ns:WayBill_v4></ns:Document>
</ns:Documents>''';

const _reg = '''<?xml version="1.0" encoding="UTF-8"?>
<ns:Documents xmlns:ns="http://fsrar.ru/WEGAIS/WB_DOC_SINGLE_01" xmlns:wbr="http://fsrar.ru/WEGAIS/TTNInformF2Reg">
 <ns:Document><ns:TTNInformF2Reg>
  <wbr:Header><wbr:Identity>WB-777</wbr:Identity><wbr:WBRegId>TTN-0123456789</wbr:WBRegId><wbr:WBNUMBER>Н-15</wbr:WBNUMBER></wbr:Header>
  <wbr:Content>
   <wbr:Position><wbr:Identity>1</wbr:Identity><wbr:InformF2RegId>FB-000000111</wbr:InformF2RegId></wbr:Position>
   <wbr:Position><wbr:Identity>2</wbr:Identity><wbr:InformF2RegId>FB-000000222</wbr:InformF2RegId></wbr:Position>
  </wbr:Content>
 </ns:TTNInformF2Reg></ns:Document>
</ns:Documents>''';

void main() {
  late HttpServer utm;
  final posted = <String>[];

  setUpAll(() async {
    utm = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    utm.listen((req) async {
      final base = 'http://127.0.0.1:${utm.port}';
      final path = req.uri.path;
      if (req.method == 'GET' && path == '/opt/out') {
        req.response.write('<?xml version="1.0"?><A>'
            '<url replyId="r1">$base/opt/out/WayBill_v4/1</url>'
            '<url>$base/opt/out/FORM2REGINFO/2</url>'
            '<url>$base/opt/out/Ticket/3</url><ver>2</ver></A>');
      } else if (path == '/opt/out/WayBill_v4/1') {
        req.response.add(utf8.encode(_waybill));
      } else if (path == '/opt/out/FORM2REGINFO/2') {
        req.response.add(utf8.encode(_reg));
      } else if (req.method == 'POST' && path == '/opt/in/WayBillAct_v4') {
        final body = utf8.decode(await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b)));
        posted.add(body);
        req.response.write('<?xml version="1.0"?><A><url>reply-${posted.length}</url><sign>…</sign><ver>2</ver></A>');
      } else {
        req.response.statusCode = 404;
      }
      await req.response.close();
    });
  });
  tearDownAll(() => utm.close(force: true));

  EgaisUtmService svc({String fsrar = '030000222222'}) => EgaisUtmService(utmHost: '127.0.0.1', utmPort: utm.port, fsrarId: fsrar);

  test('накладная поставщика с номером в ЕГАИС из справки', () async {
    final list = await svc().waybills();
    expect(list, hasLength(1));
    final wb = list.single;
    expect(wb.number, 'Н-15');
    expect(wb.shipper, 'Вина и Ко');
    expect(wb.regId, 'TTN-0123456789');
    expect(wb.positions.map((p) => '${p.name}:${p.quantity}:${p.informF2RegId}'),
        ['Вино красное сухое 0,75:12:FB-000000111', 'Коньяк 0,5:6:FB-000000222']);
  });

  test('принять целиком, с расхождениями, отказать — акт WayBillAct_v4 в УТМ', () async {
    posted.clear();
    final wb = (await svc().waybills()).single;
    expect(await svc().sendAct(wb, accept: true), 'reply-1');
    expect(posted.last, contains('name="xml_file"'));
    expect(posted.last, contains('<wa:IsAccept>Accepted</wa:IsAccept>'));
    expect(posted.last, contains('<wa:WBRegId>TTN-0123456789</wa:WBRegId>'));
    expect(posted.last, contains('<ns:FSRAR_ID>030000222222</ns:FSRAR_ID>'));
    expect(posted.last, contains('<wa:Content></wa:Content>'));

    await svc().sendAct(wb, accept: true, real: {'2': 5});
    expect(posted.last, contains('<wa:IsAccept>Differences</wa:IsAccept>'));
    expect(posted.last, contains('<wa:Identity>2</wa:Identity><wa:InformF2RegId>FB-000000222</wa:InformF2RegId><wa:RealQuantity>5</wa:RealQuantity>'));
    expect(posted.last, isNot(contains('FB-000000111')), reason: 'позиция без расхождения в акт не идёт');

    await svc().sendAct(wb, accept: false);
    expect(posted.last, contains('<wa:IsAccept>Rejected</wa:IsAccept>'));
  });

  test('без ФСРАР ИД или справки — понятный отказ, в УТМ ничего не уходит', () async {
    posted.clear();
    final wb = (await svc().waybills()).single;
    await expectLater(svc(fsrar: '').sendAct(wb, accept: true), throwsA(isA<EgaisException>()));
    final noReg = EgaisWaybill.parse(_waybill)!;
    await expectLater(svc().sendAct(noReg, accept: true), throwsA(isA<EgaisException>()));
    expect(posted, isEmpty);
  });

  test('акт: спецсимволы в примечании экранируются, дата акта — день отправки', () async {
    final xml = EgaisUtmService.buildActXml(
        fsrarId: '0300', wb: (await svc().waybills()).single, accept: true, note: 'a<b&c', date: DateTime(2026, 11, 14));
    expect(xml, contains('<wa:Note>a&lt;b&amp;c</wa:Note>'));
    expect(xml, contains('<wa:ActDate>2026-11-14</wa:ActDate>'));
  });
}
