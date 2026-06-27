// ThankYou.tsx - lead confirmation page for the consult path.

import { useEffect } from "react";
import { ArrowRight, CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { trackEvent } from "../lib/analytics";

export function ThankYou() {
  useEffect(() => {
    document.title = "Review request prepared | Rulix";
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (meta) meta.content = "Your Rulix review request has been prepared. Send the email draft to begin the consult path.";
    trackEvent("view_thank_you", { source: "lead_form" });
  }, []);

  return (
    <section className="thank-you-page">
      <div className="wrap thank-you-grid">
        <div className="thank-you-copy reveal">
          <span className="premium-label">Request prepared</span>
          <h1>Send the email draft. We will take it from there.</h1>
          <p>
            Your qualification details were formatted into an email to security@rulix.cloud. Once it is sent, we can confirm fit, data boundary, and the right review path.
          </p>
          <div className="hero-actions">
            <a href="mailto:security@rulix.cloud" className="btn primary">
              Email Rulix
              <Mail size={17} />
            </a>
            <Link to="/" className="btn ghost">
              Back to site
              <ArrowRight size={17} />
            </Link>
          </div>
        </div>
        <div className="thank-you-panel reveal" style={{ transitionDelay: "90ms" }}>
          <CheckCircle2 size={34} />
          <h2>What happens next</h2>
          {[
            "We confirm whether the memo can be discussed with sanitized or approved inputs.",
            "We identify the review stage, buyer risk, and the questions already blocking confidence.",
            "We recommend a sample audit, pilot path, or approved deployment boundary.",
          ].map((item) => (
            <p key={item}>
              <ShieldCheck size={16} />
              {item}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
