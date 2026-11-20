import { DOMParser } from "@xmldom/xmldom";

export function domParseInvoice(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParsePurchaseOrder(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseShipment(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseCatalog(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseManifest(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseContract(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseStatement(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseReceipt(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseLabel(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseCustoms(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParsePackingList(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseQuote(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseClaim(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

export function domParseLedger(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

