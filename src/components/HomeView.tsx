import { ArrowRight, BellRing, CalendarClock, Check, ClipboardCheck, Clock3, FileQuestion, Sparkles } from "lucide-react";
import type { MemoRecord, ReviewResult, ReviewerDecision, UserProfile, WorkspacePreferences } from "../types";

interface HomeViewProps {
  user: UserProfile;
  reviews: MemoRecord[];
  results: Record<string, ReviewResult>;
  decisions: Record<string, ReviewerDecision>;
  preferences: WorkspacePreferences;
  onOpenReview: (memoId: string) => void;
  onOpenQueue: () => void;
  onNewReview: () => void;
  onOpenMemoBuilder: () => void;
  onCompleteOnboarding: () => void;
}

export function HomeView({
  user,
  reviews,
  results,
  decisions,
  preferences,
  onOpenReview,
  onOpenQueue,
  onNewReview,
  onOpenMemoBuilder,
  onCompleteOnboarding
}: HomeViewProps) {
  const active = reviews.filter((review) => !review.archivedAt);
  const assigned = active.filter((review) => review.assignedTo === user.id || review.ownerId === user.id);
  const urgent = active.filter((review) => review.priority === "urgent" || isDueSoon(review.dueAt));
  const needsInfo = active.filter((review) => review.lifecycleStage === "needs-information" || review.status === "needs-info");
  const needsDecision = active.filter((review) => results[review.id] && !decisions[review.id]);
  const priorityWork = dedupe([...urgent, ...needsInfo, ...needsDecision, ...assigned]).slice(0, 6);
  const checklist = [
    { label: "Create or receive a review", complete: active.length > 0 },
    { label: user.role === "submitter" ? "Provide the requested evidence" : "Confirm evidence and data class", complete: active.some((review) => (review.attachments?.length ?? 0) > 0 || (review.memoText?.length ?? 0) > 80) },
    { label: user.role === "export-control-officer" ? "Approve an exact AI request" : "Request or run AI analysis", complete: Object.keys(results).length > 0 },
    { label: user.role === "submitter" ? "Track the final outcome" : "Record a human decision", complete: Object.keys(decisions).length > 0 }
  ];
  const completed = checklist.filter((item) => item.complete).length;

  return (
    <main className="px-page px-home" id="main-content">
      <header className="px-page-heading">
        <div><p className="px-eyebrow">Home / My Work</p><h1>Good {dayPart()}, {firstName(user.name)}</h1><p>Start with the work that needs your judgment. Rulix keeps the approval trail attached to every step.</p></div>
        <div className="px-heading-actions"><button className="button" type="button" onClick={onOpenMemoBuilder}><Sparkles size={17} />Draft with AI</button><button className="button primary" type="button" onClick={onNewReview}>New review</button></div>
      </header>

      <section className="px-work-summary" aria-label="Work summary">
        <button type="button" onClick={onOpenQueue}><ClipboardCheck size={19} /><span><strong>{assigned.length}</strong><small>Assigned to you</small></span><ArrowRight size={17} /></button>
        <button type="button" onClick={onOpenQueue}><CalendarClock size={19} /><span><strong>{urgent.length}</strong><small>Urgent or due soon</small></span><ArrowRight size={17} /></button>
        <button type="button" onClick={onOpenQueue}><FileQuestion size={19} /><span><strong>{needsInfo.length}</strong><small>Needs information</small></span><ArrowRight size={17} /></button>
        <button type="button" onClick={onOpenQueue}><BellRing size={19} /><span><strong>{needsDecision.length}</strong><small>Needs a decision</small></span><ArrowRight size={17} /></button>
      </section>

      <div className="px-home-grid">
        <section className="px-section" aria-labelledby="priority-work-title">
          <div className="px-section-head"><div><h2 id="priority-work-title">Priority work</h2><p>Ordered by urgency, blockers, and ownership.</p></div><button type="button" className="px-text-button" onClick={onOpenQueue}>Open queue <ArrowRight size={15} /></button></div>
          <div className="px-work-list">
            {priorityWork.length ? priorityWork.map((review) => (
              <button type="button" key={review.id} className="px-work-row" onClick={() => onOpenReview(review.id)}>
                <span className={`px-priority-dot ${review.priority ?? "normal"}`} />
                <span><strong>{review.title}</strong><small>{review.documentCode} · {workReason(review, results[review.id], decisions[review.id])}</small></span>
                <span className="px-work-meta"><small>{review.dueAt ? dueLabel(review.dueAt) : "No due date"}</small><ArrowRight size={16} /></span>
              </button>
            )) : (
              <div className="px-empty-state compact"><Check size={24} /><h3>No urgent work</h3><p>Create a review or open the full queue to explore recent work.</p><button type="button" className="button" onClick={onNewReview}>Create review</button></div>
            )}
          </div>
        </section>

        {!preferences.onboardingCompletedAt ? (
          <aside className="px-onboarding" aria-labelledby="onboarding-title">
            <div className="px-onboarding-head"><span><Sparkles size={18} /></span><div><h2 id="onboarding-title">Your Rulix workflow</h2><p>{completed} of {checklist.length} complete</p></div></div>
            <div className="px-progress-track" aria-label={`${completed} of ${checklist.length} onboarding steps complete`}><i style={{ width: `${completed / checklist.length * 100}%` }} /></div>
            <ol>{checklist.map((item) => <li className={item.complete ? "complete" : ""} key={item.label}><span>{item.complete ? <Check size={14} /> : null}</span>{item.label}</li>)}</ol>
            <p className="px-onboarding-note">Guidance is role-aware, dismissible, and never blocks experienced users.</p>
            <button type="button" className="button" onClick={onCompleteOnboarding}>{completed === checklist.length ? "Finish setup" : "Dismiss checklist"}</button>
          </aside>
        ) : (
          <aside className="px-recent-panel"><Clock3 size={19} /><h2>Recent activity</h2><p>Your checklist is complete. Review history and audit events remain available inside each case.</p><button type="button" className="px-text-button" onClick={onOpenQueue}>Browse recent reviews <ArrowRight size={15} /></button></aside>
        )}
      </div>
    </main>
  );
}

function dedupe(reviews: MemoRecord[]) {
  return [...new Map(reviews.map((review) => [review.id, review])).values()];
}

function isDueSoon(value?: string) {
  if (!value) return false;
  const days = (Date.parse(value) - Date.now()) / 86_400_000;
  return days <= 7;
}

function dueLabel(value: string) {
  const days = Math.ceil((Date.parse(value) - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days}d`;
}

function workReason(review: MemoRecord, result?: ReviewResult, decision?: ReviewerDecision) {
  if (review.lifecycleStage === "needs-information" || review.status === "needs-info") return "Needs information";
  if (result && !decision) return "Ready for human decision";
  if (!result) return "Waiting for AI review";
  return review.lifecycleStage?.replaceAll("-", " ") ?? review.status;
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || "there";
}

function dayPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}
