// Home.tsx - public marketing landing page and SEO landing variants.

import { useEffect } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CircleAlert,
  ClipboardCheck,
  FileCheck2,
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

type Meta = {
  title: string;
  description: string;
  h1: string;
  body: string;
};

const META: Record<LandingVariant, Meta> = {
  default: {
    title: "Rulix - Export-control memo review before audit risk",
    description:
      "Rulix checks export-control classification memos for weak evidence, missing thresholds, and reviewer questions while keeping final decisions with trained humans.",
    h1: "Review export-control memos before they become audit risk.",
    body:
      "Rulix finds weak evidence, missing thresholds, and reviewer questions while keeping final decisions with trained humans.",
  },
  "memo-review": {
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for evidence gaps, missing technical thresholds, reviewer questions, and audit-ready signoff.",
    h1: "Turn export-control drafts into reviewer-ready packets.",
    body:
      "Rulix turns classification drafts into evidence gaps, source questions, readiness notes, and a human signoff trail.",
  },
  "eccn-assistant": {
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN classification review, evidence gaps, and human signoff without replacing expert judgment.",
    h1: "Structure ECCN review without replacing the reviewer.",
    body:
      "Rulix separates classification facts from unsupported conclusions, then gives reviewers the questions needed for a defensible memo.",
  },
  "ai-review": {
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI decision support to spot export-control memo gaps while keeping final determinations with trained human reviewers.",
    h1: "AI-assisted export review with human signoff.",
    body:
      "Rulix uses decision support to spot missing facts and weak evidence while keeping every final export-control decision with trained humans.",
  },
  university: {
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities and research operations triage public or sanitized export-control memo drafts before empowered officials spend review time.",
    h1: "Export-control review support for research teams.",
    body:
      "Help research offices triage public or sanitized memo drafts before empowered officials and counsel spend scarce review time.",
  },
  manufacturer: {
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce back-and-forth on ECCN memo evidence, product specifications, and reviewer-ready questions.",
    h1: "Cleaner ECCN review packets for manufacturers and labs.",
    body:
      "Reduce product-spec back-and-forth by surfacing the thresholds, facts, and reviewer-ready questions that block a classification memo.",
  },
};

const WORKFLOW = [
  {
    step: "01",
    title: "Intake",
    body: "Upload a public or sanitized memo with the source excerpts your reviewer can inspect.",
    detail: "Draft memo",
  },
  {
    step: "02",
    title: "Evidence scan",
    body: "Map claims to requirements, citations, deterministic checks, and missing threshold facts.",
    detail: "ITAR 120.17 / ECCN 3A001",
  },
  {
    step: "03",
    title: "Questions",
    body: "Convert weak claims into precise questions for engineering, counsel, or the reviewer of record.",
    detail: "6 open questions",
  },
  {
    step: "04",
    title: "Signoff",
    body: "Keep Rulix as decision support and record the trained human's disposition.",
    detail: "Reviewer trail",
  },
];

const GAP_ROWS = [
  {
    requirement: "ITAR 120.17",
    gap: "End-use statement missing for item 3",
    severity: "High",
    source: "Sec. 2.1",
  },
  {
    requirement: "ECCN 3A001",
    gap: "Technical specs not attached",
    severity: "High",
    source: "Sec. 3.4",
  },
  {
    requirement: "Record retention",
    gap: "Retention policy not documented",
    severity: "Med",
    source: "Sec. 5.2",
  },
  {
    requirement: "Deemed exports",
    gap: "No TSU training records",
    severity: "Med",
    source: "Sec. 6.1",
  },
  {
    requirement: "License support",
    gap: "Exception rationale is incomplete",
    severity: "Med",
    source: "Sec. 4.2",
  },
];

const USE_CASES = [
  {
    icon: Landmark,
    title: "Export-control officers",
    body: "Review packets that show what changed, what is unsupported, and where a human decision is still required.",
    bullets: ["Consistent reviews across licenses and entities", "Fewer back-and-forths with reviewers", "Evidence you can export and archive"],
  },
  {
    icon: FlaskConical,
    title: "Manufacturers and labs",
    body: "Turn product-spec uncertainty into focused engineering questions before an ECCN memo reaches signoff.",
    bullets: ["Capture the right technical evidence", "Reduce cycle time for approvals", "Maintain institutional knowledge"],
  },
  {
    icon: GraduationCap,
    title: "Universities and research operations",
    body: "Support collaborations and transfer reviews while respecting sponsor and regulatory requirements.",
    bullets: ["Clear questions for sensitive research", "Stronger records for audits and ITAR/EAR", "Protect researchers and your institution"],
  },
];

