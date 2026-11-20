export interface ParserSecurityConfig {
  allowDtd: boolean;
  resolveExternalEntities: boolean;
  expandEntities: boolean;
  maxDepth: number;
}

// 线上默认值：文档转换服务为了让供应商的 DTD 模板能用，默认把 DTD 与外部实体都打开。
export const defaultConfig: ParserSecurityConfig = {
  allowDtd: true,
  resolveExternalEntities: true,
  expandEntities: true,
  maxDepth: 64,
};

export function loadConfig(overrides: Partial<ParserSecurityConfig> = {}): ParserSecurityConfig {
  return { ...defaultConfig, ...overrides };
}

export function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error("DTD and entity declarations are not allowed by this tenant policy");
  }
}

export function isSecure(config: ParserSecurityConfig): boolean {
  return config.allowDtd === false && config.resolveExternalEntities === false;
}

export * from "./secure";
