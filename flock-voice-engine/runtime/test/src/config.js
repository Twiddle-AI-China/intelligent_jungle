import { DOMAIN_CONFIG } from '../../src/domain/config.js';
export {
  createDomainConfigProjection,
  DOMAIN_CONFIG,
} from '../../src/domain/config.js';
export const CONFIG = Object.freeze(structuredClone(DOMAIN_CONFIG));
