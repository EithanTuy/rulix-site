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
    title: "Rulix - Defensible export-control memo review",
    description:
      "Rulix checks classification memos for missing thresholds, weak evidence, and reviewer questions before human export-control reviewers sign off.",
    h1: "Defensible export-control memo review.",
    body:
      "Rulix checks classification memos for missing thresholds, weak evidence, and reviewer questions before your human reviewer signs off.",
  },
  "memo-review": {
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for evidence gaps, missing technical thresholds, reviewer questions, and audit-ready signoff.",
    h1: "Export-control memo review software.",
    body:
      "Turn raw classification drafts into reviewer-ready packets with evidence gaps, source questions, readiness scoring, and a human signoff trail.",
  },
  "eccn-assistant": {
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN classification review, evidence gaps, and human signoff without replacing expert judgment.",
    h1: "ECCN classification assistant for reviewers.",
    body:
      "Rulix helps reviewers separate classification facts from unsupported conclusions, then produce the next questions needed for a defensible ECCN review.",
  },
  "ai-review": {
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI decision support to spot export-control memo gaps while keeping final determinations with trained human reviewers.",
    h1: "AI export-compliance review with human signoff.",
    body:
      "Use AI decision support to spot missing facts and weak evidence while keeping final export-control determinations with trained human reviewers.",
  },
  university: {
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities and research operations triage public or sanitized export-control memo drafts before empowered officials spend review time.",
    h1: "Export-control review support for universities.",
    body:
      "Help research offices triage public or sanitized memo drafts before empowered officials and counsel spend scarce review time.",
  },
  manufacturer: {
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce back-and-forth on ECCN memo evidence, product specifications, and reviewer-ready questions.",
    h1: "ECCN review packets for manufacturers and labs.",
    body:
      "Reduce back-and-forth on product specs by surfacing the thresholds, facts, and reviewer-ready questions that block a classification memo.",
  },
};

const AUDIT_ROWS = [
  {
    area: "Technical threshold",
    gap: "ADC sample rate is asserted but not tied to a cited CCL threshold.",
    question: "Confirm the maximum sample rate per channel and aggregate rate.",
    priority: "High",
  },
  {
    area: "Evidence support",
    gap: "EAR99 conclusion is not supported by the quoted source text.",
    question: "Add the specific paragraph that excludes 3A001 coverage.",
    priority: "High",
  },
  {
    area: "Human signoff",
    gap: "Reviewer rationale is missing the uncertainty note.",
    question: "Record whether the classification is accepted or needs facts.",
    priority: "Review",
  },
];

const USE_CASES = [
  {
    icon: Landmark,
    title: "Export-control officers",
    body: "See weak memo claims before signoff, keep the reviewer of record visible, and preserve the audit trail.",
    outcome: "Cleaner packets before counsel or empowered officials spend time.",
  },
  {
    icon: FlaskConical,
    title: "Manufacturers and labs",
    body: "Reduce product-spec back-and-forth by turning missing facts into precise engineering questions.",
    outcome: "Fewer unsupported EAR99 and ECCN assertions.",
  },
  {
    icon: GraduationCap,
    title: "Universities and research ops",
    body: "Triage public or sanitized drafts before formal review, without moving controlled data into the hosted pilot.",
    outcome: "Faster early review without relaxing data boundaries.",
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
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/contact" className="btn primary lg">
              Book a 20-minute memo audit
              <ArrowRight size={17} />
            </Link>
            <a href="#sample" className="btn lg">See sample output</a>
          </div>
          <p className="footnote mt-6 flex max-w-[60ch] items-start gap-2">
            <ShieldCheck size={15} className="mt-0.5 flex-none text-ok" />
            Decision support only. Human reviewers decide. Hosted pilot is for public,
            sanitized, or explicitly approved material.
          </p>
        </div>

        <div className="reveal vis">
          <div className="panel overflow-hidden bg-panel shadow-lg">
            <div className="grid gap-0 border-b border-line-soft bg-raised px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <strong className="text-[13px]">Memo audit packet</strong>
              <span className="chip ok">reviewer-ready draft</span>
            </div>
            <img
              src="/marketing/rulix-audit-product.png"
              alt="Rulix sample audit output showing readiness, evidence gaps, and reviewer questions"
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
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Proof you can inspect, not a vague demo claim.</h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            Rulix turns a memo into a review packet: readiness score, concrete blockers,
            official-source questions, and a decision trail for the reviewer of record.
          </p>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[260px_1fr]">
          <div className="reveal panel grid content-center gap-3 p-6">
            <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-text-3">Readiness</span>
            <strong className="font-mono text-[78px] leading-none text-warn">42%</strong>
            <p className="m-0 text-[13px] text-text-2">
              Blocked until the technical thresholds and source support are tightened.
            </p>
          </div>

          <div className="reveal overflow-hidden border border-line-soft bg-bg" style={{ transitionDelay: "80ms" }}>
            <div className="grid gap-3 bg-ink px-4 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-white/80 md:grid-cols-[0.8fr_1.2fr_1.2fr_90px]">
              <span>Area</span>
              <span>Gap found</span>
              <span>Reviewer question</span>
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
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section id="use-cases" className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="reveal max-w-[68ch]">
          <span className="eyebrow">Use cases</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Built for teams whose decisions get audited.</h2>
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
      </div>
    </section>
  );
}

