// One input accepts an email address or a US phone number (design doc:
// email plus SMS code for everyone). Validated once, at the edge.

export type Contact = { kind: 'email'; value: string } | { kind: 'phone'; value: string };

// No spaces, commas or quotes; a pasted "a@b.com," is a typo, not an address.
const EMAIL = /^[^\s@,'"<>]+@[^\s@,'"<>]+\.[^\s@,'"<>]{2,}$/;
// North American numbering plan: area code and exchange start with 2 to 9.
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;
// Invisible direction marks that iOS paste adds.
const INVISIBLE = /[‎‏​﻿]/g;

export function parseContact(raw: unknown): Contact | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(INVISIBLE, '').trim();
  if (!text) return null;
  if (text.includes('@')) {
    return EMAIL.test(text) ? { kind: 'email', value: text.toLowerCase() } : null;
  }
  let digits = text.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return NANP.test(digits) ? { kind: 'phone', value: `+1${digits}` } : null;
}

/** How the contact is shown back: never the full phone number. */
export function maskContact(contact: Contact): string {
  if (contact.kind === 'email') return contact.value;
  return `(•••) •••-${contact.value.slice(-4)}`;
}
