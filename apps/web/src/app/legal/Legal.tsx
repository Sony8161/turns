import Link from 'next/link';
import type { ReactNode } from 'react';

// The frame for the draft Terms and Privacy pages (Part 10). The DRAFT banner
// stays until a Florida attorney has reviewed the text (13-Turn-System-GRC-
// Scoping.md, section 8). Brackets mark what only the attorney or the owners
// can fill in; nothing here claims compliance with any law.
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <p
        role="note"
        className="rounded-control border-4 border-polish bg-board px-4 py-3 text-lead font-semibold text-polish"
      >
        DRAFT, needs attorney review. Not in force. Bản nháp, cần luật sư duyệt; chưa có hiệu lực.
      </p>
      <h1 className="text-heading font-semibold">{title}</h1>
      <div className="flex flex-col gap-4 [&_h2]:pt-2 [&_h2]:text-lead [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
        {children}
      </div>
      <p className="text-small text-slate/80">
        Bản dịch tiếng Việt sẽ có sau khi luật sư duyệt bản tiếng Anh.
      </p>
      <nav className="flex gap-6">
        <Link href="/" className="underline">
          Start · Trang đầu
        </Link>
        <Link href="/terms" className="underline">
          Terms
        </Link>
        <Link href="/privacy" className="underline">
          Privacy
        </Link>
      </nav>
    </main>
  );
}
