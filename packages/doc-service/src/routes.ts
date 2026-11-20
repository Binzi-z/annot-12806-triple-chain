import {
  bindPayment,
  bindRefund,
  bindSupplier,
  bindWarehouse,
  domParseContract,
  domParseCustoms,
  domParseLabel,
  domParseReceipt,
  domParseStatement,
  entitiesParseCustoms,
  entitiesParseLabel,
  entitiesParseReceipt,
  entitiesParseShipment,
  saxParseBooking,
  saxParsePriceList,
  saxParseSchedule,
  saxParseWaybill,
} from "@doc/parser-wrapper";

export function routeDom01(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return domParseContract(xml);
}

export function routeDom02(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return domParseStatement(xml);
}

export function routeDom03(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return domParseReceipt(xml);
}

export function routeDom04(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return domParseLabel(xml);
}

export function routeDom05(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return domParseCustoms(xml);
}

export function routeSax06(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return saxParsePriceList(xml);
}

export function routeSax07(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return saxParseBooking(xml);
}

export function routeSax08(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return saxParseWaybill(xml);
}

export function routeSax09(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return saxParseSchedule(xml);
}

export function routeBind10(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return bindPayment(xml);
}

export function routeBind11(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return bindRefund(xml);
}

export function routeBind12(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return bindSupplier(xml);
}

export function routeBind13(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return bindWarehouse(xml);
}

export function routeEnt14(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return entitiesParseReceipt(xml);
}

export function routeEnt15(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return entitiesParseLabel(xml);
}

export function routeEnt16(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return entitiesParseCustoms(xml);
}

export function routeEnt17(req: any): any {
  const xml = String(req.query.xml ?? req.query.doc ?? "");
  return entitiesParseShipment(xml);
}

