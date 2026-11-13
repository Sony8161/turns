import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { locations, serviceCategories, services, visitServices, visits } from '@turn/db';
import { aheadBecause, plainQueue, techBoard } from '@turn/db/board';
import { toCheckOut } from '@turn/db/checkout';
import { nameParts, shortName } from '@turn/db/clients';
import { floorAttention, pickQueues, todayPenalties, waitingVisits } from '@turn/db/engine';
import { feedSummary } from '@turn/db/feeds';
import { openHelpRequests } from '@turn/db/help';
import { menuLevels, reaches } from '@turn/db/levels';
import { requestHolds } from '@turn/db/requests';
import { activeRules } from '@turn/db/rules';
import { mayEditTechnicians } from '@turn/db/tech-settings';
import { mayActForTechnicians } from '@turn/db/act-for';
import { sweepFloor } from '@turn/db/status';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/AdminNav';
import { AutoRefresh } from '@/components/AutoRefresh';
import { formatClock, formatPoints, pointsWord, secondsSince } from '@/components/Board';
import { lineText, signedPoints } from '@/components/tech-lines';
import { fill } from '@/i18n/dictionary';
import { getDictionary } from '@/i18n/lang';
import { membershipWith, requireActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { salonInput } from './appointments/form';
import { Floor } from './floor/Floor';
import {
  categoryLabel,
  floorStatus,
  groupTiles,
  minutesSince,
  nextLine,
  pickOptions,
  rowTitle,
  timeText,
} from './floor/model';
import type { CheckoutItem, ClientRow, NeedsItem, TeamMember } from './floor/types';
import type { Waiting } from './floor/waiting';

// v0.18.0 "Simplify the desk": the board as one screen. What needs a person
// (Needs you), who is next, the team in turn order and the clients, with
// every desk action one tap away. Today's counts, yesterday's line and the
// calendar box moved to Reports ("Today"); Overrides moved into each tech's
// drawer. Every action still goes to the same server function, which checks
// the person's rights again.
export default async function AdminPage() {
  const [{ lang, t }, actor] = await Promise.all([getDictionary(), requireActor()]);
  // Technicians see their own position on /me, never the whole board (roles table).
  const membership = membershipWith(actor, 'view_board');
  if (!membership && actor.memberships.some((m) => m.role === 'technician')) redirect('/me');
  if (!membership) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-4 sm:px-8">
        <AdminNav current="board" badge={0} />
        <p className="max-w-[60ch] text-lead">{t.admin.noSalon}</p>
      </main>
    );
  }
  const loc = membership.locationId;
  const role = membership.role;
  // Out-over penalties and what an earlier day left open are settled first.
  await sweepFloor(db(), loc);
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 24 * 3_600_000);
  const [
    cards,
    plain,
    menu,
    usage,
    waiting,
    attention,
    calendar,
    place,
    holds,
    rules,
    help,
    picks,
    levelMenu,
  ] = await Promise.all([
    techBoard(db(), loc, now),
    plainQueue(db(), loc, now),
    db()
      .select({
        id: services.id,
        name: services.name,
        category: serviceCategories.name,
        isFillOrFullSet: serviceCategories.isFillOrFullSet,
        deskPicks: services.deskPicks,
        isFix: services.isFix,
      })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(and(eq(services.locationId, loc), isNull(services.archivedAt)))
      .orderBy(serviceCategories.name, services.name),
    // B7: most used first, from the last 30 days of visits.
    db()
      .select({ id: visitServices.serviceId, n: sql<number>`count(*)::int` })
      .from(visitServices)
      .innerJoin(visits, eq(visits.id, visitServices.visitId))
      .where(and(eq(visits.locationId, loc), gt(visits.arrivedAt, since30)))
      .groupBy(visitServices.serviceId),
    waitingVisits(db(), loc),
    floorAttention(db(), loc),
    feedSummary(db(), loc, now),
    db()
      .select({ timezone: locations.timezone })
      .from(locations)
      .where(eq(locations.id, loc))
      .then((r) => r[0]),
    requestHolds(db(), loc, now),
    activeRules(db(), loc),
    openHelpRequests(db(), loc),
    pickQueues(db(), loc, now),
    menuLevels(db(), loc),
  ]);
  const tz = place?.timezone ?? 'America/New_York';
  const clock = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const f = t.floor;
  const canActFor =
    can(role, 'act_for_technician') && (await mayActForTechnicians(db(), membership));
  const canOverride = can(role, 'override_queue');
  const canReassign = can(role, 'reassign_visit');
  const canApprove = can(role, 'approve_fixes');
  const canEnter = can(role, 'enter_walkins');
  const [penalties, checkout, canEdit] = await Promise.all([
    canOverride ? todayPenalties(db(), loc) : Promise.resolve([]),
    canEnter
      ? toCheckOut(db(), {
          userId: actor.userId,
          role,
          organizationId: membership.organizationId,
          locationId: loc,
        })
      : Promise.resolve(null),
    mayEditTechnicians(db(), membership),
  ]);

  // ---- Team (B2 to B6) ------------------------------------------------------
  const plainOf = new Map(plain.rows.map((r) => [r.technicianId, r]));
  const timers = new Map(attention?.timers.map((x) => [x.technicianId, x]) ?? []);
  const sort = rules?.queue.sort;
  const everyScore = !!sort?.includes('had_appointment_last');
  const zeroOnly = !everyScore && (!sort || sort.includes('double_zero_last'));
  const unansweredMin = attention?.unansweredCallMin ?? 3;
  const team: TeamMember[] = cards.map((c, i) => {
    const pr = plainOf.get(c.technicianId);
    const status = floorStatus(c.status, c.heldForAppointment, pr?.why);
    const minutes = minutesSince(c.status === 'called' ? c.calledAt : c.since, now);
    const apptAt = pr?.appointmentAt ?? c.nextAppointmentAt;
    const heldAt = apptAt ? clock.format(apptAt) : null;
    const over = timers.get(c.technicianId)?.over ?? false;
    const callable = pr?.eligible ?? false;
    // The labelled time already says why for these; others get a few words.
    const said = ['break', 'out', 'in_service', 'already_called', 'appointment_soon'];
    const reason =
      !callable && pr && !said.includes(pr.why)
        ? fill(f.why[pr.why] ?? pr.why, { time: heldAt ?? '' })
        : null;
    const levelName = c.level ? (t.levels.name[c.level] ?? c.level) : null;
    const diffLines: string[] = [];
    if (c.level && c.services) {
      const ticks = new Set(c.services);
      const asLevel = levelMenu.filter((s) => reaches(c.level!, s.minLevel)).map((s) => s.name);
      const extra = c.services.filter((n) => !asLevel.includes(n));
      const missing = asLevel.filter((n) => !ticks.has(n));
      if (extra.length) diffLines.push(fill(f.alsoDoes, { list: extra.join(', ') }));
      if (missing.length) diffLines.push(fill(f.doesNot, { list: missing.join(', ') }));
      if (!extra.length && !missing.length) diffLines.push(f.asLevel);
    } else {
      diffLines.push(
        c.skills === null
          ? f.everything
          : fill(f.skillsOnly, {
              list: c.skills.map((s) => categoryLabel(s, f.category)).join(', '),
            }),
      );
    }
    const ahead = cards[i + 1];
    const notes = [
      c.checkedInAt
        ? fill(t.techBoard.checkedIn, {
            time: clock.format(c.checkedInAt),
            rank: c.checkInRank,
            count: cards.length,
          })
        : null,
      c.hadAppointmentLast && everyScore
        ? t.techBoard.appointmentLast
        : c.hadAppointmentLast && zeroOnly && c.points === 0
          ? t.techBoard.appointmentLastZero
          : null,
      ahead
        ? fill(t.techBoard.ahead[aheadBecause(c, ahead, sort)], { name: ahead.displayName })
        : null,
    ].filter((n): n is string => !!n);
    return {
      id: c.technicianId,
      name: c.displayName,
      place: c.turn,
      status,
      points: formatPoints(c.points, c.hadAppointmentLast),
      pointsWords: pointsWord(c.points, c.hadAppointmentLast, t.board),
      time: timeText(f, status, minutes, { heldAt, over, limit: attention?.outOverMin }),
      alert: over || (status === 'called' && minutes >= unansweredMin),
      callable,
      isNext: plain.next?.technicianId === c.technicianId,
      reason,
      levelLine: levelName ? fill(f.level, { level: levelName }) : f.noLevel,
      diffLines,
      limits: c.restrictions.map((r) =>
        r.type === 'custom'
          ? (r.note ?? '')
          : fill(t.profile.summary[r.type] ?? r.type, { value: r.value ?? '' }),
      ),
      apptLine: c.nextAppointmentAt
        ? fill(c.heldForAppointment ? f.heldAppt : f.nextAppt, {
            time: clock.format(c.nextAppointmentAt),
          })
        : f.noAppt,
      currentLine:
        c.currentServices.length && (c.status === 'called' || c.status === 'in_service')
          ? fill(f.current, { services: c.currentServices.join(' + ') })
          : null,
      lines: c.lines.map((l) => ({
        delta: signedPoints(l.delta),
        text: lineText(l, t.techBoard, t.me.call.reasons),
        at: clock.format(l.at),
      })),
      total: formatPoints(c.points, c.hadAppointmentLast),
      notes,
      // v0.17.1: the free-no badge is for owners and managers only.
      freeDenyBadge:
        can(role, 'view_audit') && c.freeDenyFlag
          ? fill(t.techBoard.freeDenies, { n: c.freeDenies })
          : null,
      openCallId: c.openCallId,
      openCallKind: c.openCallKind,
      inServiceVisitId: c.inServiceVisitId,
      penalties: penalties
        .filter((p) => p.technicianId === c.technicianId)
        .map((p) => ({
          ledgerId: p.ledgerId,
          text:
            fill(t.manage.penaltyLine, {
              name: p.technicianName,
              points: formatPoints(p.delta),
              kind: t.manage.penalty[p.reasonType] ?? p.reasonType,
            }) + (p.note ? ` · ${p.note}` : ''),
          excused: p.excused,
        })),
    };
  });
  const nextName = plain.next
    ? (cards.find((c) => c.technicianId === plain.next!.technicianId)?.displayName ?? null)
    : null;
  const next = { ...nextLine(f, nextName, team), free: !!nextName };

  // ---- Clients (B9 to B12, C1 to C3) --------------------------------------
  const cardOf = new Map(cards.map((c) => [c.technicianId, c]));
  const rows: ClientRow[] = waiting.map((v) => {
    const base: Waiting = {
      id: v.id,
      status: v.status,
      services: v.services,
      waitSeconds: secondsSince(v.arrivedAt),
      calledTechnician: v.calledTechnician,
      calledSeconds: v.calledAt ? secondsSince(v.calledAt) : null,
      assignedTechnician: v.assignedTechnician,
      requestedTechnician: v.requestedTechnician,
      note: v.note,
      clientName:
        v.clientFirstName || v.clientLastName
          ? shortName(v.clientFirstName, v.clientLastName)
          : v.clientName
            ? shortName(
                nameParts({ name: v.clientName }).firstName,
                nameParts({ name: v.clientName }).lastName,
              )
            : null,
      clientGender: v.clientGender,
      clientIsKid: v.clientIsKid,
      clientAge: v.clientAge,
      groupId: v.groupId,
      fromKiosk: v.fromKiosk,
      kioskName: v.kioskName ? shortName(v.kioskName, v.kioskLastName) : null,
      needsConfirm: v.needsConfirm,
      deskPicks: v.deskPicks,
      splitRest: v.splitFromVisitId !== null,
      callKind: v.callKind ?? null,
      slip: v.slip,
      held: v.held,
      callId: v.callId ?? null,
      calledTechnicianId: v.calledTechnicianId ?? null,
      assignedTechnicianId: v.assignedTechnicianId ?? null,
      leftClaimPending: v.leftClaimPending === true,
      booked: v.source === 'appointment',
      hold: holdOf(holds.get(v.id), now, clock),
      partyId: v.partyId,
      partySize: v.partySize,
      isFix: v.isFix,
      needsApproval: v.needsApproval,
      fixOf: v.fixOf
        ? {
            date: day.format(v.fixOf.at),
            services: v.fixOf.services,
            technician: v.fixOf.technician,
          }
        : null,
    };
    const title = rowTitle(f, base, v.status === 'waiting' ? minutesSince(v.arrivedAt, now) : null);
    const callTime = (s: number) =>
      s < 60 ? t.desk.justNow : fill(f.waitMin, { n: Math.floor(s / 60) });
    const callLine =
      v.status === 'called' && v.calledTechnician
        ? fill(
            v.callKind === 'offer'
              ? f.askedRow
              : v.callKind === 'desk_pick'
                ? f.pickedRow
                : f.calledRow,
            { name: v.calledTechnician, time: callTime(base.calledSeconds ?? 0) },
          )
        : v.status === 'in_service' && v.assignedTechnician
          ? fill(f.servedRow, {
              name: v.assignedTechnician,
              n: minutesSince(
                v.assignedTechnicianId ? (cardOf.get(v.assignedTechnicianId)?.since ?? null) : null,
                now,
              ),
            })
          : null;
    const entry = picks.get(v.id);
    return {
      ...base,
      who: title.who,
      servicesText: title.services,
      wait: title.wait,
      title: title.title,
      callLine,
      pick:
        entry && !base.hold
          ? pickOptions(
              f,
              {
                deskPicks: entry.deskPicks,
                originalTechnicianId: entry.originalTechnicianId,
                queue: entry.queue.map((c) => ({
                  technicianId: c.technicianId,
                  displayName: c.displayName,
                  eligible: c.eligible,
                  why: c.why,
                  skilled: c.skilled,
                  ...(c.level ? { level: c.level } : {}),
                  ...(c.appointmentAt ? { appointmentAt: c.appointmentAt } : {}),
                })),
              },
              { canReassign, clock: (iso) => clock.format(new Date(iso)) },
            )
          : null,
    };
  });

  // ---- Needs you (B1) -------------------------------------------------------
  const toApprove = calendar && can(role, 'approve_calendar_links') ? calendar.pending : [];
  const seenParty = new Set<string>();
  const needs: NeedsItem[] = [];
  for (const r of rows) {
    if (r.status === 'waiting' && r.needsConfirm) {
      if (r.partyId && seenParty.has(r.partyId)) continue;
      if (r.partyId) seenParty.add(r.partyId);
      needs.push({ kind: 'kiosk', key: `k-${r.id}`, row: r });
    }
  }
  if (canApprove) {
    for (const r of rows)
      if (r.status === 'waiting' && r.needsApproval)
        needs.push({ kind: 'fix', key: `f-${r.id}`, row: r });
  }
  for (const r of rows)
    if (r.status === 'called' && r.leftClaimPending)
      needs.push({ kind: 'left', key: `l-${r.id}`, row: r });
  for (const h of help) {
    needs.push({
      kind: 'help',
      key: `h-${h.id}`,
      id: h.id,
      title: fill(t.desk.helpTitle, { name: h.technician }),
      detail:
        fill(t.desk.helpWaiting, { time: formatClock(secondsSince(h.createdAt)) }) +
        (h.reason ? ` · ${fill(t.desk.helpReason, { reason: h.reason })}` : ''),
    });
  }
  for (const c of attention?.unansweredCalls ?? []) {
    needs.push({
      kind: 'unanswered',
      key: `u-${c.callId}`,
      callId: c.callId,
      title: fill(t.desk.unanswered, { name: c.technicianName, minutes: c.waitedMin }),
    });
  }
  for (const r of rows) {
    if (r.status === 'waiting' && r.hold?.attention) {
      needs.push({
        kind: 'hold',
        key: `r-${r.id}`,
        row: r,
        title: fill(t.desk.holdFlag, { name: r.hold.technicianName, minutes: r.hold.waitedMin }),
        detail: r.title,
      });
    }
  }
  if (toApprove.length) {
    needs.push({
      kind: 'links',
      key: 'links',
      title: fill(f.linksToApprove, { names: toApprove.join(', ') }),
    });
  }
  if (calendar && (calendar.failing.length || calendar.stale.length)) {
    needs.push({
      kind: 'sync',
      key: 'sync',
      title: fill(f.syncFailing, {
        names: [...calendar.failing.map((x) => x.technicianName), ...calendar.stale].join(', '),
      }),
    });
  }
  const waitLine =
    !attention || attention.estimatedWaitMin === null
      ? t.desk.waitUnknown
      : attention.estimatedWaitMin === 0
        ? t.desk.noWait
        : fill(t.desk.estimatedWait, { minutes: attention.estimatedWaitMin });

  // ---- To check out (F1) ----------------------------------------------------
  const items: CheckoutItem[] =
    checkout && checkout.ok
      ? checkout.rows.map((c) => {
          const who =
            (c.clientFirstName || c.clientLastName
              ? shortName(c.clientFirstName, c.clientLastName)
              : c.clientName
                ? shortName(
                    nameParts({ name: c.clientName }).firstName,
                    nameParts({ name: c.clientName }).lastName,
                  )
                : c.kioskName
                  ? shortName(c.kioskName, c.kioskLastName)
                  : null) ?? f.walkInName;
          return {
            visitId: c.visitId,
            who,
            parts: c.parts.map((p) =>
              p.technician
                ? fill(f.partLine, { services: p.services.join(' + '), name: p.technician })
                : fill(f.partNobody, { services: p.services.join(' + ') }),
            ),
            finished: fill(f.finishedAt, { time: clock.format(c.finishedAt) }),
          };
        })
      : [];

  // ---- Walk-in sheet (B7) ---------------------------------------------------
  const count = Object.fromEntries(usage.map((u) => [u.id, Number(u.n)]));
  const tiles = menu.map((s) => ({ ...s, category: categoryLabel(s.category, f.category) }));
  const raw = menu.map((s) => ({ ...s }));
  const groups = groupTiles(raw, count).map((g) => ({
    group: g.group,
    services: g.services.map((s) => ({
      id: s.id,
      name: s.name,
      category: categoryLabel(s.category, f.category),
    })),
  }));

  return (
    <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-3 px-4 py-3 min-[1100px]:h-dvh min-[1100px]:overflow-hidden">
      <AutoRefresh seconds={5} />
      <AdminNav current="board" badge={needs.length} />
      <Floor
        words={{
          floor: f,
          desk: t.desk,
          actFor: t.actFor,
          manage: t.manage,
          reasons: t.me.call.reasons,
          freeLabel: t.me.call.freeReason,
        }}
        levelNames={t.levels.name}
        canEnter={canEnter}
        needs={needs}
        waitLine={
          attention?.longWait
            ? `${waitLine} · ${fill(t.desk.longWait, { minutes: attention.longWaitMin })}`
            : waitLine
        }
        longWait={!!attention?.longWait}
        noticeEnabled={!!attention?.noticeEnabled}
        next={next}
        team={team}
        rows={rows}
        checkout={{ on: !!(checkout && checkout.ok && checkout.on), items }}
        clientRights={{ approve: canApprove, actFor: canActFor }}
        drawerRights={{
          actFor: canActFor,
          edit: canEdit,
          override: canOverride,
          reassign: canReassign,
        }}
        freeReasons={rules?.penalties.deny_excused_reasons ?? []}
        bookDefault={salonInput(
          new Date(Math.ceil((now.getTime() + 60 * 60_000) / 900_000) * 900_000),
          tz,
        )}
        walkIn={{
          groups,
          fixes: tiles
            .filter((s) => s.isFix)
            .map((s) => ({ id: s.id, name: s.name, category: s.category, isFix: true })),
          allServices: tiles.map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            isFix: s.isFix,
          })),
          technicians: cards.map((c) => ({ id: c.technicianId, name: c.displayName })),
          fixWindowDays: rules?.fixes.window_days ?? 14,
          fixNeedsApproval: !canApprove && (rules?.fixes.receptionist_needs_approval ?? true),
          groupMax: rules?.groups.max_people ?? 8,
        }}
      />
    </main>
  );
}

/** A request hold in the desk's shape: minutes and a clock time, no ids. */
function holdOf(
  h:
    | {
        technicianName: string;
        status: string;
        detail?: string;
        since: Date | null;
        nextAppointmentAt: Date | null;
        waitedMin: number;
        attention: boolean;
      }
    | undefined,
  now: Date,
  clock: Intl.DateTimeFormat,
) {
  if (!h) return null;
  return {
    technicianName: h.technicianName,
    why: h.status,
    ...(h.detail ? { detail: h.detail } : {}),
    forMinutes: h.since
      ? Math.max(0, Math.floor((now.getTime() - h.since.getTime()) / 60_000))
      : null,
    nextAppointment: h.nextAppointmentAt ? clock.format(h.nextAppointmentAt) : null,
    waitedMin: h.waitedMin,
    attention: h.attention,
  };
}
