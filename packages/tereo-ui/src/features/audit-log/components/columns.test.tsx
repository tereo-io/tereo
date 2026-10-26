import { auditLogColumns, entityHistoryColumns } from "./columns";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TableColumn } from "@kosmeo-ui/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AuditLogEntry } from "../types";
import { Table } from "@kosmeo-ui/react";

const actor = { id: "u1", email: "ada@example.com", name: "Ada" };

const entry: AuditLogEntry = {
  id: "e1",
  source: "tereo",
  organizationId: null,
  userId: "u1",
  userEmail: "ada@example.com",
  user: actor,
  action: "UPDATE",
  entityType: "Role",
  entityId: "r1",
  entityName: "support",
  changes: null,
  metadata: null,
  ipAddress: null,
  correlationId: null,
  writerUserId: "u1",
  writer: actor,
  organization: null,
  createdAt: "2026-10-22T19:00:00.000Z",
};

const renderTable = (columns: TableColumn<AuditLogEntry>[]) =>
  render(
    <MemoryRouter>
      <Table columns={columns} rows={[entry]} rowKey={(e) => e.id} />
    </MemoryRouter>
  );

describe("audit log columns", () => {
  it("link each entry's timestamp to its detail", () => {
    renderTable(auditLogColumns((e) => ({ search: `entry=${e.id}` })));

    expect(screen.getByRole("link")).toHaveAttribute("href", "/?entry=e1");
  });

  it("open an entity history entry from its timestamp button", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderTable(entityHistoryColumns(onOpen));

    await user.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith(entry);
  });
});
