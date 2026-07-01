// Home.tsx - public marketing landing page.

import { useState, useEffect } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  FileSearch,
  FlaskConical,
  GraduationCap,
  Landmark,
  Mail,
  Phone,
  ShieldCheck,
  XCircle,
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
    title: "Rulix — Export-control memo review",
    description:
      "Rulix helps reviewers find gaps, ask better evidence questions, and prepare a clean record before final signoff.",
    h1: "Export-control memo review, organized.",
    body:
      "Rulix helps reviewers find gaps, ask better evidence questions, and prepare a clean record before final signoff.",
  },
  "memo-review": {
    title: "Export-control memo review software | Rulix",
    description:
      "Find gaps in export-control memos before your reviewer does. Missing thresholds, weak evidence, and audit-ready signoff.",
    h1: "Find the gaps in your export-control memos.",
    body:
      "Paste a memo, get a prioritized list of missing facts, weak claims, and the questions your reviewer needs answered.",
  },
  "eccn-assistant": {
    title: "ECCN review support for export-control teams | Rulix",
    description:
      "Rulix helps export-control teams separate what the memo actually proves from what it just asserts.",
    h1: "ECCN review support for export-control teams.",
    body:
      "Rulix separates what the memo actually proves from what it just asserts, then builds the question list your reviewer needs.",
  },
  "ai-review": {
    title: "AI export-control review with human signoff | Rulix",
    description:
      "AI spots the gaps in your classification memo. Your licensed reviewer makes the final call.",
    h1: "AI spots the gaps. Your reviewer makes the call.",
    body:
      "Upload a classification memo. Rulix flags the weak evidence and missing thresholds. Your licensed reviewer decides.",
  },
  university: {
    title: "University export-control memo review | Rulix",
    description:
      "Screen public or sanitized memos before they reach your licensed reviewer.",
    h1: "Export-control review support for university teams.",
    body:
      "Screen public or sanitized memos before they reach your licensed reviewer. Keep the workload manageable without relaxing your data rules.",
  },
  manufacturer: {
    title: "ECCN memo review for manufacturers and labs | Rulix",
    description:
      "Stop back-and-forth on product specs. Rulix turns vague blockers into specific questions your team can answer.",
    h1: "Get your ECCN memo ready before it reaches legal review.",
    body:
      "Stop the back-and-forth on product specs. Rulix turns vague blockers into specific questions your team can actually answer.",
  },
};

const WHAT_YOU_GET = [
  {
    title: "Unsupported claims flagged",
    body: "Highlighted beside the memo section that needs support — so your reviewer knows exactly where to look.",
  },
  {
    title: "Missing evidence surfaced",
    body: "Grouped by what the reviewer needs before signoff, not scattered across comments and email threads.",
  },
  {
    title: "Decision trail kept",
    body: "Actions, notes, and export state stay in one record. The whole review is auditable and exportable.",
  },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Add the memo",
    body: "Upload or paste memo content, support docs, classifications, and context. Public, sanitized, or approved samples only.",
  },
  {
    step: "02",
    title: "Map the reasoning",
    body: "Rulix identifies claims, assumptions, missing evidence, and decision logic tied to the memo text.",
  },
  {
    step: "03",
    title: "Flag review risk",
    body: "Gaps are grouped by what a reviewer actually needs to inspect — not a generic checklist.",
  },
  {
    step: "04",
    title: "Generate the record",
    body: "Export the summary, checklist, and full review trail for final human signoff.",
  },
];

const USE_CASES = [
  {
    icon: Landmark,
    title: "Export-control officers",
    body: "Spot the weak claims before you sign off. Every decision stays on the record.",
  },
  {
    icon: FlaskConical,
    title: "Manufacturers and labs",
    body: "Stop the back-and-forth. Turn vague requests into specific questions your engineering team can answer.",
  },
  {
    icon: GraduationCap,
    title: "Universities and research offices",
    body: "Pre-screen public or sanitized memos before they reach your licensed reviewer.",
  },
];

