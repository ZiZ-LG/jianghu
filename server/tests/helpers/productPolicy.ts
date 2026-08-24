import { assembleProductAccess } from '@jianghu/domain-contracts';

export const internalProductPolicy = assembleProductAccess({ edition: 'internal' }).policy;
