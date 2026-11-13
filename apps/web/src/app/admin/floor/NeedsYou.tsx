'use client';

// v0.18.0 (B1): every alert in one strip, each with its own one or two
// buttons: kiosk check-ins to confirm, fixes to approve, a tech saying the
// client left, help requests, calls nobody answered, a busy requested or
// booked tech, calendar links to approve, a failing calendar sync. The
// long-wait notice switch ends the strip. Nothing waiting: one quiet line.
import { LinkButton } from '@/components/ui';
import { fill } from '@/i18n/dictionary';
import {
  ackHelpFor,
  clearCallFor,
  clientHereFor,
  clientLeftFor,
  notHereFor,
  requestHoldFor,
  reviewFixFor,
  reviewKioskFor,
  setNotice,
} from '../actions';
import type { NeedsItem } from './types';
import { ActButton, useWords } from './ui';

export function NeedsYou({
  items,
  waitLine,
  longWait,
  noticeEnabled,
}: {
  items: NeedsItem[];
  waitLine: string;
  longWait: boolean;
  noticeEnabled: boolean;
}) {
  const w = useWords();
  const f = w.floor;
  const d = w.desk;
  return (
    <section
      aria-labelledby="needs-h"
      aria-live="polite"
      className={`flex flex-col gap-2 border-l-[12px] bg-board px-4 py-2 ${items.length ? 'border-polish' : 'border-teal'}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="needs-h" className="font-semibold">
          {f.needsYou}
          {items.length ? <span className="pl-1 text-polish">({items.length})</span> : null}
        </h2>
        {items.length === 0 ? <span className="text-slate/80">{f.needsNothing}</span> : null}
        <span className={`text-small ${longWait ? 'font-semibold text-polish' : 'text-slate/70'}`}>
          {waitLine}
        </span>
        <span className="ml-auto flex items-center gap-2 text-small text-slate/80">
          {noticeEnabled ? d.noticeOn : d.noticeOff}
          <ActButton
            action={setNotice}
            fields={{ enabled: noticeEnabled ? 'false' : 'true' }}
            label={noticeEnabled ? d.turnNoticeOff : d.turnNoticeOn}
            tone="quiet"
          />
        </span>
      </div>
      {items.length ? (
        <ul className="grid max-h-[32vh] gap-2 overflow-y-auto md:grid-cols-2 wide:max-h-[9.5rem]">
          {items.map((i) => (
            <li
              key={i.key}
              className="flex flex-wrap items-center gap-2 border-l-4 border-polish bg-pumice/60 px-3 py-2"
            >
              <Item i={i} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Item({ i }: { i: NeedsItem }) {
  const w = useWords();
  const f = w.floor;
  const d = w.desk;
  const line = (title: string, detail?: string) => (
    <span className="flex min-w-0 flex-1 basis-40 flex-col">
      <span className="font-semibold leading-snug">{title}</span>
      {detail ? <span className="text-small text-slate/80">{detail}</span> : null}
    </span>
  );
  switch (i.kind) {
    case 'kiosk': {
      const v = i.row;
      const group = v.partyId && v.partySize && v.partySize > 1;
      return (
        <>
          {line(v.who, `${f.kioskLine} · ${v.servicesText}`)}
          <ActButton
            action={reviewKioskFor}
            fields={
              group
                ? { visitId: v.id, decision: 'confirm', wholeParty: 'true' }
                : { visitId: v.id, decision: 'confirm' }
            }
            label={group ? fill(d.groupConfirmAll, { n: v.partySize ?? 0 }) : d.kioskConfirm}
            ariaLabel={`${d.kioskConfirm}: ${v.who}`}
          />
          <ActButton
            action={notHereFor}
            fields={{ visitId: v.id, kind: 'kiosk_decline' }}
            label={f.notHere}
            ariaLabel={`${f.notHere}: ${v.who}`}
            tone="quiet"
          />
        </>
      );
    }
    case 'fix': {
      const v = i.row;
      return (
        <>
          {line(`${d.fixBadge}: ${v.who}`, v.servicesText)}
          <ActButton
            action={reviewFixFor}
            fields={{ visitId: v.id, decision: 'approve' }}
            label={d.fixApprove}
            ariaLabel={`${d.fixApprove}: ${v.who}`}
          />
          <ActButton
            action={reviewFixFor}
            fields={{ visitId: v.id, decision: 'decline' }}
            label={d.fixDecline}
            ariaLabel={`${d.fixDecline}: ${v.who}`}
            tone="quiet"
          />
        </>
      );
    }
    case 'left': {
      const v = i.row;
      return (
        <>
          {line(fill(d.claimLine, { name: v.calledTechnician ?? '' }), v.title)}
          <ActButton
            action={clientLeftFor}
            fields={{ visitId: v.id }}
            label={d.claimConfirm}
            ariaLabel={`${d.claimConfirm}: ${v.who}`}
          />
          <ActButton
            action={clientHereFor}
            fields={{ visitId: v.id }}
            label={d.claimHere}
            ariaLabel={`${d.claimHere}: ${v.who}`}
            tone="quiet"
          />
        </>
      );
    }
    case 'help':
      return (
        <>
          {line(i.title, i.detail)}
          <ActButton
            action={ackHelpFor}
            fields={{ helpId: i.id }}
            label={d.helpAck}
            ariaLabel={`${d.helpAck}: ${i.title}`}
          />
        </>
      );
    case 'unanswered':
      return (
        <>
          {line(i.title)}
          <ActButton
            action={clearCallFor}
            fields={{ callId: i.callId }}
            label={d.clearCall}
            tone="quiet"
          />
        </>
      );
    case 'hold':
      return (
        <>
          {line(i.title, i.detail)}
          <ActButton
            action={requestHoldFor}
            fields={{ visitId: i.row.id, decision: 'keep' }}
            label={d.keepWaiting}
            ariaLabel={`${d.keepWaiting}: ${i.row.who}`}
          />
          <ActButton
            action={requestHoldFor}
            fields={{ visitId: i.row.id, decision: 'by_turn' }}
            label={d.sendByTurn}
            ariaLabel={`${d.sendByTurn}: ${i.row.who}`}
            tone="quiet"
          />
        </>
      );
    case 'links':
    case 'sync':
      return (
        <>
          {line(i.title)}
          <LinkButton href="/admin/appointments" tone="quiet">
            {f.open}
          </LinkButton>
        </>
      );
  }
}
