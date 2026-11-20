import fs from "node:fs";

const ENTITY_DECL = /<!ENTITY\s+(\w+)\s+SYSTEM\s+"([^"]+)">/g;

export function expandEntities(xml: string): string {
  return xml.replace(ENTITY_DECL, (_m, name: string, uri: string) => {
    const value = fs.readFileSync(uri, "utf8");
    return `<!ENTITY ${name} "${value}">`;
  });
}

export function entitiesParseCatalog(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseManifest(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseInvoice(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseContract(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseReceipt(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseLabel(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseCustoms(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseShipment(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseQuote(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseClaim(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseLedger(xml: string): string {
  return expandEntities(xml);
}

export function entitiesParseJournal(xml: string): string {
  return expandEntities(xml);
}

