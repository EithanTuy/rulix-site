// Home.tsx - public marketing landing page and SEO landing variants.

import { useEffect } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  FlaskConical,
  GraduationCap,
  Landmark,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";

export type LandingVariant =
  | "default"
  | "memo-review"
  | "eccn-assistant"
  | "ai-review"
  | "university"
  | "manufacturer";

const META: Record<LandingVariant, { title: string; description: string; h1: string; body: string }> = {
  default: {
    title: "Rulix — Export control memo review",
    description:
      "Rulix reads your export control memo and flags the gaps before your reviewer signs off. You make the final call.",
    h1: "Export control memos reviewed before your expert signs off.",
    body:
      "Rulix reads your memo and flags the gaps — missing facts, weak claims, and questions your reviewer will ask. You make the final call.",
  },
  "memo-review": {
    title: "Export control memo review software | Rulix",
    description:
      "Find gaps in export control memos before your reviewer does. Missing thresholds, weak evidence, and audit-ready signoff.",
    h1: "Find the gaps in your export control memos.",
    body:
      "Paste a memo, get a prioritized list of missing facts, weak claims, and the questions your reviewer needs answered.",
  },
  "eccn-assistant": {
    title: "ECCN review support for export control teams | Rulix",
    description:
      "Rulix helps export control teams separate what the memo actually proves from what it just asserts.",
    h1: "ECCN review support for export control teams.",
    body:
      "Rulix separates what the memo actually proves from what it just asserts, then builds the question list your reviewer needs.",
  },
  "ai-review": {
    title: "AI export control review with human signoff | Rulix",
    description:
      "AI spots the gaps in your classification memo. Your licensed reviewer makes the final call.",
    h1: "AI spots the gaps. Your reviewer makes the call.",
    body:
      "Upload a classification memo. Rulix flags the weak evidence and missing thresholds. Your licensed reviewer decides.",
  },
  university: {
    title: "University export control memo review | Rulix",
    description:
      "Screen public or sanitized memos before they reach your licensed reviewer.",
    h1: "Export control review support for university teams.",
    body:
      "Screen public or sanitized memos before they reach your licensed reviewer. Keep the workload manageable without relaxing your data rules.",
  },
  manufacturer: {
    title: "ECCN memo review for manufacturers and labs | Rulix",
    description:
      "Stop back-and-forth on product specs. Rulix turns vague blockers into specific questions your team can answer.",
    h1: "Get your ECCN memo ready before it reaches legal review.",
    body:
      "Stop the back-and-forth on product specs. Rulix turns vague blockers into specific questions your team can actually answer.",
  },
};

const AUDIT_ROWS = [
  {
    area: "Technical threshold",
    gap: "Sample rate is listed but not checked against the CCL limit.",
    question: "What is the maximum sample rate per channel and total?",
    priority: "High",
  },
  {
    area: "Source support",
    gap: "The EAR99 call isn't backed by the text you quoted.",
    question: "Add the exact sentence that rules out 3A001.",
    priority: "High",
  },
  {
    area: "Reviewer decision",
    gap: "No rationale on record for the reviewer's final call.",
    question: "Is this classification accepted, or does more evidence need to come in?",
    priority: "Review",
  },
];

const USE_CASES = [
  {
    icon: Landmark,
    title: "Export control officers",
    body: "Spot the weak claims before you sign off. Every decision stays on the record.",
    outcome: "Tighter memos before they reach legal review.",
  },
  {
    icon: FlaskConical,
    title: "Manufacturers and labs",
    body: "Stop the back-and-forth. Turn vague requests into specific questions your engineering team can answer.",
    outcome: "Fewer unsupported classification calls.",
  },
  {
    icon: GraduationCap,
    title: "Universities and research offices",
    body: "Pre-screen public or sanitized memos before they reach your licensed reviewer.",
    outcome: "Faster triage. Same data rules.",
  },
];

const SEO_LINKS = [
  ["Export-control memo review", "/export-control-memo-review"],
  ["ECCN classification assistant", "/eccn-classification-assistant"],
  ["AI export-compliance review", "/ai-export-compliance-review"],
  ["University export-control review", "/university-export-control-review"],
  ["Manufacturer ECCN review", "/manufacturer-eccn-review"],
];

export function Home({ variant = "default" }: { variant?: LandingVariant }) {
  const meta = META[variant];
  usePageMeta(meta.title, meta.description);

  return (
    <>
      <Hero meta={meta} />
      <SampleAudit />
      <UseCases />
      <ComplianceBoundary />
      <LeadSection />
      <SeoSection />
    </>
  );
}

function usePageMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (meta) meta.content = description;
  }, [title, description]);
}

