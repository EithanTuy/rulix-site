import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Eye,
  FileCheck2,
  FileSearch,
  GitBranch,
  Link2,
  LockKeyhole,
  Mail,
  SearchCheck,
  ShieldCheck,
  UploadCloud,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { ThemeToggle } from "./ThemeToggle";

type MarketingPageKey =
  | "home"
  | "export-control-memo-review"
  | "eccn-classification-assistant"
  | "ai-export-compliance-review"
  | "university-export-control-review"
  | "manufacturer-eccn-review";

interface PageMeta {
  key: MarketingPageKey;
  path: string;
  title: string;
  description: string;
  heroTitle: string;
  heroCopy: string;
}

interface RequestAccessForm {
  email: string;
  company: string;
  role: string;
  volume: string;
  sampleReady: boolean;
}

const CONTACT_EMAIL = "security@rulix.cloud";

type DemoMediaKey = "findMissingReasoning" | "resolveReviewGaps" | "exportReviewRecord";
type UseCaseKey = "legal" | "compliance" | "founders" | "operations" | "universities";

interface DemoMedia {
  title: string;
  duration: string;
  poster: string;
  video: string;
  still: string;
  buyerQuestionAnswered: string;
}

const MARKETING_PAGES: Record<MarketingPageKey, PageMeta> = {
  home: {
    key: "home",
    path: "/",
    title: "Rulix - Defensible export-control memo review",
    description:
      "Rulix helps export-control, legal, and compliance teams review memo reasoning, surface gaps, and prepare audit-ready decision records.",
    heroTitle: "Review export-control memos with defensible AI.",
    heroCopy:
      "Rulix helps teams find gaps in reasoning, surface review risk, and turn draft memos into audit-ready decision records."
  },
  "export-control-memo-review": {
    key: "export-control-memo-review",
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for missing reasoning, evidence gaps, reviewer questions, and audit-ready signoff.",
    heroTitle: "Export-control memo review your team can defend.",
    heroCopy:
      "Rulix helps reviewers test classification logic, find unsupported claims, and document the evidence trail before final signoff."
  },
  "eccn-classification-assistant": {
    key: "eccn-classification-assistant",
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN classification review, evidence gaps, and human signoff without replacing expert judgment.",
    heroTitle: "ECCN classification support for human reviewers.",
    heroCopy:
      "Rulix turns draft classification memos into structured review work: claims, assumptions, missing evidence, and a signoff trail."
  },
  "ai-export-compliance-review": {
    key: "ai-export-compliance-review",
    path: "/ai-export-compliance-review",
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI review support to spot export-control memo gaps while keeping final determinations with trained human reviewers.",
    heroTitle: "AI-assisted export review with reviewer control.",
    heroCopy:
      "Rulix pressure-tests memo reasoning, surfaces questions, and organizes evidence while expert reviewers keep final authority."
  },
  "university-export-control-review": {
    key: "university-export-control-review",
    path: "/university-export-control-review",
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities and research operations triage public or sanitized export-control memo drafts before empowered officials spend review time.",
    heroTitle: "Export-control memo triage for research teams.",
    heroCopy:
      "Rulix helps universities and labs prepare cleaner memo drafts, isolate missing technical facts, and keep reviewer questions organized."
  },
  "manufacturer-eccn-review": {
    key: "manufacturer-eccn-review",
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce back-and-forth on ECCN memo evidence, product specifications, and reviewer-ready questions.",
    heroTitle: "ECCN review packets for manufacturers and labs.",
    heroCopy:
      "Rulix helps product, engineering, and compliance teams catch missing specs and unsupported claims before final classification review."
  }
};

const PAGE_BY_PATH = new Map(Object.values(MARKETING_PAGES).map((page) => [page.path, page]));

const proofChips = [
  { label: "Traceable reasoning", icon: SearchCheck },
  { label: "Reviewer workflow", icon: UsersRound },
  { label: "Audit-ready output", icon: ClipboardCheck }
];

const problemCards = [
  {
    title: "Manual review is slow",
    copy: "Teams lose time checking reasoning, citations, assumptions, and missing context across draft memos and comments.",
    icon: ClipboardList
  },
  {
    title: "Risk hides in details",
    copy: "Small gaps in end-use, jurisdiction, classification logic, or party context can create review risk late in the process.",
    icon: AlertTriangle
  },
  {
    title: "Defensibility is hard to prove",
    copy: "Final memos need a clear record of how conclusions were reached, what changed, and what evidence supported the call.",
    icon: ShieldCheck
  }
];

