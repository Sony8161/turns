import Link from 'next/link';

// A link that goes nowhere (Part 10). Both languages: a not-found page may be
// shown before anything is known about the visitor.
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-heading font-semibold">This page does not exist.</h1>
      <p className="text-slate/80">Check the address, or go back to the start.</p>
      <p className="text-slate/80">
        Trang này không có. Kiểm tra lại địa chỉ, hoặc quay về trang đầu.
      </p>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center self-start rounded-control bg-navy px-5 font-semibold text-board"
      >
        Start · Trang đầu
      </Link>
    </main>
  );
}
