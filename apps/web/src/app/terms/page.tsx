import type { Metadata } from 'next';
import { LegalPage } from '../legal/Legal';

export const metadata: Metadata = { title: 'Terms (draft)', robots: { index: false } };

// DRAFT for attorney review (Part 10). Describes what the product does; the
// legal terms themselves are placeholders in brackets.
export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>
        These terms are between [legal name of the company that owns the product] (&quot;we&quot;)
        and the salon that signs up (&quot;the salon&quot;), and cover everyone the salon invites:
        owners, managers, receptionists and technicians.
      </p>
      <h2>What the product does</h2>
      <p>
        It keeps the salon&apos;s turn list: who is checked in, who is next, and the points each
        technician earns, by the rules the salon&apos;s owner sets. It also offers a customer
        check-in screen, appointment import from a calendar link, and reports.
      </p>
      <h2>The salon&apos;s rules are the salon&apos;s</h2>
      <p>
        The owner chooses the turn rules, the penalties and who may change them. The product applies
        them as set and records every change. Decisions about pay, scheduling and staff remain the
        salon&apos;s. [Attorney: whether turn points used as a pay basis create a wage record, and
        who keeps it.]
      </p>
      <h2>Accounts</h2>
      <ul>
        <li>Accounts are made only through an invite from the salon.</li>
        <li>Each person keeps their own sign-in to themselves.</li>
        <li>The owner can change roles and archive staff at any time.</li>
      </ul>
      <h2>Payment, trial and refunds</h2>
      <p>[Price, billing period, trial terms and refund policy: to be set by the owners.]</p>
      <h2>Availability</h2>
      <p>
        [Service level, if any. Planned maintenance notice. What happens to the floor when the
        connection drops: the iPad shows an offline notice, and taps on its buttons are blocked, not
        queued, so nothing is sent later.]
      </p>
      <h2>Liability</h2>
      <p>[Limitation of liability and warranty disclaimer: attorney to draft.]</p>
      <h2>Ending the service</h2>
      <p>[Notice period, data export, and how long data is kept after the salon leaves.]</p>
      <h2>Governing law</h2>
      <p>[Attorney to confirm.]</p>
      <h2>Contact</h2>
      <p>[Support email.]</p>
    </LegalPage>
  );
}
