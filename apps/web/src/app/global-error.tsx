'use client';

// When the root layout itself fails (Part 10). It replaces the whole page, so
// it brings its own html and body and no styles it cannot be sure of. No
// error text or stack: only the reference the server log holds.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#eef0f3',
          color: '#2b3444',
        }}
      >
        <main style={{ maxWidth: 448, margin: '0 auto', padding: '40px 16px' }}>
          <h1 style={{ fontSize: 25 }}>Something went wrong on our side.</h1>
          <p>Try again. If it keeps happening, tell the owner.</p>
          <p>Có lỗi từ phía chúng tôi. Thử lại; nếu vẫn lỗi, báo chủ tiệm.</p>
          {error.digest ? <p style={{ fontSize: 13 }}>Ref: {error.digest}</p> : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              minHeight: 44,
              padding: '0 20px',
              borderRadius: 8,
              border: 0,
              background: '#1f2a37',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 16,
            }}
          >
            Try again · Thử lại
          </button>
        </main>
      </body>
    </html>
  );
}
