import { uuidv7 } from 'uuidv7';

/** Time-ordered UUID v7 for all primary keys (better index locality). */
export function newId(): string {
  return uuidv7();
}
