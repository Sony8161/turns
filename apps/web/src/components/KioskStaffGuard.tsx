'use client';

// v0.9.1 (review finding 4): on a kiosk iPad, a staff session is signed out
// after five minutes without a tap. Each tap or key moves the clock cookie;
// once it is older than the limit the page goes to /kiosk and the proxy signs
// the session out. Rendered only when this browser is a kiosk and someone is
// signed in (root layout).
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { KIOSK_SEEN_COOKIE, KIOSK_STAFF_IDLE_MS } from '@/lib/kiosk-idle';

const WRITE_EVERY_MS = 15_000;

export function KioskStaffGuard() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    let written = 0;
    const touch = () => {
      last = Date.now();
      if (last - written < WRITE_EVERY_MS) return;
      written = last;
      const secure = window.location.protocol === 'https:' ? '; secure' : '';
      document.cookie = `${KIOSK_SEEN_COOKIE}=${last}; path=/; max-age=43200; samesite=strict${secure}`;
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const id = setInterval(() => {
      if (Date.now() - last > KIOSK_STAFF_IDLE_MS) router.replace('/kiosk');
    }, 15_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      clearInterval(id);
    };
  }, [router]);
  return null;
}
