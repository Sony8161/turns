import type { Metadata } from 'next';
import { LegalPage } from '../legal/Legal';

export const metadata: Metadata = { title: 'Privacy (draft)', robots: { index: false } };

// DRAFT for attorney review (Part 10). Every statement below describes what
// the code does today (v0.10.0); legal duties are left in brackets.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice">
      <p>
        This notice says what the turn system keeps, why, and who sees it. The salon decides how it
        uses the system; [legal name of the company] runs it for the salon.
      </p>
      <h2>Staff</h2>
      <ul>
        <li>Name, and the phone number or email used to sign in.</li>
        <li>Role and location, skills and any service restrictions the manager sets.</li>
        <li>
          Check-in, break and check-out times, turns, points and penalties, kept in the salon&apos;s
          audit log.
        </li>
        <li>
          When the salon requires on-site check-in: the location the phone reports at check-in, and
          whether it was inside the salon&apos;s area. It is saved in the audit log. [Consent
          wording for location, and whether &quot;Always&quot; permission is used: attorney and
          owner to decide.]
        </li>
      </ul>
      <h2>Customers</h2>
      <ul>
        <li>
          A first name and, if given, a phone number, typed at the desk or on the check-in iPad. A
          number typed on the iPad is kept only with that visit until the desk confirms the customer
          is there.
        </li>
        <li>
          What the desk or the customer says the visit needs: services, and, when asked, woman or
          man, child or adult and an age, so the right technician is called. [Attorney: use of
          gender and children&apos;s data for routing.]
        </li>
        <li>Appointments imported from the salon&apos;s calendar link.</li>
      </ul>
      <h2>Who sees it</h2>
      <ul>
        <li>Each salon sees only its own data; each location only its own, by role.</li>
        <li>Technicians do not see customers&apos; phone numbers.</li>
        <li>The audit log never stores a customer&apos;s name or phone number.</li>
        <li>We do not sell personal information. [Attorney to confirm wording.]</li>
      </ul>
      <h2>How long it is kept</h2>
      <ul>
        <li>
          Customer names and phone numbers: anonymised after a period the salon sets (365 days
          unless changed). [The automatic job is not running yet.]
        </li>
        <li>
          Audit log: 730 days unless the salon sets otherwise. [Enforcement is not running yet.]
        </li>
      </ul>
      <h2>Service providers</h2>
      <p>[Hosting and database providers, with the region data is stored in.]</p>
      <h2>Security and breaches</h2>
      <p>
        Data is behind sign-in and row-level access rules; secrets stay on the server. [What notice
        is given after a breach, and to whom: attorney to draft.]
      </p>
      <h2>Your choices</h2>
      <p>[How a customer or staff member asks to see or delete their data, and the contact.]</p>
    </LegalPage>
  );
}
