import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Cpu,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  UserPlus,
  Users,
  Wifi
} from "lucide-react";
import {
  createInvite,
  getAdminMetrics,
  getCurrentUser,
  listAdminUsers,
  listInvites,
  signIn,
  signOut,
  type InviteSummary
} from "../lib/apiClient";
import type { AdminMetrics, MetricBucket, UserAdminSummary, UserProfile } from "../types";

const ADMIN_ROLE: UserProfile["role"] = "export-control-officer";
const RANGE_OPTIONS = [7, 30, 90] as const;

export function DashboardApp() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [ready, setReady] = useState(false);

  const refreshUser = useCallback(async () => {
    try {
      const me = await getCurrentUser();
      setUser(me.user);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const handleSignOut = useCallback(async () => {
    await signOut().catch(() => undefined);
    await refreshUser();
  }, [refreshUser]);

  if (!ready) {
    return (
      <DashboardFrame compact>
        <div className="dash-loading">
          <span className="dash-loader" />
          <strong>Opening Rulix Operations</strong>
          <span>Checking your secure session…</span>
        </div>
      </DashboardFrame>
    );
  }
  if (!user) return <DashboardSignIn onSignedIn={refreshUser} />;
  if (user.role !== ADMIN_ROLE) return <DashboardDenied user={user} onSignOut={handleSignOut} />;
  return <DashboardHome user={user} onSignOut={handleSignOut} />;
}

function DashboardFrame({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={`dash-auth-shell${compact ? " compact" : ""}`}>
      <div className="dash-auth-brand">
        <RulixMark />
        <div>
          <strong>Rulix</strong>
          <span>Operations</span>
        </div>
      </div>
      {children}
      <p className="dash-auth-foot">Secure administration for Rulix ECCN</p>
    </div>
  );
}

function DashboardSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
      await onSignedIn();
    } catch (signInError) {
      setError(toMessage(signInError, "Sign in failed."));
      setBusy(false);
    }
  };

  return (
    <DashboardFrame>
      <form className="dash-auth-card" onSubmit={submit}>
        <div className="dash-auth-kicker">
          <ShieldCheck size={16} />
          Authorized operators only
        </div>
        <div>
          <h1>Operations dashboard</h1>
          <p>Monitor AI usage, service health, spend, and account access.</p>
        </div>
        <label>
          <span>Email address</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="dash-error">{error}</div>}
        <button type="submit" className="dash-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in securely"}
        </button>
        <a className="dash-back-link" href="https://app.rulix.cloud">
          Return to Rulix ECCN <ExternalLink size={14} />
        </a>
      </form>
    </DashboardFrame>
  );
}

function DashboardDenied({ user, onSignOut }: { user: UserProfile; onSignOut: () => Promise<void> }) {
  return (
    <DashboardFrame>
      <div className="dash-auth-card dash-denied">
        <AlertTriangle size={30} />
        <h1>Admin access required</h1>
        <p>
          <strong>{user.email}</strong> is signed in as {roleLabel(user.role)}. Rulix Operations is limited to
          export-control officers.
        </p>
        <button type="button" className="dash-secondary" onClick={() => void onSignOut()}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </DashboardFrame>
  );
}

