import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type CSSProperties,
  type FocusEvent,
  type ReactNode
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
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "../marketing-v2.css";

const CONTACT_EMAIL = "tuyilin2@msu.edu";
const CONTACT_PAGE_HREF = "/contact";
const CONTACT_EMAIL_HREF = `mailto:${CONTACT_EMAIL}?subject=Rulix%20inquiry`;

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
  },
  {
    title: "See what is missing",
    copy: "Rulix points to conclusions that need stronger support and explains what information is missing.",
    detail: "The reviewer can inspect the exact passage instead of searching through a general AI answer.",
  },
  {
    title: "Answer the reviewer’s questions",
    copy: "Accept a finding, ask for more information, or explain why the team is taking a different view.",
    detail: "Each response stays attached to the question and the part of the memo that raised it.",
  },
  {
    title: "Save the decision record",
    copy: "Export the findings, responses, notes, and final reviewer decision as one clear record.",
    detail: "The next person can understand what changed and why without reconstructing the review from scratch.",
  }
];

interface AudienceStory {
  key: MarketingAudience;
  label: string;
  title: string;
  copy: string;
  outcome: string;
  icon: LucideIcon;
}

const AUDIENCE_STORIES: AudienceStory[] = [
  {
    key: "officers",
    label: "Export-control officers",
    title: "Review the reasoning without losing the memo.",
    copy: "Find conclusions that need stronger jurisdiction, classification, end-use, or party support while the source text stays in view.",
    outcome: "You leave with clear questions and a record of the reviewer’s final call.",
    icon: SearchCheck
  },
  {
    key: "industry",
    label: "Manufacturers and labs",
    title: "Turn product facts into answerable review questions.",
    copy: "Spot missing specifications, intended-use details, and technical support before the memo starts another round of email.",
    outcome: "Your reviewer gets a cleaner packet with fewer basic facts left unresolved.",
    icon: FileCheck2
  },
  {
    key: "research",
    label: "Universities and research teams",
    title: "Separate technical unknowns from review conclusions.",
    copy: "Collect the missing equipment, research, and destination context before qualified reviewers spend time on the final decision.",
    outcome: "The team can hand off a clearer draft with every open question attached to its source.",
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
  const { path, navigate } = useMarketingRouter();
  const page = useMemo(() => marketingPageForPath(path), [path]);
  const siteRef = useRef<HTMLDivElement | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(false);
  const scroll = useMarketingScrollState(mobileNavOpen, headerFocused);
  usePointerField(siteRef);

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
    <div className="rulix-site rulix-site--liquid-glass" onClick={navigate} ref={siteRef}>
      <GlassField />
      <SiteHeader
        currentPageKind={page.pageKind}
        focused={headerFocused}
        mobileNavOpen={mobileNavOpen}
        scrolled={scroll.scrolled}
        visible={scroll.headerVisible}
        onFocusChange={setHeaderFocused}
        onMobileNavChange={setMobileNavOpen}
      />
      <main>{renderMarketingPage(page)}</main>
      <SiteFooter />
    </div>
  );
}

/* Marketing is five static pages in one already-loaded bundle, so a plain
   anchor was paying a full document reload — reparse, remount, refetch — to
   swap a heading and a list. Same markup and same URLs; the click is just
   intercepted and answered from memory. Anything the browser should still
   handle itself (new tab, modifier click, mailto, app subdomain) falls
   through untouched. */