const FIT_CHECK = [
  {
    fits: true,
    icon: ShieldCheck,
    title: "Rulix fits when",
    body: "Your team reviews memo drafts, needs evidence-aware gap finding, and keeps final judgment with qualified people.",
  },
  {
    fits: null,
    icon: FileSearch,
    title: "Data boundary",
    body: "Use only public, sanitized, or approved data in the hosted workspace unless your policy allows more.",
  },
  {
    fits: false,
    icon: XCircle,
    title: "Rulix is not a fit when",
    body: "You need guaranteed classifications, autonomous legal decisions, or a place for unmanaged sensitive data.",
  },
];

const FAQS = [
  {
    q: "How should we use Rulix for regulatory work?",
    a: "Treat Rulix as review support, not a final authority. Use it to find gaps and prepare your reviewer's question list. Your licensed reviewer or counsel makes the final determination.",
  },
  {
    q: "What if the AI gets something wrong?",
    a: "Model output is a finding to review, not final truth. Every analysis stays tied to memo passages and source context so your reviewer can accept, override, or request more information.",
  },
  {
    q: "How is this different from a general AI assistant?",
    a: "Generic chat is free-form. Rulix keeps intake, evidence gaps, decisions, audit trail, and export records in one structured workflow built around export-control memo work.",
  },
  {
    q: "Does Rulix replace counsel or compliance reviewers?",
    a: "No. Rulix assists expert review — it doesn't make legal guarantees or regulatory determinations. Your reviewer of record signs off.",
  },
  {
    q: "What data can we put into it?",
    a: "The hosted version is for public, sanitized, sample, or explicitly approved text only. Do not submit CUI, ITAR technical data, controlled information, or proprietary specs without an approved deployment boundary.",
  },
];

const EMAIL = "tuyilin2@msu.edu";
const PHONE_DISPLAY = "+1 517 490 4177";
const PHONE_TEL = "+15174904177";
const MAIL_HREF =
  `mailto:${EMAIL}?subject=Rulix%20memo%20audit%20request` +
  `&body=Organization%3A%0ARole%3A%0AApprox.%20memo%20volume%20per%20month%3A%0ASample%20memo%20available%3F%20Yes%20%2F%20No%0A%0AWhat%20review%20workflow%20are%20you%20trying%20to%20speed%20up%3F%0A`;