function Hero({ meta }: { meta: (typeof META)[LandingVariant] }) {
  return (
    <section className="hero-bg border-b border-line-soft">
      <div className="wrap grid items-center gap-12 py-16 lg:grid-cols-[0.9fr_1.1fr] lg:py-20">
        <div>
          <h1 className="max-w-[12ch] text-[clamp(40px,6vw,76px)] leading-[0.96] tracking-[-0.02em]">
            {meta.h1}
          </h1>
          <p className="mt-6 max-w-[56ch] text-[17px] leading-8 text-text-2">
            {meta.body}
          </p>
          <div className="mt-8">
            <Link to="/contact" className="btn primary lg">
              Book a memo audit
              <ArrowRight size={17} />
            </Link>
          </div>
          <p className="mt-5 text-[13px] text-text-3">
            or{" "}
            <a href="#sample" className="underline hover:text-text-2">
              see a sample audit first
            </a>
          </p>
          <p className="footnote mt-5 flex max-w-[56ch] items-start gap-2">
            <ShieldCheck size={15} className="mt-0.5 flex-none text-ok" />
            AI helps. Your reviewer decides. Hosted version is for public or sanitized memos only.
          </p>
        </div>

        <div className="reveal vis">
          <div className="panel overflow-hidden bg-panel shadow-lg">
            <div className="grid gap-0 border-b border-line-soft bg-raised px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <strong className="text-[13px]">Sample audit packet</strong>
              <span className="chip ok">ready for reviewer</span>
            </div>
            <img
              src="/marketing/rulix-audit-product.png"
              alt="Rulix sample audit output showing readiness score, evidence gaps, and reviewer questions"
              className="block aspect-video w-full object-cover"
            />
            <div className="grid gap-3 border-t border-line-soft p-4 sm:grid-cols-3">
              {["Evidence gaps", "Source questions", "Human signoff"].map((label) => (
                <div key={label} className="flex items-center gap-2 text-[12.5px] font-semibold text-text-2">
                  <CheckCircle2 size={16} className="text-ok" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SampleAudit() {
  return (
    <section id="sample" className="border-b border-line-soft bg-panel">
      <div className="wrap py-20">
        <div className="reveal max-w-[68ch]">
          <span className="eyebrow">Sample audit output</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Here's what a Rulix audit looks like.</h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            You get a readiness score, a table of gaps, and the exact questions your reviewer
            needs answered — not a list of vague suggestions.
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[260px_1fr]">
          <div className="reveal panel grid content-center gap-3 p-6">
            <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-text-3">Readiness score</span>
            <strong className="font-mono text-[78px] leading-none text-warn">42%</strong>
            <p className="m-0 text-[13px] text-text-2">
              Blocked until the missing thresholds and source support are filled in.
            </p>
          </div>

          <div className="reveal overflow-hidden border border-line-soft bg-bg" style={{ transitionDelay: "80ms" }}>
            <div className="grid gap-3 bg-ink px-4 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-white/80 md:grid-cols-[0.8fr_1.2fr_1.2fr_90px]">
              <span>Area</span>
              <span>Gap found</span>
              <span>Question for reviewer</span>
              <span>Priority</span>
            </div>
            {AUDIT_ROWS.map((row) => (
              <div key={row.area} className="grid gap-2 border-t border-line-soft px-4 py-4 text-[13px] text-text-2 md:grid-cols-[0.8fr_1.2fr_1.2fr_90px]">
                <strong className="text-text-1">{row.area}</strong>
                <span>{row.gap}</span>
                <span>{row.question}</span>
                <span className={row.priority === "High" ? "chip warn w-max" : "chip w-max"}>{row.priority}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="reveal mt-10 text-center" style={{ transitionDelay: "120ms" }}>
          <Link to="/contact" className="btn primary lg">
            Book a free audit
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section id="use-cases" className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="reveal max-w-[68ch]">
          <span className="eyebrow">Who uses it</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Built for teams that need to show their work.</h2>
        </div>
        <div className="mt-10 divide-y divide-line-soft border-y border-line-soft">
          {USE_CASES.map((item, index) => (
            <div key={item.title} className="reveal grid gap-5 py-8 md:grid-cols-[70px_1fr_0.45fr] md:items-center" style={{ transitionDelay: `${index * 70}ms` }}>
              <span className="grid size-12 place-items-center bg-accent-soft text-accent">
                <item.icon size={22} />
              </span>
              <div>
                <h3 className="text-[22px]">{item.title}</h3>
                <p className="m-0 mt-2 max-w-[76ch] text-[14.5px] text-text-2">{item.body}</p>
              </div>
              <strong className="text-[14px] leading-6 text-text-1">{item.outcome}</strong>
            </div>
          ))}
        </div>

        <div className="reveal mt-10 text-center" style={{ transitionDelay: "120ms" }}>
          <Link to="/contact" className="btn lg">
            See if Rulix fits your workflow
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

function ComplianceBoundary() {
  const items = [
    [
      "AI helps. You decide.",
      "Rulix will never be the final word on ECCN classification, export licenses, or jurisdiction. A qualified human reviewer always makes the call.",
    ],
    [
      "Use approved content only.",
      "The hosted version is for public, sanitized, or explicitly approved memos. Don't put controlled technical data, CUI, or ITAR material into it.",
    ],
    [
      "Need more control?",
      "We can deploy in your own environment for workflows that involve sensitive or controlled technical data.",
    ],
  ];

  return (
    <section className="border-b border-line-soft bg-ink text-white">
      <div className="wrap grid gap-10 py-20 lg:grid-cols-[0.8fr_1fr] lg:items-center">
        <div className="reveal">
          <span className="eyebrow !text-white/60">What Rulix won't do</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)] text-white">Rulix never replaces your reviewer.</h2>
          <p className="mt-4 max-w-[54ch] text-[15px] text-white/70">
            We built Rulix to help reviewers ask better questions — not to quietly take over
            their job or soften the data boundary.
          </p>
          <Link to="/security" className="btn mt-7 !border-white/25 !bg-transparent !text-white hover:!border-white/60">
            Security and data policy
          </Link>
        </div>
        <div className="reveal grid gap-4" style={{ transitionDelay: "80ms" }}>
          {items.map(([title, body]) => (
            <div key={title} className="grid grid-cols-[auto_1fr] gap-3 border border-white/15 bg-white/5 p-4">
              <ShieldCheck size={18} className="mt-1 text-ok" />
              <div>
                <strong className="text-[15px] text-white">{title}</strong>
                <p className="m-0 mt-1 text-[13.5px] text-white/72">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LeadSection() {
  const subject = encodeURIComponent("Rulix memo audit request");
  const body = encodeURIComponent(
    "Work email:\nOrganization:\nRole:\nApprox. monthly memo volume:\nCan you share a public or sanitized sample? Yes / No\n\nWhat review workflow are you trying to speed up?\n",
  );

  return (
    <section id="lead" className="border-b border-line-soft bg-panel">
      <div className="wrap grid gap-10 py-20 lg:grid-cols-[0.9fr_0.75fr] lg:items-center">
        <div className="reveal">
          <span className="eyebrow">Try it</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Bring a memo. Walk away with the gaps.</h2>
          <p className="mt-4 max-w-[60ch] text-[15.5px] text-text-2">
            The easiest way to see Rulix in action is a short audit on one of your own public
            or sanitized memos. We'll show you the readiness score, the gaps, and the questions
            your reviewer would ask.
          </p>
          <div className="mt-6 flex max-w-[62ch] gap-3 border border-warn/40 bg-warn-soft p-4 text-[13px] text-text-2">
            <AlertTriangle size={18} className="mt-0.5 flex-none text-warn" />
            Don't send controlled technical data, CUI, ITAR material, or classified information
            unless you have an approved setup in place.
          </div>
        </div>

        <div className="reveal panel p-6" style={{ transitionDelay: "80ms" }}>
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center bg-accent-soft text-accent">
              <Mail size={19} />
            </span>
            <div>
              <h3 className="text-[18px]">Book a memo audit</h3>
              <p className="m-0 text-[12.5px] text-text-3">We'll reply with a time and a short intake form.</p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 text-[13px] text-text-2">
            {["Work email", "Organization", "Your role", "Memo volume per month", "Sample memo available"].map((label) => (
              <div key={label} className="flex items-center gap-2 border border-line-soft bg-raised px-3 py-2">
                <ClipboardCheck size={15} className="text-accent" />
                {label}
              </div>
            ))}
          </div>
          <a
            href={`mailto:security@rulix.cloud?subject=${subject}&body=${body}`}
            className="btn primary mt-6 w-full justify-center"
          >
            Start by email
          </a>
        </div>
      </div>
    </section>
  );
}

function SeoSection() {
  return (
    <section className="bg-bg">
      <div className="wrap py-16">
        <div className="reveal">
          <h2 className="text-[clamp(24px,3vw,34px)]">Export control review topics</h2>
        </div>
        <div className="mt-8 grid gap-3 md:grid-cols-5">
          {SEO_LINKS.map(([label, href]) => (
            <Link
              key={href}
              to={href}
              className="reveal border border-line-soft bg-panel p-4 text-[13px] font-semibold leading-5 text-text-1 transition-colors hover:border-accent"
            >
              <FileText size={18} className="mb-4 text-accent" />
              {label}
            </Link>
          ))}
        </div>
        <p className="footnote mt-8 flex items-start gap-2">
          <Lock size={14} className="mt-0.5 flex-none" />
          Content on this site is for information only. It is not legal advice and does not constitute an export control determination.
        </p>
      </div>
    </section>
  );
}
