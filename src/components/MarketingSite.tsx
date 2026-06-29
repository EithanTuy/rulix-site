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
    title: "Rulix - Export-control memo review",
    description:
      "Rulix helps export-control, legal, and compliance teams review memo reasoning, surface gaps, and prepare clear decision records.",
    heroTitle: "Export-control memo review, organized.",
    heroCopy:
      "Rulix helps reviewers find gaps, ask better evidence questions, and prepare a clean record before final signoff."
  },
  "export-control-memo-review": {
    key: "export-control-memo-review",
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review classification memos for weak reasoning, evidence gaps, reviewer questions, and signoff.",
    heroTitle: "Review export-control memos with a clear trail.",
    heroCopy:
      "Test classification logic, spot unsupported claims, and document the evidence behind each decision."
  },
  "eccn-classification-assistant": {
    key: "eccn-classification-assistant",
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Structure ECCN review, evidence gaps, and human signoff without replacing expert judgment.",
    heroTitle: "ECCN review support for human reviewers.",
    heroCopy:
      "Turn draft classification memos into structured work: claims, assumptions, missing evidence, and signoff notes."
  },
  "ai-export-compliance-review": {
    key: "ai-export-compliance-review",
    path: "/ai-export-compliance-review",
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI support to spot memo gaps while keeping final determinations with trained reviewers.",
    heroTitle: "AI-assisted export review, kept in human hands.",
    heroCopy:
      "Pressure-test reasoning, surface questions, and organize evidence while expert reviewers stay in charge."
  },
  "university-export-control-review": {
    key: "university-export-control-review",
    path: "/university-export-control-review",
    title: "University export-control memo review | Rulix",
    description:
      "Help universities and research teams triage public or sanitized memo drafts before final reviewer time.",
    heroTitle: "Memo triage for research teams.",
    heroCopy:
      "Prepare cleaner drafts, isolate missing technical facts, and keep reviewer questions organized."
  },
  "manufacturer-eccn-review": {
    key: "manufacturer-eccn-review",
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Help manufacturers and labs reduce back-and-forth on ECCN evidence, product specs, and reviewer questions.",
    heroTitle: "ECCN review packets for manufacturers and labs.",
    heroCopy:
      "Catch missing specs and unsupported claims before final classification review."
  }
};

const PAGE_BY_PATH = new Map(Object.values(MARKETING_PAGES).map((page) => [page.path, page]));

const proofChips = [
  { label: "Find missing evidence", icon: SearchCheck },
  { label: "Keep reviewers in control", icon: UsersRound },
  { label: "Export a clean record", icon: ClipboardCheck }
];

const problemCards = [
  {
    title: "Manual review is slow",
    copy: "Teams lose time checking claims, citations, assumptions, and missing context across drafts and comments.",
    icon: ClipboardList
  },
  {
    title: "Review risk hides in details",
    copy: "Small gaps in end-use, jurisdiction, classification logic, or party context can surface late.",
    icon: AlertTriangle
  },
  {
    title: "Clear records take work",
    copy: "Final memos need a trace of conclusions, changes, and supporting evidence.",
    icon: ShieldCheck
  }
];

const demoSteps = [
  {
    title: "Upload memo",
    label: "Draft uploaded",
    copy: "A sanitized memo and context enter the workspace.",
    detail: "Rulix separates claims, cited sources, assumptions, and visible facts."
  },
  {
    title: "Analyze reasoning",
    label: "Reasoning mapped",
    copy: "The review pass highlights unsupported assertions and missing logic.",
    detail: "Weak jurisdiction analysis, incomplete ECCN reasoning, and end-user gaps are surfaced for review."
  },
  {
    title: "Resolve gaps",
    label: "Checklist created",
    copy: "Findings become a checklist with evidence requests and owner-ready notes.",
    detail: "Each note stays tied to the memo location, risk context, and needed evidence."
  },
  {
    title: "Export record",
    label: "Record prepared",
    copy: "Resolved findings become a clean internal record.",
    detail: "The summary preserves findings, responses, evidence links, and trail events."
  }
];

