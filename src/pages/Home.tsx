// Home.tsx - premium public landing page and SEO landing variants.

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  FileText,
  Gauge,
  GraduationCap,
  Landmark,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { trackEvent } from "../lib/analytics";

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
    title: "Rulix - Export-control memo review under scrutiny",
    description:
      "Rulix reviews memo logic, missing evidence, and technical thresholds so teams move faster without guessing on export-control risk.",
    h1: "Export-control memos your team can defend under scrutiny.",
    body:
      "Rulix reviews memo logic, missing evidence, and technical thresholds so teams move faster without guessing on export-control risk.",
  },
  "memo-review": {
    title: "Export-control memo review software | Rulix",
    description:
      "Turn export-control drafts into reviewer-ready packets with evidence gaps, source questions, methodology notes, and human signoff.",
    h1: "Export-control memo review built for diligence and audit pressure.",
    body:
      "Rulix turns draft memos into evidence gaps, reviewer questions, and a clean decision-support trail your team can inspect.",
  },
  "eccn-assistant": {
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN review without replacing expert judgment or final human signoff.",
    h1: "ECCN review support that keeps the human decision visible.",
    body:
      "Separate classification facts from unsupported conclusions, then surface the next questions needed for a defensible review.",
  },
  "ai-review": {
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI decision support to find export-control memo gaps while keeping final determinations with trained human reviewers.",
    h1: "AI-assisted export review without the false confidence.",
    body:
      "Rulix uses AI where it helps and deterministic checks where they matter, while refusing to become the final export-control authority.",
  },
  university: {
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities triage public or sanitized export-control memo drafts before empowered officials spend review time.",
    h1: "Export-control review support for research teams under scrutiny.",
    body:
      "Help research offices turn public or sanitized drafts into clearer questions before counsel or empowered officials spend scarce review time.",
  },
  manufacturer: {
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce ECCN memo back-and-forth on evidence, product specifications, and reviewer-ready questions.",
    h1: "Cleaner ECCN review packets for technical manufacturers.",
    body:
      "Reduce product-spec back-and-forth by surfacing the thresholds, facts, and source questions that block classification confidence.",
  },
};

const PROOF_STRIP = [
  {
    label: "Decision support only",
    body: "Rulix never replaces the reviewer of record.",
  },
  {
    label: "Designed for scrutiny",
    body: "Claims, gaps, questions, and sources stay inspectable.",
  },
  {
    label: "Approved inputs first",
    body: "Hosted review starts with public, sanitized, or approved text.",
  },
];

const PROCESS = [
  {
    step: "01",
    title: "Submit memo context",
    body: "Bring the draft, source excerpts, product facts, and review objective. Keep sensitive data out until an approved boundary exists.",
  },
  {
    step: "02",
    title: "Interrogate defensibility",
    body: "Rulix checks missing thresholds, weak citations, unsupported conclusions, and facts that a reviewer would ask for anyway.",
  },
  {
    step: "03",
    title: "Leave with next actions",
    body: "Get a packet of gaps, reviewer questions, and decision-support notes your team can use in diligence, audits, or customer review.",
  },
];

const GAP_ROWS = [
  ["ECCN 3A001", "ADC threshold cited without source paragraph", "High", "Sec. 3.4"],
  ["End use", "End-user screening evidence is incomplete", "High", "Sec. 2.1"],
  ["Recordkeeping", "Retention rationale missing from memo", "Med", "Sec. 5.2"],
  ["License support", "Exception rationale lacks supporting detail", "Med", "Sec. 4.2"],
  ["Deemed exports", "Training record not attached", "Med", "Sec. 6.1"],
];

const USE_CASES = [
  {
    icon: Landmark,
    title: "Technical exporters",
    body: "For teams that need a confident review path before customer, partner, or cross-border delivery pressure starts.",
  },
  {
    icon: Gauge,
    title: "Diligence-ready operators",
    body: "For founders and operating teams who cannot afford a memo that collapses when investors or customers ask harder questions.",
  },
  {
    icon: GraduationCap,
    title: "Research and review offices",
    body: "For institutions that need repeatable review quality without relaxing data boundaries or human signoff.",
  },
];