const demoSteps = [
  {
    title: "Upload memo",
    label: "Draft uploaded",
    copy: "A sanitized memo and supporting context enter the review workspace.",
    detail: "Rulix separates memo claims, cited sources, assumptions, and reviewer-visible facts."
  },
  {
    title: "Analyze reasoning",
    label: "Reasoning mapped",
    copy: "The review pass highlights unsupported assertions and missing decision logic.",
    detail: "Weak jurisdiction analysis, incomplete ECCN reasoning, and unsupported end-user context are surfaced for review."
  },
  {
    title: "Resolve gaps",
    label: "Checklist created",
    copy: "Findings become a reviewer checklist with evidence requests and owner-ready notes.",
    detail: "Each note stays connected to the memo location, risk context, and required evidence."
  },
  {
    title: "Export record",
    label: "Record prepared",
    copy: "Resolved findings become a clean decision record for internal review.",
    detail: "The exportable summary preserves findings, responses, evidence links, and audit trail events."
  }
];

const demoMediaCatalog: Record<"hero" | DemoMediaKey, DemoMedia> = {
  hero: {
    title: "Rulix review loop",
    duration: "10s",
    poster: "/marketing/demos/hero-rulix-review-loop.webp",
    video: "/marketing/demos/hero-rulix-review-loop.mp4",
    still: "/marketing/demos/hero-rulix-review-loop.png",
    buyerQuestionAnswered: "What is Rulix, and how does a memo move from draft to review record?"
  },
  findMissingReasoning: {
    title: "Find missing reasoning",
    duration: "6s",
    poster: "/marketing/demos/demo-find-missing-reasoning.webp",
    video: "/marketing/demos/demo-find-missing-reasoning.mp4",
    still: "/marketing/demos/demo-find-missing-reasoning.png",
    buyerQuestionAnswered: "Can reviewers see where the memo reasoning is weak?"
  },
  resolveReviewGaps: {
    title: "Resolve review gaps",
    duration: "6s",
    poster: "/marketing/demos/demo-resolve-review-gaps.webp",
    video: "/marketing/demos/demo-resolve-review-gaps.mp4",
    still: "/marketing/demos/demo-resolve-review-gaps.png",
    buyerQuestionAnswered: "Does this support a human reviewer workflow?"
  },
  exportReviewRecord: {
    title: "Export a defensible record",
    duration: "6s",
    poster: "/marketing/demos/demo-export-review-record.webp",
    video: "/marketing/demos/demo-export-review-record.mp4",
    still: "/marketing/demos/demo-export-review-record.png",
    buyerQuestionAnswered: "Can the team preserve what happened for audit review?"
  }
};

const demoModules: Array<{
  key: DemoMediaKey;
  title: string;
  shortTitle: string;
  copy: string;
  proof: string[];
  outcome: string;
}> = [
  {
    key: "findMissingReasoning",
    title: "Find missing reasoning",
    shortTitle: "Find gaps",
    copy: "Analysis and Evidence Map show unsupported jurisdiction, ECCN, and end-use reasoning directly beside the memo.",
    proof: ["Analysis panel", "Evidence Map", "Memo highlights"],
    outcome: "Reviewers can see the weak link before signoff."
  },
  {
    key: "resolveReviewGaps",
    title: "Resolve review gaps",
    shortTitle: "Resolve gaps",
    copy: "Highlighted findings become reviewer actions: accept, request more information, or override with notes.",
    proof: ["Finding selection", "Decision tab", "Reviewer checklist"],
    outcome: "Rulix fits workflows that require a human decision trail."
  },
  {
    key: "exportReviewRecord",
    title: "Export a defensible record",
    shortTitle: "Export record",
    copy: "The audit trail and export state preserve memo intake, AI analysis, reviewer decision, and report generation.",
    proof: ["Audit tab", "Decision note", "Report export"],
    outcome: "Teams get an internal record they can explain."
  }
];