function ComplianceBoundary() {
  const items = [
    ["Decision support only", "Rulix refuses to act as the final ECCN, license, sanctions, or jurisdiction authority."],
    ["Hosted pilot boundary", "Use public, sanitized, sample, or approved text only in the commercial hosted environment."],
    ["Approved lanes available", "GovCloud or customer-controlled deployment can be scoped for controlled technical data discussions."],
  ];

  return (
    <section className="border-b border-line-soft bg-ink text-white">
      <div className="wrap grid gap-10 py-20 lg:grid-cols-[0.8fr_1fr] lg:items-center">
        <div className="reveal">
          <span className="eyebrow !text-white/60">Compliance boundary</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)] text-white">Clear constraints make the product more credible.</h2>
          <p className="mt-4 max-w-[54ch] text-[15px] text-white/70">
            Rulix is designed to help the reviewer ask sharper questions, not to replace the
            reviewer or quietly relax the data boundary.
          </p>
          <Link to="/security" className="btn mt-7 !border-white/25 !bg-transparent !text-white hover:!border-white/60">
            Read security overview
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
  const subject = encodeURIComponent("Rulix 20-minute memo audit");
  const body = encodeURIComponent(
    "Work email:\nCompany:\nRole:\nExpected monthly memo volume:\nCan use a public/sanitized sample? Yes/No\n\nWhat review workflow should Rulix help with?\n",
  );

  return (
    <section id="lead" className="border-b border-line-soft bg-panel">
      <div className="wrap grid gap-10 py-20 lg:grid-cols-[0.9fr_0.75fr] lg:items-center">
        <div className="reveal">
          <span className="eyebrow">Lead magnet</span>
          <h2 className="text-[clamp(28px,3.8vw,44px)]">Bring a sanitized memo. Leave with the gaps.</h2>
          <p className="mt-4 max-w-[60ch] text-[15.5px] text-text-2">
            The cleanest first conversation is a short audit on a public or sanitized memo sample.
            We will show the readiness score, evidence gaps, and reviewer questions Rulix would hand back.
          </p>
          <div className="mt-6 flex max-w-[62ch] gap-3 border border-warn/40 bg-warn-soft p-4 text-[13px] text-text-2">
            <AlertTriangle size={18} className="mt-0.5 flex-none text-warn" />
            Do not send controlled technical data, CUI, ITAR technical data, classified material,
            or third-party proprietary specifications unless an approved deployment boundary is in place.
          </div>
        </div>

        <div className="reveal panel p-6" style={{ transitionDelay: "80ms" }}>
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center bg-accent-soft text-accent">
              <Mail size={19} />
            </span>
            <div>
              <h3 className="text-[18px]">Book a memo audit</h3>
              <p className="m-0 text-[12.5px] text-text-3">Opens an email template with the right questions.</p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 text-[13px] text-text-2">
            {["Work email", "Company", "Role", "Expected review volume", "Sample memo availability"].map((label) => (
              <div key={label} className="flex items-center gap-2 border border-line-soft bg-raised px-3 py-2">
                <ClipboardCheck size={15} className="text-accent" />
                {label}
              </div>
            ))}
          </div>
          <a href={`mailto:security@rulix.cloud?subject=${subject}&body=${body}`} className="btn primary mt-6 w-full justify-center">
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
          <h2 className="text-[clamp(24px,3vw,34px)]">Export-control review topics</h2>
        </div>
        <div className="mt-8 grid gap-3 md:grid-cols-5">
          {SEO_LINKS.map(([label, href]) => (
            <Link key={href} to={href} className="reveal border border-line-soft bg-panel p-4 text-[13px] font-semibold leading-5 text-text-1 transition-colors hover:border-accent">
              <FileText size={18} className="mb-4 text-accent" />
              {label}
            </Link>
          ))}
        </div>
        <p className="footnote mt-8 flex items-start gap-2">
          <Lock size={14} className="mt-0.5 flex-none" />
          Public site content is informational and does not create legal advice or export-control determinations.
        </p>
      </div>
    </section>
  );
}
