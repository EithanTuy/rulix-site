import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoRecord, UserProfile } from "../types";
import { SidebarRail } from "./SidebarRail";
import { WorkView } from "./WorkView";

const user: UserProfile = {
  id: "user-1",
  name: "Aisha Patel",
  email: "aisha@example.com",
  role: "export-control-officer",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const reviews: MemoRecord[] = [
  review({ id: "urgent", title: "Industrial servo controller", priority: "urgent", dueAt: "2026-01-01T17:00:00.000Z", assignedTo: user.id }),
  review({ id: "info", title: "Thermal imaging module", lifecycleStage: "needs-information", status: "needs-info", assignedTo: user.id }),
  review({ id: "decision", title: "Navigation assembly", lifecycleStage: "ready-for-decision", status: "ready", assignedTo: user.id }),
  review({ id: "done", title: "Composite sample", lifecycleStage: "approved", status: "signed-off", assignedTo: user.id })
];

describe("WorkView", () => {
  it("prioritizes one App-owned list and keeps advanced controls collapsed", () => {
    const { container } = renderWork();

    expect(screen.getByRole("heading", { name: "Work", level: 1 })).toBeInTheDocument();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /industrial servo controller/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /advanced filters/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));
    const drawer = screen.getByRole("complementary", { name: /advanced filters/i });
    expect(within(drawer).getByLabelText("Lifecycle")).toBeInTheDocument();
    expect(within(drawer).getByText(/bulk actions/i)).toBeInTheDocument();
  });

  it("uses the five clear queues without mixing completed work into Next up", () => {
    renderWork();
    expect(screen.queryByText("Composite sample")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs information" }));
    expect(screen.getByText("Thermal imaging module")).toBeInTheDocument();
    expect(screen.queryByText("Navigation assembly")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs decision" }));
    expect(screen.getByText("Navigation assembly")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByText("Composite sample")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-current", "page");
  });
});

describe("SidebarRail", () => {
  it("keeps submitter navigation to Work and relevant tools", () => {
    render(<SidebarRail activeView="work" userRole="submitter" mobileOpen={false} onViewChange={vi.fn()} onMobileClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Officer" })).not.toBeInTheDocument();
  });

  it("puts officer-only controls under an Officer disclosure", () => {
    render(<SidebarRail activeView="work" userRole="export-control-officer" mobileOpen={false} onViewChange={vi.fn()} onMobileClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Officer" }));
    expect(screen.getByRole("button", { name: "Approvals & controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Administration" })).toBeInTheDocument();
  });
});

function renderWork() {
  return render(
    <WorkView
      reviews={reviews}
      user={user}
      members={[user]}
      savedViews={[]}
      hasMore={false}
      loadingMore={false}
      onOpenReview={vi.fn()}
      onNewReview={vi.fn()}
      onLoadMore={vi.fn()}
      onSaveView={vi.fn()}
      onBulkUpdate={vi.fn()}
    />
  );
}

function review(patch: Partial<MemoRecord>): MemoRecord {
  return {
    id: "review",
    title: "Review",
    itemFamily: "Equipment",
    owner: "Aisha Patel",
    ownerId: user.id,
    updatedAt: "2026-07-22T12:00:00.000Z",
    documentCode: "REV-001",
    status: "draft",
    lifecycleStage: "draft",
    priority: "normal",
    memoText: "Memo",
    attachments: [],
    dataClass: "proprietary",
    sourcePath: "self-classification",
    ...patch
  };
}
