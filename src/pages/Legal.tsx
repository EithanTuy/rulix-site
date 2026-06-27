// Legal.tsx - disclaimer, acceptable use, and privacy in one page.

const SECTIONS = [
  {
    title: "No legal determinations",
    body: "Rulix provides decision support only. It does not, and is designed to refuse to, issue final ECCN classifications, export license decisions, sanctions rulings, or jurisdiction determinations. Output from Rulix is not legal advice and is not a substitute for review by qualified export-control counsel or an empowered official within your organization.",
  },
  {
    title: "Acceptable input",
    body: "You may submit only sanitized, public, or explicitly approved text. You must not submit Controlled Unclassified Information (CUI), ITAR technical data, controlled technical data, classified information, or third-party proprietary specifications you are not authorized to share. You are responsible for sanitizing input before submission.",
  },
  {
    title: "Accuracy",
    body: "Audit output may be incomplete or wrong. Candidate classifications, readiness scores, and cited sources are starting points for human review, not conclusions. Always verify against the current official text of the EAR, CCL, ITAR, and applicable sanctions programs.",
  },
  {
    title: "Privacy",
    body: "The public demo runs entirely in your browser on sample data. Demo input is not transmitted to our servers. If you contact us directly, we use the information you send only to respond to your inquiry, and we do not sell it.",
  },
];

export function Legal() {
  return (
    <section className="section-white">
      <div className="wrap grid gap-12 py-16 lg:grid-cols-[0.55fr_1fr] lg:py-24">
        <aside className="reveal">
          <span className="section-label text-accent">Legal</span>
          <h1 className="mt-4 text-[clamp(42px,5.6vw,70px)] leading-none">Disclaimer, acceptable use & privacy</h1>
          <p className="mt-6 text-[13px] leading-6 text-text-3">Last updated: June 2026. Rulix is a research-grade prototype.</p>
        </aside>

        <div className="legal-stack reveal" style={{ transitionDelay: "80ms" }}>
          {SECTIONS.map((section) => (
            <article key={section.title}>
              <h2>{section.title}</h2>
              <p>{section.body}</p>
            </article>
          ))}
          <article>
            <h2>Contact</h2>
            <p>
              Questions about these terms: <a href="mailto:security@rulix.cloud">security@rulix.cloud</a>.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
