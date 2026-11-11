'use client';

// The page that shows when a server page throws (for example a location with
// no valid rule config). Plain words in both languages: an error boundary
// cannot read the language cookie, and the floor must know what to do.
// The digest is the only detail shown: it matches the server log line, and
// says nothing about the code (no message, no stack; Part 10).
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-heading font-semibold">Something went wrong on our side.</h1>
      <p className="text-slate/80">Try again. If it keeps happening, tell the owner.</p>
      <p className="text-slate/80">Có lỗi từ phía chúng tôi. Thử lại; nếu vẫn lỗi, báo chủ tiệm.</p>
      {error.digest ? <p className="text-small text-slate/80">Ref: {error.digest}</p> : null}
      <button
        type="button"
        onClick={() => reset()}
        className="min-h-11 self-start rounded-control bg-navy px-5 font-semibold text-board"
      >
        Try again · Thử lại
      </button>
    </main>
  );
}