const demoMediaCatalog: Record<"hero" | DemoMediaKey, DemoMedia> = {
  hero: {
    title: "Rulix review loop",
    duration: "10s",
    poster: "/marketing/demos/hero-rulix-review-loop.webp",
    video: "/marketing/demos/hero-rulix-review-loop.mp4",
    still: "/marketing/demos/hero-rulix-review-loop.png",
    buyerQuestionAnswered: "How does a memo move from draft to review record?"
  },
  findMissingReasoning: {
    title: "Find missing reasoning",
    duration: "6s",
    poster: "/marketing/demos/demo-find-missing-reasoning.webp",
    video: "/marketing/demos/demo-find-missing-reasoning.mp4",
    still: "/marketing/demos/demo-find-missing-reasoning.png",
    buyerQuestionAnswered: "Where is the memo reasoning weak?"
  },
  resolveReviewGaps: {
    title: "Resolve review gaps",
    duration: "6s",
    poster: "/marketing/demos/demo-resolve-review-gaps.webp",
    video: "/marketing/demos/demo-resolve-review-gaps.mp4",
    still: "/marketing/demos/demo-resolve-review-gaps.png",
    buyerQuestionAnswered: "Can teams close gaps without losing context?"
  },
  exportReviewRecord: {
    title: "Export a clear record",
    duration: "6s",
    poster: "/marketing/demos/demo-export-review-record.webp",
    video: "/marketing/demos/demo-export-review-record.mp4",
    still: "/marketing/demos/demo-export-review-record.png",
    buyerQuestionAnswered: "Can the team export the review trail?"
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
    copy: "Analysis and Evidence Map show unsupported jurisdiction, ECCN, and end-use reasoning beside the memo.",
    proof: ["Analysis panel", "Evidence Map", "Memo highlights"],
    outcome: "Reviewers see the weak link before signoff."
  },
  {
    key: "resolveReviewGaps",
    title: "Resolve review gaps",
    shortTitle: "Resolve gaps",
    copy: "Highlighted findings become actions: accept, request more information, or override with notes.",
    proof: ["Finding selection", "Decision tab", "Reviewer checklist"],
    outcome: "Fits workflows that need a human decision trail."
  },
  {
    key: "exportReviewRecord",
    title: "Export a clear record",
    shortTitle: "Export record",
    copy: "The export view preserves intake, analysis, reviewer decisions, and report generation.",
    proof: ["Audit tab", "Decision note", "Report export"],
    outcome: "Teams get an internal record they can explain."
  }
];

const workflowSteps = [
  {
    title: "Add the memo",
    copy: "Upload or paste memo content, support docs, classifications, and context.",
    panel: "Memo, attachments, item facts"
  },
  {
    title: "Map the reasoning",
    copy: "Rulix identifies claims, assumptions, missing evidence, and decision logic.",
    panel: "Claims, sources, assumptions"
  },
  {
    title: "Flag review risk",
    copy: "Gaps are grouped by what a reviewer needs to inspect.",
    panel: "Jurisdiction, ECCN, end use"
  },
  {
    title: "Generate the record",
    copy: "Export the summary, checklist, and review trail for final signoff.",
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
    title: "Human review stays central",
    copy: "Rulix supports expert reviewers. It does not replace legal or compliance judgment.",
    icon: UsersRound
  },
  {
    title: "Suggestions with context",
    copy: "Findings point back to memo sections, rationale gaps, and the evidence needed to resolve them.",
    icon: GitBranch
  },
  {
    title: "Clear review history",
    copy: "Comments, decisions, and exports are organized so teams can explain how the memo changed.",
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
    title: "Pressure-test memo reasoning before signoff",
    who: "Counsel and legal operations",
    outcome: "See missing jurisdiction, classification, and evidence support before final review.",
    fit: "Best when legal wants structured notes, not a model making the decision.",
    icon: FileSearch
  },
  {
    key: "compliance",
    label: "Compliance",
    title: "Standardize export-control review",
    who: "Export-control and compliance teams",
    outcome: "Turn drafts into evidence findings, reviewer actions, and a clean record.",
    fit: "Best when the team needs repeatable review across memo owners.",
    icon: SearchCheck
  },
  {
    key: "founders",
    label: "Founders",
    title: "Get cleaner review packets before escalation",
    who: "Founders and executives handling technical trade decisions",
    outcome: "Find missing facts before asking counsel or outside advisors for final review.",
    fit: "Best when the company has technical facts but needs a clearer packet.",
    icon: FileCheck2
  },
  {
    key: "operations",
    label: "Operations",
    title: "Reduce back-and-forth on memo evidence",
    who: "Operations, product, and engineering teams",
    outcome: "Collect missing specs, party context, and end-use support before review stalls.",
    fit: "Best when non-lawyers prepare the facts and reviewers need a consistent packet.",
    icon: UsersRound
  },
  {
    key: "universities",
    label: "Universities/Labs",
    title: "Triage public or sanitized research review drafts",
    who: "University export-control offices and research operations",
    outcome: "Separate technical unknowns from review conclusions before final reviewer time.",
    fit: "Best when data is public, sanitized, or approved for the workspace.",
    icon: ShieldCheck
  }
];

const fitCards = [
  {
    title: "Rulix fits when",
    copy: "Your team reviews memo drafts, needs evidence-aware gap finding, and keeps final judgment with people.",
    icon: CheckCircle2,
    tone: "fit"
  },
  {
    title: "Data boundary",
    copy: "Use only public, sanitized, or approved data in the hosted workspace unless your policy allows more.",
    icon: LockKeyhole,
    tone: "boundary"
  },
  {
    title: "Rulix is not a fit when",
    copy: "You need guaranteed classifications, autonomous legal decisions, or a place for unmanaged sensitive data.",
    icon: AlertTriangle,
    tone: "not-fit"
  }
];

