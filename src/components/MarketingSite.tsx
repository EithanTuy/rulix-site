import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileSearch,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UploadCloud
} from "lucide-react";

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

const CONTACT_EMAIL = "security@rulix.cloud";

const MARKETING_PAGES: Record<MarketingPageKey, PageMeta> = {
  home: {
    key: "home",
    path: "/",
    title: "Rulix - Defensible export-control memo review",
    description:
      "Rulix checks classification memos for missing thresholds, weak evidence, and reviewer questions before human export-control reviewers sign off.",
    heroTitle: "Defensible export-control memo review",
    heroCopy:
      "Rulix checks classification memos for missing thresholds, weak evidence, and reviewer questions before your export-control team signs off. Human reviewers decide. Rulix keeps the audit trail organized."
  },
  "export-control-memo-review": {
    key: "export-control-memo-review",
    path: "/export-control-memo-review",
    title: "Export-control memo review software | Rulix",
    description:
      "Review export-control classification memos for evidence gaps, missing technical thresholds, reviewer questions, and audit-ready signoff.",
    heroTitle: "Export-control memo review with a defensible audit trail",
    heroCopy:
      "Rulix reviews sanitized classification memos for the gaps that slow signoff: missing thresholds, unsupported reasoning, weak source evidence, and unresolved reviewer questions."
  },
  "eccn-classification-assistant": {
    key: "eccn-classification-assistant",
    path: "/eccn-classification-assistant",
    title: "ECCN classification assistant for reviewers | Rulix",
    description:
      "Rulix helps export-control reviewers structure ECCN classification review, evidence gaps, and human signoff without replacing expert judgment.",
    heroTitle: "An ECCN classification assistant for human reviewers",
    heroCopy:
      "Rulix turns a draft memo into a focused review workspace: possible classification paths, evidence questions, missing specifications, and a signoff record your team can defend."
  },
  "ai-export-compliance-review": {
    key: "ai-export-compliance-review",
    path: "/ai-export-compliance-review",
    title: "AI export compliance review with human signoff | Rulix",
    description:
      "Use AI decision support to spot export-control memo gaps while keeping final determinations with trained human reviewers.",
    heroTitle: "AI-assisted export review without surrendering judgment",
    heroCopy:
      "Rulix uses AI and deterministic checks to pressure-test memo reasoning, surface questions, and organize evidence while your export-control team keeps final authority."
  },
  "university-export-control-review": {
    key: "university-export-control-review",
    path: "/university-export-control-review",
    title: "University export-control memo review | Rulix",
    description:
      "Rulix helps universities and research operations triage public or sanitized export-control memo drafts before empowered officials spend review time.",
    heroTitle: "Export-control triage for universities and research ops",
    heroCopy:
      "Rulix helps research teams prepare cleaner memo drafts, isolate missing technical facts, and keep questions organized before an empowered official or counsel reviews."
  },
  "manufacturer-eccn-review": {
    key: "manufacturer-eccn-review",
    path: "/manufacturer-eccn-review",
    title: "Manufacturer ECCN review support | Rulix",
    description:
      "Rulix helps manufacturers and labs reduce back-and-forth on ECCN memo evidence, product specifications, and reviewer-ready questions.",
    heroTitle: "ECCN review packets for manufacturers and labs",
    heroCopy:
      "Rulix helps product, engineering, and compliance teams catch missing specs and unsupported claims before a classification memo reaches final review."
  }
};

const PAGE_BY_PATH = new Map(Object.values(MARKETING_PAGES).map((page) => [page.path, page]));

const auditRows = [
  {
    finding: "Missing threshold",
    why: "The memo names performance but omits the measured value and test condition.",
    recommendation: "Add model-specific speed, resolution, tolerance, or operating limits.",
    priority: "High"
  },
  {
    finding: "Unsupported EAR99 fallback",
    why: "The conclusion skips why nearby CCL entries do not apply.",
    recommendation: "Record the rejected entries and the evidence used to reject them.",
    priority: "High"
  },
  {
    finding: "End-use mixed into classification",
    why: "Transaction facts appear in the classification rationale.",
    recommendation: "Separate item classification from license/end-use review.",
    priority: "Review"
  }
];

