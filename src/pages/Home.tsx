import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  FileSearch,
  GitBranch,
  LockKeyhole,
  Mail,
  SearchCheck,
  ShieldCheck,
  UploadCloud,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";

export type LandingVariant =
  | "default"
  | "memo-review"
  | "eccn-assistant"
  | "ai-review"
  | "university"
  | "manufacturer";

type DemoKey = "findMissingReasoning" | "resolveReviewGaps" | "exportReviewRecord";
type UseCaseKey = "legal" | "compliance" | "founders" | "operations" | "universities";

interface PageMeta {
  title: string;
  description: string;
  h1: string;
  body: string;
}

const META: Record<LandingVariant, PageMeta> = {
  default: {
    title: "Rulix - Export-control memo review",
    description:
      "Rulix helps export-control, legal, and compliance teams review memo reasoning, surface gaps, and prepare clear decision records.",
    h1: "Export-control memo review, organized.",
    body:
      "Rulix helps reviewers find gaps, ask better evidence questions, and prepare a clean record before final signoff.",
  },
  "memo-review": {
    title: "Export-control memo review software | Rulix",
    description:
      "Review classification memos for weak reasoning, evidence gaps, reviewer questions, and signoff.",
    h1: "Review export-control memos with a clear trail.",
    body:
      "Test classification logic, spot unsupported claims, and document the evidence behind each decision.",
  },
  "eccn-assistant": {
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Structure ECCN review, evidence gaps, and human signoff without replacing expert judgment.",
    h1: "ECCN review support for human reviewers.",
    body:
      "Turn draft classification memos into structured work: claims, assumptions, missing evidence, and signoff notes.",
  },
  "ai-review": {
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI support to spot memo gaps while keeping final determinations with trained reviewers.",
    h1: "AI-assisted export review, kept in human hands.",
    body:
      "Pressure-test reasoning, surface questions, and organize evidence while expert reviewers stay in charge.",
  },
  university: {
    title: "University export-control memo review | Rulix",
    description:
      "Help universities and research teams triage public or sanitized memo drafts before final reviewer time.",
    h1: "Memo triage for research teams.",
    body:
      "Prepare cleaner drafts, isolate missing technical facts, and keep reviewer questions organized.",
  },
  manufacturer: {
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Help manufacturers and labs reduce back-and-forth on ECCN evidence, product specs, and reviewer questions.",
    h1: "ECCN review packets for manufacturers and labs.",
    body:
      "Catch missing specs and unsupported claims before final classification review.",
  },
};

const proofChips = [
  { label: "Find missing evidence", icon: SearchCheck },
  { label: "Keep reviewers in control", icon: UsersRound },
  { label: "Export a clean record", icon: ClipboardCheck },
];

const problemCards = [
  {
    title: "Manual review is slow",
    copy: "Teams lose time checking claims, citations, assumptions, and missing context across drafts and comments.",
    icon: ClipboardCheck,
  },
  {
    title: "Review risk hides in details",
    copy: "Small gaps in end-use, jurisdiction, classification logic, or party context can surface late.",
    icon: AlertTriangle,
  },
  {
    title: "Clear records take work",
    copy: "Final memos need a trace of conclusions, changes, and supporting evidence.",
    icon: ShieldCheck,
  },
];

const demoMedia: Record<"hero" | DemoKey, { title: string; duration: string; poster: string; video: string; still: string; prompt: string }> = {
  hero: {
    title: "Rulix review loop",
    duration: "10s",
    poster: "/marketing/demos/hero-rulix-review-loop.webp",
    video: "/marketing/demos/hero-rulix-review-loop.mp4",
    still: "/marketing/demos/hero-rulix-review-loop.png",
    prompt: "How does a memo move from draft to review record?",
  },
  findMissingReasoning: {
    title: "Find missing reasoning",
    duration: "6s",
    poster: "/marketing/demos/demo-find-missing-reasoning.webp",
    video: "/marketing/demos/demo-find-missing-reasoning.mp4",
    still: "/marketing/demos/demo-find-missing-reasoning.png",
    prompt: "Where is the memo reasoning weak?",
  },
  resolveReviewGaps: {
    title: "Resolve review gaps",
    duration: "6s",
    poster: "/marketing/demos/demo-resolve-review-gaps.webp",
    video: "/marketing/demos/demo-resolve-review-gaps.mp4",
    still: "/marketing/demos/demo-resolve-review-gaps.png",
    prompt: "Can teams close gaps without losing context?",
  },
  exportReviewRecord: {
    title: "Export a clear record",
    duration: "6s",
    poster: "/marketing/demos/demo-export-review-record.webp",
    video: "/marketing/demos/demo-export-review-record.mp4",
    still: "/marketing/demos/demo-export-review-record.png",
    prompt: "Can the team export the review trail?",
  },
};

