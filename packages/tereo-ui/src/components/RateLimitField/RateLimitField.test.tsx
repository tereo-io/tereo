import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RateLimitField } from ".";

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Rate limit (requests/second)"), {
    target: { value },
  });
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("RateLimitField", () => {
  it("shows the default placeholder when there is no value", () => {
    render(<RateLimitField value={null} onSave={vi.fn()} />);

    expect(
      screen.getByLabelText("Rate limit (requests/second)")
    ).toHaveAttribute("placeholder", "Default");
  });

  it("shows a value that changes after mounting", () => {
    const { rerender } = render(
      <RateLimitField value={null} onSave={vi.fn()} />
    );

    rerender(<RateLimitField value={400} onSave={vi.fn()} />);

    expect(screen.getByLabelText("Rate limit (requests/second)")).toHaveValue(
      "400"
    );
  });

  it("treats a missing value as the default", () => {
    render(<RateLimitField value={undefined} onSave={vi.fn()} readOnly />);

    expect(screen.getByText("Default")).toBeVisible();
  });

  it("words the warning for internal callers", () => {
    render(
      <RateLimitField
        value={400}
        onSave={vi.fn()}
        preAuthLimit={300}
        internalCaller
      />
    );

    expect(
      screen.getByText(
        "Above the per-IP limit of 300/s before sign-in, so a caller outside the internal network from a single IP is capped there first."
      )
    ).toBeVisible();
  });

  it("saves null when the input is emptied", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RateLimitField value={500} onSave={onSave} />);

    type("");
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("saves a whole number", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RateLimitField value={null} onSave={onSave} />);

    type("250");
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(250));
  });

  it.each(["0", "100001", "1.5", "abc"])(
    "rejects %s without saving",
    async (input) => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<RateLimitField value={null} onSave={onSave} />);

      type(input);
      save();

      expect(
        await screen.findByText("Enter a whole number from 1 to 100,000.")
      ).toBeVisible();
      expect(onSave).not.toHaveBeenCalled();
    }
  );

  it("renders no input when read-only", () => {
    render(<RateLimitField value={250} onSave={vi.fn()} readOnly />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("250")).toBeVisible();
  });

  it("shows Default when read-only without a value", () => {
    render(<RateLimitField value={null} onSave={vi.fn()} readOnly />);

    expect(screen.getByText("Default")).toBeVisible();
  });

  it("warns when the value is above the pre-sign-in limit", () => {
    render(<RateLimitField value={400} onSave={vi.fn()} preAuthLimit={300} />);

    expect(
      screen.getByText(
        "Above the per-IP limit of 300/s before sign-in, so a caller from a single IP is capped there first."
      )
    ).toBeVisible();
  });

  it("warns about a value being typed", () => {
    render(<RateLimitField value={null} onSave={vi.fn()} preAuthLimit={300} />);

    type("301");

    expect(screen.getByText(/Above the per-IP limit of 300\/s/)).toBeVisible();
  });

  it.each([
    ["at the limit", 300, 300],
    ["without a limit", 400, undefined],
    ["without a value", null, 300],
  ])("does not warn %s", (_case, value, preAuthLimit) => {
    render(
      <RateLimitField
        value={value}
        onSave={vi.fn()}
        preAuthLimit={preAuthLimit}
      />
    );

    expect(
      screen.queryByText(/Above the per-IP limit/)
    ).not.toBeInTheDocument();
  });
});
