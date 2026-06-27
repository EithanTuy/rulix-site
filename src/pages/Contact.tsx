// Contact.tsx - demo-request landing with direct lead handoff.

import { ArrowRight, Check, Mail, Phone, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

const EMAIL = "security@rulix.cloud";
const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF =
  `mailto:${EMAIL}?subject=Rulix%20memo%20audit` +
  `&body=Work%20email%3A%0ACompany%3A%0ARole%3A%0AExpected%20monthly%20memo%20volume%3A%0ACan%20use%20a%20public%20or%20sanitized%20sample%3F%20Yes%2FNo%0A%0AWhat%20review%20workflow%20should%20Rulix%20help%20with%3F%0A`;

const DETAILS = [
  "Work email and company",
  "Your review role",
  "Expected monthly memo volume",
  "Whether a public or sanitized sample is available",
];

export function Contact() {
  return (
    <section className="section-white">
      <div className="wrap grid gap-12 py-16 lg:grid-cols-[1fr_0.78fr] lg:items-start lg:py-24">
        <div className="reveal">
          <span className="section-label text-accent">Contact</span>
          <h1 className="mt-4 max-w-[11ch] text-[clamp(44px,6.6vw,78px)] leading-none">
            Bring a sanitized memo.
          </h1>
          <p className="mt-6 max-w-[58ch] text-[18px] leading-8 text-text-2">
            Send your company, role, review volume, and whether you have a public or sanitized memo sample. We will use the first conversation to show how Rulix finds gaps without treating its output as a final determination.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={MAIL_HREF} className="btn primary lg">
              Email the audit request
              <ArrowRight size={17} />
            </a>
            <Link to="/security" className="btn lg">
              Review data boundary
            </Link>
          </div>
        </div>

        <div className="contact-panel reveal" style={{ transitionDelay: "80ms" }}>
          <div className="contact-card dark">
            <ShieldCheck size={24} />
            <h2>Start with approved material only</h2>
            <p>
              Please do not send CUI, ITAR technical data, controlled technical data, classified information, or third-party proprietary specifications unless an approved deployment boundary is in place.
            </p>
          </div>

          <a href={MAIL_HREF} className="contact-card link-card">
            <Mail size={22} />
            <span>
              <small>Email</small>
              <strong>{EMAIL}</strong>
            </span>
            <ArrowRight size={16} />
          </a>

          <a href={`tel:${PHONE_TEL}`} className="contact-card link-card">
            <Phone size={22} />
            <span>
              <small>Phone</small>
              <strong>{PHONE_DISPLAY}</strong>
            </span>
            <ArrowRight size={16} />
          </a>
        </div>
      </div>

      <div className="wrap border-t border-line-soft pb-20 pt-10">
        <div className="grid gap-6 lg:grid-cols-[0.5fr_1fr]">
          <h2 className="text-[28px] leading-tight">What to include</h2>
          <div className="detail-grid">
            {DETAILS.map((item) => (
              <div key={item} className="detail-item">
                <Check size={16} />
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
