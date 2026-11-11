'use client';

// Part 10: the salon iPad loses Wi-Fi. A banner says so, every form submit is
// held back (a tap would otherwise fail halfway and leave the person unsure
// what happened), and "Try again" reloads once the connection is back. The
// browser's own online/offline events drive it; a server that is down but
// reachable shows the normal "Something went wrong" answers instead.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export function OfflineBanner({ text, retry }: { text: string; retry: string }) {
  const router = useRouter();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = () => {
      const off = !navigator.onLine;
      setOffline(off);
      if (off) document.documentElement.dataset['offline'] = 'true';
      else delete document.documentElement.dataset['offline'];
    };
    // Capture phase on window: runs before React's own submit listener, so a
    // form action is never started while offline.
    const hold = (e: Event) => {
      if (navigator.onLine) return;
      e.preventDefault();
      e.stopPropagation();
      setOffline(true);
    };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    window.addEventListener('submit', hold, true);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      window.removeEventListener('submit', hold, true);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center gap-4 bg-polish px-4 py-3 text-lead font-semibold text-board"
    >
      <span className="flex-1">{text}</span>
      <button
        type="button"
        onClick={() => {
          if (!navigator.onLine) return;
          setOffline(false);
          router.refresh();
        }}
        className="min-h-11 rounded-control border-2 border-board px-5"
      >
        {retry}
      </button>
    </div>
  );
}
