// Contact.tsx - demo-request landing with direct lead handoff.

import { Mail, Phone } from "lucide-react";

const EMAIL = "security@rulix.cloud";
const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF =
  `mailto:${EMAIL}?subject=Rulix%2020-minute%20memo%20audit` +
  `&body=Work%20email%3A%0ACompany%3A%0ARole%3A%0AExpected%20monthly%20memo%20volume%3A%0ACan%20use%20a%20public%20or%20sanitized%20sample%3F%0A%0AWhat%20review%20workflow%20should%20Rulix%20help%20with%3F%0A`;

export function Contact() {
  return (
    <section>
      <div className="wrap max-w-[78ch] py-20">
        <span className="eyebrow">Contact</span>
        <h1 className="text-[clamp(30px,4vw,44px)]">Book a 20-minute memo audit.</h1>
        <p className="mt-5 text-[16px] text-text-2">
          Send a quick note with your company, role, review volume, and whether you have a public
          or sanitized memo sample we can walk through.
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

        <div className="mt-10 border border-line-soft bg-panel p-6">
          <h2 className="text-[18px]">What to include</h2>
          <ul className="m-0 mt-4 grid gap-2 p-0 text-[14px] text-text-2 sm:grid-cols-2">
            {[
              "Work email and company",
              "Your review role",
              "Expected memo volume",
              "A public or sanitized sample path",
            ].map((item) => (
              <li key={item} className="list-none border border-line-soft bg-raised px-3 py-2">{item}</li>
            ))}
          </ul>
        </div>

        <p className="footnote mt-8">
          Please do not send CUI, ITAR technical data, controlled technical data, classified
          information, or third-party proprietary specifications unless an approved deployment
          boundary is in place.
        </p>
      </div>
    </section>
  );
}
