import { useCallback, useEffect, useState } from "react";
import { Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import {
  createOutreachJob,
  getOutreachPage,
  updateOutreachJob
} from "../lib/apiClient";
import type { OutreachJob } from "../types";

export function OutreachJobsPanel() {
  const [jobs, setJobs] = useState<OutreachJob[]>([]);
  const [maxCostUsd, setMaxCostUsd] = useState(5);
  const [busy, setBusy] = useState(false);
  const [jobCursor, setJobCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const page = await getOutreachPage<OutreachJob>("jobs", { limit: 25 });
      setJobs((current) => mergeJobs(page.items, current));
    } catch (loadError) {
      setError(message(loadError, "Could not load background jobs."));
    }
  }, []);

  useEffect(() => {
    void getOutreachPage<OutreachJob>("jobs", { limit: 25 })
      .then((page) => {
        setJobs(page.items);
        setJobCursor(page.nextCursor);
      })
      .catch((loadError) => setError(message(loadError, "Could not load background jobs.")));
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const loadMore = async () => {
    if (!jobCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await getOutreachPage<OutreachJob>("jobs", { limit: 25, cursor: jobCursor });
      setJobs((current) => mergeJobs(current, page.items));
      setJobCursor(page.nextCursor);
    } catch (loadError) {
      setError(message(loadError, "Could not load more jobs."));
    } finally {
      setLoadingMore(false);
    }
  };

  const start = async (type: OutreachJob["type"]) => {
    setBusy(true);
    setError("");
    try {
      const result = await createOutreachJob({
        type,
        maxCostUsd,
        maxRetries: 2,
        searchDurationSeconds: 30
      });
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
    } catch (startError) {
      setError(message(startError, "Could not start the background job."));
    } finally {
      setBusy(false);
    }
  };

  const act = async (job: OutreachJob, action: "pause" | "resume" | "retry" | "terminate") => {
    if (action === "terminate" && !window.confirm(`Terminate ${jobTitle(job.type)}? Any result currently being generated will be discarded.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await updateOutreachJob(job.id, action);
      setJobs((current) => current.map((item) => item.id === job.id ? result.job : item));
    } catch (actionError) {
      setError(message(actionError, "Could not update the background job."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="jobs-workspace">
      <div className="jobs-launcher">
        <div>
          <span className="dash-eyebrow">Durable automation</span>
          <h2>Background outreach jobs</h2>
          <p>Jobs continue in Lambda after the browser closes, one item per invocation.</p>
        </div>
        <label>
          Maximum estimated cost
          <span><strong>$</strong><input type="number" min="0.05" max="100" step="0.25" value={maxCostUsd} onChange={(event) => setMaxCostUsd(Number(event.target.value))} /></span>
        </label>
        <div className="jobs-launch-actions">
          <button className="dash-secondary" type="button" onClick={() => void start("draft-missing")} disabled={busy}>Draft missing</button>
          <button className="dash-secondary" type="button" onClick={() => void start("personalize-all")} disabled={busy}>Personalize drafts</button>
          <button className="dash-primary" type="button" onClick={() => void start("lead-search")} disabled={busy}>Search for leads</button>
        </div>
      </div>

      {error && <div className="dash-error">{error}</div>}

      <div className="jobs-list">
        {jobs.map((job) => {
          const total = job.type === "lead-search" ? Math.max(1, job.completedCount) : Math.max(1, job.itemIds.length);
          const progress = job.status === "completed" ? 100 : Math.min(100, ((job.completedCount + job.failedCount) / total) * 100);
          return (
            <article className="job-card" key={job.id}>
              <div className="job-card-head">
                <div>
                  <span className={`job-status ${job.status}`}>{job.status}</span>
                  <h3>{jobTitle(job.type)}</h3>
                  <p>{job.completedCount} completed · {job.failedCount} failed · ${job.estimatedCostUsd.toFixed(3)} estimated / ${job.maxCostUsd.toFixed(2)} cap</p>
                </div>
                <div className="job-actions">
                  {(job.status === "queued" || job.status === "running") && (
                    <button type="button" title="Pause" onClick={() => void act(job, "pause")}><Pause size={15} /></button>
                  )}
                  {job.status === "paused" && (
                    <button type="button" title="Resume" onClick={() => void act(job, "resume")}><Play size={15} /></button>
                  )}
                  {job.status === "failed" && (
                    <button type="button" title="Retry" onClick={() => void act(job, "retry")}><RotateCcw size={15} /></button>
                  )}
                  {(job.status === "queued" || job.status === "running" || job.status === "paused") && (
                    <button className="job-terminate" type="button" title="Terminate" onClick={() => void act(job, "terminate")}><Square size={15} /></button>
                  )}
                  <button type="button" title="Refresh" onClick={() => void load()}><RefreshCw size={15} /></button>
                </div>
              </div>
              <div className="job-progress"><span style={{ width: `${progress}%` }} /></div>
              <div className="job-logs">
                {job.logs.slice(0, 5).map((log, index) => (
                  <div className={`job-log ${log.level}`} key={`${log.at}-${index}`}>
                    <time>{formatTime(log.at)}</time><span>{log.message}</span>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
        {!jobs.length && <div className="dash-empty">No background jobs yet.</div>}
      </div>
      {jobCursor && (
        <button type="button" className="dash-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading more jobs..." : "Load 25 more jobs"}
        </button>
      )}
    </section>
  );
}

function mergeJobs(primary: OutreachJob[], secondary: OutreachJob[]) {
  return [...new Map([...primary, ...secondary].map((job) => [job.id, job])).values()];
}

function jobTitle(type: OutreachJob["type"]) {
  if (type === "draft-missing") return "Draft all missing emails";
  if (type === "personalize-all") return "Personalize eligible drafts";
  return "Public-web lead discovery";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function message(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try {
    return (JSON.parse(error.message) as { error?: string }).error ?? error.message;
  } catch {
    return error.message || fallback;
  }
}
