import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReviewStartDialog } from "./ReviewStartDialog";

describe("ReviewStartDialog", () => {
  it("starts with only the essential paste fields and inserts the template explicitly", async () => {
    const onPaste = vi.fn().mockResolvedValue(undefined);
    renderDialog({ onPaste });

    expect(screen.getByLabelText("Review title")).toBeInTheDocument();
    expect(screen.getByLabelText("Memo content")).toHaveValue("");
    expect(screen.getByText("Review details").closest("details")).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Review details"));
    expect(screen.getByLabelText("Manufacturer or source")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Insert memo template" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Memo content").value).toContain("# Classification memo");

    fireEvent.change(screen.getByLabelText("Review title"), { target: { value: "Servo review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create review" }));
    await waitFor(() => expect(onPaste).toHaveBeenCalledWith(expect.objectContaining({ title: "Servo review", dataClass: "proprietary" })));
  });

  it("requires a data class before file selection", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: /upload file/i }));
    expect(screen.getByLabelText(/choose the data class first/i)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Data class"), { target: { value: "cui" } });
    expect(screen.getByLabelText(/choose a file/i)).toBeEnabled();
    expect(screen.getByText(/controlled-file policy/i)).toBeInTheDocument();
  });

  it("opens the existing Memo Builder path for AI drafting", () => {
    const onDraftWithAi = vi.fn();
    renderDialog({ onDraftWithAi });
    fireEvent.click(screen.getByRole("tab", { name: /draft with ai/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open Memo Builder" }));
    expect(onDraftWithAi).toHaveBeenCalledOnce();
  });
});

function renderDialog(overrides: Partial<ComponentProps<typeof ReviewStartDialog>> = {}) {
  return render(
    <ReviewStartDialog
      open
      userRole="export-control-officer"
      onClose={vi.fn()}
      onPaste={vi.fn().mockResolvedValue(undefined)}
      onUpload={vi.fn().mockResolvedValue(undefined)}
      onDraftWithAi={vi.fn()}
      {...overrides}
    />
  );
}
