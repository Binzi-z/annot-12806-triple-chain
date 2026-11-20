import { DOMParser } from "@xmldom/xmldom";
import sax from "sax";
import { parseString } from "xml2js";
import { assertNoDoctype } from "@doc/common-config";
import { expandEntities } from "./entities";

export function secureDomInvoice(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureDomPurchaseOrder(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureDomShipment(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureDomCatalog(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureDomManifest(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureDomContract(xml: string): Document | null {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function secureSaxFeed(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureSaxTally(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureSaxEventStream(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureSaxInventory(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureSaxPriceList(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureSaxBooking(xml: string): string[] {
  assertNoDoctype(xml);
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function secureBindOrder(xml: string, done: (err: Error | null, doc: any) => void): void {
  assertNoDoctype(xml);
  parseString(xml, { explicitArray: false }, done);
}

export function secureBindCustomer(xml: string, done: (err: Error | null, doc: any) => void): void {
  assertNoDoctype(xml);
  parseString(xml, { explicitArray: false }, done);
}

export function secureBindProduct(xml: string, done: (err: Error | null, doc: any) => void): void {
  assertNoDoctype(xml);
  parseString(xml, { explicitArray: false }, done);
}

export function secureBindAddress(xml: string, done: (err: Error | null, doc: any) => void): void {
  assertNoDoctype(xml);
  parseString(xml, { explicitArray: false }, done);
}

export function secureBindPayment(xml: string, done: (err: Error | null, doc: any) => void): void {
  assertNoDoctype(xml);
  parseString(xml, { explicitArray: false }, done);
}

export function secureEntitiesCatalog(xml: string): string {
  assertNoDoctype(xml);
  return expandEntities(xml);
}

export function secureEntitiesManifest(xml: string): string {
  assertNoDoctype(xml);
  return expandEntities(xml);
}

export function secureEntitiesInvoice(xml: string): string {
  assertNoDoctype(xml);
  return expandEntities(xml);
}

export function secureEntitiesContract(xml: string): string {
  assertNoDoctype(xml);
  return expandEntities(xml);
}

export function secureEntitiesReceipt(xml: string): string {
  assertNoDoctype(xml);
  return expandEntities(xml);
}

