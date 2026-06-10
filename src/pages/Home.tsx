// Home.tsx — single scrolling landing page: hero, how-it-works, features,
// security teaser, audience, demo CTA.

import {
  ClipboardCheck, FileSearch, GitBranch, Landmark, ListChecks, Lock,
  MessageSquareWarning, Scale, ShieldCheck, University, Workflow,
} from "lucide-react";
import { Link } from "react-router-dom";
import { ConsoleMock } from "../components/ConsoleMock";

export function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <Features />
      <SecurityTeaser />
      <Audience />
      <DemoCta />
    </>
  );
}

function Hero() {
  return (
    <section className="hero-bg border-b border-line-soft">
      <div className="wrap grid items-center gap-12 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div>
          <h1 className="text-[clamp(34px,5vw,52px)]">
            <span className="text-accent">AI-assisted</span> export-control classification.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[16.5px] text-text-2">
            Rulix audits classification memos with a council of AI agents backed by deterministic
            checks — then hands your reviewers a readiness score, the exact evidence gaps, and an
            audit-ready record. Your team makes the call. Rulix makes it defensible.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#demo" className="btn primary lg">Request a demo</a>
            <a href="#how" className="btn lg">See how it works</a>
          </div>
          <p className="footnote mt-6">
            No final ECCN, license, sanctions, or jurisdiction determinations — ever. Sanitized input only.
          </p>
        </div>
        <div className="reveal vis">
          <ConsoleMock />
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  {
    icon: FileSearch,
    title: "Sanitized intake",
    body: "Paste a memo or drop a document. One line is enough to start — Rulix asks for what it's missing.",
  },
  {
    icon: GitBranch,
    title: "Council audit",
    body: "LLM agents extract and challenge every claim while deterministic rules validate citations and routing risks.",
  },
  {
    icon: ListChecks,
    title: "Readiness & gaps",
    body: "A readiness score, candidate classifications with official source links, and targeted questions that close the gaps.",
  },
  {
    icon: ClipboardCheck,
    title: "Human disposition",
    body: "Your reviewer records the decision. Rulix keeps the full trail — claims, evidence, history — as the artifact.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="border-b border-line-soft bg-panel">
      <div className="wrap py-20">
        <div className="reveal max-w-[60ch]">
          <span className="eyebrow">How it works</span>
          <h2 className="text-[clamp(26px,3.4vw,36px)]">From raw memo to reviewer-ready in minutes.</h2>
        </div>
        <ol className="m-0 mt-12 grid list-none gap-5 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="reveal border border-line-soft bg-bg p-5" style={{ transitionDelay: `${i * 70}ms` }}>
              <div className="flex items-center gap-3">
                <span className="grid size-9 flex-none place-items-center bg-accent-soft text-accent">
                  <s.icon size={18} />
                </span>
                <span className="font-mono text-[12px] text-text-3">0{i + 1}</span>
              </div>
              <h3 className="mt-4 text-[16px]">{s.title}</h3>
              <p className="m-0 mt-2 text-[13.5px] text-text-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: Workflow,
    title: "Council orchestration",
    body: "Multiple agents argue over the memo — extraction, challenge, readiness — with deterministic fallback when the model is unavailable.",
  },
  {
    icon: Scale,
    title: "Candidate classification",
    body: "Suggested ECCN candidates with confidence, evidence status, and links to the official source text — EAR, CCL, ITAR.",
  },
  {
    icon: MessageSquareWarning,
    title: "Evidence-gap questions",
    body: "Prioritized, answerable questions with the expected readiness impact of each answer. No vague 'needs more info'.",
  },
  {
    icon: ShieldCheck,
    title: "Guarded Q&A",
    body: "Ask anything about an audit. Requests for final legal determinations are refused by design, not by policy doc.",
  },
  {
    icon: ListChecks,
    title: "Reviewer queue",
    body: "Triage by readiness, filter by gate state, walk findings, claims, and history — then record a disposition.",
  },
  {
    icon: Lock,
    title: "Audit-ready trail",
    body: "Every claim, citation check, question, and decision is kept. The artifact is the defense.",
  },
];

function Features() {
  return (
    <section id="features" className="border-b border-line-soft">
      <div className="wrap py-20">
        <div className="reveal max-w-[60ch]">
          <span className="eyebrow">Features</span>
          <h2 className="text-[clamp(26px,3.4vw,36px)]">Built for the review, not just the answer.</h2>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="reveal panel p-5" style={{ transitionDelay: `${(i % 3) * 70}ms` }}>
              <span className="grid size-9 place-items-center bg-accent-soft text-accent">
                <f.icon size={18} />
              </span>
              <h3 className="mt-4 text-[16px]">{f.title}</h3>
              <p className="m-0 mt-2 text-[13.5px] text-text-2">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SecurityTeaser() {
  return (
    <section className="border-b border-line-soft bg-ink text-white">
      <div className="wrap grid items-center gap-10 py-20 lg:grid-cols-[1fr_1fr]">
        <div className="reveal">
          <span className="eyebrow">Security &amp; data handling</span>
          <h2 className="text-[clamp(26px,3.4vw,36px)] text-white">Cautious by construction.</h2>
          <p className="mt-4 max-w-[52ch] text-[15px] text-white/70">
            Rulix is built for a domain where the input itself can be sensitive. The guardrails are
            architectural, not optional settings.
          </p>
          <Link to="/security" className="btn mt-7 !border-white/25 !bg-transparent !text-white hover:!border-white/60">
            Read the security overview
          </Link>
        </div>
        <ul className="reveal m-0 list-none space-y-4 p-0 text-[14px]" style={{ transitionDelay: "100ms" }}>
          {[
            "Sanitized, public, or approved input only — CUI and ITAR technical data stay out of hosted models",
            "Hosted LLM calls are server-side only; keys never reach the browser",
            "Deterministic rule checks validate citations independently of any model",
            "Final determinations are refused by design — a human reviewer always decides",
          ].map((t) => (
            <li key={t} className="flex gap-3 border border-white/15 bg-white/5 px-4 py-3.5">
              <ShieldCheck size={17} className="mt-0.5 flex-none text-ok" />
              <span className="text-white/85">{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const AUDIENCES = [
  {
    icon: University,
    title: "University export offices",
    body: "Fundamental-research triage with a record that holds up when the auditor asks why.",
  },
  {
    icon: Landmark,
    title: "Trade-compliance teams",
    body: "Consistent memo quality across analysts, with gaps surfaced before sign-off instead of after.",
  },
  {
    icon: Scale,
    title: "Dual-use exporters",
    body: "Catch unsupported EAR99 assertions and missing parameters before they become findings.",
  },
];

function Audience() {
  return (
    <section className="border-b border-line-soft bg-panel">
      <div className="wrap py-20">
        <div className="reveal max-w-[60ch]">
          <span className="eyebrow">Who it&apos;s for</span>
          <h2 className="text-[clamp(26px,3.4vw,36px)]">Teams whose decisions get audited.</h2>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {AUDIENCES.map((a, i) => (
            <div key={a.title} className="reveal border border-line-soft bg-bg p-6" style={{ transitionDelay: `${i * 70}ms` }}>
              <a.icon size={22} className="text-accent" />
              <h3 className="mt-4 text-[16px]">{a.title}</h3>
              <p className="m-0 mt-2 text-[13.5px] text-text-2">{a.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DemoCta() {
  const mail =
    "mailto:hello@rulix.example?subject=Rulix%20demo%20request&body=Organization%3A%0ARole%3A%0AWhat%20does%20your%20review%20workflow%20look%20like%20today%3F%0A";
  return (
    <section id="demo" className="hero-bg">
      <div className="wrap py-24 text-center">
        <div className="reveal mx-auto max-w-[58ch]">
          <h2 className="text-[clamp(28px,3.8vw,40px)]">See your own memo workflow in Rulix.</h2>
          <p className="mt-4 text-[15.5px] text-text-2">
            We&apos;ll walk through the council audit, the reviewer queue, and the audit artifact —
            on demo data, in about 25 minutes.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href={mail} className="btn primary lg">Request a demo</a>
            <a href={mail} className="btn lg">Join the pilot waitlist</a>
          </div>
          <p className="footnote mt-6">
            Prototype status: research-grade. Pilots run on sanitized or public data only.
          </p>
        </div>
      </div>
    </section>
  );
}
