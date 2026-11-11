'use client';

// v0.10.1 (Part 10 review finding 2): an unplanned failure shows a short
// reference next to its "Something went wrong" line, so the person can read
// it out and the matching log line can be found. The label comes from the
// root layout in the person's language.
import { createContext, useContext, type ReactNode } from 'react';

const Label = createContext('Reference: {ref}');

export function ErrorRefLabel({ label, children }: { label: string; children: ReactNode }) {
  return <Label.Provider value={label}>{children}</Label.Provider>;
}

export function ErrorRef({ refId }: { refId?: string | undefined }) {
  const label = useContext(Label);
  if (!refId) return null;
  return (
    <span className="block text-sm font-normal" data-error-ref={refId}>
      {label.replace('{ref}', refId)}
    </span>
  );
}
