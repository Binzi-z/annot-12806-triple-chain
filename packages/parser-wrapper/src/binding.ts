import { parseString } from "xml2js";

export function bindOrder(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindCustomer(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindProduct(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindAddress(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindPayment(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindRefund(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindSupplier(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindWarehouse(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindRoute(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindTariff(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindVoucher(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

export function bindProfile(xml: string, done: (err: Error | null, doc: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}