const faqItems = [
  {
    question: "How should we use Rulix for regulatory work?",
    answer:
      "Use it as review support. Rulix surfaces gaps, evidence needs, and decision history so qualified humans can document the final call."
  },
  {
    question: "What if AI gets something wrong?",
    answer:
      "Model output is treated as a finding to review, not final truth. Analysis stays tied to memo passages, source context, and human signoff."
  },
  {
    question: "How is this different from generic AI?",
    answer:
      "Generic chat is free-form. Rulix keeps intake, evidence gaps, decisions, audit trail, and export records in one workflow."
  },
  {
    question: "Does Rulix replace counsel or compliance reviewers?",
    answer:
      "No. Rulix assists expert review; it does not make legal guarantees or regulatory determinations."
  },
  {
    question: "What data can we put into it?",
    answer:
      "Use public, sanitized, or approved data in the hosted app unless your organization has approved a different boundary."
  }
];

const securityItems = [
  {
    title: "Data handling",
    copy: "Use public, sanitized, or approved data in the hosted workspace unless your policy allows more.",
    icon: LockKeyhole
  },
  {
    title: "Access control",
    copy: "Account-based workspaces and invite-only team access.",
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

  useEffect(() => {
    if (reducedMotion) {
      return;
    }

    const rotation = window.setInterval(() => {
      setActiveDemo((currentDemo) => {
        const currentIndex = demoModules.findIndex((demo) => demo.key === currentDemo);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % demoModules.length;
        return demoModules[nextIndex].key;
      });
    }, 6200);

    return () => window.clearInterval(rotation);
  }, [reducedMotion]);

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
          <BrandLogo tone="adaptive" size="compact" />
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
        <BrandLogo tone="adaptive" size="compact" />
        <p>Export-control memo review with human signoff.</p>
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
          <p className="site-eyebrow">
            <span aria-hidden="true" />
            For export-control, legal, and compliance teams
          </p>
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
          <p className="site-hero-note">
            Review support only. Final judgment stays with qualified people.
          </p>
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
      <div className="proof-hotspots" aria-label="What the product preview shows">
        <span>
          <SearchCheck size={16} aria-hidden="true" />
          Unsupported claim flagged
        </span>
        <span>
          <GitBranch size={16} aria-hidden="true" />
          Evidence trail mapped
        </span>
        <span>
          <ClipboardCheck size={16} aria-hidden="true" />
          Review record prepared
        </span>
      </div>
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
          label="The review gap"
          title="Reviews slow down when reasoning is scattered."
          copy="Export-control review slows when teams cannot see which assumptions, evidence, and questions support the final memo."
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
            title="See what Rulix helps reviewers catch."
            copy="The product stays close to the memo: analysis, evidence gaps, reviewer actions, audit trail, and export state."
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
        key={media.video}
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
          copy="Rulix supports memo review. It is not autopilot legal judgment, guaranteed classification, or a place for unmanaged sensitive data."
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
          copy="The workflow turns scattered draft analysis into a record reviewers can inspect, revise, and approve."
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
          copy="Rulix is built around export-control memo work: findings, evidence requests, reviewer resolution, and record export."
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
            label="Trust"
            title="Human judgment stays in control."
            copy="Rulix gives reviewers structured findings and traceable suggestions without turning software into the final authority."
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
          title="For teams who own export-control review."
          copy="Each team gets a shared review surface while final regulatory judgment stays with qualified reviewers."
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
          title="Plain answers for careful buyers."
          copy="Rulix helps reviewers work faster and explain decisions better. It does not replace qualified judgment."
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
            title="Designed for technical trade decisions."
            copy="Built around where reviews get stuck: scattered comments, missing facts, unresolved assumptions, and the final trail."
          />
          <div className="credibility-proof-list" aria-label="Rulix proof points">
            <span>Memo reasoning</span>
            <span>Evidence gaps</span>
            <span>Reviewer signoff</span>
          </div>
        </div>
        <article className="case-study-card">
          <span>Illustrative use case</span>
          <h3>A cleaner path before final memo approval</h3>
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
          copy="Built for controlled workflows: account-based access, review history, and clear guidance about what belongs in a hosted workspace."
        />
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
            title="See if Rulix fits your review workflow."
            copy="Send a few details. We'll use them to understand fit and suggest a sensible next step."
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
              I have a redacted memo sample ready.
            </span>
          </label>
          <button className="site-button site-button-primary site-button-full" type="submit">
            <Mail size={18} aria-hidden="true" />
            Request access
          </button>
          {submitted && (
            <p className="form-confirmation">
              Opening your mail client. Attach only public, sanitized, or approved samples.
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
          copy="Each page keeps the same review-support boundary for a specific use case."
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