function DashboardHome({ user, onSignOut }: { user: UserProfile; onSignOut: () => Promise<void> }) {
  const [metrics, setMetrics] = useState<AdminMetrics | undefined>();
  const [users, setUsers] = useState<UserAdminSummary[]>([]);
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]>(30);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [m, u] = await Promise.all([getAdminMetrics(rangeDays), listAdminUsers()]);
      setMetrics(m);
      setUsers(u);
    } catch (loadError) {
      setError(toMessage(loadError, "Could not load operations data."));
    } finally {
      setLoading(false);
    }
  }, [rangeDays]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="dash-app-shell">
      <aside className="dash-rail">
        <div className="dash-brand">
          <RulixMark />
          <div>
            <strong>Rulix</strong>
            <span>Operations</span>
          </div>
        </div>
        <nav aria-label="Operations dashboard">
          <a className="active" href="#overview">
            <LayoutDashboard size={18} /> <span>Overview</span>
          </a>
          <a href="#usage">
            <BarChart3 size={18} /> <span>Usage</span>
          </a>
          <a href="#access">
            <Users size={18} /> <span>Access</span>
          </a>
        </nav>
        <div className="dash-rail-status">
          <span className="dash-status-dot" />
          <div>
            <strong>Rulix service</strong>
            <span>Operational</span>
          </div>
        </div>
        <a className="dash-product-link" href="https://app.rulix.cloud">
          <ExternalLink size={16} /> <span>Open ECCN app</span>
        </a>
      </aside>

      <main className="dash-main">
        <header className="dash-header" id="overview">
          <div>
            <span className="dash-eyebrow">Admin control room</span>
            <h1>Operations overview</h1>
            <p>Bedrock usage, account access, and service activity across Rulix.</p>
          </div>
          <div className="dash-account">
            <div className="dash-avatar">{initials(user.name)}</div>
            <div>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            <button type="button" aria-label="Sign out" title="Sign out" onClick={() => void onSignOut()}>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        <div className="dash-toolbar">
          <div className="dash-range" aria-label="Metrics date range">
            {RANGE_OPTIONS.map((days) => (
              <button
                type="button"
                className={rangeDays === days ? "active" : ""}
                aria-pressed={rangeDays === days}
                onClick={() => setRangeDays(days)}
                key={days}
              >
                {days} days
              </button>
            ))}
          </div>
          <div className="dash-toolbar-meta">
            {metrics && <span>Updated {relativeTime(metrics.generatedAt)}</span>}
            <button type="button" className="dash-secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "spin" : ""} size={16} /> {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>

        {error && <div className="dash-error dash-banner">{error}</div>}

        <section className="dash-health-strip" aria-label="System status">
          <div>
            <CheckCircle2 size={18} />
            <span><strong>Service healthy</strong> API and account storage are responding</span>
          </div>
          <div>
            <Server size={18} />
            <span><strong>Amazon Bedrock</strong> Usage telemetry connected</span>
          </div>
          <div>
            <ShieldCheck size={18} />
            <span><strong>Access protected</strong> Officer role required</span>
          </div>
        </section>

        {metrics ? (
          <>
            <section className="dash-cards" aria-label="Key metrics">
              <MetricCard icon={<CircleDollarSign size={20} />} label={`Spend (${rangeDays}d)`} value={usd(metrics.totals.costUsd)} accent />
              <MetricCard icon={<Activity size={20} />} label="AI calls" value={num(metrics.totals.calls)} />
              <MetricCard icon={<Cpu size={20} />} label="Tokens processed" value={compact(metrics.totals.inputTokens + metrics.totals.outputTokens)} />
              <MetricCard icon={<Clock3 size={20} />} label="Average latency" value={`${num(metrics.totals.avgLatencyMs)} ms`} />
              <MetricCard icon={<Users size={20} />} label="Accounts" value={num(metrics.users.total)} />
              <MetricCard icon={<Wifi size={20} />} label="Online now" value={num(metrics.users.online)} tone={metrics.users.online ? "green" : "default"} />
            </section>

            <section className="dash-charts" id="usage">
              <ChartCard title="Daily spend" detail={`Last ${rangeDays} days`}>
                <BarChart buckets={metrics.daily} metric="cost" empty="No billed Bedrock activity in this range." />
              </ChartCard>
              <ChartCard title="Spend by model" detail="USD estimate">
                <BarChart buckets={metrics.byModel} metric="cost" empty="Model spend will appear after the first live AI call." />
              </ChartCard>
              <ChartCard title="Calls by workflow" detail="Request count">
                <BarChart buckets={metrics.byCallType} metric="calls" empty="Workflow activity will appear after the first live AI call." />
              </ChartCard>
            </section>
          </>
        ) : (
          <DashboardSkeleton />
        )}

        <section className="dash-grid" id="access">
          <UsersTable users={users} />
          <InvitePanel onChanged={load} />
        </section>

        <footer className="dash-footer">
          <span>Rulix Operations</span>
          <span>Human review remains the final authority for every classification.</span>
        </footer>
      </main>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  accent,
  tone = "default"
}: {
  icon: ReactNode;
  label: string;
  value: string;
  accent?: boolean;
  tone?: "default" | "green";
}) {
  return (
    <div className={`dash-card${accent ? " accent" : ""} tone-${tone}`}>
      <div className="dash-card-top">
        <span className="dash-card-icon">{icon}</span>
        <span className="dash-card-trend">Live</span>
      </div>
      <strong className="dash-card-value">{value}</strong>
      <span className="dash-card-label">{label}</span>
    </div>
  );
}

function ChartCard({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="dash-chart-card">
      <div className="dash-chart-head">
        <h2>{title}</h2>
        <span>{detail}</span>
      </div>
      {children}
    </div>
  );
}