const BOUNDARIES = [
  {
    title: "Decision support only",
    body: "Rulix provides review structure and gap analysis. Human reviewers decide and sign off.",
  },
  {
    title: "Hosted pilot input boundary",
    body: "Use public, sanitized, sample, or explicitly approved material in the hosted environment.",
  },
  {
    title: "Approved deployment lanes",
    body: "Customer-controlled or approved compute lanes can be scoped before controlled data discussions.",
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
      <Workflow />
      <ProofSection />
      <UseCases />
      <SecurityBand />
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

function Hero({ meta }: { meta: Meta }) {
  return (
    <section className="hero-stage border-b border-line-soft">
      <div className="wrap grid min-h-[720px] items-center gap-12 py-10 lg:grid-cols-[0.9fr_1.1fr] lg:py-14">
        <div className="reveal max-w-[640px]">
          <HeroTitle text={meta.h1} />
          <p className="mt-6 max-w-[54ch] text-[18px] leading-8 text-text-2">{meta.body}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/contact" className="btn primary lg">
              Book memo audit
              <ArrowRight size={17} />
            </Link>
            <a href="#sample" className="btn lg">
              View sample packet
              <ArrowRight size={17} />
            </a>
          </div>
          <p className="footnote mt-6 flex max-w-[56ch] items-start gap-2 text-text-2">
            <ShieldCheck size={15} className="mt-0.5 flex-none text-accent" />
            Sanitized, public, or approved input only.
          </p>
        </div>

        <div className="reveal" style={{ transitionDelay: "80ms" }}>
          <ReviewerConsole />
        </div>
      </div>
      <div className="wrap hidden border-t border-line-soft py-7 md:grid md:grid-cols-[1fr_0.55fr] md:items-center">
        <h2 className="text-[31px] leading-tight">Built for export-control professionals</h2>
        <p className="m-0 max-w-[48ch] text-[14px] leading-6 text-text-2">
          Rulix surfaces what matters so teams can focus on decisions that require human expertise.
        </p>
      </div>
    </section>
  );
}

function HeroTitle({ text }: { text: string }) {
  const parts = text.split("export-control");

  return (
    <h1 className="hero-title">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {part}
          {index < parts.length - 1 && <span className="hero-nowrap">export-control</span>}
        </span>
      ))}
    </h1>
  );
}