const demoModules: Array<{
  key: DemoKey;
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
    outcome: "Reviewers see the weak link before signoff.",
  },
  {
    key: "resolveReviewGaps",
    title: "Resolve review gaps",
    shortTitle: "Resolve gaps",
    copy: "Highlighted findings become actions: accept, request more information, or override with notes.",
    proof: ["Finding selection", "Decision tab", "Reviewer checklist"],
    outcome: "Fits workflows that need a human decision trail.",
  },
  {
    key: "exportReviewRecord",
    title: "Export a clear record",
    shortTitle: "Export record",
    copy: "The export view preserves intake, analysis, reviewer decisions, and report generation.",
    proof: ["Audit tab", "Decision note", "Report export"],
    outcome: "Teams get an internal record they can explain.",
  },
];

const workflowSteps = [
  { title: "Add the memo", copy: "Upload or paste memo content, support docs, classifications, and context.", panel: "Memo, attachments, item facts" },
  { title: "Map the reasoning", copy: "Rulix identifies claims, assumptions, missing evidence, and decision logic.", panel: "Claims, sources, assumptions" },
  { title: "Flag review risk", copy: "Gaps are grouped by what a reviewer needs to inspect.", panel: "Jurisdiction, ECCN, end use" },
  { title: "Generate the record", copy: "Export the summary, checklist, and review trail for final signoff.", panel: "Findings, responses, audit trail" },
];

const comparisonRows = [
  ["Workflow shape", "Unstructured conversation", "Scattered comments", "Structured memo review"],
  ["Traceability", "Hard to audit", "Depends on reviewer notes", "Findings tied to reasoning"],
  ["Context retention", "Easy to lose", "Split across tools", "Memo, evidence, and trail together"],
  ["Review output", "Free-form answer", "Variable quality", "Reviewer-ready record"],
];

const trustItems = [
  { title: "Human review stays central", copy: "Rulix supports expert reviewers. It does not replace legal or compliance judgment.", icon: UsersRound },
  { title: "Suggestions with context", copy: "Findings point back to memo sections, rationale gaps, and the evidence needed to resolve them.", icon: GitBranch },
  { title: "Clear review history", copy: "Comments, decisions, and exports are organized so teams can explain how the memo changed.", icon: ClipboardCheck },
];

const useCases: Array<{
  key: UseCaseKey;
  label: string;
  title: string;
  who: string;
  outcome: string;
  fit: string;
  icon: LucideIcon;
}> = [
  { key: "legal", label: "Legal", title: "Pressure-test memo reasoning before signoff", who: "Counsel and legal operations", outcome: "See missing jurisdiction, classification, and evidence support before final review.", fit: "Best when legal wants structured notes, not a model making the decision.", icon: FileSearch },
  { key: "compliance", label: "Compliance", title: "Standardize export-control review", who: "Export-control and compliance teams", outcome: "Turn drafts into evidence findings, reviewer actions, and a clean record.", fit: "Best when the team needs repeatable review across memo owners.", icon: SearchCheck },
  { key: "founders", label: "Founders", title: "Get cleaner review packets before escalation", who: "Founders and executives handling technical trade decisions", outcome: "Find missing facts before asking counsel or outside advisors for final review.", fit: "Best when the company has technical facts but needs a clearer packet.", icon: FileCheck2 },
  { key: "operations", label: "Operations", title: "Reduce back-and-forth on memo evidence", who: "Operations, product, and engineering teams", outcome: "Collect missing specs, party context, and end-use support before review stalls.", fit: "Best when non-lawyers prepare the facts and reviewers need a consistent packet.", icon: UsersRound },
  { key: "universities", label: "Universities/Labs", title: "Triage public or sanitized research review drafts", who: "University export-control offices and research operations", outcome: "Separate technical unknowns from review conclusions before final reviewer time.", fit: "Best when data is public, sanitized, or approved for the workspace.", icon: ShieldCheck },
];