const FAQS = [
  {
    question: "Why not review these memos in-house?",
    answer:
      "You still should. Rulix is built to make the in-house review sharper by finding weak evidence, missing thresholds, and unclear assumptions before the reviewer of record signs off.",
  },
  {
    question: "Does Rulix issue a final ECCN or legal determination?",
    answer:
      "No. Rulix is decision support only. It is designed to refuse final ECCN, license, sanctions, or jurisdiction determinations and keep the human reviewer visible.",
  },
  {
    question: "Can we submit controlled technical data?",
    answer:
      "Not to the hosted pilot. Start with public, sanitized, sample, or explicitly approved text. If your review requires controlled data, scope an approved deployment boundary first.",
  },
  {
    question: "What happens after the first consult?",
    answer:
      "We look at the review workflow, confirm the data boundary, identify the memo stage, and decide whether a sample audit, pilot, or custom deployment lane is the right next step.",
  },
];

const SEO_LINKS = [
  ["Memo review", "/export-control-memo-review"],
  ["ECCN assistant", "/eccn-classification-assistant"],
  ["AI export review", "/ai-export-compliance-review"],
  ["University review", "/university-export-control-review"],
  ["Manufacturer ECCN", "/manufacturer-eccn-review"],
];

export function Home({ variant = "default" }: { variant?: LandingVariant }) {
  const meta = META[variant];
  usePageMeta(meta.title, meta.description);

  useEffect(() => {
    trackEvent("view_home", { variant });
  }, [variant]);

  return (
    <div className="premium-home">
      <Hero meta={meta} />
      <TrustStrip />
      <ProblemSection />
      <ProcessSection />
      <MethodologySection />
      <UseCaseSection />
      <FaqSection />
      <LeadCapture />
      <SeoSection />
    </div>
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
    <section className="premium-hero" id="outcome">
      <div className="premium-glow" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy reveal">
          <h1>{meta.h1}</h1>
          <p className="hero-subhead">{meta.body}</p>
          <div className="hero-actions">
            <a
              href="#lead"
              className="btn primary hero-btn"
              data-track="click_primary_cta"
              onClick={() => trackEvent("click_primary_cta", { location: "hero", label: "Book a review consult" })}
            >
              Book a review consult
              <ArrowRight size={18} />
            </a>
            <a
              href="#methodology"
              className="btn ghost hero-btn"
              data-track="click_secondary_cta"
              onClick={() => trackEvent("click_secondary_cta", { location: "hero", label: "See methodology" })}
            >
              See methodology
            </a>
          </div>
          <p className="hero-proof">
            <ShieldCheck size={16} />
            Decision support only. Human reviewers sign off.
          </p>
        </div>
        <div className="hero-artifact reveal" style={{ transitionDelay: "100ms" }}>
          <ReviewerConsole />
        </div>
      </div>
    </section>
  );
}

