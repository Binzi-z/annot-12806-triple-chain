import { loadConfig } from "./index";

export const secureConfig = loadConfig({
  allowDtd: false,
  resolveExternalEntities: false,
  expandEntities: false,
});
