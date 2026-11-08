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

  it("seeds an unset swatch from the inherited hex", () => {
    renderFields();
    expect(screen.getByLabelText("primary-color picker")).toHaveValue(
      "#112233"
    );
    expect(screen.getByLabelText("primary-color picker")).not.toHaveAttribute(
      "data-unset"
    );
  });

  it("shows an unset swatch when nothing gives a hex", () => {
    renderFields();
    expect(screen.getByLabelText("danger-color picker")).toHaveAttribute(
      "data-unset",
      "true"
    );
  });

  it("shows the profile's own colour, expanding a short hex", () => {
    renderFields({ "--k-primary-color": "#0b5" });
    expect(screen.getByLabelText("primary-color picker")).toHaveValue(
      "#00bb55"
    );
  });

  it("converts rgb() and hsl() values for the swatch", () => {
    renderFields({
      "--k-primary-color": "rgb(10 20 30)",
      "--k-text-color": "hsl(0 100% 50%)",
    });
    expect(screen.getByLabelText("primary-color picker")).toHaveValue(
      "#0a141e"
    );
    expect(screen.getByLabelText("text-color picker")).toHaveValue("#ff0000");
  });

  it("drops the alpha of a 4- or 8-digit hex", () => {
    renderFields({
      "--k-primary-color": "#11223344",
      "--k-text-color": "#0b5f",
    });
    expect(screen.getByLabelText("primary-color picker")).toHaveValue(
      "#112233"
    );
    expect(screen.getByLabelText("text-color picker")).toHaveValue("#00bb55");
  });

  it("shows a neutral, not unset, swatch for a value it cannot show", () => {
    renderFields({ "--k-danger-color": "color-mix(in srgb, red, blue)" });
    expect(screen.getByLabelText("danger-color picker")).not.toHaveAttribute(
      "data-unset"
    );
  });
});
