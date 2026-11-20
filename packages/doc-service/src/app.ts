import { defaultConfig } from "@doc/common-config";
import { uploadDom01, routeDom01, queueDom01 } from "./index";

// 转换服务的入口：上传、URL 参数、消息体三条源都从这里进。
export function convert(raw: any, kind: string): any {
  if (kind === "upload") return uploadDom01(raw);
  if (kind === "route") return routeDom01(raw);
  return queueDom01(raw);
}

export const runtimeConfig = defaultConfig;
