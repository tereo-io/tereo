import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ColorFields } from "./ColorFields";

const renderFields = (value = {}) =>
  render(
    <ColorFields
      value={value}
      onChange={() => {}}
      inherited={{
        "--k-primary-color": "#112233",
        "--k-text-color": "#222222",
      }}
      sources={{
        "--k-primary-color": "default",
        "--k-text-color": "tereo",
      }}
      errors={{}}
      errorPrefix="colorsLight"
      readOnly={false}
    />
  );

describe("ColorFields", () => {
  it("groups the variables under their headings", () => {
    renderFields();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      "Primary",
      "Secondary",
      "Background",
      "Border",
      "Text",
      "Danger",
      "Success",
      "Warning",
      "Light",
      "Shadow",
    ]);
  });

  it("shows the inherited value and its source as the placeholder", () => {
    renderFields();
    expect(screen.getByLabelText("primary-color")).toHaveAttribute(
      "placeholder",
      "#112233 (from Default)"
    );
    expect(screen.getByLabelText("text-color")).toHaveAttribute(
      "placeholder",
      "#222222 (Tereo)"
    );
    expect(screen.getByLabelText("primary-color")).toHaveValue("");
  });
});
