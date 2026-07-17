import { useMemo, useState } from "react";
import { BookOpen, CheckCircle2, ExternalLink, FileSearch, Filter, Link2, Search, ShieldCheck } from "lucide-react";
import type { CorpusSnapshot, MemoRecord } from "../types";
import { SafeExternalLink } from "./SafeExternalLink";

interface EvidenceLibraryViewProps {
  corpus: CorpusSnapshot;
  reviews: MemoRecord[];
  onOpenReview: (memoId: string) => void;
}

export function EvidenceLibraryView({ corpus, reviews, onOpenReview }: EvidenceLibraryViewProps) {
  const [search, setSearch] = useState("");
  const [authority, setAuthority] = useState("");
  const [selectedId, setSelectedId] = useState(corpus.documents[0]?.id);
  const documents = useMemo(() => corpus.documents.filter((document) => {
    const normalized = search.trim().toLocaleLowerCase();
    return (!normalized || `${document.title} ${document.authority}`.toLocaleLowerCase().includes(normalized))
      && (!authority || document.authority === authority);
  }), [authority, corpus.documents, search]);
  const selected = corpus.documents.find((document) => document.id === selectedId) ?? documents[0];
  const chunks = selected ? corpus.chunks.filter((chunk) => chunk.documentId === selected.id) : [];
  const associated = selected ? reviews.filter((review) =>
    review.memoText?.toLocaleLowerCase().includes(selected.title.toLocaleLowerCase())
    || review.attachments?.some((attachment) => attachment.toLocaleLowerCase().includes(selected.authority.toLocaleLowerCase()))) : [];

  return (
    <main className="px-page px-evidence-library" id="main-content">
      <header className="px-page-heading"><div><p className="px-eyebrow">Evidence</p><h1>Evidence Library</h1><p>Search approved sources, inspect exact excerpts, and follow citations back to the reviews that use them.</p></div><div className="px-corpus-status"><ShieldCheck size={18} /><span><strong>{corpus.label}</strong><small>Snapshot {corpus.generatedAt.slice(0, 10)}</small></span></div></header>
      <section className="px-filter-bar">
        <label className="px-search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents and authorities…" /></label>
        <select value={authority} onChange={(event) => setAuthority(event.target.value)} aria-label="Filter by authority"><option value="">All authorities</option><option value="EAR">EAR</option><option value="ITAR">ITAR</option><option value="BIS">BIS</option><option value="ITA">ITA</option></select>
        <button type="button" className="px-filter-toggle"><Filter size={16} />Source status: approved</button>
      </section>
      <div className="px-library-grid">
        <section className="px-library-list" aria-label="Source documents">
          <div className="px-section-head"><div><h2>Approved sources</h2><p>{documents.length} documents</p></div></div>
          {documents.map((document) => (
            <button type="button" key={document.id} className={selected?.id === document.id ? "active" : ""} onClick={() => setSelectedId(document.id)}>
              <span><BookOpen size={18} /></span><span><strong>{document.title}</strong><small>{document.authority} · Snapshot {document.snapshotDate}</small></span><CheckCircle2 size={16} />
            </button>
          ))}
          {!documents.length ? <div className="px-empty-state compact"><FileSearch size={24} /><h3>No sources match</h3><p>Try a broader title or authority.</p></div> : null}
        </section>
        <section className="px-document-preview" aria-live="polite">
          {selected ? (
            <>
              <header><div><p>{selected.authority} source</p><h2>{selected.title}</h2><span><CheckCircle2 size={15} />{selected.approvalStatus ?? "approved"} · Retrieved {selected.retrievedAt?.slice(0, 10) ?? selected.snapshotDate}</span></div><SafeExternalLink className="button" href={selected.url}>Open official source <ExternalLink size={15} /></SafeExternalLink></header>
              <div className="px-source-provenance"><span><strong>Content hash</strong>{selected.contentHash?.slice(0, 18) ?? corpus.checksum.slice(0, 18)}…</span><span><strong>Parser</strong>{selected.parserVersion ?? "Verified corpus"}</span><span><strong>Effective</strong>{selected.effectiveAt?.slice(0, 10) ?? selected.snapshotDate}</span></div>
              <div className="px-excerpt-list"><h3>Verified excerpts</h3>{chunks.length ? chunks.slice(0, 8).map((chunk) => <article key={chunk.id}><div><span>{chunk.locator}</span><small>{chunk.tags.join(" · ")}</small></div><p>{chunk.text}</p><SafeExternalLink href={chunk.url}><Link2 size={14} />Open citation</SafeExternalLink></article>) : <p>No excerpt chunks are stored for this source.</p>}</div>
            </>
          ) : null}
        </section>
        <aside className="px-backlinks"><h2>Citation backlinks</h2><p>Reviews associated with this source or authority.</p>{associated.length ? associated.slice(0, 8).map((review) => <button type="button" key={review.id} onClick={() => onOpenReview(review.id)}><strong>{review.title}</strong><small>{review.documentCode}</small></button>) : <div className="px-empty-state compact"><Link2 size={22} /><h3>No backlinks yet</h3><p>Associations appear as evidence is cited in reviews.</p></div>}</aside>
      </div>
    </main>
  );
}
