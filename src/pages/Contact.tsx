// Contact.tsx — demo-request landing with direct phone + email.

import { Mail, Phone } from "lucide-react";

const EMAIL = "tuyilin2@msu.edu";
const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF =
  `mailto:${EMAIL}?subject=Rulix%20demo%20request` +
  `&body=Organization%3A%0ARole%3A%0AWhat%20does%20your%20review%20workflow%20look%20like%20today%3F%0A`;

export function Contact() {
  return (
    <section>
      <div className="wrap max-w-[68ch] py-20">
        <span className="eyebrow">Contact</span>
        <h1 className="text-[clamp(30px,4vw,44px)]">Request a demo.</h1>
        <p className="mt-5 text-[16px] text-text-2">
          Reach out by email or phone to set up a demo on sample data.
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

        <p className="footnote mt-8">
          Please don&apos;t send CUI, ITAR technical data, or other controlled information in your
          message — use sanitized or public data only.
        </p>
      </div>
    </section>
  );
}
