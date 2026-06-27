// Security.tsx - due-diligence page for data handling, guardrails, and scope.

import { Ban, FileWarning, KeyRound, Scale, ServerCog, ShieldCheck } from "lucide-react";

const ITEMS = [
  {
    icon: FileWarning,
    title: "Input scope is the first control",
    body: "Rulix is designed for sanitized, public, or explicitly approved text. CUI, ITAR technical data, controlled technical data, and proprietary specifications must not be submitted to hosted models.",
  },
  {
    icon: KeyRound,
    title: "Keys never leave the server",
    body: "Hosted LLM calls run server-side only. API keys are environment configuration on the backend. They are never embedded in, or returned to, browser JavaScript.",
  },
  {
    icon: ServerCog,
    title: "Deterministic checks are independent",
    body: "Citation validation and routing-risk rules run as deterministic code, not model output. If the model is unavailable, the deterministic engine carries the audit as a labeled fallback.",
  },
  {
    icon: Ban,
    title: "Final determinations are refused by design",
    body: "Requests for a final ECCN, license decision, sanctions ruling, or jurisdiction determination are refused at the application layer. This is part of the product contract.",
  },
  {
    icon: Scale,
    title: "Human reviewer of record",
    body: "Every case ends in a human disposition. Rulix output is decision support: readiness, gaps, candidates, and sources. The reviewer of record is responsible for the decision.",
  },
  {
    icon: ShieldCheck,
    title: "Demo mode is local",
    body: "The demo console runs an in-browser heuristic engine on sample data. Nothing leaves the page, which keeps early evaluation simple.",
  },
];

export function Security() {
  return (
    <section>
      <div className="security-band">
        <div className="wrap grid gap-10 py-20 lg:grid-cols-[0.8fr_1fr] lg:items-end lg:py-24">
          <div className="reveal">
            <span className="section-label text-accent">Security & data handling</span>
            <h1 className="mt-4 max-w-[12ch] text-[clamp(42px,6.2vw,76px)] leading-none text-white">
              Built for a domain where the input is the risk.
            </h1>
          </div>
          <p className="reveal m-0 max-w-[58ch] text-[18px] leading-8 text-white/68" style={{ transitionDelay: "80ms" }}>
            Export-control review software has to be explicit about data boundaries. These are guardrails Rulix ships with as architectural decisions, not fine print.
          </p>
        </div>
      </div>

      <div className="wrap py-20 lg:py-24">
        <div className="security-grid">
          {ITEMS.map((item, index) => (
            <article key={item.title} className="security-item reveal" style={{ transitionDelay: `${index * 50}ms` }}>
              <span>
                <item.icon size={22} />
              </span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </article>
          ))}
        </div>

        <div className="prototype-note reveal">
          <h2>Current status: research-grade prototype</h2>
          <p>
            Rulix has not completed a third-party security audit and should be evaluated on sanitized or public data only. If your evaluation requires processing controlled information, talk to us about an approved compute lane first.
          </p>
        </div>
      </div>
    </section>
  );
}
