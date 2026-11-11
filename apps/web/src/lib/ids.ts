// Ids from a form or a URL are checked before they reach a query: Postgres
// rejects a non-UUID with an error, which would surface as a 500 instead of
// "not found".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The value as a UUID string, or null. */
export function uuidOf(value: unknown): string | null {
  return isUuid(value) ? value : null;
}
