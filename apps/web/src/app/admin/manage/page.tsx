import { redirect } from 'next/navigation';

// v0.18.0 (C4): Overrides folded into the board. Reassign, excuse a penalty
// and adjust points are in each technician's drawer (tap her row). The old
// address still works for bookmarks and the docs.
export default function ManagePage() {
  redirect('/admin');
}
