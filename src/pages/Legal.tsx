// Legal.tsx — disclaimer, acceptable use, and privacy in one page (prototype stage).

export function Legal() {
  return (
    <section>
      <div className="wrap max-w-[78ch] py-20">
        <span className="eyebrow">Legal</span>
        <h1 className="text-[clamp(30px,4vw,42px)]">Disclaimer, acceptable use &amp; privacy</h1>
        <p className="footnote mt-3">Last updated: June 2026 · Rulix is a research-grade prototype.</p>

        <h2 className="mt-12 text-[20px]">No legal determinations</h2>
        <p className="text-[14.5px] text-text-2">
          Rulix provides decision support only. It does not — and is designed to refuse to — issue
          final ECCN classifications, export license decisions, sanctions rulings, or jurisdiction
          determinations. Output from Rulix is not legal advice and is not a substitute for review by
          qualified export-control counsel or an empowered official within your organization. The
          human reviewer of record is responsible for every decision.
        </p>

        <h2 className="mt-10 text-[20px]">Acceptable input</h2>
        <p className="text-[14.5px] text-text-2">
          You may submit only sanitized, public, or explicitly approved text. You must not submit
          Controlled Unclassified Information (CUI), ITAR technical data, controlled technical data,
          classified information, or third-party proprietary specifications you are not authorized to
          share. You are responsible for sanitizing input before submission.
        </p>

        <h2 className="mt-10 text-[20px]">Accuracy</h2>
        <p className="text-[14.5px] text-text-2">
          Audit output may be incomplete or wrong. Candidate classifications, readiness scores, and
          cited sources are starting points for human review, not conclusions. Always verify against
          the current official text of the EAR, CCL, ITAR, and applicable sanctions programs.
        </p>

        <h2 className="mt-10 text-[20px]">Privacy</h2>
        <p className="text-[14.5px] text-text-2">
          The public demo runs entirely in your browser on sample data; demo input is not transmitted
          to our servers. If you contact us directly, we use the information you send only to respond
          to your inquiry, and we do not sell or share it. Where hosted models are used, those calls
          are made server-side under the terms of the model provider&apos;s API agreement. Contact us
          with any questions about data handling or to request deletion of information you&apos;ve sent.
        </p>

        <h2 className="mt-10 text-[20px]">Contact</h2>
        <p className="text-[14.5px] text-text-2">
          Questions about these terms: <a className="text-accent" href="mailto:tuyilin2@msu.edu">tuyilin2@msu.edu</a>.
        </p>
      </div>
    </section>
  );
}
