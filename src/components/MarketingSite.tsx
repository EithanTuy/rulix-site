import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  GitBranch,
  LockKeyhole,
  Mail,
  Menu,
  SearchCheck,
  ShieldCheck,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { CONTACT_EMAIL_TO } from "../lib/contact";
import "../marketing-v2.css";

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

type DemoKey = "find" | "resolve" | "export";
type ComparisonKey = "reasoning" | "evidence" | "reviewer" | "trail";
type TrustKey = "human" | "sources" | "data" | "history";
type UseCaseKey = "officers" | "industry" | "research";

const CONTACT_EMAIL = CONTACT_EMAIL_TO;
const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Rulix access request")}&body=${encodeURIComponent(
  "Organization:\nRole:\nWhat we would like to review:\n\nPlease do not include controlled technical data."
)}`;
const SECTION_IDS = ["product", "review-loop", "trust", "use-cases", "request-access"] as const;

const MARKETING_PAGES: Record<MarketingPageKey, PageMeta> = {
  home: {
    key: "home",
    path: "/",
    title: "Rulix - Export-control memo review",
    description:
      "Rulix maps export-control memo claims to evidence, surfaces gaps, and preserves reviewer decisions in an exportable record.",
    heroTitle: "Find the weak link in every export-control memo.",
    heroCopy:
      "Rulix maps claims to evidence, flags what is still missing, and keeps every reviewer decision in one exportable record."
  },
  "export-control-memo-review": {
    key: "export-control-memo-review",
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review classification memos for unsupported reasoning, evidence gaps, reviewer questions, and signoff.",
    heroTitle: "Find the weak link before an export-control memo reaches signoff.",
    heroCopy:
      "Map claims to evidence, surface unanswered questions, and keep each reviewer decision in one exportable record."
  },
  "eccn-classification-assistant": {
    key: "eccn-classification-assistant",
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Structure ECCN review, evidence gaps, and human signoff without replacing expert judgment.",
    heroTitle: "Make every ECCN conclusion show its work.",
    heroCopy:
      "Rulix ties draft classification reasoning to evidence, flags what is missing, and keeps final judgment with your reviewer."
  },
  "ai-export-compliance-review": {
    key: "ai-export-compliance-review",
    path: "/ai-export-compliance-review",
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI support to spot memo gaps while keeping final determinations with trained reviewers.",
    heroTitle: "Use AI to find the gap—not make the final call.",
    heroCopy:
      "Rulix organizes findings, evidence questions, and reviewer decisions without turning software into the authority."
  },
  "university-export-control-review": {
    key: "university-export-control-review",
    path: "/university-export-control-review",
    title: "University export-control memo review | Rulix",
    description:
      "Help research teams triage public or sanitized memo drafts before final reviewer time.",
    heroTitle: "Give research review drafts a stronger first pass.",
    heroCopy:
      "Separate technical unknowns from conclusions, collect the right evidence, and preserve the path to human signoff."
  },
  "manufacturer-eccn-review": {
    key: "manufacturer-eccn-review",
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Reduce back-and-forth on ECCN evidence, product specifications, and reviewer questions.",
    heroTitle: "Turn product facts into a review-ready ECCN record.",
    heroCopy:
      "Catch missing specifications and unsupported claims before the classification memo reaches final review."
  }
};

const PAGE_BY_PATH = new Map(Object.values(MARKETING_PAGES).map((page) => [page.path, page]));

const DEMOS: Array<{
  key: DemoKey;
  label: string;
  title: string;
  copy: string;
  outcome: string;
  video: string;
  poster: string;
  still: string;
}> = [
  {
    key: "find",
    label: "Find unsupported reasoning",
    title: "Find the claim that needs another look.",
    copy:
      "Rulix highlights weak or missing reasoning beside the memo, while the surrounding text stays in view.",
    outcome: "Finding flagged",
    video: "/marketing/demos/demo-find-missing-reasoning.mp4",
    poster: "/marketing/demos/demo-find-missing-reasoning.webp",
    still: "/marketing/demos/demo-find-missing-reasoning.png"
  },
  {
    key: "resolve",
    label: "Resolve with evidence",
    title: "Turn a gap into the next reviewer action.",
    copy:
      "Accept the finding, request more information, or override it with a note that stays tied to the memo.",
    outcome: "Reviewer action captured",
    video: "/marketing/demos/demo-resolve-review-gaps.mp4",
    poster: "/marketing/demos/demo-resolve-review-gaps.webp",
    still: "/marketing/demos/demo-resolve-review-gaps.png"
  },
  {
    key: "export",
    label: "Export the decision trail",
    title: "Keep the reasoning, response, and final decision together.",
    copy:
      "The export preserves intake, analysis, reviewer notes, resolved findings, and the final review record.",
    outcome: "Record ready",
    video: "/marketing/demos/demo-export-review-record.mp4",
    poster: "/marketing/demos/demo-export-review-record.webp",
    still: "/marketing/demos/demo-export-review-record.png"
  }
];

const WORKFLOW = [
  {
    title: "Add the memo",
    copy: "Upload a public, sanitized, or approved draft and the context your reviewer already has.",
    media: "/marketing/demos/hero-rulix-review-loop.webp"
  },
  {
    title: "Map the reasoning",
    copy: "Rulix identifies claims, cited support, assumptions, and the gaps between them.",
    media: "/marketing/demos/demo-find-missing-reasoning.webp"
  },
  {
    title: "Resolve the gaps",
    copy: "Reviewers accept, request, annotate, or override findings while the memo stays in view.",
    media: "/marketing/demos/demo-resolve-review-gaps.webp"
  },
  {
    title: "Generate the record",
    copy: "Export a reviewer-signed trail of the findings, evidence, notes, and final decisions.",
    media: "/marketing/demos/demo-export-review-record.webp"
  }
];

const COMPARISON_ROWS: Array<{
  key: ComparisonKey;
  label: string;
  generic: string;
  rulix: string;
  inspect: string;
}> = [
  {
    key: "reasoning",
    label: "Reasoning",
    generic: "Returns an answer without showing the review path.",
    rulix: "Shows the claim, relevant controls, and the reasoning behind the finding.",
    inspect: "The memo remains the source of truth while Rulix points to the exact claim that needs review."
  },
  {
    key: "evidence",
    label: "Evidence",
    generic: "May cite sources, but does not keep them tied to specific claims.",
    rulix: "Links each claim to evidence and makes the missing support visible.",
    inspect: "Evidence questions stay attached to the memo passage and the reason the reviewer needs them."
  },
  {
    key: "reviewer",
    label: "Reviewer action",
    generic: "Has no durable place for requests, overrides, or decision notes.",
    rulix: "Captures requests, resolutions, notes, and final reviewer control.",
    inspect: "Every finding becomes an explicit reviewer action instead of disappearing into another chat thread."
  },
  {
    key: "trail",
    label: "Decision trail",
    generic: "A conversation is hard to hand off, explain, or audit.",
    rulix: "Exports a reviewer-ready record of the complete workflow.",
    inspect: "The final record preserves what changed, why it changed, and who made the decision."
  }
];

const TRUST_ITEMS: Array<{
  key: TrustKey;
  title: string;
  summary: string;
  detail: string;
  icon: LucideIcon;
  media: string;
}> = [
  {
    key: "human",
    title: "Human decision required",
    summary: "Rulix finds gaps and suggests questions. Reviewers make the call.",
    detail:
      "No finding becomes a determination on its own. Accept, request more information, or override with a note before the record moves forward.",
    icon: UsersRound,
    media: "/marketing/demos/demo-resolve-review-gaps.webp"
  },
  {
    key: "sources",
    title: "Source-linked findings",
    summary: "Every finding points back to the claim and the evidence it still needs.",
    detail:
      "Reviewers can see the memo passage, the reason for the finding, and the next evidence question in the same surface.",
    icon: GitBranch,
    media: "/marketing/demos/demo-find-missing-reasoning.webp"
  },
  {
    key: "data",
    title: "Public, sanitized, or approved data",
    summary: "The hosted workspace has a clear input boundary.",
    detail:
      "Use public, sanitized, or organization-approved content unless your policy and deployment explicitly permit something else.",
    icon: LockKeyhole,
    media: "/marketing/demos/hero-rulix-review-loop.webp"
  },
  {
    key: "history",
    title: "Exportable review history",
    summary: "Decisions, responses, notes, and evidence move together.",
    detail:
      "The record is built for handoff and final signoff, so the team can explain what changed without reconstructing the process.",
    icon: ClipboardCheck,
    media: "/marketing/demos/demo-export-review-record.webp"
  }
];

const USE_CASES: Array<{
  key: UseCaseKey;
  label: string;
  title: string;
  copy: string;
  preview: string;
  icon: LucideIcon;
}> = [
  {
    key: "officers",
    label: "Export-control officers",
    title: "Audit-ready review without losing the memo.",
    copy:
      "Find unsupported jurisdiction, classification, and end-use reasoning while preserving the reviewer’s decision trail.",
    preview: "Self-classification memo",
    icon: SearchCheck
  },
  {
    key: "industry",
    label: "Manufacturers and labs",
    title: "Turn product facts into answerable review questions.",
    copy:
      "Spot missing specifications, end-use context, and technical support before the memo starts another round of email.",
    preview: "Component classification memo",
    icon: FileCheck2
  },
  {
    key: "research",
    label: "Universities and research offices",
    title: "Prepare cleaner drafts before licensed reviewer time.",
    copy:
      "Separate technical unknowns from review conclusions and keep every follow-up tied to the research memo.",
    preview: "Research equipment memo",
    icon: ShieldCheck
  }
];

const FAQS = [
  {
    question: "Does Rulix make the final classification?",
    answer:
      "No. Rulix is review support. It surfaces gaps, evidence needs, and decision history so qualified people can document the final call."
  },
  {
    question: "What data can we use?",
    answer:
      "Use public, sanitized, or organization-approved information in the hosted workspace unless your policy and deployment allow a different boundary."
  },
  {
    question: "How is this different from a general AI assistant?",
    answer:
      "Rulix keeps the memo, findings, evidence questions, reviewer actions, and export record in one structured workflow instead of a free-form conversation."
  },
  {
    question: "What comes out of a review?",
    answer:
      "A structured set of findings and evidence questions, the reviewer’s responses and decisions, and an exportable record for final signoff."
  }
];

export function MarketingSite() {
  const page = useMemo(() => pageForLocation(), []);
  const reducedMotion = usePrefersReducedMotion();
  const { activeSection, scrolled } = useSectionState();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeDemo, setActiveDemo] = useState<DemoKey>("find");
  const [demoPaused, setDemoPaused] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState(0);
  const [activeComparison, setActiveComparison] = useState<ComparisonKey>("reasoning");
  const [activeTrust, setActiveTrust] = useState<TrustKey>("human");
  const [activeUseCase, setActiveUseCase] = useState<UseCaseKey>("officers");
  const [activeFaq, setActiveFaq] = useState(0);

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
    if (reducedMotion || demoPaused) return;
    const timer = window.setInterval(() => {
      setActiveDemo((current) => {
        const index = DEMOS.findIndex((demo) => demo.key === current);
        return DEMOS[(index + 1) % DEMOS.length].key;
      });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [demoPaused, reducedMotion]);

  return (
    <div className="rulix-site">
      <SiteHeader
        activeSection={activeSection}
        mobileNavOpen={mobileNavOpen}
        onMobileNavChange={setMobileNavOpen}
        scrolled={scrolled}
      />
      <main>
        <Hero page={page} reducedMotion={reducedMotion} />
        <ProductProof
          activeDemo={activeDemo}
          paused={demoPaused}
          reducedMotion={reducedMotion}
          onDemoChange={setActiveDemo}
          onPauseChange={setDemoPaused}
        />
        <ReviewLoop
          activeStep={activeWorkflow}
          onStepChange={setActiveWorkflow}
        />
        <Comparison
          activeRow={activeComparison}
          onRowChange={setActiveComparison}
        />
        <TrustSection activeItem={activeTrust} onItemChange={setActiveTrust} />
        <UseCases activeUseCase={activeUseCase} onUseCaseChange={setActiveUseCase} />
        <FitCheck />
        <ConversionSection
          activeFaq={activeFaq}
          onFaqChange={setActiveFaq}
        />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader({
  activeSection,
  mobileNavOpen,
  onMobileNavChange,
  scrolled
}: {
  activeSection: string;
  mobileNavOpen: boolean;
  onMobileNavChange: (open: boolean) => void;
  scrolled: boolean;
}) {
  const nav = [
    ["product", "Product"],
    ["review-loop", "Review loop"],
    ["trust", "Trust"],
    ["use-cases", "Use cases"]
  ];

  return (
    <header className={["rulix-header", scrolled ? "is-compact" : "", mobileNavOpen ? "is-open" : ""].join(" ")}>
      <a className="rulix-header__brand" href="/" aria-label="Rulix home">
        <BrandLogo tone="dark" size="compact" />
      </a>
      <nav className="rulix-header__nav" aria-label="Primary">
        {nav.map(([id, label]) => (
          <a
            href={`#${id}`}
            aria-current={activeSection === id ? "page" : undefined}
            key={id}
            onClick={() => onMobileNavChange(false)}
          >
            {label}
          </a>
        ))}
        <a href="https://app.rulix.cloud">Sign in</a>
      </nav>
      <div className="rulix-header__actions">
        <a className="rulix-button rulix-button--primary rulix-header__cta" href="#request-access">
          Request access
        </a>
        <button
          className="rulix-menu-button"
          type="button"
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileNavOpen}
          onClick={() => onMobileNavChange(!mobileNavOpen)}
        >
          {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
    </header>
  );
}