const workflowSteps = [
  {
    title: "Ingest the memo",
    copy: "Upload or paste memo content, supporting documents, classifications, and review context.",
    panel: "Memo, attachments, item facts"
  },
  {
    title: "Map the reasoning",
    copy: "Rulix identifies claims, assumptions, missing evidence, and decision logic.",
    panel: "Claims, sources, assumptions"
  },
  {
    title: "Flag review risk",
    copy: "Review gaps are grouped by what a human reviewer would need to inspect.",
    panel: "Jurisdiction, ECCN, end use"
  },
  {
    title: "Generate the record",
    copy: "Export a clean summary, checklist, and review trail for final signoff.",
    panel: "Findings, responses, audit trail"
  }
];

const comparisonRows = [
  {
    dimension: "Workflow shape",
    chatbot: "Unstructured conversation",
    manual: "Scattered comments",
    rulix: "Structured memo review"
  },
  {
    dimension: "Traceability",
    chatbot: "Hard to audit",
    manual: "Depends on reviewer notes",
    rulix: "Findings tied to reasoning"
  },
  {
    dimension: "Context retention",
    chatbot: "Easy to lose",
    manual: "Split across tools",
    rulix: "Memo, evidence, and trail together"
  },
  {
    dimension: "Review output",
    chatbot: "Free-form answer",
    manual: "Variable quality",
    rulix: "Reviewer-ready record"
  }
];

const trustItems = [
  {
    title: "Human-in-the-loop review",
    copy: "Rulix supports expert reviewers. It does not replace final legal or compliance judgment.",
    icon: UsersRound
  },
  {
    title: "Traceable suggestions",
    copy: "Findings point back to memo sections, rationale gaps, and the evidence needed to resolve them.",
    icon: GitBranch
  },
  {
    title: "Clear review history",
    copy: "Comments, decisions, and record exports are organized so teams can explain how a memo evolved.",
    icon: ClipboardCheck
  }
];

const buyerUseCases: Array<{
  key: UseCaseKey;
  label: string;
  title: string;
  who: string;
  outcome: string;
  fit: string;
  icon: LucideIcon;
}> = [
  {
    key: "legal",
    label: "Legal",
    title: "Pressure-test memo reasoning before counsel signoff",
    who: "Counsel and legal operations",
    outcome: "See missing jurisdiction, classification, and evidence support before final review.",
    fit: "Best when legal wants structured review notes, not a model making the final determination.",
    icon: FileSearch
  },
  {
    key: "compliance",
    label: "Compliance",
    title: "Standardize export-control memo review",
    who: "Export-control and compliance teams",
    outcome: "Turn draft memos into evidence findings, reviewer actions, and an exportable record.",
    fit: "Best when the team needs repeatable review discipline across multiple memo owners.",
    icon: SearchCheck
  },
  {
    key: "founders",
    label: "Founders",
    title: "Get cleaner review packets before escalation",
    who: "Founders and executives handling technical trade decisions",
    outcome: "Find what is missing before asking counsel or outside advisors for final review.",
    fit: "Best when the company has technical facts but needs a clearer review package.",
    icon: FileCheck2
  },
  {
    key: "operations",
    label: "Operations",
    title: "Reduce back-and-forth on memo evidence",
    who: "Operations, product, and engineering teams",
    outcome: "Collect missing specs, party context, and end-use support before review cycles stall.",
    fit: "Best when non-lawyers prepare the facts and reviewers need a consistent packet.",
    icon: UsersRound
  },
  {
    key: "universities",
    label: "Universities/Labs",
    title: "Triage public or sanitized research review drafts",
    who: "University export-control offices and research operations",
    outcome: "Separate technical unknowns from review conclusions before empowered officials spend time.",
    fit: "Best when the workspace data boundary is limited to public, sanitized, or approved data.",
    icon: ShieldCheck
  }
];

const fitCards = [
  {
    title: "Rulix fits when",
    copy: "Your team reviews export-control memo drafts, needs evidence-aware gap finding, and keeps final judgment with human reviewers.",
    icon: CheckCircle2,
    tone: "fit"
  },
  {
    title: "Boundary required",
    copy: "Use public, sanitized, or approved data in the hosted workspace unless your deployment and policy boundary permits more.",
    icon: LockKeyhole,
    tone: "boundary"
  },
  {
    title: "Rulix is not a fit when",
    copy: "You need autonomous legal determinations, guaranteed classifications, or a place to paste unmanaged sensitive data without approval.",
    icon: AlertTriangle,
    tone: "not-fit"
  }
];