const fitCards = [
  { title: "Rulix fits when", copy: "Your team reviews memo drafts, needs evidence-aware gap finding, and keeps final judgment with people.", icon: CheckCircle2, tone: "fit" },
  { title: "Data boundary", copy: "Use only public, sanitized, or approved data in the hosted workspace unless your policy allows more.", icon: LockKeyhole, tone: "boundary" },
  { title: "Rulix is not a fit when", copy: "You need guaranteed classifications, autonomous legal decisions, or a place for unmanaged sensitive data.", icon: AlertTriangle, tone: "not-fit" },
];

const faqItems = [
  { question: "How should we use Rulix for regulatory work?", answer: "Use it as review support. Rulix surfaces gaps, evidence needs, and decision history so qualified humans can document the final call." },
  { question: "What if AI gets something wrong?", answer: "Model output is treated as a finding to review, not final truth. Analysis stays tied to memo passages, source context, and human signoff." },
  { question: "How is this different from generic AI?", answer: "Generic chat is free-form. Rulix keeps intake, evidence gaps, decisions, audit trail, and export records in one workflow." },
  { question: "Does Rulix replace counsel or compliance reviewers?", answer: "No. Rulix assists expert review; it does not make legal guarantees or regulatory determinations." },
  { question: "What data can we put into it?", answer: "Use public, sanitized, or approved data in the hosted app unless your organization has approved a different boundary." },
];

const EMAIL = "security@rulix.cloud";

export function Home({ variant = "default" }: { variant?: LandingVariant }) {
  const meta = META[variant];
  const [activeDemo, setActiveDemo] = useState<DemoKey>("findMissingReasoning");
  const [activeUseCase, setActiveUseCase] = useState<UseCaseKey>("compliance");
  const [activeFaq, setActiveFaq] = useState(1);

  usePageMeta(meta.title, meta.description);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) return;

    const rotation = window.setInterval(() => {
      setActiveDemo((currentDemo) => {
        const currentIndex = demoModules.findIndex((demo) => demo.key === currentDemo);
        return demoModules[(currentIndex + 1) % demoModules.length].key;
      });
    }, 6200);

    return () => window.clearInterval(rotation);
  }, []);

  return (
    <>
      <Hero meta={meta} />
      <ProblemCards />
      <ProductDemo activeDemo={activeDemo} onDemoChange={setActiveDemo} />
      <FitCheck />
      <HowItWorks />
      <ComparisonSection />
      <TrustSection />
      <UseCases activeUseCase={activeUseCase} onUseCaseChange={setActiveUseCase} />
      <CredibilitySection />
      <FaqSection activeFaq={activeFaq} onFaqChange={setActiveFaq} />
      <RequestAccessSection />
    </>
  );
}

function usePageMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    const descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (descriptionMeta) descriptionMeta.content = description;
  }, [title, description]);
}

function Hero({ meta }: { meta: PageMeta }) {
  return (
    <section className="site-hero" id="top">
      <div className="site-wrap site-hero-grid">
        <div className="site-hero-copy">
          <p className="site-eyebrow"><span aria-hidden="true" />For export-control, legal, and compliance teams</p>
          <h1>{meta.h1}</h1>
          <p className="site-hero-subcopy">{meta.body}</p>
          <div className="site-actions">
            <Link to="/contact" className="site-button site-button-primary">Request access<ArrowRight size={18} aria-hidden="true" /></Link>
            <a href="#product-demo" className="site-button site-button-text">See how it works<ArrowRight size={16} aria-hidden="true" /></a>
          </div>
          <div className="site-proof-row" aria-label="Rulix review strengths">
            {proofChips.map((chip) => <span key={chip.label}><chip.icon size={17} aria-hidden="true" />{chip.label}</span>)}
          </div>
          <p className="site-hero-note">Review support only. Final judgment stays with qualified people.</p>
        </div>
        <HeroProductProof />
      </div>
    </section>
  );
}

function HeroProductProof() {
  const media = demoMedia.hero;

  return (
    <div className="product-proof-frame hero-product-proof" aria-label="Rulix product proof video">
      <div className="product-proof-top"><span>Product in action</span><strong>{media.duration}</strong></div>
      <ProductVideo media={media} />
      <div className="proof-hotspots" aria-label="What the product preview shows">
        <span><SearchCheck size={16} aria-hidden="true" />Unsupported claim flagged</span>
        <span><GitBranch size={16} aria-hidden="true" />Evidence trail mapped</span>
        <span><ClipboardCheck size={16} aria-hidden="true" />Review record prepared</span>
      </div>
      <div className="proof-caption"><strong>{media.title}</strong><span>{media.prompt}</span></div>
    </div>
  );
}

