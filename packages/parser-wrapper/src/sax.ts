import sax from "sax";
import type { Readable } from "node:stream";

export function saxParseFeed(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseTally(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseEventStream(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseInventory(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParsePriceList(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseBooking(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseWaybill(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseSchedule(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseNotice(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseBatch(xml: string): string[] {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  parser.write(xml).close();
  return tags;
}

export function saxParseStream01(stream: Readable, done: (tags: string[]) => void): void {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  stream.on("data", (chunk: Buffer) => parser.write(chunk.toString()));
  stream.on("end", () => done(tags));
  stream.on("error", () => done(tags));
}

export function saxParseStream02(stream: Readable, done: (tags: string[]) => void): void {
  const parser = sax.parser(true);
  const tags: string[] = [];
  parser.onopentag = (node: any) => { tags.push(node.name); };
  stream.on("data", (chunk: Buffer) => parser.write(chunk.toString()));
  stream.on("end", () => done(tags));
  stream.on("error", () => done(tags));
}

