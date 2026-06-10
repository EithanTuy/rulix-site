// Security.tsx — the buyer's due-diligence page: data handling, guardrails, scope.

import { Ban, FileWarning, KeyRound, Scale, ServerCog, ShieldCheck } from "lucide-react";

const ITEMS = [
  {
    icon: FileWarning,
    title: "Input scope is the first control",
    body: "Rulix is designed for sanitized, public, or explicitly approved text. CUI, ITAR technical data, controlled technical data, and proprietary specifications must not be submitted to hosted models. The intake screens state this clearly.",
  },
  {
    icon: KeyRound,
    title: "Keys never leave the server",
    body: "Hosted LLM calls run server-side only. API keys are environment configuration on the backend — they are never embedded in, or returned to, browser JavaScript. The frontend-config endpoint exposes capability flags, not secrets.",
  },
  {
    icon: ServerCog,
    title: "Deterministic checks are independent",
    body: "Citation validation and routing-risk rules run as deterministic code, not model output. When the model is unavailable or unconfigured, the deterministic engine carries the audit as a fallback — clearly labeled as such.",
  },
  {
    icon: Ban,
    title: "Final determinations are refused by design",
    body: "Requests for a final ECCN, license decision, sanctions ruling, or jurisdiction determination are refused at the application layer. This is not a prompt suggestion — it is the product's contract.",
  },
  {
    icon: Scale,
    title: "Human reviewer of record",
    body: "Every case ends in a human disposition. Rulix's output is decision support: readiness, gaps, candidates, and sources. The reviewer's recorded decision — with the full trail — is the artifact.",
  },
  {
    icon: ShieldCheck,
    title: "Demo mode is fully local",
    body: "The demo console runs an in-browser heuristic engine on sample data. Nothing leaves the page — useful for evaluation without any data-handling questions at all.",
  },
];

export function Security() {
  return (
    <section>
      <div className="wrap py-20">
        <div className="max-w-[62ch]">
          <span className="eyebrow">Security &amp; data handling</span>
          <h1 className="text-[clamp(30px,4vw,42px)]">Built for a domain where the input is the risk.</h1>
          <p className="mt-5 text-[15.5px] text-text-2">
            Export-control review software has to be paranoid about its own inputs. These are the
            guardrails Rulix ships with — architectural decisions, not configuration options.
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {ITEMS.map((it) => (
            <div key={it.title} className="panel p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-9 flex-none place-items-center bg-accent-soft text-accent">
                  <it.icon size={18} />
                </span>
                <h2 className="text-[16.5px]">{it.title}</h2>
              </div>
              <p className="m-0 mt-3 text-[14px] text-text-2">{it.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 border border-warn/40 bg-warn-soft p-6">
          <h2 className="text-[16px] text-warn">Current status: research-grade prototype</h2>
          <p className="m-0 mt-2 max-w-[80ch] text-[14px] text-text-2">
            Rulix is an early-stage prototype. It has not completed a third-party security audit, and
            should be evaluated on sanitized or public data only. If your evaluation requires
            processing controlled information, talk to us about an approved compute lane first — do
            not submit it to the hosted service.
          </p>
        </div>
      </div>
    </section>
  );
}