function Hero({ page, reducedMotion }: { page: PageMeta; reducedMotion: boolean }) {
  return (
    <section className="rulix-hero" id="top">
      <div className="rulix-shell rulix-hero__grid">
        <div className="rulix-hero__copy">
          <h1>
            {page.key === "home" ? (
              <>
                <span className="rulix-hero-line">Find the weak link</span>
                <span className="rulix-hero-line">
                  in every <span className="rulix-no-break">export-control</span>
                </span>
                <span className="rulix-hero-line">memo.</span>
              </>
            ) : (
              page.heroTitle
            )}
          </h1>
          <p>{page.heroCopy}</p>
          <div className="rulix-hero__actions">
            <a className="rulix-button rulix-button--primary" href="#request-access">
              Request access
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="rulix-button rulix-button--secondary" href="#product">
              Review a sample memo
            </a>
          </div>
        </div>
        <ProductMedia
          autoPlay
          className="rulix-hero__media"
          label="Rulix export-control memo review workspace"
          poster="/marketing/demos/demo-find-missing-reasoning.webp"
          reducedMotion={reducedMotion}
          video="/marketing/demos/demo-find-missing-reasoning.mp4"
        />
      </div>
      <div className="rulix-shell evidence-rail" aria-label="Rulix review path">
        {["Claim", "Evidence gap", "Reviewer decision", "Record"].map((item) => (
          <span key={item}>
            <i aria-hidden="true" />
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}

function ProductProof({
  activeDemo,
  paused,
  reducedMotion,
  onDemoChange,
  onPauseChange
}: {
  activeDemo: DemoKey;
  paused: boolean;
  reducedMotion: boolean;
  onDemoChange: (demo: DemoKey) => void;
  onPauseChange: (paused: boolean) => void;
}) {
  const active = DEMOS.find((demo) => demo.key === activeDemo) ?? DEMOS[0];

  return (
    <section
      className="rulix-band rulix-band--dark product-proof"
      id="product"
      onFocusCapture={() => onPauseChange(true)}
      onBlurCapture={() => onPauseChange(false)}
      onMouseEnter={() => onPauseChange(true)}
      onMouseLeave={() => onPauseChange(false)}
    >
      <div className="rulix-shell product-proof__grid">
        <div className="product-proof__story">
          <h2>See the gap.<br />Ask the question.<br />Keep the decision.</h2>
          <p>
            Rulix stays beside the memo, so every finding has context and every resolution leaves a trail.
          </p>
          <div className="product-proof__active-copy" aria-live="polite">
            <strong>{active.title}</strong>
            <span>{active.copy}</span>
          </div>
          <div className="demo-clock" aria-label={paused ? "Demo paused" : "Demo playing"}>
            <span>Demo</span>
            <time>00:00 / 00:06</time>
            <div className="demo-clock__track">
              <i key={`${active.key}-${paused}`} className={paused ? "is-paused" : ""} />
            </div>
          </div>
        </div>
        <div className="product-proof__stage">
          <div className="demo-tabs" role="tablist" aria-label="Rulix product demos">
            {DEMOS.map((demo) => (
              <button
                type="button"
                role="tab"
                aria-selected={demo.key === activeDemo}
                aria-controls={`demo-panel-${demo.key}`}
                className={demo.key === activeDemo ? "is-active" : ""}
                id={`demo-tab-${demo.key}`}
                key={demo.key}
                onClick={() => onDemoChange(demo.key)}
              >
                {demo.label}
              </button>
            ))}
          </div>
          <div
            className="product-proof__panel"
            id={`demo-panel-${active.key}`}
            role="tabpanel"
            aria-labelledby={`demo-tab-${active.key}`}
          >
            <ProductMedia
              autoPlay
              key={active.key}
              label={`${active.label} Rulix product demo`}
              poster={active.poster}
              reducedMotion={reducedMotion}
              video={active.video}
            />
            <div className="product-proof__outcome">
              <i aria-hidden="true" />
              Outcome: {active.outcome}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewLoop({ activeStep, onStepChange }: { activeStep: number; onStepChange: (step: number) => void }) {
  const active = WORKFLOW[activeStep];

  return (
    <section className="rulix-band review-loop" id="review-loop">
      <div className="rulix-shell review-loop__grid">
        <div className="review-loop__visual">
          <h2>A review that moves<br />like your reviewers do.</h2>
          <p>A structured workflow that keeps the memo, the evidence, and the decision in one place.</p>
          <div className="review-loop__media" key={active.title}>
            <img src={active.media} alt={`${active.title} in the Rulix workspace`} />
          </div>
        </div>
        <div className="review-loop__steps" role="list" aria-label="Rulix review workflow">
          {WORKFLOW.map((step, index) => (
            <button
              className={index === activeStep ? "is-active" : ""}
              type="button"
              role="listitem"
              aria-pressed={index === activeStep}
              key={step.title}
              onClick={() => onStepChange(index)}
              onFocus={() => onStepChange(index)}
              onMouseEnter={() => onStepChange(index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.copy}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Comparison({ activeRow, onRowChange }: { activeRow: ComparisonKey; onRowChange: (row: ComparisonKey) => void }) {
  const active = COMPARISON_ROWS.find((row) => row.key === activeRow) ?? COMPARISON_ROWS[0];

  return (
    <section className="rulix-band rulix-band--dark comparison-section">
      <div className="rulix-shell comparison-section__grid">
        <div className="comparison-section__copy">
          <h2>Not another answer.<br />A review record.</h2>
          <p>Rulix keeps the why, the what, and the decision in one place.</p>
        </div>
        <div className="comparison-table" role="table" aria-label="Generic AI chat compared with Rulix review">
          <div className="comparison-table__row comparison-table__head" role="row">
            <span role="columnheader">Review need</span>
            <span role="columnheader">Generic AI chat</span>
            <span role="columnheader">Rulix review</span>
          </div>
          {COMPARISON_ROWS.map((row) => (
            <button
              className={row.key === activeRow ? "comparison-table__row is-active" : "comparison-table__row"}
              type="button"
              role="row"
              aria-pressed={row.key === activeRow}
              key={row.key}
              onClick={() => onRowChange(row.key)}
            >
              <strong role="cell">{row.label}</strong>
              <span role="cell">{row.generic}</span>
              <span role="cell">
                {row.rulix}
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </button>
          ))}
          <div className="comparison-table__inspect" aria-live="polite">
            <SearchCheck size={18} aria-hidden="true" />
            <p><strong>{active.label}:</strong> {active.inspect}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustSection({ activeItem, onItemChange }: { activeItem: TrustKey; onItemChange: (item: TrustKey) => void }) {
  const active = TRUST_ITEMS.find((item) => item.key === activeItem) ?? TRUST_ITEMS[0];

  return (
    <section className="rulix-band trust-section" id="trust">
      <div className="rulix-shell trust-section__grid">
        <div className="trust-section__copy">
          <h2>Clear boundaries,<br />visible at every step.</h2>
          <p>Rulix is built for reviewer control and an auditable trail—not autonomous legal judgment.</p>
          <a href="#review-loop">Learn how the review works <ArrowRight size={15} aria-hidden="true" /></a>
        </div>
        <div className="trust-accordion">
          {TRUST_ITEMS.map((item) => {
            const expanded = item.key === activeItem;
            const Icon = item.icon;
            return (
              <article className={expanded ? "trust-item is-open" : "trust-item"} key={item.key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`trust-panel-${item.key}`}
                  onClick={() => onItemChange(item.key)}
                >
                  <span><Icon size={17} aria-hidden="true" /></span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.summary}</small>
                  </div>
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
                {expanded ? <p id={`trust-panel-${item.key}`}>{item.detail}</p> : null}
              </article>
            );
          })}
        </div>
        <figure className="trust-preview" key={active.key}>
          <div className="trust-preview__top">
            <span>Inspecting</span>
            <strong>{active.title}</strong>
          </div>
          <img src={active.media} alt={`${active.title} shown in Rulix`} />
          <figcaption>{active.detail}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function UseCases({ activeUseCase, onUseCaseChange }: { activeUseCase: UseCaseKey; onUseCaseChange: (item: UseCaseKey) => void }) {
  const active = USE_CASES.find((item) => item.key === activeUseCase) ?? USE_CASES[0];
  const ActiveIcon = active.icon;

  return (
    <section className="rulix-band use-cases" id="use-cases">
      <div className="rulix-shell use-cases__grid">
        <div className="use-cases__copy">
          <h2>Built for the people<br />who have to show<br />their work.</h2>
          <p>Different teams. The same outcome: clearer reasoning, defensible decisions, and a record that survives handoff.</p>
        </div>
        <div className="use-cases__stage">
          <div className="use-case-tabs" role="tablist" aria-label="Rulix use cases">
            {USE_CASES.map((item) => (
              <button
                type="button"
                role="tab"
                aria-selected={item.key === activeUseCase}
                aria-controls={`use-case-panel-${item.key}`}
                className={item.key === activeUseCase ? "is-active" : ""}
                id={`use-case-tab-${item.key}`}
                key={item.key}
                onClick={() => onUseCaseChange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <article
            className="use-case-panel"
            id={`use-case-panel-${active.key}`}
            role="tabpanel"
            aria-labelledby={`use-case-tab-${active.key}`}
            key={active.key}
          >
            <div className="use-case-panel__copy">
              <ActiveIcon size={22} aria-hidden="true" />
              <h3>{active.title}</h3>
              <p>{active.copy}</p>
              <span>Previewing: {active.preview}</span>
            </div>
            <img src="/marketing/demos/demo-resolve-review-gaps.webp" alt={`${active.preview} in Rulix`} />
          </article>
        </div>
      </div>
    </section>
  );
}

function FitCheck() {
  return (
    <section className="rulix-band rulix-band--dark fit-check" id="fit-check">
      <div className="rulix-shell fit-check__grid">
        <h2>Rulix belongs where review needs structure—not autopilot.</h2>
        <FitList
          title="A fit when"
          items={[
            "You need reviewer-owned workflows.",
            "You want evidence-aware gap finding.",
            "You use public, sanitized, or approved data.",
            "You need an exportable review record."
          ]}
        />
        <FitList
          muted
          title="Not a fit when"
          items={[
            "You want the system to make legal determinations.",
            "You cannot provide context or evidence.",
            "You need a general-purpose chat assistant.",
            "You cannot define your review process."
          ]}
        />
      </div>
    </section>
  );
}

function FitList({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return (
    <div className={muted ? "fit-list is-muted" : "fit-list"}>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>
            {muted ? <X size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversionSection({ activeFaq, onFaqChange }: { activeFaq: number; onFaqChange: (faq: number) => void }) {
  return (
    <section className="rulix-band conversion-section" id="request-access">
      <div className="rulix-shell conversion-section__grid">
        <div className="conversion-section__copy">
          <h2>Bring a memo. Leave with the questions that matter.</h2>
          <p>
            Use a public, sanitized, or approved sample. We’ll show you where the reasoning holds, where it breaks, and what your reviewer should ask next.
          </p>
        </div>
        <div className="faq-list">
          {FAQS.map((item, index) => {
            const expanded = index === activeFaq;
            return (
              <article className={expanded ? "faq-item is-open" : "faq-item"} key={item.question}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`faq-answer-${index}`}
                  onClick={() => onFaqChange(expanded ? -1 : index)}
                >
                  {item.question}
                  <ChevronDown size={17} aria-hidden="true" />
                </button>
                {expanded ? <p id={`faq-answer-${index}`}>{item.answer}</p> : null}
              </article>
            );
          })}
        </div>
        <div className="access-contact">
          <div className="access-contact__icon" aria-hidden="true"><Mail size={22} /></div>
          <span className="access-contact__eyebrow">Direct contact</span>
          <h3>Start with an email.</h3>
          <p>Tell us what your team reviews and where the current process slows down. We’ll reply with access and a focused next step.</p>
          <a className="access-contact__email" href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>
          <a className="rulix-button rulix-button--primary access-contact__button" href={CONTACT_MAILTO}>
            Email the Rulix team
            <ArrowRight size={17} aria-hidden="true" />
          </a>
          <small>We usually reply within one business day. Please don’t email controlled technical data.</small>
        </div>
      </div>
    </section>
  );
}

function ProductMedia({
  autoPlay = false,
  className = "",
  label,
  poster,
  reducedMotion,
  video
}: {
  autoPlay?: boolean;
  className?: string;
  label: string;
  poster: string;
  reducedMotion: boolean;
  video: string;
}) {
  return (
    <figure className={["product-media", className].filter(Boolean).join(" ")}>
      <div className="product-media__top">
        <BrandLogo tone="light" size="compact" />
        <span>Reviewer workspace</span>
        <strong>Human signoff</strong>
      </div>
      {reducedMotion ? (
        <img src={poster} alt={label} />
      ) : (
        <video muted loop playsInline autoPlay={autoPlay} preload="metadata" poster={poster} aria-label={label}>
          <source src={video} type="video/mp4" />
        </video>
      )}
    </figure>
  );
}

function SiteFooter() {
  return (
    <footer className="rulix-footer">
      <div className="rulix-shell rulix-footer__grid">
        <div>
          <BrandLogo tone="dark" size="compact" />
          <p>Export-control memo review with human signoff.</p>
          <small>© 2026 Rulix. Public, sanitized, or approved input only.</small>
        </div>
        <FooterLinks title="Product" links={[["Product overview", "#product"], ["Review loop", "#review-loop"], ["Use cases", "#use-cases"]]} />
        <FooterLinks title="Trust" links={[["How it works", "#trust"], ["Security and data handling", "/security"], ["Fit check", "#fit-check"]]} />
        <FooterLinks title="Company" links={[["About", "/#top"], ["Contact", `mailto:${CONTACT_EMAIL}`], ["Sign in", "https://app.rulix.cloud"]]} />
        <FooterLinks title="Legal" links={[["Privacy policy", "/legal"], ["Terms of service", "/legal"]]} />
      </div>
    </footer>
  );
}

function FooterLinks({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <nav aria-label={title}>
      <strong>{title}</strong>
      {links.map(([label, href]) => <a href={href} key={label}>{label}</a>)}
    </nav>
  );
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

function useSectionState() {
  const [activeSection, setActiveSection] = useState<string>("product");
  const [scrolled, setScrolled] = useState(false);
  const frameRef = useRef<number>();

  useEffect(() => {
    const update = () => {
      frameRef.current = undefined;
      setScrolled(window.scrollY > 24);
      let current = "product";
      for (const id of SECTION_IDS) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= 190) current = id;
      }
      setActiveSection(current);
    };
    const onScroll = () => {
      if (frameRef.current !== undefined) return;
      frameRef.current = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return { activeSection, scrolled };
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