function ProblemCards() {
  return (
    <section className="site-section problem-section">
      <div className="site-wrap">
        <SectionHeader label="The review gap" title="Reviews slow down when reasoning is scattered." copy="Export-control review slows when teams cannot see which assumptions, evidence, and questions support the final memo." />
        <div className="problem-grid">{problemCards.map((card) => <FeatureCard key={card.title} {...card} />)}</div>
      </div>
    </section>
  );
}

function ProductDemo({ activeDemo, onDemoChange }: { activeDemo: DemoKey; onDemoChange: (demo: DemoKey) => void }) {
  const active = demoModules.find((demo) => demo.key === activeDemo) ?? demoModules[0];
  const media = demoMedia[active.key];

  return (
    <section className="site-section product-demo-section" id="product-demo">
      <div className="site-wrap product-demo-grid">
        <div>
          <SectionHeader label="Product in action" title="See what Rulix helps reviewers catch." copy="The product stays close to the memo: analysis, evidence gaps, reviewer actions, audit trail, and export state." />
          <div className="demo-stepper" role="tablist" aria-label="Rulix product demos">
            {demoModules.map((demo) => (
              <button type="button" role="tab" aria-selected={activeDemo === demo.key} className={activeDemo === demo.key ? "is-active" : ""} id={`demo-tab-${demo.key}`} key={demo.key} onClick={() => onDemoChange(demo.key)}>
                <span>{demoMedia[demo.key].duration}</span>{demo.shortTitle}
              </button>
            ))}
          </div>
        </div>
        <div className="demo-proof-panel" id={`demo-panel-${active.key}`} role="tabpanel" aria-labelledby={`demo-tab-${active.key}`}>
          <ProductVideo media={media} />
          <div className="demo-proof-copy">
            <span>{media.prompt}</span>
            <h3>{active.title}</h3>
            <p>{active.copy}</p>
            <div className="demo-proof-pills">{active.proof.map((item) => <span key={item}>{item}</span>)}</div>
            <strong>{active.outcome}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductVideo({ media }: { media: (typeof demoMedia)["hero"] }) {
  return (
    <div className="proof-video">
      <video muted loop playsInline autoPlay preload="metadata" poster={media.poster} aria-label={`${media.title} product demo video`}>
        <source src={media.video} type="video/mp4" />
      </video>
      <img src={media.still} alt={`${media.title} still`} loading="lazy" />
    </div>
  );
}

function FitCheck() {
  return (
    <section className="site-section fit-check-section" id="fit-check">
      <div className="site-wrap">
        <SectionHeader label="Fit check" title="Know when Rulix belongs in the workflow." copy="Rulix supports memo review. It is not autopilot legal judgment, guaranteed classification, or a place for unmanaged sensitive data." />
        <div className="fit-check-grid">
          {fitCards.map((card) => (
            <article className={`fit-card ${card.tone}`} key={card.title}>
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
      <div className="site-wrap">
        <SectionHeader label="How it works" title="From draft memo to review-ready record." copy="The workflow turns scattered draft analysis into a record reviewers can inspect, revise, and approve." />
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
      <div className="site-wrap comparison-grid">
        <SectionHeader label="Why Rulix" title="Built for structured review, not generic chat." copy="Rulix is built around export-control memo work: findings, evidence requests, reviewer resolution, and record export." />
        <div className="comparison-table" role="table" aria-label="Rulix comparison">
          <div className="comparison-row comparison-head" role="row"><span>Need</span><span>Generic AI chatbot</span><span>Manual review</span><span>Rulix</span></div>
          {comparisonRows.map(([dimension, chatbot, manual, rulix]) => (
            <div className="comparison-row" role="row" key={dimension}><span>{dimension}</span><span>{chatbot}</span><span>{manual}</span><strong>{rulix}</strong></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className="site-section trust-section" id="trust">
      <div className="site-wrap trust-grid">
        <div>
          <SectionHeader label="Trust" title="Human judgment stays in control." copy="Rulix gives reviewers structured findings and traceable suggestions without turning software into the final authority." />
          <Link to="/contact" className="site-button site-button-secondary">Talk through your workflow<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className="trust-list">{trustItems.map((item) => <FeatureCard key={item.title} {...item} />)}</div>
      </div>
    </section>
  );
}

function UseCases({ activeUseCase, onUseCaseChange }: { activeUseCase: UseCaseKey; onUseCaseChange: (useCase: UseCaseKey) => void }) {
  const active = useCases.find((item) => item.key === activeUseCase) ?? useCases[0];

  return (
    <section className="site-section" id="use-cases">
      <div className="site-wrap">
        <SectionHeader label="Use cases" title="For teams who own export-control review." copy="Each team gets a shared review surface while final regulatory judgment stays with qualified reviewers." />
        <div className="use-case-selector" role="tablist" aria-label="Buyer use cases">
          {useCases.map((item) => <button type="button" role="tab" aria-selected={activeUseCase === item.key} className={activeUseCase === item.key ? "is-active" : ""} key={item.key} onClick={() => onUseCaseChange(item.key)}>{item.label}</button>)}
        </div>
        <article className="use-case-proof-card">
          <active.icon size={26} aria-hidden="true" />
          <div><span>{active.who}</span><h3>{active.title}</h3><p>{active.outcome}</p><strong>{active.fit}</strong></div>
        </article>
      </div>
    </section>
  );
}

function CredibilitySection() {
  return (
    <section className="site-section credibility-section" id="sample-review">
      <div className="site-wrap credibility-grid">
        <div>
          <SectionHeader label="Credibility" title="Designed for technical trade decisions." copy="Built around where reviews get stuck: scattered comments, missing facts, unresolved assumptions, and the final trail." />
          <div className="credibility-proof-list" aria-label="Rulix proof points"><span>Memo reasoning</span><span>Evidence gaps</span><span>Reviewer signoff</span></div>
        </div>
        <article className="case-study-card">
          <span>Illustrative use case</span>
          <h3>A cleaner path before final memo approval</h3>
          <div className="case-study-columns">
            <div><strong>Before</strong><p>Three reviewers, scattered comments, unresolved evidence requests, and an unclear decision trail.</p></div>
            <div><strong>After</strong><p>Structured findings, resolved gaps, and an exportable review record ready for final human signoff.</p></div>
          </div>
          <small>Illustrative only. Not a customer reference.</small>
        </article>
      </div>
    </section>
  );
}

function FaqSection({ activeFaq, onFaqChange }: { activeFaq: number; onFaqChange: (faq: number) => void }) {
  return (
    <section className="site-section faq-section" id="faq">
      <div className="site-wrap faq-grid">
        <SectionHeader label="FAQ" title="Plain answers for careful buyers." copy="Rulix helps reviewers work faster and explain decisions better. It does not replace qualified judgment." />
        <div className="faq-list">
          {faqItems.map((item, index) => {
            const expanded = activeFaq === index;
            return (
              <article className={expanded ? "faq-item is-open" : "faq-item"} key={item.question}>
                <button type="button" aria-expanded={expanded} onClick={() => onFaqChange(expanded ? -1 : index)}><span>{item.question}</span><ArrowRight size={17} aria-hidden="true" /></button>
                {expanded && <p>{item.answer}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RequestAccessSection() {
  const mailHref = useMemo(
    () => `mailto:${EMAIL}?subject=Rulix%20access%20request&body=${encodeURIComponent("I'd like to request access to Rulix.\n\nWork email:\nOrganization:\nRole:\nExpected review volume:\nRedacted memo sample ready: yes / not yet\n\nWorkflow notes:\n")}`,
    [],
  );

  return (
    <section className="site-section request-section" id="request-access">
      <div className="site-wrap request-grid">
        <div>
          <SectionHeader label="Request access" title="See if Rulix fits your review workflow." copy="Send a few details. We'll use them to understand fit and suggest a sensible next step." />
          <a className="sample-link" href="#sample-review">See sample review<ArrowRight size={16} aria-hidden="true" /></a>
        </div>
        <div className="access-form">
          <div className="request-field"><Mail size={18} aria-hidden="true" /><span>Work email, organization, role, and review volume</span></div>
          <div className="request-field"><UploadCloud size={18} aria-hidden="true" /><span>Redacted memo sample if you have one ready</span></div>
          <a className="site-button site-button-primary site-button-full" href={mailHref}><Mail size={18} aria-hidden="true" />Request access</a>
          <p className="form-confirmation">Attach only public, sanitized, or approved samples.</p>
        </div>
      </div>
    </section>
  );
}

function SectionHeader({ label, title, copy }: { label: string; title: string; copy: string }) {
  return (
    <div className="section-header">
      <span>{label}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  );
}

function FeatureCard({ title, copy, icon: Icon }: { title: string; copy: string; icon: LucideIcon }) {
  return (
    <article className="feature-card">
      <Icon size={22} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{copy}</p>
    </article>
  );
}