const useCases = [
  {
    title: "Export-control officers",
    copy: "Move faster from draft memo to signoff by seeing evidence gaps, reviewer questions, and audit events in one place.",
    detail: "Good for teams whose determinations get revisited months later."
  },
  {
    title: "Manufacturers and labs",
    copy: "Reduce back-and-forth on product specifications before a classification packet reaches legal or compliance review.",
    detail: "Useful when engineering facts, datasheets, and memo conclusions drift apart."
  },
  {
    title: "Universities and research ops",
    copy: "Triage public or sanitized memo drafts before counsel or empowered officials spend scarce review time.",
    detail: "Keeps open questions clear without uploading controlled technical data."
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
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    email: "",
    company: "",
    role: "",
    volume: "1-5 reviews/month",
    memoReady: false
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
    const subject = encodeURIComponent("Rulix memo audit request");
    const body = encodeURIComponent([
      "I'd like to book a 20-minute Rulix memo audit.",
      "",
      `Work email: ${form.email}`,
      `Company: ${form.company}`,
      `Role: ${form.role}`,
      `Expected review volume: ${form.volume}`,
      `Redacted memo sample ready: ${form.memoReady ? "yes" : "not yet"}`,
      "",
      "Please send available times and sample-audit next steps."
    ].join("\n"));
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  };

  return (
    <div className="marketing-site">
      <header className="marketing-header">
        <a className="marketing-brand" href="/" aria-label="Rulix home">
          <img src="/favicon.svg" alt="" />
          <span>Rulix</span>
        </a>
        <nav className="marketing-nav" aria-label="Primary">
          <a href="#product">Product</a>
          <a href="#sample-audit">Sample audit</a>
          <a href="#use-cases">Use cases</a>
          <a href="#compliance">Compliance</a>
        </nav>
        <a className="marketing-nav-cta" href="#lead">Start</a>
      </header>

      <main>
        <section className="marketing-hero" id="product">
          <div className="marketing-hero-copy">
            <h1>{page.heroTitle}</h1>
            <p>{page.heroCopy}</p>
            <div className="marketing-actions">
              <a className="marketing-button primary" href="#lead">
                Book a 20-minute memo audit
                <ArrowRight size={18} />
              </a>
              <a className="marketing-button secondary" href="#sample-audit">
                See sample audit output
              </a>
            </div>
            <p className="marketing-trust">
              <ShieldCheck size={18} />
              Use public, sanitized, or approved data in the hosted workspace.
            </p>
          </div>
          <div className="marketing-product-visual" aria-label="Rulix sample audit output preview">
            <img src="/marketing/rulix-audit-product.png" alt="Rulix audit packet with readiness score, evidence gaps, reviewer questions, and human signoff trail" />
            <div className="visual-stat readiness">
              <strong>82%</strong>
              <span>Readiness</span>
            </div>
            <div className="visual-stat signoff">
              <CheckCircle2 size={18} />
              <span>Human signoff required</span>
            </div>
          </div>
        </section>

        <section className="sample-band" id="sample-audit">
          <div className="section-heading split">
            <div>
              <h2>Sample audit output</h2>
              <p>
                Rulix turns a memo into reviewer-ready findings, evidence gaps, and questions.
                The output supports judgment; it does not replace it.
              </p>
            </div>
            <a className="marketing-button secondary" href="#lead">
              <Download size={18} />
              Download sample audit pack
            </a>
          </div>
          <div className="marketing-audit-output">
            <div className="marketing-audit-score">
              <span>Readiness score</span>
              <strong>82</strong>
              <p>Ready for focused human review after high-priority evidence gaps are resolved.</p>
            </div>
            <div className="marketing-audit-table" role="table" aria-label="Sample audit findings">
              <div className="marketing-audit-row marketing-audit-head" role="row">
                <span>Finding</span>
                <span>Why it matters</span>
                <span>Recommendation</span>
                <span>Priority</span>
              </div>
              {auditRows.map((row) => (
                <div className="marketing-audit-row" role="row" key={row.finding}>
                  <span>{row.finding}</span>
                  <span>{row.why}</span>
                  <span>{row.recommendation}</span>
                  <span className={`priority ${row.priority.toLowerCase()}`}>{row.priority}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="use-case-section" id="use-cases">
          <div className="section-heading">
            <h2>Built for the people who own the review</h2>
            <p>Different teams come to Rulix with different bottlenecks. The workflow stays grounded in evidence and human signoff.</p>
          </div>
          <div className="use-case-list">
            {useCases.map((item, index) => (
              <article className="use-case-row" key={item.title}>
                <span className="use-case-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </div>
                <strong>{item.detail}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="compliance-section" id="compliance">
          <div className="compliance-copy">
            <h2>Clear compliance boundary, from the first conversation</h2>
            <p>
              Rulix is decision support for authorized reviewers. The hosted workspace is for
              public, sanitized, or approved data. Controlled technical data conversations need
              an approved deployment boundary.
            </p>
          </div>
          <div className="boundary-list">
            <div>
              <FileSearch size={22} />
              <strong>Decision support only</strong>
              <span>Human reviewers decide and own final determinations.</span>
            </div>
            <div>
              <ShieldCheck size={22} />
              <strong>Hosted data boundary</strong>
              <span>Use public, sanitized, or approved data in the commercial workspace.</span>
            </div>
            <div>
              <LockKeyhole size={22} />
              <strong>Controlled-data path</strong>
              <span>GovCloud or customer-controlled deployment is available for deeper reviews.</span>
            </div>
          </div>
        </section>

        <section className="lead-section" id="lead">
          <div className="lead-copy">
            <h2>Book a 20-minute memo audit</h2>
            <p>
              Bring a sanitized memo draft, a public product description, or a representative
              sample. We will show the readiness score, evidence gaps, reviewer questions, and
              audit trail the product produces.
            </p>
            <div className="lead-download">
              <Download size={18} />
              <span>Ask for the sample audit pack if you want to review the output before a call.</span>
            </div>
          </div>
          <form className="lead-form" onSubmit={submitLead}>
            <label>
              Work email
              <input
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="you@company.edu"
              />
            </label>
            <label>
              Company
              <input
                required
                value={form.company}
                onChange={(event) => setForm((current) => ({ ...current, company: event.target.value }))}
                placeholder="Organization or lab"
              />
            </label>
            <label>
              Role
              <input
                required
                value={form.role}
                onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
                placeholder="Export-control officer, counsel, engineering lead"
              />
            </label>
            <label>
              Expected review volume
              <select value={form.volume} onChange={(event) => setForm((current) => ({ ...current, volume: event.target.value }))}>
                <option>1-5 reviews/month</option>
                <option>6-20 reviews/month</option>
                <option>21-50 reviews/month</option>
                <option>50+ reviews/month</option>
              </select>
            </label>
            <label className="upload-intent">
              <input
                type="checkbox"
                checked={form.memoReady}
                onChange={(event) => setForm((current) => ({ ...current, memoReady: event.target.checked }))}
              />
              <span>
                <UploadCloud size={18} />
                I have a redacted memo sample ready to discuss.
              </span>
            </label>
            <button className="marketing-button primary full" type="submit">
              <Mail size={18} />
              Send audit request
            </button>
            {submitted && (
              <p className="lead-confirmation">
                Opening your mail client with the request details. Attach only public, sanitized, or approved samples.
              </p>
            )}
          </form>
        </section>

        <section className="seo-section" aria-label="Rulix topic pages">
          <h2>Explore Rulix by review need</h2>
          <div className="seo-link-grid">
            {seoLinks.map((item) => (
              <a href={item.path} key={item.path}>
                <strong>{item.heroTitle}</strong>
                <span>{item.description}</span>
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <span>Rulix</span>
        <a href="https://app.rulix.cloud">Sign in to app</a>
        <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
      </footer>
    </div>
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
  upsertMeta("og:image", `${window.location.origin}/marketing/rulix-audit-product.png`, "property");
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