function BarChart({ buckets, metric, empty }: { buckets: MetricBucket[]; metric: "cost" | "calls"; empty: string }) {
  const rows = useMemo(
    () =>
      buckets
        .map((bucket) => ({ label: bucket.label, value: metric === "cost" ? bucket.costUsd : bucket.calls }))
        .filter((row) => row.value > 0)
        .slice(-12),
    [buckets, metric]
  );
  const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0);
  if (!rows.length || max === 0) {
    return (
      <div className="dash-empty">
        <Activity size={22} />
        <span>{empty}</span>
      </div>
    );
  }
  return (
    <div className="dash-bars">
      {rows.map((row) => (
        <div className="dash-bar-row" key={row.label}>
          <span className="dash-bar-label" title={row.label}>{row.label}</span>
          <span className="dash-bar-track">
            <span className="dash-bar-fill" style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }} />
          </span>
          <span className="dash-bar-value">{metric === "cost" ? usd(row.value) : num(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

function UsersTable({ users }: { users: UserAdminSummary[] }) {
  return (
    <div className="dash-panel">
      <div className="dash-panel-head">
        <div>
          <span className="dash-panel-icon"><Users size={18} /></span>
          <div>
            <h2>Account access</h2>
            <p>Signed-in users and cumulative AI usage</p>
          </div>
        </div>
        <span className="dash-count">{users.length}</span>
      </div>
      <div className="dash-table-wrap">
        <div className="dash-table">
          <div className="dash-table-head">
            <span>User</span><span>Role</span><span>Last seen</span><span>Calls</span><span>Spend</span>
          </div>
          {users.map((u) => (
            <div className="dash-table-row" key={u.id}>
              <span className="dash-user">
                <span className={`dash-dot ${u.online ? "online" : "offline"}`} />
                <span>
                  <strong>{u.name}</strong>
                  <small>{u.email}</small>
                </span>
              </span>
              <span className="dash-role">{roleLabel(u.role)}</span>
              <span>{u.lastSeenAt ? relativeTime(u.lastSeenAt) : "—"}</span>
              <span>{num(u.usage.calls)}</span>
              <span>{usd(u.usage.costUsd)}</span>
            </div>
          ))}
          {users.length === 0 && <div className="dash-empty"><Users size={22} /><span>No accounts yet.</span></div>}
        </div>
      </div>
    </div>
  );
}

function InvitePanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserProfile["role"]>("reviewer");
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const loadInvites = useCallback(async () => {
    try {
      setInvites(await listInvites());
    } catch (loadError) {
      setError(toMessage(loadError, "Invite list unavailable."));
    }
  }, []);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const created = await createInvite(email, name, role);
      setEmail("");
      setName("");
      setInvites((current) => [created.invite, ...current.filter((i) => i.id !== created.invite.id)]);
      setNotice(
        created.delivery.sent
          ? `Invite emailed to ${created.invite.email}.`
          : `Invite created. Email delivery is not configured; copy the generated link: ${created.inviteLink}`
      );
      await onChanged();
    } catch (inviteError) {
      setError(toMessage(inviteError, "Invite failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-panel">
      <div className="dash-panel-head">
        <div>
          <span className="dash-panel-icon"><UserPlus size={18} /></span>
          <div>
            <h2>Invite an operator</h2>
            <p>Provision controlled access to Rulix</p>
          </div>
        </div>
        <span className="dash-count">{invites.length}</span>
      </div>
      <form className="dash-invite-form" onSubmit={submit}>
        <label><span>Email address</span><input type="email" placeholder="name@organization.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label><span>Display name</span><input type="text" placeholder="Optional" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserProfile["role"])}>
            <option value="reviewer">Reviewer</option>
            <option value="submitter">Submitter</option>
            <option value="counsel">Counsel</option>
            <option value="export-control-officer">Export-control officer (admin)</option>
          </select>
        </label>
        <button type="submit" className="dash-primary" disabled={busy}>
          <Send size={16} /> {busy ? "Creating invite…" : "Create secure invite"}
        </button>
      </form>
      {notice && <div className="dash-notice">{notice}</div>}
      {error && <div className="dash-error">{error}</div>}
      <div className="dash-invite-list">
        <h3>Recent invitations</h3>
        {invites.slice(0, 6).map((invite) => (
          <div className="dash-invite-row" key={invite.id}>
            <span><strong>{invite.email}</strong><small>{roleLabel(invite.role)}</small></span>
            <span className={`dash-badge ${invite.status}`}>{invite.status}</span>
          </div>
        ))}
        {invites.length === 0 && <div className="dash-empty compact"><Send size={20} /><span>No invitations yet.</span></div>}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <section className="dash-cards">
        {Array.from({ length: 6 }, (_, index) => <div className="dash-card dash-skeleton" key={index} />)}
      </section>
      <section className="dash-charts">
        {Array.from({ length: 3 }, (_, index) => <div className="dash-chart-card dash-skeleton" key={index} />)}
      </section>
    </>
  );
}

function RulixMark() {
  return (
    <span className="dash-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 44 44">
        <path d="M7 8.5h19.5c6.1 0 10.5 4 10.5 9.7 0 4-2.2 7.2-5.7 8.7L38 35.5h-8.4l-5.8-7.6h-8.9v7.6H7V8.5Zm7.9 6.6v6.5h10.7c2 0 3.3-1.3 3.3-3.2 0-2-1.3-3.3-3.3-3.3H14.9Z" />
        <path d="M15.8 23.7h9.4l4 5.3H15.8v-5.3Z" />
      </svg>
    </span>
  );
}

function usd(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(value > 0 && value < 1 ? 4 : 2)}`;
}

function num(value: number) {
  return new Intl.NumberFormat("en").format(Math.round(value));
}

function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs)) return "—";
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") : "RU";
}

function roleLabel(role: UserProfile["role"]) {
  if (role === "export-control-officer") return "Export-control officer";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function toMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const match = error.message.match(/\{.*\}$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // Fall through to the original message.
    }
  }
  return error.message || fallback;
}