export function Home({ variant = "default" }: { variant?: LandingVariant }) {
  const meta = META[variant];
  usePageMeta(meta.title, meta.description);
  return (
    <>
      <Hero meta={meta} />
      <ProductDemo />
      <WhatYouGet />
      <HowItWorks />
      <UseCases />
      <FitCheck />
      <Faq />
      <LeadSection />
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

type VideoCrop = { left: string; top: string; width: string; height: string };

function ProductShot({
  src,
  poster,
  alt,
  className = "",
  videoKey,
  crop,
}: {
  src: string;
  poster: string;
  alt: string;
  className?: string;
  videoKey?: string;
  crop: VideoCrop;
}) {
  return (
    <div className={`panel relative overflow-hidden ${className}`}>
      <video
        key={videoKey}
        muted
        loop
        playsInline
        autoPlay
        preload="metadata"
        poster={poster}
        style={{ position: "absolute", maxWidth: "none", ...crop }}
        aria-label={alt}
      >
        <source src={src} type="video/mp4" />
      </video>
    </div>
  );
}

function Hero({ meta }: { meta: (typeof META)[LandingVariant] }) {
  return (
    <section className="hero-bg border-b border-line-soft">
      <div className="wrap grid items-center gap-12 py-16 lg:grid-cols-[0.9fr_1.1fr] lg:py-20">
        <div>
          <h1 className="max-w-[14ch] text-[clamp(38px,5.5vw,68px)] leading-[0.96] tracking-[-0.02em]">
            {meta.h1}
          </h1>
          <p className="mt-6 max-w-[52ch] text-[17px] leading-8 text-text-2">
            {meta.body}
          </p>
          <div className="mt-8">
            <Link to="/contact" className="btn primary lg">
              Book a memo audit
              <ArrowRight size={17} />
            </Link>
          </div>
          <p className="footnote mt-5 flex max-w-[52ch] items-start gap-2">
            <ShieldCheck size={15} className="mt-0.5 flex-none text-ok" />
            AI helps. Your reviewer decides. Hosted version is for public or sanitized memos only.
          </p>
        </div>
        <div>
          <ProductShot
            src="/marketing/demos/hero-rulix-review-loop.mp4"
            poster="/marketing/demos/hero-rulix-review-loop.webp"
            alt="Rulix audit output showing a readiness score, evidence gaps, and reviewer questions"
            className="aspect-[1121/799] shadow-lg"
            crop={{ left: "-62.98%", top: "-18.52%", width: "171.28%", height: "135.17%" }}
          />
        </div>
      </div>
    </section>
  );
}

const DEMOS = [
  {
    key: "find",
    label: "Find gaps",
    title: "Reviewer sees the gaps",
    body: "Unsupported claims are highlighted inline. The reviewer clicks through to see what's missing and what question to ask.",
    video: "/marketing/demos/demo-find-missing-reasoning.mp4",
    poster: "/marketing/demos/demo-find-missing-reasoning.webp",
  },
  {
    key: "resolve",
    label: "Resolve gaps",
    title: "Analysis runs only when ready",
    body: "The analysis button is explicit. Review doesn't happen behind automation — you control when it runs.",
    video: "/marketing/demos/demo-resolve-review-gaps.mp4",
    poster: "/marketing/demos/demo-resolve-review-gaps.webp",
  },
  {
    key: "export",
    label: "Export record",
    title: "Export a clean review record",
    body: "Export the summary, checklist, and full review trail for final human signoff.",
    video: "/marketing/demos/demo-export-review-record.mp4",
    poster: "/marketing/demos/demo-export-review-record.webp",
  },
] as const;

function ProductDemo() {
  const [active, setActive] = useState(0);
  const demo = DEMOS[active];

  return (
    <section id="product" className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)]">
            A memo enters the review queue.
          </h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            Rulix starts from a real memo workspace — not a loose prompt thread. The team sees what's being reviewed before AI analysis starts.
          </p>
        </div>

        <div className="mt-10 inline-flex gap-1 border border-line-soft bg-panel p-1">
          {DEMOS.map((d, i) => (
            <button
              key={d.key}
              onClick={() => setActive(i)}
              className={`px-4 py-1.5 text-[13.5px] font-[530] transition-colors ${
                i === active
                  ? "bg-accent text-white"
                  : "text-text-2 hover:text-text-1"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="mt-6 max-w-[640px]">
          <div className="panel relative aspect-[1191/791] overflow-hidden">
            {DEMOS.map((d, i) => (
              <video
                key={d.key}
                muted
                loop
                playsInline
                autoPlay
                preload="auto"
                poster={d.poster}
                aria-label={d.title}
                aria-hidden={i !== active}
                style={{
                  position: "absolute",
                  maxWidth: "none",
                  left: "-53.74%",
                  top: "-18.96%",
                  width: "161.21%",
                  height: "136.54%",
                }}
                className={`transition-opacity duration-200 ${
                  i === active ? "opacity-100" : "opacity-0"
                }`}
              >
                <source src={d.video} type="video/mp4" />
              </video>
            ))}
          </div>
          <div className="mt-5">
            <h3 className="text-[18px]">{demo.title}</h3>
            <p className="mt-2 max-w-[56ch] text-[14.5px] text-text-2">{demo.body}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function WhatYouGet() {
  return (
    <section className="border-b border-line-soft bg-panel">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)]">What comes out of a Rulix review.</h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            Every review produces structured output your team can act on and your reviewer can inspect.
          </p>
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {WHAT_YOU_GET.map((item) => (
            <div key={item.title} className="panel p-6">
              <h3 className="text-[16px]">{item.title}</h3>
              <p className="mt-3 text-[14px] text-text-2">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)]">From draft memo to review-ready record.</h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            The workflow turns scattered draft analysis into a record your reviewer can inspect, revise, and approve.
          </p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="border border-line-soft bg-panel p-6">
              <span className="font-mono text-[13px] font-bold text-accent">{item.step}</span>
              <h3 className="mt-3 text-[17px]">{item.title}</h3>
              <p className="mt-2 text-[13.5px] text-text-2">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section id="use-cases" className="border-b border-line-soft bg-panel">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)]">Built for teams that need to show their work.</h2>
        </div>
        <div className="mt-10 divide-y divide-line-soft border-y border-line-soft">
          {USE_CASES.map((item) => (
            <div key={item.title} className="grid gap-5 py-8 md:grid-cols-[70px_1fr] md:items-center">
              <span className="grid size-12 place-items-center bg-accent-soft text-accent">
                <item.icon size={22} />
              </span>
              <div>
                <h3 className="text-[20px]">{item.title}</h3>
                <p className="m-0 mt-2 max-w-[60ch] text-[14.5px] text-text-2">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-10 text-center">
          <Link to="/contact" className="btn lg">
            Talk to us about your workflow
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

function FitCheck() {
  return (
    <section className="border-b border-line-soft bg-ink text-white">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)] text-white">
            Know when Rulix belongs in the workflow.
          </h2>
          <p className="mt-4 max-w-[54ch] text-[15px] text-white/70">
            Rulix supports memo review. It is not autopilot legal judgment, guaranteed classification, or a place for unmanaged sensitive data.
          </p>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {FIT_CHECK.map((item) => (
            <div key={item.title} className="grid grid-cols-[auto_1fr] gap-3 border border-white/15 bg-white/5 p-5">
              <item.icon
                size={18}
                className={
                  item.fits === true ? "mt-0.5 text-ok" :
                  item.fits === false ? "mt-0.5 text-block" :
                  "mt-0.5 text-white/50"
                }
              />
              <div>
                <strong className="text-[15px] text-white">{item.title}</strong>
                <p className="m-0 mt-1 text-[13.5px] text-white/70">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-10">
          <Link to="/security" className="btn !border-white/25 !bg-transparent !text-white hover:!border-white/60">
            Security and data policy
          </Link>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="max-w-[68ch]">
          <h2 className="text-[clamp(26px,3.5vw,40px)]">Common questions.</h2>
        </div>
        <div className="mt-10 max-w-[72ch] divide-y divide-line-soft border-y border-line-soft">
          {FAQS.map((item, i) => (
            <div key={item.q}>
              <button
                className="flex w-full items-center justify-between gap-4 py-5 text-left text-[15.5px] font-[560]"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
              >
                {item.q}
                <ChevronDown
                  size={17}
                  className="flex-none text-text-3 transition-transform"
                  style={{ transform: open === i ? "rotate(180deg)" : "none" }}
                />
              </button>
              {open === i && (
                <p className="pb-5 text-[14.5px] text-text-2">{item.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LeadSection() {
  return (
    <section id="lead" className="border-b border-line-soft bg-panel">
      <div className="wrap grid gap-10 py-20 lg:grid-cols-[1fr_0.7fr] lg:items-start">
        <div>
          <h2 className="text-[clamp(26px,3.5vw,40px)]">Bring a memo. Walk away with the gaps.</h2>
          <p className="mt-4 max-w-[56ch] text-[15.5px] text-text-2">
            The easiest way to see Rulix in action is a short audit on one of your own public or sanitized memos. We'll show you the readiness score, the gaps, and the questions your reviewer would ask.
          </p>
          <div className="mt-6 flex max-w-[56ch] gap-3 border border-warn/40 bg-warn-soft p-4 text-[13px] text-text-2">
            <AlertTriangle size={18} className="mt-0.5 flex-none text-warn" />
            Don't send controlled technical data, CUI, ITAR material, or classified information unless you have an approved setup in place.
          </div>
        </div>

        <div className="grid gap-4 pt-2">
          <a href={MAIL_HREF} className="panel flex items-center gap-4 p-5 transition-colors hover:border-accent">
            <span className="grid size-11 flex-none place-items-center bg-accent-soft text-accent">
              <Mail size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11.5px] uppercase tracking-[0.1em] text-text-3">Email</span>
              <span className="block truncate text-[15px] font-semibold">{EMAIL}</span>
            </span>
          </a>
          <a href={`tel:${PHONE_TEL}`} className="panel flex items-center gap-4 p-5 transition-colors hover:border-accent">
            <span className="grid size-11 flex-none place-items-center bg-accent-soft text-accent">
              <Phone size={20} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11.5px] uppercase tracking-[0.1em] text-text-3">Phone</span>
              <span className="block text-[15px] font-semibold">{PHONE_DISPLAY}</span>
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
