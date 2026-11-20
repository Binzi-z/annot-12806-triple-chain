import {
  bindProfile,
  bindRoute,
  bindTariff,
  bindVoucher,
  domParseClaim,
  domParseLedger,
  domParsePackingList,
  domParseQuote,
  entitiesParseClaim,
  entitiesParseJournal,
  entitiesParseLedger,
  entitiesParseQuote,
  saxParseBatch,
  saxParseNotice,
} from "@doc/parser-wrapper";

export function queueDom01(msg: any): any {
  const xml = String(msg.body ?? "");
  return domParsePackingList(xml);
}

export function queueDom02(msg: any): any {
  const xml = String(msg.body ?? "");
  return domParseQuote(xml);
}

export function queueDom03(msg: any): any {
  const xml = String(msg.body ?? "");
  return domParseClaim(xml);
}

export function queueDom04(msg: any): any {
  const xml = String(msg.body ?? "");
  return domParseLedger(xml);
}

export function queueSax05(msg: any): any {
  const xml = String(msg.body ?? "");
  return saxParseNotice(xml);
}

export function queueSax06(msg: any): any {
  const xml = String(msg.body ?? "");
  return saxParseBatch(xml);
}

export function queueBind07(msg: any): any {
  const xml = String(msg.body ?? "");
  return bindRoute(xml);
}

export function queueBind08(msg: any): any {
  const xml = String(msg.body ?? "");
  return bindTariff(xml);
}

export function queueBind09(msg: any): any {
  const xml = String(msg.body ?? "");
  return bindVoucher(xml);
}

export function queueBind10(msg: any): any {
  const xml = String(msg.body ?? "");
  return bindProfile(xml);
}

export function queueEnt11(msg: any): any {
  const xml = String(msg.body ?? "");
  return entitiesParseQuote(xml);
}

export function queueEnt12(msg: any): any {
  const xml = String(msg.body ?? "");
  return entitiesParseClaim(xml);
}

export function queueEnt13(msg: any): any {
  const xml = String(msg.body ?? "");
  return entitiesParseLedger(xml);
}

export function queueEnt14(msg: any): any {
  const xml = String(msg.body ?? "");
  return entitiesParseJournal(xml);
}

