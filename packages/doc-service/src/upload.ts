import fs from "node:fs";
import {
  bindAddress,
  bindCustomer,
  bindOrder,
  bindProduct,
  domParseCatalog,
  domParseInvoice,
  domParseManifest,
  domParsePurchaseOrder,
  domParseShipment,
  entitiesParseCatalog,
  entitiesParseContract,
  entitiesParseInvoice,
  entitiesParseManifest,
  saxParseEventStream,
  saxParseFeed,
  saxParseInventory,
  saxParseStream01,
  saxParseStream02,
  saxParseTally,
} from "@doc/parser-wrapper";

export function uploadDom01(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return domParseInvoice(xml);
}

export function uploadDom02(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return domParsePurchaseOrder(xml);
}

export function uploadDom03(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return domParseShipment(xml);
}

export function uploadDom04(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return domParseCatalog(xml);
}

export function uploadDom05(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return domParseManifest(xml);
}

export function uploadSax06(req: any, done: (tags: string[]) => void): void {
  saxParseStream01(req.file.stream, done);
}

export function uploadSax07(req: any, done: (tags: string[]) => void): void {
  saxParseStream02(req.file.stream, done);
}

export function uploadSax08(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return saxParseFeed(xml);
}

export function uploadSax09(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return saxParseTally(xml);
}

export function uploadSax10(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return saxParseEventStream(xml);
}

export function uploadSax11(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return saxParseInventory(xml);
}

export function uploadBind12(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return bindOrder(xml);
}

export function uploadBind13(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return bindCustomer(xml);
}

export function uploadBind14(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return bindProduct(xml);
}

export function uploadBind15(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return bindAddress(xml);
}

export function uploadEnt16(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return entitiesParseCatalog(xml);
}

export function uploadEnt17(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return entitiesParseManifest(xml);
}

export function uploadEnt18(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return entitiesParseInvoice(xml);
}

export function uploadEnt19(req: any): any {
  const xml = fs.readFileSync(req.file.path, "utf8");
  return entitiesParseContract(xml);
}