function ReviewerConsole() {
  const queue = [
    ["Classification", "2", "yellow"],
    ["ECCN & license", "1", "yellow"],
    ["End use & end user", "1", "red"],
    ["Evidence & rationale", "0", "green"],
    ["Recordkeeping", "1", "yellow"],
  ];
  const gaps = [
    ["Missing threshold", "Mass market screening rationale is not documented.", "red"],
    ["Weak evidence", "End-use statement lacks supporting detail.", "yellow"],
    ["Reviewer question", "Dual-use application rationale needs clarification.", "cyan"],
  ];
  const trail = [
    ["Pre-check", "Completed", "green"],
    ["Questions", "2 items", "yellow"],
    ["Alex Ortega", "In review", "cyan"],
    ["Signoff", "Pending", "white"],
  ];

  return (
    <div className="review-console" aria-label="Rulix memo review console preview">
      <div className="console-rail">
        <img src="/brand/rulix-mark.png" alt="" className="size-8 rounded-[8px]" />
        {["home", "doc", "chat", "team", "gear"].map((item, index) => (
          <span key={item} className={index === 1 ? "rail-dot active" : "rail-dot"} />
        ))}
      </div>
      <div className="console-main">
        <div className="console-bar">
          <strong>Acme Labs Memo - 2026-05-12</strong>
          <span className="status-chip cyan">In review</span>
        </div>
        <div className="console-grid">
          <aside className="console-panel">
            <div className="console-label">Audit queue</div>
            <div className="console-stack">
              {queue.map(([label, count, tone]) => (
                <div key={label} className="queue-row">
                  <span className={`signal ${tone}`} />
                  <span>{label}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <div className="console-label mt-7">Evidence gaps</div>
            <div className="console-stack">
              {gaps.map(([title, body, tone]) => (
                <div key={title} className={`gap-note ${tone}`}>
                  <strong>{title}</strong>
                  <span>{body}</span>
                </div>
              ))}
            </div>
          </aside>
          <div className="memo-page">
            <span className="memo-kicker">Export-control classification memo</span>
            <div className="memo-meta">
              <span>Document ID</span>
              <strong>ACM-2026-05-12</strong>
              <span>Prepared by</span>
              <strong>Export Compliance</strong>
              <span>Organization</span>
              <strong>Acme Labs</strong>
            </div>
            <div className="memo-rule" />
            <h3>1. Item Description</h3>
            <p>Laboratory instrument for material characterization using spectroscopic analysis. Includes integrated software.</p>
            <h3>2. Classification</h3>
            <div className="memo-meta compact">
              <span>ECCN</span>
              <strong>3B001</strong>
              <span>License</span>
              <strong>NLR</strong>
            </div>
            <p>The item is controlled based on technical characteristics. Source support still requires reviewer confirmation.</p>
            <h3>3. End Use</h3>
            <p>Research and development use in a controlled laboratory environment.</p>
          </div>
          <aside className="console-panel trail-panel">
            <div className="console-label">Reviewer trail</div>
            {trail.map(([name, state, tone]) => (
              <div key={name} className="trail-row">
                <span className={`trail-dot ${tone}`} />
                <span>
                  <strong>{name}</strong>
                  <em>{state}</em>
                </span>
              </div>
            ))}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Workflow() {
  return (
    <section id="product" className="section-white">
      <div className="wrap py-20 lg:py-24">
        <div className="reveal max-w-[700px]">
          <h2 className="section-title">From draft to reviewer-ready packet</h2>
          <p className="mt-4 max-w-[54ch] text-[16px] leading-7 text-text-2">
            Rulix turns a draft memo into a consistent, traceable packet your reviewer can inspect.
          </p>
        </div>
        <div className="workflow-grid mt-12">
          {WORKFLOW.map((item, index) => (
            <article key={item.step} className="workflow-step reveal" style={{ transitionDelay: `${index * 55}ms` }}>
              <span className="step-number">{item.step}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <div className="step-artifact">
                <ClipboardCheck size={18} />
                <strong>{item.detail}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProofSection() {
  return (
    <section id="sample" className="section-soft border-y border-line-soft">
      <div className="wrap py-20 lg:py-24">
        <div className="reveal max-w-[680px]">
          <h2 className="section-title">Proof you can inspect</h2>
          <p className="mt-4 text-[16px] leading-7 text-text-2">
            Every result is sourced, scored, and explained so reviewers can focus on judgment, not hunting for context.
          </p>
        </div>
        <div className="audit-board reveal mt-10" style={{ transitionDelay: "80ms" }}>
          <div className="audit-score">
            <span>Readiness score</span>
            <strong>78</strong>
            <em>/100</em>
            <p>Reviewer-ready with 6 gaps to resolve</p>
          </div>
          <div className="audit-table">
            <div className="audit-table-head">
              <span>Requirement</span>
              <span>Gap</span>
              <span>Severity</span>
              <span>Source</span>
            </div>
            {GAP_ROWS.map((row) => (
              <div key={`${row.requirement}-${row.source}`} className="audit-row">
                <strong>{row.requirement}</strong>
                <span>{row.gap}</span>
                <span className={row.severity === "High" ? "severity high" : "severity med"}>{row.severity}</span>
                <span>{row.source}</span>
              </div>
            ))}
          </div>
          <div className="question-list">
            <div className="question-head">
              <strong>Reviewer questions</strong>
              <span>Filter by: All</span>
            </div>
            {[
              "Confirm end-use and end-user screening",
              "Provide packing slip or test report for item 3",
              "Clarify encryption classification for embedded module",
              "Upload export license or exception rationale",
            ].map((question, index) => (
              <div key={question} className="question-row">
                <CircleAlert size={15} className={index < 2 ? "text-block" : "text-warn"} />
                <span>{question}</span>
                <em>{index < 2 ? "High" : "Medium"}</em>
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
    <section id="use-cases" className="section-white">
      <div className="wrap py-20 lg:py-24">
        <div className="reveal max-w-[620px]">
          <h2 className="section-title">For teams whose decisions get audited</h2>
          <p className="mt-4 text-[16px] leading-7 text-text-2">
            Keep export-control reviews consistent, traceable, and ready for scrutiny.
          </p>
        </div>
        <div className="use-case-list mt-10">
          {USE_CASES.map((item, index) => (
            <article key={item.title} className="use-case-row reveal" style={{ transitionDelay: `${index * 70}ms` }}>
              <span className="case-icon">
                <item.icon size={25} />
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
              <ul>
                {item.bullets.map((bullet) => (
                  <li key={bullet}>
                    <Check size={15} />
                    {bullet}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SecurityBand() {
  return (
    <section className="security-band">
      <div className="wrap py-20 lg:py-24">
        <div className="reveal grid gap-8 border-b border-white/14 pb-8 lg:grid-cols-[0.9fr_1fr] lg:items-end">
          <div>
            <span className="section-label text-accent">Security & data handling</span>
            <h2 className="section-title mt-3 text-white">Clear boundaries make the product more credible.</h2>
          </div>
          <p className="m-0 max-w-[52ch] text-[16px] leading-8 text-white/68">
            Export-control tooling should be explicit about what it is, what it refuses to do, and what data should not enter the hosted pilot.
          </p>
        </div>
        <div className="boundary-list">
          {BOUNDARIES.map((item, index) => (
            <article key={item.title} className="boundary-row reveal" style={{ transitionDelay: `${index * 70}ms` }}>
              <span className="boundary-icon">
                {index === 0 ? <ShieldCheck size={25} /> : index === 1 ? <Lock size={25} /> : <FileCheck2 size={25} />}
              </span>
              <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
        <div className="security-warning reveal">
          <CircleAlert size={24} />
          <p>
            Do not submit CUI, ITAR technical data, controlled information, or proprietary specifications unless an approved boundary is in place.
          </p>
        </div>
      </div>
    </section>
  );
}

function LeadSection() {
  const subject = encodeURIComponent("Rulix memo audit");
  const body = encodeURIComponent(
    "Work email:\nCompany:\nRole:\nExpected monthly memo volume:\nCan use a public or sanitized sample? Yes/No\n\nWhat review workflow should Rulix help with?\n",
  );

  return (
    <section id="lead" className="section-white border-b border-line-soft">
      <div className="wrap grid gap-10 py-16 lg:grid-cols-[1fr_0.72fr] lg:items-center lg:py-20">
        <div className="reveal">
          <h2 className="section-title">Bring a sanitized memo. Leave with the gaps.</h2>
          <p className="mt-5 max-w-[60ch] text-[17px] leading-8 text-text-2">
            We will run a decision-support memo audit and show where thresholds, evidence, or source questions are missing.
          </p>
        </div>
        <div className="lead-actions reveal" style={{ transitionDelay: "80ms" }}>
          <Link to="/contact" className="action-tile primary">
            <CalendarDays size={21} />
            Book memo audit
            <ArrowRight size={18} />
          </Link>
          <a href={`mailto:security@rulix.cloud?subject=${subject}&body=${body}`} className="action-tile">
            <Mail size={21} />
            security@rulix.cloud
          </a>
          <p>
            <Lock size={14} />
            No sensitive data required to start.
          </p>
        </div>
      </div>
    </section>
  );
}

function SeoSection() {
  return (
    <section className="section-white">
      <div className="wrap py-16">
        <div className="reveal flex flex-col gap-4 border-b border-line-soft pb-8 md:flex-row md:items-end md:justify-between">
          <div>
            <span className="section-label">Export-control review topics</span>
            <h2 className="mt-3 text-[clamp(26px,3vw,36px)] leading-tight">Find the right review path</h2>
          </div>
          <p className="m-0 max-w-[48ch] text-[14px] leading-6 text-text-2">
            Focused entry points for teams comparing memo review, ECCN support, AI decision support, and research operations workflows.
          </p>
        </div>
        <div className="topic-list mt-6">
          {SEO_LINKS.map(([label, href]) => (
            <Link key={href} to={href} className="topic-link reveal">
              <FileText size={18} />
              {label}
              <ArrowRight size={15} />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
