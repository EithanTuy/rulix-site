// Contact.tsx - demo-request landing with direct lead handoff.

import { Mail, Phone } from "lucide-react";

const EMAIL = "security@rulix.cloud";
const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF =
  `mailto:${EMAIL}?subject=Rulix%20memo%20audit%20request` +
  `&body=Work%20email%3A%0AOrganization%3A%0ARole%3A%0AApprox.%20memo%20volume%20per%20month%3A%0ASample%20memo%20available%3F%20Yes%20%2F%20No%0A%0AWhat%20review%20workflow%20are%20you%20trying%20to%20speed%20up%3F%0A`;

export function Contact() {
  return (
    <section>
      <div className="wrap max-w-[68ch] py-20">
        <h1 className="text-[clamp(30px,4vw,44px)]">Book a memo audit.</h1>
        <p className="mt-5 text-[16px] text-text-2">
          Send a quick note with your organization, role, expected review volume, and whether
          you have a public or sanitized memo we can walk through together.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <a href={MAIL_HREF} className="panel flex items-center gap-4 p-5 transition-colors hover:border-accent">
            <span className="grid size-11 flex-none place-items-center bg-accent-soft text-accent">
              <Mail size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11.5px] uppercase tracking-[0.1em] text-text-3">Email</span>
              <span className="block truncate text-[15px] font-semibold">{EMAIL}</span>
            </span>
          </a>

          <a href={`tel:${PHONE_TEL}`} className="panel flex items-center gap-4 p-5 transition-colors hover:border-accent">
            <span className="grid size-11 flex-none place-items-center bg-accent-soft text-accent">
              <Phone size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11.5px] uppercase tracking-[0.1em] text-text-3">Phone</span>
              <span className="block text-[15px] font-semibold">{PHONE_DISPLAY}</span>
            </span>
          </a>
        </div>

        <p className="footnote mt-10">
          Please do not send CUI, ITAR technical data, classified information, or third-party
          proprietary specifications unless an approved deployment boundary is in place.
        </p>
      </div>
    </section>
  );
}
