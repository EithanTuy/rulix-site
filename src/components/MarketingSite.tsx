import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent
} from "react";
import {
  ArrowRight,
  Check,
  FileCheck2,
  FileSearch,
  GitBranch,
  LockKeyhole,
  Menu,
  SearchCheck,
  ShieldCheck,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import {
  PRIMARY_MARKETING_NAV,
  isMarketingRoute,
  marketingCanonicalPath,
  marketingPageForPath,
  type MarketingAudience,
  type MarketingPageKind,
  type MarketingPageMeta
} from "../marketingPages";
import { BrandLogo } from "./BrandLogo";
import "../marketing-v2.css";

const CONTACT_EMAIL = "tuyilin2@msu.edu";
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=Rulix%20inquiry`;

const HOME_OUTCOMES = [
  {
    title: "Find missing support",
    copy: "See which conclusions need another fact, source, or explanation before the memo moves forward."
  },
  {
    title: "Organize reviewer questions",
    copy: "Turn open issues into clear questions that the right person can answer without another scattered email thread."
  },
  {
    title: "Preserve the final decision",
    copy: "Keep the reasoning, responses, and reviewer decision together in a record the team can explain later."
  }
];

const PRODUCT_STEPS = [
  {
    title: "Add the memo",
    copy: "Upload or paste the draft classification memo and the facts the reviewer already has.",
    detail: "Rulix keeps the memo in view so the review starts with your work—not a blank chat window.",
    media: "/marketing/demos/hero-rulix-review-loop.webp",
    alt: "A classification memo open in the Rulix reviewer workspace"
  },
  {
    title: "See what is missing",
    copy: "Rulix points to conclusions that need stronger support and explains what information is missing.",
    detail: "The reviewer can inspect the exact passage instead of searching through a general AI answer.",
    media: "/marketing/demos/demo-find-missing-reasoning.webp",
    alt: "Rulix pointing to a classification conclusion that needs more support"
  },
  {
    title: "Answer the reviewer’s questions",
    copy: "Accept a finding, ask for more information, or explain why the team is taking a different view.",
    detail: "Each response stays attached to the question and the part of the memo that raised it.",
    media: "/marketing/demos/demo-resolve-review-gaps.webp",
    alt: "A reviewer resolving a classification question in Rulix"
  },
  {
    title: "Save the decision record",
    copy: "Export the findings, responses, notes, and final reviewer decision as one clear record.",
    detail: "The next person can understand what changed and why without reconstructing the review from scratch.",
    media: "/marketing/demos/demo-export-review-record.webp",
    alt: "A completed export classification review record in Rulix"
  }
];

interface AudienceStory {
  key: MarketingAudience;
  label: string;
  title: string;
  copy: string;
  outcome: string;
  media: string;
  alt: string;
  icon: LucideIcon;
}

const AUDIENCE_STORIES: AudienceStory[] = [
  {
    key: "officers",
    label: "Export-control officers",
    title: "Review the reasoning without losing the memo.",
    copy: "Find conclusions that need stronger jurisdiction, classification, end-use, or party support while the source text stays in view.",
    outcome: "You leave with clear questions and a record of the reviewer’s final call.",
    media: "/marketing/demos/demo-find-missing-reasoning.webp",
    alt: "An export-control officer reviewing a highlighted memo finding in Rulix",
    icon: SearchCheck
  },
  {
    key: "industry",
    label: "Manufacturers and labs",
    title: "Turn product facts into answerable review questions.",
    copy: "Spot missing specifications, intended-use details, and technical support before the memo starts another round of email.",
    outcome: "Your reviewer gets a cleaner packet with fewer basic facts left unresolved.",
    media: "/marketing/demos/demo-resolve-review-gaps.webp",
    alt: "A manufacturer resolving a product classification question in Rulix",
    icon: FileCheck2
  },
  {
    key: "research",
    label: "Universities and research teams",
    title: "Separate technical unknowns from review conclusions.",
    copy: "Collect the missing equipment, research, and destination context before qualified reviewers spend time on the final decision.",
    outcome: "The team can hand off a clearer draft with every open question attached to its source.",
    media: "/marketing/demos/hero-rulix-review-loop.webp",
    alt: "A university research classification review open in Rulix",
    icon: ShieldCheck
  }
];

const TRUST_POINTS = [
  {
    title: "A person makes the final decision",
    copy: "Rulix finds issues and suggests questions. Qualified reviewers decide what the classification should be.",
    icon: UsersRound
  },
  {
    title: "Findings point back to the source",
    copy: "Every question stays connected to the memo passage and the reason the reviewer needs more support.",
    icon: GitBranch
  },
  {
    title: "Workspace access is controlled",
    copy: "Account-based workspaces and invite-only access keep review work with the people who are meant to see it.",
    icon: LockKeyhole
  },
  {
    title: "The record explains what changed",
    copy: "Findings, responses, notes, and final decisions remain together for handoff and later review.",
    icon: FileSearch
  }
];

export interface HeaderVisibilityInput {
  previousY: number;
  currentY: number;
  currentlyVisible: boolean;
  mobileNavOpen: boolean;
  hasFocus: boolean;
}

export function nextMarketingHeaderVisibility({
  previousY,
  currentY,
  currentlyVisible,
  mobileNavOpen,
  hasFocus
}: HeaderVisibilityInput) {
  if (mobileNavOpen || hasFocus || currentY <= 24) return true;
  if (currentY < previousY - 1) return true;
  if (currentY > previousY + 6) return false;
  return currentlyVisible;
}

export function MarketingSite() {
  const page = useMemo(() => pageForLocation(), []);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(false);
  const headerVisible = useMarketingHeaderVisibility(mobileNavOpen, headerFocused);

  useEffect(() => {
    document.documentElement.classList.add("marketing-page");
    document.body.classList.add("marketing-page");
    applyMarketingMetadata(page);
    return () => {
      document.documentElement.classList.remove("marketing-page");
      document.body.classList.remove("marketing-page");
    };
  }, [page]);

  return (
    <div className="rulix-site">
      <SiteHeader
        currentPageKind={page.pageKind}
        focused={headerFocused}
        mobileNavOpen={mobileNavOpen}
        visible={headerVisible}
        onFocusChange={setHeaderFocused}
        onMobileNavChange={setMobileNavOpen}
      />
      <main>{renderMarketingPage(page)}</main>
      <SiteFooter />
    </div>
  );
}

function renderMarketingPage(page: MarketingPageMeta) {
  switch (page.pageKind) {
    case "product":
      return <ProductPage page={page} />;
    case "use-cases":
      return <UseCasesPage page={page} />;
    case "trust":
      return <TrustPage />;
    case "contact":
      return <ContactPage />;
    default:
      return <HomePage />;
  }
}

function SiteHeader({
  currentPageKind,
  focused,
  mobileNavOpen,
  visible,
  onFocusChange,
  onMobileNavChange
}: {
  currentPageKind: MarketingPageKind;
  focused: boolean;
  mobileNavOpen: boolean;
  visible: boolean;
  onFocusChange: (focused: boolean) => void;
  onMobileNavChange: (open: boolean) => void;
}) {
  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onFocusChange(false);
    }
  };

  return (
    <header
      className={[
        "rulix-header",
        visible || focused ? "is-visible" : "is-hidden",
        mobileNavOpen ? "is-open" : ""
      ].join(" ")}
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={handleBlur}
    >
      <a className="rulix-header__brand" href="/" aria-label="Rulix home">
        <BrandLogo tone="dark" size="compact" />
      </a>
      <nav className="rulix-header__nav" aria-label="Primary">
        {PRIMARY_MARKETING_NAV.map((item) => (
          <a
            href={item.path}
            aria-current={currentPageKind === item.pageKind ? "page" : undefined}
            key={item.path}
            onClick={() => onMobileNavChange(false)}
          >
            {item.label}
          </a>
        ))}
        <a className="rulix-header__signin" href="https://app.rulix.cloud">
          Sign in
        </a>
      </nav>
      <button
        className="rulix-menu-button"
        type="button"
        aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={mobileNavOpen}
        onClick={() => onMobileNavChange(!mobileNavOpen)}
      >
        {mobileNavOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>
    </header>
  );
}

function HomePage() {
  return (
    <>
      <PageHero
        title="AI-assisted export classification."
        copy="Rulix helps export-control teams review classification memos, find missing support, and keep the final decision with a qualified person."
        media="/marketing/demos/demo-find-missing-reasoning.webp"
        mediaAlt="Rulix showing a classification memo conclusion that needs more support"
      />
      <section className="rulix-band outcome-band" aria-labelledby="home-outcomes-title">
        <div className="rulix-shell outcome-band__grid">
          <div className="section-intro section-intro--light">
            <h2 id="home-outcomes-title">A clearer path from draft to decision.</h2>
            <p>Rulix keeps the review focused on three questions: what is missing, who needs to answer, and what was finally decided.</p>
          </div>
          <ol className="outcome-list">
            {HOME_OUTCOMES.map((outcome, index) => (
              <li key={outcome.title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{outcome.title}</h3>
                  <p>{outcome.copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}

function ProductPage({ page }: { page: MarketingPageMeta }) {
  const hero = productHeroForPage(page.key);

  return (
    <>
      <PageHero
        title={hero.title}
        copy={hero.copy}
        media="/marketing/demos/demo-export-review-record.webp"
        mediaAlt="A complete export classification review record in Rulix"
      />
      <ProductFlow />
    </>
  );
}

function ProductFlow() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const visible = useOnceVisible(sectionRef);

  return (
    <section
      className={visible ? "rulix-band product-flow is-visible" : "rulix-band product-flow"}
      ref={sectionRef}
      aria-labelledby="product-flow-title"
    >
      <div className="rulix-shell">
        <div className="section-intro product-flow__intro">
          <h2 id="product-flow-title">Four steps, all in the open.</h2>
          <p>Nothing is hidden behind a tab. The team can see how the draft becomes a reviewer-owned decision record.</p>
        </div>
        <ol className="product-flow__steps">
          {PRODUCT_STEPS.map((step, index) => (
            <li
              className="product-step"
              key={step.title}
              style={{ "--step-index": index } as CSSProperties}
            >
              <div className="product-step__copy">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
                <strong>{step.detail}</strong>
              </div>
              <StaticProductFrame src={step.media} alt={step.alt} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function UseCasesPage({ page }: { page: MarketingPageMeta }) {
  const orderedStories = page.legacyAudience
    ? [
        ...AUDIENCE_STORIES.filter((story) => story.key === page.legacyAudience),
        ...AUDIENCE_STORIES.filter((story) => story.key !== page.legacyAudience)
      ]
    : AUDIENCE_STORIES;
  const title = useCaseTitleForAudience(page.legacyAudience);

  return (
    <>
      <PageHero
        title={title}
        copy="Rulix gives each team a shared way to find missing information, answer review questions, and document the final decision."
        media="/marketing/demos/demo-resolve-review-gaps.webp"
        mediaAlt="A classification review question being resolved in Rulix"
      />
      <section className="rulix-band audience-stories" aria-label="Rulix use cases">
        <div className="rulix-shell">
          {orderedStories.map((story, index) => {
            const Icon = story.icon;
            return (
              <article className="audience-story" id={story.key} key={story.key}>
                <div className="audience-story__copy">
                  <div className="audience-story__label">
                    <Icon size={21} aria-hidden="true" />
                    <span>{story.label}</span>
                  </div>
                  <h2>{story.title}</h2>
                  <p>{story.copy}</p>
                  <strong>{story.outcome}</strong>
                </div>
                <StaticProductFrame src={story.media} alt={story.alt} priority={index === 0} />
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

function TrustPage() {
  return (
    <>
      <PageHero
        title="A person makes the final decision."
        copy="Rulix helps reviewers see the weak point, ask for the right information, and record why they made the final call."
        media="/marketing/demos/demo-export-review-record.webp"
        mediaAlt="A human-reviewed export classification record in Rulix"
      />
      <section className="rulix-band trust-band" aria-labelledby="trust-title">
        <div className="rulix-shell trust-band__grid">
          <div className="section-intro section-intro--light">
            <h2 id="trust-title">Clear limits. Clear ownership.</h2>
            <p>Rulix supports the review. It does not make legal determinations or replace qualified judgment.</p>
          </div>
          <div className="trust-list">
            {TRUST_POINTS.map((point) => {
              const Icon = point.icon;
              return (
                <article key={point.title}>
                  <Icon size={22} aria-hidden="true" />
                  <div>
                    <h3>{point.title}</h3>
                    <p>{point.copy}</p>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="data-boundary">
            <Check size={20} aria-hidden="true" />
            <p>Only share information your organization has approved for this workspace.</p>
          </div>
        </div>
      </section>
    </>
  );
}

function ContactPage() {
  return (
    <section className="contact-page">
      <div className="rulix-shell contact-page__inner">
        <h1>Talk with us about your classification workflow.</h1>
        <p>Tell us where the review slows down. We’ll reply by email and help you decide whether Rulix fits the work.</p>
        <a className="rulix-primary-action contact-email" href={CONTACT_HREF}>
          <span>Email Rulix</span>
          <strong>{CONTACT_EMAIL}</strong>
          <ArrowRight size={20} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}

function PageHero({
  title,
  copy,
  media,
  mediaAlt
}: {
  title: string;
  copy: string;
  media: string;
  mediaAlt: string;
}) {
  return (
    <section className="rulix-hero">
      <div className="rulix-shell rulix-hero__grid">
        <div className="rulix-hero__copy">
          <h1>{title}</h1>
          <p>{copy}</p>
          <EmailAction />
        </div>
        <StaticProductFrame className="rulix-hero__media" src={media} alt={mediaAlt} priority />
      </div>
    </section>
  );
}

function EmailAction() {
  return (
    <a className="rulix-primary-action" href={CONTACT_HREF}>
      Email Rulix
      <ArrowRight size={18} aria-hidden="true" />
    </a>
  );
}

function StaticProductFrame({
  alt,
  className = "",
  priority = false,
  src
}: {
  alt: string;
  className?: string;
  priority?: boolean;
  src: string;
}) {
  return (
    <figure className={["product-frame", className].filter(Boolean).join(" ")}>
      <div className="product-frame__top">
        <BrandLogo tone="light" size="compact" />
        <span>Reviewer workspace</span>
        <strong>Human decision</strong>
      </div>
      <img src={src} alt={alt} loading={priority ? "eager" : "lazy"} />
    </figure>
  );
}

function SiteFooter() {
  return (
    <footer className="rulix-footer">
      <div className="rulix-shell rulix-footer__inner">
        <BrandLogo tone="dark" size="compact" />
        <p>AI-assisted export classification with human review.</p>
        <small>© 2026 Rulix</small>
        <a href="https://app.rulix.cloud">Sign in</a>
      </div>
    </footer>
  );
}

function productHeroForPage(key: string) {
  switch (key) {
    case "export-control-memo-review":
      return {
        title: "Review export-control memos without losing the reasoning.",
        copy: "Rulix helps reviewers find conclusions that need more support and keep the final decision tied to the memo."
      };
    case "eccn-classification-assistant":
      return {
        title: "Make every ECCN conclusion show its work.",
        copy: "Rulix helps reviewers see the facts, questions, and reasoning behind a draft classification before they make the final call."
      };
    case "ai-export-compliance-review":
      return {
        title: "Use AI assistance to find the gap—not make the final call.",
        copy: "Rulix organizes missing support and reviewer questions while qualified people remain responsible for the decision."
      };
    default:
      return {
        title: "Review classification work without losing the reasoning.",
        copy: "Rulix keeps the memo, missing information, reviewer questions, and final decision together from start to finish."
      };
  }
}

function useCaseTitleForAudience(audience?: MarketingAudience) {
  if (audience === "research") {
    return "Export classification support for universities and research teams.";
  }
  if (audience === "industry") {
    return "A clearer ECCN review path for manufacturers and labs.";
  }
  return "Built for teams that have to explain the classification.";
}

function useMarketingHeaderVisibility(mobileNavOpen: boolean, hasFocus: boolean) {
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const previousYRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (mobileNavOpen || hasFocus) setVisible(true);
  }, [hasFocus, mobileNavOpen]);

  useEffect(() => {
    previousYRef.current = window.scrollY;

    const update = () => {
      frameRef.current = undefined;
      const currentY = window.scrollY;
      const nextVisible = nextMarketingHeaderVisibility({
        previousY: previousYRef.current,
        currentY,
        currentlyVisible: visibleRef.current,
        mobileNavOpen,
        hasFocus
      });
      previousYRef.current = currentY;
      if (nextVisible !== visibleRef.current) {
        visibleRef.current = nextVisible;
        setVisible(nextVisible);
      }
    };

    const onScroll = () => {
      if (frameRef.current !== undefined) return;
      frameRef.current = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
    };
  }, [hasFocus, mobileNavOpen]);

  return visible;
}

function useOnceVisible(ref: { current: HTMLElement | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold: 0.14 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return visible;
}

export function isMarketingPath(pathname: string) {
  return isMarketingRoute(pathname);
}

export function marketingMetaForPath(pathname: string) {
  return marketingPageForPath(pathname);
}

function pageForLocation() {
  if (typeof window === "undefined") return marketingPageForPath("/");
  return marketingPageForPath(window.location.pathname);
}

function applyMarketingMetadata(page: MarketingPageMeta) {
  const canonicalPath = marketingCanonicalPath(page);
  document.title = page.title;
  upsertMeta("description", page.description);
  upsertMeta("og:title", page.title, "property");
  upsertMeta("og:description", page.description, "property");
  upsertMeta("og:type", "website", "property");
  upsertMeta("og:url", `${window.location.origin}${canonicalPath}`, "property");
  upsertMeta("og:image", `${window.location.origin}/marketing/rulix-audit-product.png`, "property");
  upsertMeta("twitter:card", "summary_large_image");
  upsertCanonical(`${window.location.origin}${canonicalPath}`);
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