function ReviewerConsole() {
  return (
    <div className="premium-console" aria-label="Rulix review artifact preview">
      <div className="console-topline">
        <span>Rulix defensibility review</span>
        <em>In review</em>
      </div>
      <div className="console-layout">
        <aside className="console-sidebar">
          <img src="/brand/rulix-mark.png" alt="" />
          {["Memo", "Evidence", "Questions", "Signoff"].map((item, index) => (
            <span key={item} className={index === 1 ? "active" : ""}>{item}</span>
          ))}
        </aside>
        <div className="console-document">
          <span>Export-control classification memo</span>
          <h3>ACM-2026-05-12</h3>
          <dl>
            <div><dt>Status</dt><dd>Needs evidence</dd></div>
            <div><dt>Reviewer</dt><dd>Alex Ortega</dd></div>
            <div><dt>Decision</dt><dd>Human signoff pending</dd></div>
          </dl>
          <p>
            Classification rationale is directionally plausible, but threshold support and end-use evidence require reviewer confirmation.
          </p>
        </div>
        <aside className="console-findings">
          <strong>Gaps found</strong>
          {[
            ["High", "Missing threshold citation"],
            ["High", "End-use evidence incomplete"],
            ["Med", "Retention rationale unclear"],
          ].map(([severity, label]) => (
            <div key={label} className={severity === "High" ? "finding high" : "finding"}>
              <span>{severity}</span>
              <p>{label}</p>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

function TrustStrip() {
  return (
    <section className="trust-strip">
      <div className="wrap trust-grid">
        {PROOF_STRIP.map((item) => (
          <article key={item.label} className="reveal">
            <span>{item.label}</span>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProblemSection() {
  return (
    <section className="premium-section problem-section">
      <div className="wrap problem-grid">
        <div className="reveal">
          <span className="premium-label">The expensive part</span>
          <h2>Weak memo review is expensive before anything goes wrong.</h2>
        </div>
        <div className="problem-copy reveal" style={{ transitionDelay: "80ms" }}>
          <p>
            What slows teams down is not only the export question. It is the uncertainty after the answer:
            missing rationale, unclear edge cases, inconsistent standards, and debates that resurface when
            customers, investors, or regulators ask harder questions.
          </p>
          <div className="risk-list">
            {[
              "Unsupported EAR99 or ECCN assertions",
              "Technical thresholds separated from source evidence",
              "Customer or diligence questions reopened late",
            ].map((item) => (
              <span key={item}>
                <CircleAlert size={16} />
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProcessSection() {
  return (
    <section className="premium-section process-section" id="product">
      <div className="wrap">
        <div className="section-heading reveal">
          <span className="premium-label">How it works</span>
          <h2>Three moves from draft uncertainty to review confidence.</h2>
        </div>
        <div className="process-grid">
          {PROCESS.map((item, index) => (
            <article key={item.step} className="process-card reveal" style={{ transitionDelay: `${index * 80}ms` }}>
              <span>{item.step}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function MethodologySection() {
  return (
    <section className="premium-section methodology-section" id="methodology">
      <div className="wrap methodology-grid">
        <div className="reveal">
          <span className="premium-label">Methodology</span>
          <h2>Proof beside every meaningful claim.</h2>
          <p>
            The review packet is intentionally inspectable: requirements, gaps, severity, source references, reviewer questions, and the human signoff boundary stay visible.
          </p>
          <a
            href="#lead"
            className="btn primary"
            onClick={() => trackEvent("click_primary_cta", { location: "methodology", label: "Talk through your memo" })}
          >
            Talk through your memo
            <ArrowRight size={17} />
          </a>
        </div>
        <div className="method-board reveal" id="sample" style={{ transitionDelay: "90ms" }}>
          <div className="method-score">
            <span>Readiness</span>
            <strong>78</strong>
            <em>/100</em>
            <p>Illustrative score. Reviewer questions still open.</p>
          </div>
          <div className="method-table">
            <div className="method-head">
              <span>Requirement</span>
              <span>Gap</span>
              <span>Severity</span>
              <span>Source</span>
            </div>
            {GAP_ROWS.map(([requirement, gap, severity, source]) => (
              <div key={`${requirement}-${source}`} className="method-row">
                <strong>{requirement}</strong>
                <span>{gap}</span>
                <em className={severity === "High" ? "high" : ""}>{severity}</em>
                <span>{source}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function UseCaseSection() {
  return (
    <section className="premium-section usecase-section" id="proof">
      <div className="wrap">
        <div className="section-heading reveal">
          <span className="premium-label">Who it is for</span>
          <h2>Built for people whose answers have to survive a second room.</h2>
        </div>
        <div className="usecase-premium-grid">
          {USE_CASES.map((item, index) => (
            <article key={item.title} className="usecase-premium-card reveal" style={{ transitionDelay: `${index * 70}ms` }}>
              <span><item.icon size={23} /></span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  const [open, setOpen] = useState(0);

  return (
    <section className="premium-section faq-section" id="faq">
      <div className="wrap faq-grid">
        <div className="reveal">
          <span className="premium-label">Objections handled</span>
          <h2>Common concerns, answered without hand-waving.</h2>
        </div>
        <div className="faq-list reveal" style={{ transitionDelay: "80ms" }}>
          {FAQS.map((item, index) => {
            const isOpen = open === index;
            return (
              <article key={item.question} className={isOpen ? "faq-item open" : "faq-item"}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`faq-${index}`}
                  onClick={() => {
                    setOpen(isOpen ? -1 : index);
                    trackEvent("expand_faq", { question: item.question });
                  }}
                >
                  {item.question}
                  <ChevronDown size={18} />
                </button>
                <div id={`faq-${index}`} hidden={!isOpen}>
                  <p>{item.answer}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LeadCapture() {
  const navigate = useNavigate();
  const [touched, setTouched] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
    stage: "",
    urgency: "This month",
  });

  const mailto = useMemo(() => {
    const subject = encodeURIComponent("Rulix review consult");
    const body = encodeURIComponent(
      [
        `Name: ${form.name}`,
        `Work email: ${form.email}`,
        `Company: ${form.company}`,
        `Role: ${form.role}`,
        `Memo stage: ${form.stage}`,
        `Urgency: ${form.urgency}`,
        "",
        "Sensitive data note: I will not send CUI, ITAR technical data, controlled information, or proprietary specifications unless an approved boundary is in place.",
      ].join("\n"),
    );
    return `mailto:security@rulix.cloud?subject=${subject}&body=${body}`;
  }, [form]);

  function update(name: keyof typeof form, value: string) {
    if (!touched) {
      setTouched(true);
      trackEvent("start_lead_form", { location: "home" });
    }
    setForm((current) => ({ ...current, [name]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    trackEvent("submit_lead_form", { role: form.role, stage: form.stage, urgency: form.urgency });
    trackEvent("generate_lead", { source: "home_qualification_form" });
    window.open(mailto, "_blank", "noopener,noreferrer");
    navigate("/thank-you");
  }

  return (
    <section className="premium-section lead-capture" id="lead">
      <div className="wrap lead-grid">
        <div className="lead-copy reveal">
          <span className="premium-label">Primary path</span>
          <h2>Talk through your memo.</h2>
          <p>
            No portal upload. No sensitive data. Just enough context to decide whether Rulix can help and what boundary the review needs.
          </p>
          <div className="lead-assurance">
            <Lock size={17} />
            Public, sanitized, sample, or explicitly approved inputs only.
          </div>
        </div>

        <form className="lead-form reveal" onSubmit={submit} style={{ transitionDelay: "90ms" }}>
          <label>
            <span>Name</span>
            <input required value={form.name} onChange={(event) => update("name", event.target.value)} autoComplete="name" />
          </label>
          <label>
            <span>Work email</span>
            <input required type="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" />
          </label>
          <label>
            <span>Company</span>
            <input required value={form.company} onChange={(event) => update("company", event.target.value)} autoComplete="organization" />
          </label>
          <label>
            <span>Role</span>
            <input required value={form.role} onChange={(event) => update("role", event.target.value)} autoComplete="organization-title" />
          </label>
          <label className="span-2">
            <span>Memo stage</span>
            <select required value={form.stage} onChange={(event) => update("stage", event.target.value)}>
              <option value="">Select one</option>
              <option>Early draft</option>
              <option>Internal review</option>
              <option>Customer or diligence review</option>
              <option>Audit or regulator-facing concern</option>
            </select>
          </label>
          <label className="span-2">
            <span>Timing</span>
            <select value={form.urgency} onChange={(event) => update("urgency", event.target.value)}>
              <option>This week</option>
              <option>This month</option>
              <option>This quarter</option>
              <option>Exploring fit</option>
            </select>
          </label>
          <button className="btn primary span-2" type="submit">
            Prepare review request
            <Mail size={17} />
          </button>
          <p className="span-2">This opens an email draft to security@rulix.cloud and then shows a confirmation page.</p>
        </form>
      </div>
    </section>
  );
}

function SeoSection() {
  return (
    <section className="premium-section seo-premium">
      <div className="wrap">
        <div className="section-heading reveal">
          <span className="premium-label">Search paths</span>
          <h2>Choose the review path that matches the job.</h2>
        </div>
        <div className="seo-premium-grid">
          {SEO_LINKS.map(([label, href]) => (
            <Link key={href} to={href} className="seo-premium-link reveal">
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
