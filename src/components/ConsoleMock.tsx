// ConsoleMock.tsx — stylized recreation of the reviewer console using demo data.
// Pure JSX/CSS so the hero stays crisp at every size; no screenshots, no real memos.

export function ConsoleMock() {
  return (
    <div className="panel overflow-hidden text-left shadow-lg" aria-hidden="true">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-line-soft bg-raised px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12px] font-semibold">
          <span className="size-2 bg-ok" />
          Reviewer console · EC-2041
        </div>
        <span className="chip">demo data</span>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-[1fr_128px]">
        <div className="min-w-0 space-y-3">
          {/* Gate banner */}
          <div className="flex items-center gap-2.5 border border-warn/40 bg-warn-soft px-3 py-2.5 text-[12.5px]">
            <strong className="text-warn">Request more facts</strong>
            <span className="text-text-2 max-sm:hidden">2 evidence gaps block a defensible draft</span>
          </div>

          {/* Candidate cards */}
          <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
            <div className="border border-line-soft bg-raised p-3">
              <div className="flex items-center justify-between">
                <code className="font-mono text-[13px] font-bold text-accent">3A001</code>
                <span className="chip warn">needs facts</span>
              </div>
              <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-text-2">
                Electronics — ADC parameter thresholds unresolved
              </p>
            </div>
            <div className="border border-line-soft bg-raised p-3">
              <div className="flex items-center justify-between">
                <code className="font-mono text-[13px] font-bold text-text-1">EAR99</code>
                <span className="chip block">asserted</span>
              </div>
              <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-text-2">
                Memo claim — citation does not support conclusion
              </p>
            </div>
          </div>

          {/* Evidence-gap question */}
          <div className="border-l-2 border-accent bg-accent-soft px-3 py-2.5">
            <p className="m-0 text-[12px] font-medium">
              What is the maximum ADC sample rate per channel?
            </p>
            <p className="m-0 mt-0.5 text-[11px] text-text-3">high priority · +16 readiness if answered</p>
          </div>
        </div>

        {/* Readiness gauge */}
        <div className="flex flex-col items-center justify-center gap-1 max-sm:hidden">
          <Gauge pct={42} />
          <div className="text-center leading-tight">
            <b className="font-mono text-[20px] text-warn">42%</b>
            <span className="block text-[10px] uppercase tracking-[0.08em] text-text-3">readiness</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Gauge({ pct }: { pct: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <svg width={96} height={96} viewBox="0 0 96 96">
      <circle cx="48" cy="48" r={r} fill="none" stroke="var(--bg-2)" strokeWidth="9" />
      <circle
        cx="48" cy="48" r={r} fill="none" stroke="var(--warn)" strokeWidth="9" strokeLinecap="butt"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 48 48)"
      />
    </svg>
  );
}
