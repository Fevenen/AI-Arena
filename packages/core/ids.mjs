import { randomUUID } from 'node:crypto';

export function createId(prefix = '') {
  const id = randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

export function createSeed() {
  return randomUUID().replaceAll('-', '');
}