const faqItems = [
  {
    question: "Can we trust Rulix with serious regulatory work?",
    answer:
      "Rulix is built as review support. It surfaces gaps, evidence needs, and decision history so qualified humans can make and document the final call."
  },
  {
    question: "What about hallucination risk?",
    answer:
      "The product frames model output as reviewer-facing findings, not final truth. The workflow keeps analysis tied to memo passages, source context, and human signoff."
  },
  {
    question: "How is this different from a generic LLM?",
    answer:
      "Generic chat is free-form. Rulix organizes memo intake, Evidence Map findings, decision actions, audit trail, and exportable review records around export-control work."
  },
  {
    question: "Does Rulix replace counsel or compliance reviewers?",
    answer:
      "No. The site and app intentionally keep the boundary clear: Rulix assists expert review and does not make legal guarantees or regulatory determinations."
  },
  {
    question: "What data can we put into it?",
    answer:
      "Use public, sanitized, or approved data in the hosted app unless your organization has verified a different deployment and handling boundary."
  }
];

const securityItems = [
  {
    title: "Data handling",
    copy: "Use public, sanitized, or approved data in the hosted workspace unless your deployment boundary permits more.",
    icon: LockKeyhole
  },
  {
    title: "Access control",
    copy: "The product supports account-based review workspaces and invite-oriented team access.",
    icon: ShieldCheck
  },
  {
    title: "Review history",
    copy: "Memos, decisions, comments, and exports are organized around the review record.",
    icon: ClipboardCheck
  }
];

const seoLinks = [
  MARKETING_PAGES["export-control-memo-review"],
  MARKETING_PAGES["eccn-classification-assistant"],
  MARKETING_PAGES["ai-export-compliance-review"],
  MARKETING_PAGES["university-export-control-review"],
  MARKETING_PAGES["manufacturer-eccn-review"]
];

export function MarketingSite() {
  const page = useMemo(() => pageForLocation(), []);
  const reducedMotion = usePrefersReducedMotion();
  const [activeDemo, setActiveDemo] = useState<DemoMediaKey>("findMissingReasoning");
  const [activeUseCase, setActiveUseCase] = useState<UseCaseKey>("compliance");
  const [activeFaq, setActiveFaq] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<RequestAccessForm>({
    email: "",
    company: "",
    role: "",
    volume: "1-5 reviews/month",
    sampleReady: false
  });

  useEffect(() => {
    document.documentElement.classList.add("marketing-page");
    document.body.classList.add("marketing-page");
    applyMarketingMetadata(page);
    return () => {
      document.documentElement.classList.remove("marketing-page");
      document.body.classList.remove("marketing-page");
    };
  }, [page]);

  const submitLead = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    const subject = encodeURIComponent("Rulix access request");
    const body = encodeURIComponent(
      [
        "I'd like to request access to Rulix.",
        "",
        `Work email: ${form.email}`,
        `Company: ${form.company}`,
        `Role: ${form.role}`,
        `Expected review volume: ${form.volume}`,
        `Redacted memo sample ready: ${form.sampleReady ? "yes" : "not yet"}`,
        "",
        "Please send available times and access next steps."
      ].join("\n")
    );
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  };

  return (
    <div className="marketing-site">
      <header className="site-header">
        <a className="site-brand" href="/" aria-label="Rulix home">
          <BrandLogo tone="light" size="compact" />
        </a>
        <nav className="site-nav" aria-label="Primary">
          <a href="#product-demo">Product</a>
          <a href="#fit-check">Fit check</a>
          <a href="#how-it-works">How it works</a>
          <a href="#trust">Trust</a>
          <a href="#use-cases">Use cases</a>
        </nav>
        <div className="site-header-actions">
          <ThemeToggle className="theme-toggle--site" />
          <MarketingButton href="#request-access" variant="primary" className="site-header-cta">
            Request access
          </MarketingButton>
        </div>
      </header>

      <main>
        <Hero page={page} reducedMotion={reducedMotion} />
        <ProblemCards />
        <ProductDemo activeDemo={activeDemo} onDemoChange={setActiveDemo} reducedMotion={reducedMotion} />
        <FitCheck />
        <HowItWorks />
        <ComparisonSection />
        <TrustSection />
        <UseCases activeUseCase={activeUseCase} onUseCaseChange={setActiveUseCase} />
        <CredibilitySection />
        <SecuritySection />
        <FaqSection activeFaq={activeFaq} onFaqChange={setActiveFaq} />
        <RequestAccessSection
          form={form}
          submitted={submitted}
          onFormChange={setForm}
          onSubmit={submitLead}
        />
        <SeoSection />
      </main>

      <footer className="site-footer">
        <BrandLogo tone="light" size="compact" />
        <p>AI for export-control memo review. Built for serious teams.</p>
        <div>
          <a href="#product-demo">Product</a>
          <a href="#trust">Trust</a>
          <a href="https://app.rulix.cloud">Sign in to app</a>
          <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
        </div>
      </footer>
    </div>
  );
}