function useMarketingRouter() {
  const [path, setPath] = useState(() => currentMarketingPath());

  useEffect(() => {
    const onPopState = () => setPath(currentMarketingPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as HTMLElement | null)?.closest?.("a");
    if (!anchor) return;
    if (anchor.target && anchor.target !== "_self") return;
    if (anchor.hasAttribute("download")) return;

    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    if (!isMarketingRoute(href)) return;

    event.preventDefault();
    if (href === window.location.pathname) return;
    window.history.pushState({}, "", href);
    setPath(href);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  return { path, navigate };
}

function currentMarketingPath() {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/* The drifting colour field behind every glass surface. */
function GlassField() {
  return (
    <>
      <div className="rulix-aurora" aria-hidden="true">
        <div className="rulix-aurora__blob" />
        <div className="rulix-aurora__blob" />
        <div className="rulix-aurora__blob" />
        <div className="rulix-aurora__grain" />
      </div>
      <div className="rulix-spotlight" aria-hidden="true" />
    </>
  );
}

/* Lets the field answer the pointer without becoming a cursor toy: the values
   are written once per frame and the movement is eased over ~1s in CSS, so the
   light trails well behind the cursor and reads as drift. Fine pointers only,
   and nothing runs when the reader has asked for reduced motion. */
function usePointerField(root: { current: HTMLElement | null }) {
  useEffect(() => {
    const element = root.current;
    if (!element || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame: number | undefined;
    let pending: { x: number; y: number } | null = null;

    const commit = () => {
      frame = undefined;
      if (!pending) return;
      const { x, y } = pending;
      element.style.setProperty("--spot-x", `${x}px`);
      element.style.setProperty("--spot-y", `${y}px`);
      // a few px of sway, signed from the centre of the viewport
      element.style.setProperty("--sway-x", `${(x / window.innerWidth - 0.5) * 46}px`);
      element.style.setProperty("--sway-y", `${(y / window.innerHeight - 0.5) * 34}px`);
    };

    const onMove = (event: PointerEvent) => {
      pending = { x: event.clientX, y: event.clientY };
      element.classList.add("is-pointing");
      if (frame === undefined) frame = window.requestAnimationFrame(commit);
    };
    const onLeave = () => element.classList.remove("is-pointing");

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      element.classList.remove("is-pointing");
    };
  }, [root]);
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
  scrolled,
  visible,
  onFocusChange,
  onMobileNavChange
}: {
  currentPageKind: MarketingPageKind;
  focused: boolean;
  mobileNavOpen: boolean;
  scrolled: boolean;
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
        "glass",
        "glass--chrome",
        visible || focused ? "is-visible" : "is-hidden",
        scrolled ? "is-scrolled" : "",
        mobileNavOpen ? "is-open" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={handleBlur}
    >
      <a className="rulix-header__brand" href="/" aria-label="Rulix home">
        <BrandLogo tone="light" size="compact" />
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
      />
      <section className="rulix-band glass glass--pane outcome-band" aria-labelledby="home-outcomes-title">
        <div className="rulix-shell outcome-band__grid">
          <div className="section-intro section-intro--light">
            <h2 id="home-outcomes-title">A clearer path from draft to decision.</h2>
            <p>Rulix keeps the review focused on three questions: what is missing, who needs to answer, and what was finally decided.</p>
          </div>
          <ol className="outcome-list">
            {HOME_OUTCOMES.map((outcome, index) => (
              <li className="tile" key={outcome.title}>
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
      className={[
        "rulix-band glass glass--pane product-flow",
        visible ? "is-visible" : ""
      ]
        .filter(Boolean)
        .join(" ")}
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
              className="product-step tile"
              key={step.title}
              style={{ "--step-index": index } as CSSProperties}
            >
              <div className="product-step__copy">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
                <strong>{step.detail}</strong>
              </div>
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
      />
      <section className="rulix-band glass glass--pane audience-stories" aria-label="Rulix use cases">
        <div className="rulix-shell">
          {orderedStories.map((story) => {
            const Icon = story.icon;
            return (
              <article className="audience-story tile" id={story.key} key={story.key}>
                <div className="audience-story__copy">
                  <div className="audience-story__label">
                    <Icon size={21} aria-hidden="true" />
                    <span>{story.label}</span>
                  </div>
                  <h2>{story.title}</h2>
                  <p>{story.copy}</p>
                  <strong>{story.outcome}</strong>
                </div>
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
      />
      <section className="rulix-band glass glass--pane trust-band" aria-labelledby="trust-title">
        <div className="rulix-shell trust-band__grid">
          <div className="section-intro section-intro--light">
            <h2 id="trust-title">Clear limits. Clear ownership.</h2>
            <p>Rulix supports the review. It does not make legal determinations or replace qualified judgment.</p>
          </div>
          <div className="trust-list">
            {TRUST_POINTS.map((point) => {
              const Icon = point.icon;
              return (
                <article className="tile" key={point.title}>
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
      <div className="rulix-shell contact-page__inner glass glass--pane">
        <h1>Talk with us about your classification workflow.</h1>
        <p>Tell us where the review slows down. We’ll reply by email and help you decide whether Rulix fits the work.</p>
        <EmailAction className="contact-email" href={CONTACT_EMAIL_HREF}>
          <span>{CONTACT_EMAIL}</span>
        </EmailAction>
      </div>
    </section>
  );
}

function PageHero({
  title,
  copy
}: {
  title: string;
  copy: string;
}) {
  return (
    <section className="rulix-hero">
      <div className="rulix-shell rulix-hero__copy">
        <h1>{title}</h1>
        <p>{copy}</p>
        <EmailAction />
      </div>
    </section>
  );
}

function EmailAction({ className = "", href = CONTACT_PAGE_HREF, children }: {
  className?: string;
  href?: string;
  children?: ReactNode;
}) {
  const ref = useGlassSheen<HTMLAnchorElement>();

  return (
    <a className={["rulix-primary-action", className].filter(Boolean).join(" ")} href={href} ref={ref}>
      {children ?? "Email Rulix"}
      <ArrowRight size={18} aria-hidden="true" />
    </a>
  );
}

function SiteFooter() {

  return (
    <footer className="rulix-footer">
      <div className="rulix-shell rulix-footer__inner">
        <BrandLogo tone="light" size="compact" />
        <p>AI-assisted export classification with human review.</p>
        <small>© 2026 Rulix</small>
        <a href="https://app.rulix.cloud">Sign in</a>
      </div>
    </footer>
  );
}

/* Moves the specular hotspot on a control to follow the pointer. */
function useGlassSheen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    // Touch-only pointers have no hover state to track, and jsdom has no matchMedia.
    if (!element || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(hover: hover)").matches) return;

    const track = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      element.style.setProperty("--sheen-x", `${((event.clientX - box.left) / box.width) * 100}%`);
      element.style.setProperty("--sheen-y", `${((event.clientY - box.top) / box.height) * 100}%`);
      element.style.setProperty("--sheen-opacity", "1");
    };
    const release = () => element.style.setProperty("--sheen-opacity", "0");

    element.addEventListener("pointermove", track);
    element.addEventListener("pointerleave", release);
    return () => {
      element.removeEventListener("pointermove", track);
      element.removeEventListener("pointerleave", release);
    };
  }, []);

  return ref;
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

// Capped so the parallax offset can never drag a blob past the field's bleed.
const PARALLAX_CEILING = 1600;

function useMarketingScrollState(mobileNavOpen: boolean, hasFocus: boolean) {
  const [state, setState] = useState({ headerVisible: true, scrolled: false });
  const stateRef = useRef(state);
  const previousYRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (mobileNavOpen || hasFocus) {
      setState((current) => (current.headerVisible ? current : { ...current, headerVisible: true }));
    }
  }, [hasFocus, mobileNavOpen]);

  useEffect(() => {
    previousYRef.current = window.scrollY;

    const update = () => {
      frameRef.current = undefined;
      const currentY = window.scrollY;
      const headerVisible = nextMarketingHeaderVisibility({
        previousY: previousYRef.current,
        currentY,
        currentlyVisible: stateRef.current.headerVisible,
        mobileNavOpen,
        hasFocus
      });
      const scrolled = currentY > 24;
      previousYRef.current = currentY;

      document.documentElement.style.setProperty(
        "--scroll",
        String(Math.min(currentY, PARALLAX_CEILING))
      );

      if (headerVisible !== stateRef.current.headerVisible || scrolled !== stateRef.current.scrolled) {
        stateRef.current = { headerVisible, scrolled };
        setState(stateRef.current);
      }
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
      document.documentElement.style.removeProperty("--scroll");
    };
  }, [hasFocus, mobileNavOpen]);

  return state;
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
