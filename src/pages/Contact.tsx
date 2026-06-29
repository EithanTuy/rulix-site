// Contact.tsx - demo-request landing with direct lead handoff.

import { Mail, Phone } from "lucide-react";
import { CONTACT_EMAIL_DISPLAY, createContactMailto } from "../lib/contact";

const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF = createContactMailto(
  "Rulix access request",
  "Work email:\nOrganization:\nRole:\nApprox. memo volume per month:\nSample memo available? Yes / No\n\nWhat review workflow are you trying to clean up?\n",
);

export function Contact() {
  return (
    <section>
      <div className="wrap max-w-[68ch] py-20">
        <h1 className="text-[clamp(30px,4vw,44px)]">Request Rulix access.</h1>
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
              <span className="block truncate text-[15px] font-semibold">{CONTACT_EMAIL_DISPLAY}</span>
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