function Hero({ page, reducedMotion }: { page: PageMeta; reducedMotion: boolean }) {
  return (
    <section className="site-hero" id="top">
      <div className="site-container site-hero-grid">
        <div className="site-hero-copy">
          <p className="site-eyebrow">For export-control, legal, and compliance teams</p>
          <h1>{page.heroTitle}</h1>
          <p className="site-hero-subcopy">{page.heroCopy}</p>
          <div className="site-actions">
            <MarketingButton href="#request-access" variant="primary">
              Request access
              <ArrowRight size={18} aria-hidden="true" />
            </MarketingButton>
            <MarketingButton href="#product-demo" variant="text">
              See how it works
              <ArrowRight size={16} aria-hidden="true" />
            </MarketingButton>
          </div>
          <div className="site-proof-row" aria-label="Rulix review strengths">
            {proofChips.map((chip) => (
              <span key={chip.label}>
                <chip.icon size={17} aria-hidden="true" />
                {chip.label}
              </span>
            ))}
          </div>
        </div>
        <HeroProductProof reducedMotion={reducedMotion} />
      </div>
    </section>
  );
}

function HeroProductProof({ reducedMotion }: { reducedMotion: boolean }) {
  const media = demoMediaCatalog.hero;

  return (
    <div className="product-proof-frame hero-product-proof" aria-label="Rulix product proof video">
      <div className="product-proof-top">
        <span>Product in action</span>
        <strong>{media.duration}</strong>
      </div>
      <ProductVideo media={media} reducedMotion={reducedMotion} autoPlay />
      <div className="proof-caption">
        <strong>{media.title}</strong>
        <span>{media.buyerQuestionAnswered}</span>
      </div>
    </div>
  );
}

