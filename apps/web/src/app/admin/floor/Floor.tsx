'use client';

// v0.18.0 "Simplify the desk" (B1, B2, B5, B10, B15): the board as one
// screen. On an iPad in landscape: "Needs you" on top, the Next banner, then
// two panes, Team on the left and Clients on the right, each scrolling on its
// own; the page itself does not scroll on a normal day. In portrait and on a
// phone the same blocks stack: Needs you, Next, Clients, Team.
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import { callNextFor, type DeskState } from '../actions';
import { ClientsPane, type ClientRights } from './ClientsPane';
import { NeedsYou } from './NeedsYou';
import { PickSheet } from './PickSheet';
import { TeamPane } from './TeamPane';
import { TechDrawer, type DrawerRights } from './TechDrawer';
import type { CheckoutItem, ClientRow, NeedsItem, TeamMember } from './types';
import { FloorWords, Sheet, type FloorDict } from './ui';
import { WalkInSheet, type Tile } from './WalkInSheet';
import type { TileGroup } from './model';

export type FloorProps = {
  words: FloorDict;
  levelNames: Record<string, string>;
  canEnter: boolean;
  needs: NeedsItem[];
  waitLine: string;
  longWait: boolean;
  noticeEnabled: boolean;
  next: { title: string; why: string | null; free: boolean };
  team: TeamMember[];
  rows: ClientRow[];
  checkout: { on: boolean; items: CheckoutItem[] };
  clientRights: ClientRights;
  drawerRights: DrawerRights;
  freeReasons: readonly string[];
  bookDefault: string;
  walkIn: {
    groups: { group: TileGroup; services: Tile[] }[];
    fixes: Tile[];
    allServices: Tile[];
    technicians: { id: string; name: string }[];
    fixWindowDays: number;
    fixNeedsApproval: boolean;
    groupMax: number;
  };
};

export function Floor(p: FloorProps) {
  const f = p.words.floor;
  const [drawer, setDrawer] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [callState, call, calling] = useActionState<DeskState, FormData>(callNextFor, {});
  const tech = drawer ? p.team.find((m) => m.id === drawer) : undefined;
  const picking = pick ? p.rows.find((r) => r.id === pick && r.status === 'waiting') : undefined;
  const openVisits = p.rows
    .filter((r) => !r.needsConfirm)
    .map((r) => ({ id: r.id, title: r.title }));
  return (
    <FloorWords value={p.words}>
      <div className="flex flex-col gap-3 min-[1100px]:min-h-0 min-[1100px]:flex-1">
        <NeedsYou
          items={p.needs}
          waitLine={p.waitLine}
          longWait={p.longWait}
          noticeEnabled={p.noticeEnabled}
        />
        <div
          className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-l-[12px] bg-board px-4 py-2 ${p.next.free ? 'border-teal' : 'border-amber'}`}
        >
          <p aria-live="polite" className="flex min-w-0 flex-col">
            <span className="text-[32px] leading-tight font-extrabold tracking-tight">
              {p.next.title}
            </span>
            {p.next.why ? <span className="text-slate/80">{p.next.why}</span> : null}
          </p>
          {p.canEnter ? (
            <Button
              type="button"
              onClick={() => setWalkIn(true)}
              className="ml-auto min-h-14 px-8 text-lead"
            >
              {f.walkIn}
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[1100px]:grid-rows-1">
          <div className="flex min-h-0 flex-col min-[1100px]:col-start-2 min-[1100px]:row-start-1">
            <ClientsPane
              rows={p.rows}
              checkout={p.checkout}
              rights={p.clientRights}
              freeReasons={p.freeReasons}
              bookDefault={p.bookDefault}
              onPick={setPick}
              call={call}
              callState={callState}
              calling={calling}
            />
          </div>
          <div className="flex min-h-0 flex-col min-[1100px]:col-start-1 min-[1100px]:row-start-1">
            <TeamPane team={p.team} onOpen={setDrawer} />
          </div>
        </div>
      </div>

      <Sheet open={!!tech} onClose={() => setDrawer(null)} title={tech?.name ?? ''} side="right">
        {tech ? (
          <TechDrawer
            m={tech}
            rights={p.drawerRights}
            freeReasons={p.freeReasons}
            openVisits={openVisits}
          />
        ) : null}
      </Sheet>
      <Sheet
        open={!!picking}
        onClose={() => setPick(null)}
        title={picking ? f.pickTitle.replace('{who}', picking.who) : ''}
      >
        {picking ? (
          <PickSheet
            v={picking}
            call={call}
            calling={calling}
            onDone={() => setPick(null)}
            levelNames={p.levelNames}
          />
        ) : null}
      </Sheet>
      {p.canEnter ? (
        <Sheet open={walkIn} onClose={() => setWalkIn(false)} title={f.sheetTitle}>
          <WalkInSheet {...p.walkIn} onDone={() => setWalkIn(false)} />
        </Sheet>
      ) : null}
    </FloorWords>
  );
}