function ProblemCards() {
  return (
    <section className="site-section problem-section">
      <div className="site-container">
        <SectionHeader
          label="The review risk"
          title="High-stakes reviews break when reasoning is scattered."
          copy="Export-control review is rarely blocked by a single answer. It slows down when teams cannot see which assumptions, evidence, and reviewer questions support the final memo."
        />
        <div className="problem-grid">
          {problemCards.map((card) => (
            <FeatureCard key={card.title} title={card.title} copy={card.copy} icon={card.icon} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductDemo({
  activeDemo,
  onDemoChange,
  reducedMotion
}: {
  activeDemo: DemoMediaKey;
  onDemoChange: (demo: DemoMediaKey) => void;
  reducedMotion: boolean;
}) {
  const active = demoModules.find((demo) => demo.key === activeDemo) ?? demoModules[0];
  const activeMedia = demoMediaCatalog[active.key];

  return (
    <section className="site-section product-demo-section" id="product-demo">
      <div className="site-container product-demo-grid">
        <div>
          <SectionHeader
            label="Product in action"
            title="Short demos that answer the buyer question."
            copy="Each clip uses real Rulix UI captured from the app: analysis, Evidence Map, reviewer decision, audit trail, and export state."
          />
          <div className="demo-stepper demo-module-tabs" role="tablist" aria-label="Rulix product demos">
            {demoModules.map((demo) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeDemo === demo.key}
                aria-controls={`demo-panel-${demo.key}`}
                aria-label={`${demo.shortTitle} demo, ${demoMediaCatalog[demo.key].duration}`}
                className={activeDemo === demo.key ? "is-active" : ""}
                id={`demo-tab-${demo.key}`}
                key={demo.key}
                onClick={() => onDemoChange(demo.key)}
              >
                <span>{demoMediaCatalog[demo.key].duration}</span>
                {demo.shortTitle}
              </button>
            ))}
          </div>
        </div>
        <div
          className="demo-proof-panel"
          id={`demo-panel-${active.key}`}
          role="tabpanel"
          aria-labelledby={`demo-tab-${active.key}`}
        >
          <ProductVideo media={activeMedia} reducedMotion={reducedMotion} autoPlay />
          <div className="demo-proof-copy">
            <span>{activeMedia.buyerQuestionAnswered}</span>
            <h3>{active.title}</h3>
            <p>{active.copy}</p>
            <div className="demo-proof-pills">
              {active.proof.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <strong>{active.outcome}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductVideo({
  media,
  reducedMotion,
  autoPlay
}: {
  media: DemoMedia;
  reducedMotion: boolean;
  autoPlay?: boolean;
}) {
  if (reducedMotion) {
    return (
      <div className="proof-video is-still">
        <img src={media.still} alt={`${media.title} still`} loading="lazy" />
      </div>
    );
  }

  return (
    <div className="proof-video">
      <video
        muted
        loop
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
        poster={media.poster}
        aria-label={`${media.title} product demo video`}
      >
        <source src={media.video} type="video/mp4" />
      </video>
    </div>
  );
}

function FitCheck() {
  return (
    <section className="site-section fit-check-section" id="fit-check">
      <div className="site-container">
        <SectionHeader
          label="Fit check"
          title="Know when Rulix belongs in the workflow."
          copy="Rulix is designed for defensible memo review. It is intentionally not positioned as autonomous legal judgment or a place to bypass data-boundary rules."
        />
        <div className="fit-check-grid">
          {fitCards.map((card) => (
            <article className={`fit-card ${card.tone}`} tabIndex={0} key={card.title}>
              <card.icon size={22} aria-hidden="true" />
              <h3>{card.title}</h3>
              <p>{card.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="site-section" id="how-it-works">
      <div className="site-container">
        <SectionHeader
          label="How it works"
          title="From draft memo to review-ready record."
          copy="The workflow turns scattered draft analysis into a structured record a human reviewer can inspect, revise, and approve."
        />
        <div className="workflow-grid">
          {workflowSteps.map((step, index) => (
            <article className="workflow-card" key={step.title}>
              <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
              <div>{step.panel}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComparisonSection() {
  return (
    <section className="site-section comparison-section">
      <div className="site-container comparison-grid">
        <SectionHeader
          label="Why Rulix"
          title="Built for structured review, not generic chat."
          copy="Rulix is designed around export-control memo workflows: findings, evidence requests, reviewer resolution, and record export."
        />
        <div className="comparison-table" role="table" aria-label="Rulix comparison">
          <div className="comparison-row comparison-head" role="row">
            <span>Need</span>
            <span>Generic AI chatbot</span>
            <span>Manual review</span>
            <span>Rulix</span>
          </div>
          {comparisonRows.map((row) => (
            <div className="comparison-row" role="row" key={row.dimension}>
              <span>{row.dimension}</span>
              <span>{row.chatbot}</span>
              <span>{row.manual}</span>
              <strong>{row.rulix}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className="site-section trust-section" id="trust">
      <div className="site-container trust-grid">
        <div>
          <SectionHeader
            label="Defensibility"
            title="Human judgment stays in control."
            copy="Rulix supports reviewers with structured findings and traceable suggestions. The product is review support, not blind automation or a legal conclusion."
          />
          <MarketingButton href="#request-access" variant="secondary">
            Talk through your workflow
            <ArrowRight size={16} aria-hidden="true" />
          </MarketingButton>
        </div>
        <div className="trust-list">
          {trustItems.map((item) => (
            <FeatureCard key={item.title} title={item.title} copy={item.copy} icon={item.icon} />
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCases({
  activeUseCase,
  onUseCaseChange
}: {
  activeUseCase: UseCaseKey;
  onUseCaseChange: (useCase: UseCaseKey) => void;
}) {
  const active = buyerUseCases.find((item) => item.key === activeUseCase) ?? buyerUseCases[0];

  return (
    <section className="site-section" id="use-cases">
      <div className="site-container">
        <SectionHeader
          label="Use cases"
          title="Built for the teams who own export-control risk."
          copy="Rulix gives each team a shared review surface without pretending software should make final regulatory judgments."
        />
        <div className="use-case-selector" role="tablist" aria-label="Buyer use cases">
          {buyerUseCases.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeUseCase === item.key}
              aria-controls={`use-case-panel-${item.key}`}
              className={activeUseCase === item.key ? "is-active" : ""}
              id={`use-case-tab-${item.key}`}
              onClick={() => onUseCaseChange(item.key)}
              key={item.key}
            >
              {item.label}
            </button>
          ))}
        </div>
        <article
          className="use-case-proof-card"
          id={`use-case-panel-${active.key}`}
          role="tabpanel"
          aria-labelledby={`use-case-tab-${active.key}`}
        >
          <active.icon size={26} aria-hidden="true" />
          <div>
            <span>{active.who}</span>
            <h3>{active.title}</h3>
            <p>{active.outcome}</p>
            <strong>{active.fit}</strong>
          </div>
        </article>
      </div>
    </section>
  );
}

function FaqSection({
  activeFaq,
  onFaqChange
}: {
  activeFaq: number;
  onFaqChange: (faq: number) => void;
}) {
  return (
    <section className="site-section faq-section" id="faq">
      <div className="site-container faq-grid">
        <SectionHeader
          label="FAQ"
          title="Buyer objections, answered plainly."
          copy="The most important boundary: Rulix helps reviewers work faster and explain decisions better. It does not replace qualified judgment."
        />
        <div className="faq-list">
          {faqItems.map((item, index) => {
            const expanded = activeFaq === index;
            return (
              <article className={expanded ? "faq-item is-open" : "faq-item"} key={item.question}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`faq-answer-${index}`}
                  onClick={() => onFaqChange(expanded ? -1 : index)}
                >
                  <span>{item.question}</span>
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
                {expanded && <p id={`faq-answer-${index}`}>{item.answer}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function CredibilitySection() {
  return (
    <section className="site-section credibility-section" id="sample-review">
      <div className="site-container credibility-grid">
        <div>
          <SectionHeader
            label="Credibility"
            title="Designed for teams handling high-stakes technical trade decisions."
            copy="Built with review discipline, traceability, and defensibility at the center. Replace this section with real customer proof when it is available."
          />
          {/* TODO: Replace this placeholder with a real customer quote or named proof point when approved. */}
          <blockquote className="placeholder-quote">
            "TODO: Replace with real customer quote."
          </blockquote>
        </div>
        <article className="case-study-card">
          <span>Illustrative use case</span>
          <h3>How a compliance team could use Rulix before final memo approval</h3>
          <div className="case-study-columns">
            <div>
              <strong>Before</strong>
              <p>Three reviewers, scattered comments, unresolved evidence requests, and an unclear decision trail.</p>
            </div>
            <div>
              <strong>After</strong>
              <p>Structured findings, resolved gaps, and an exportable review record ready for final human signoff.</p>
            </div>
          </div>
          <small>Illustrative only. Not a customer reference.</small>
        </article>
      </div>
    </section>
  );
}

function SecuritySection() {
  return (
    <section className="site-section security-section">
      <div className="site-container">
        <SectionHeader
          label="Security and privacy"
          title="Security-conscious by design."
          copy="For high-stakes review work, Rulix keeps its public claims cautious. Security, deployment, and data-boundary details should be verified before adding stronger claims."
        />
        {/* TODO: Replace cautious placeholders with verified security claims, retention language, and deployment details. */}
        <div className="security-grid">
          {securityItems.map((item) => (
            <FeatureCard key={item.title} title={item.title} copy={item.copy} icon={item.icon} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RequestAccessSection({
  form,
  submitted,
  onFormChange,
  onSubmit
}: {
  form: RequestAccessForm;
  submitted: boolean;
  onFormChange: (form: RequestAccessForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="site-section request-section" id="request-access">
      <div className="site-container request-grid">
        <div>
          <SectionHeader
            label="Request access"
            title="Make every memo easier to review, explain, and defend."
            copy="Give your team a faster way to find gaps, document reasoning, and prepare review-ready memos."
          />
          <a className="sample-link" href="#sample-review">
            See sample review
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
        <form className="access-form" onSubmit={onSubmit}>
          <label>
            Work email
            <input
              type="email"
              required
              value={form.email}
              onChange={(event) => onFormChange({ ...form, email: event.target.value })}
              placeholder="you@company.com"
            />
          </label>
          <label>
            Company
            <input
              required
              value={form.company}
              onChange={(event) => onFormChange({ ...form, company: event.target.value })}
              placeholder="Organization or lab"
            />
          </label>
          <label>
            Role
            <input
              required
              value={form.role}
              onChange={(event) => onFormChange({ ...form, role: event.target.value })}
              placeholder="Compliance, counsel, founder, operations"
            />
          </label>
          <label>
            Expected review volume
            <select
              value={form.volume}
              onChange={(event) => onFormChange({ ...form, volume: event.target.value })}
            >
              <option>1-5 reviews/month</option>
              <option>6-20 reviews/month</option>
              <option>21-50 reviews/month</option>
              <option>50+ reviews/month</option>
            </select>
          </label>
          <label className="sample-checkbox">
            <input
              type="checkbox"
              checked={form.sampleReady}
              onChange={(event) => onFormChange({ ...form, sampleReady: event.target.checked })}
            />
            <span>
              <UploadCloud size={18} aria-hidden="true" />
              I have a redacted memo sample ready to discuss.
            </span>
          </label>
          <button className="site-button site-button-primary site-button-full" type="submit">
            <Mail size={18} aria-hidden="true" />
            Request access
          </button>
          {submitted && (
            <p className="form-confirmation">
              Opening your mail client with request details. Attach only public, sanitized, or approved samples.
            </p>
          )}
        </form>
      </div>
    </section>
  );
}

function SeoSection() {
  return (
    <section className="site-section seo-section" aria-label="Rulix topic pages">
      <div className="site-container">
        <SectionHeader
          label="Search paths"
          title="Choose the review path that matches the job."
          copy="Each page keeps the same review-support boundary while speaking to a specific use case."
        />
        <div className="seo-link-grid">
          {seoLinks.map((item) => (
            <a href={item.path} key={item.path}>
              <strong>{item.heroTitle}</strong>
              <span>{item.description}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHeader({ label, title, copy }: { label: string; title: string; copy: string }) {
  return (
    <div className="site-section-header">
      <span>{label}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  );
}

function FeatureCard({
  title,
  copy,
  icon: Icon
}: {
  title: string;
  copy: string;
  icon: LucideIcon;
}) {
  return (
    <article className="feature-card">
      <Icon size={22} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{copy}</p>
    </article>
  );
}

function MarketingButton({
  href,
  variant,
  className,
  children
}: {
  href: string;
  variant: "primary" | "secondary" | "text";
  className?: string;
  children: ReactNode;
}) {
  return (
    <a className={["site-button", `site-button-${variant}`, className].filter(Boolean).join(" ")} href={href}>
      {children}
    </a>
  );
}

export function isMarketingPath(pathname: string) {
  return pathname === "/" || pathname === "/site" || PAGE_BY_PATH.has(pathname);
}

export function marketingMetaForPath(pathname: string) {
  return PAGE_BY_PATH.get(pathname) ?? MARKETING_PAGES.home;
}

function pageForLocation() {
  if (typeof window === "undefined") return MARKETING_PAGES.home;
  return marketingMetaForPath(window.location.pathname);
}

function applyMarketingMetadata(page: PageMeta) {
  document.title = page.title;
  upsertMeta("description", page.description);
  upsertMeta("og:title", page.title, "property");
  upsertMeta("og:description", page.description, "property");
  upsertMeta("og:type", "website", "property");
  upsertMeta("og:url", `${window.location.origin}${page.path}`, "property");
  upsertMeta("og:image", `${window.location.origin}/marketing/demos/hero-rulix-review-loop.png`, "property");
  upsertMeta("twitter:card", "summary_large_image");
  upsertCanonical(`${window.location.origin}${page.path}`);
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const update = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

function upsertMeta(name: string, content: string, attribute = "name") {
  let element = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertCanonical(href: string) {
  let element = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement("link");
    element.rel = "canonical";
    document.head.appendChild(element);
  }
  element.href = href;
}
