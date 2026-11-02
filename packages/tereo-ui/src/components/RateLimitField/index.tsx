import { Alert, Button, Col, Form, Input, Row } from "@kosmeo-ui/react";
import { useState } from "react";

const LABEL = "Rate limit (requests/second)";
const MAX = 100_000;
const INVALID = "Enter a whole number from 1 to 100,000.";

interface RateLimitFieldProps {
  /** The account's own limit; null or missing means it follows the default. */
  value?: number | null;
  onSave: (value: number | null) => Promise<void>;
  readOnly?: boolean;
  /** The per-IP limit before sign-in; set only when the viewer can read it. */
  preAuthLimit?: number;
  /** The account's callers are on the internal network, so the pre-sign-in cap reaches only others. */
  internalCaller?: boolean;
}

/** Null for an empty input, NaN for anything that is not a valid limit. */
const parse = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return n >= 1 && n <= MAX ? n : NaN;
};

const toText = (value: number | null) => (value === null ? "" : String(value));

export const RateLimitField = ({
  value: given,
  onSave,
  readOnly,
  preAuthLimit,
  internalCaller,
}: RateLimitFieldProps) => {
  const value = given ?? null;
  const [text, setText] = useState(toText(value));
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A value changed elsewhere replaces what the input shows.
  if (value !== seen) {
    setSeen(value);
    setText(toText(value));
    setError(null);
  }

  if (readOnly) {
    return (
      <Col size="sm">
        <span>{LABEL}</span>
        <span>{value === null ? "Default" : value}</span>
      </Col>
    );
  }

  const parsed = parse(text);
  const dirty = !Number.isNaN(parsed) ? parsed !== value : true;
  const warn =
    preAuthLimit !== undefined &&
    parsed !== null &&
    !Number.isNaN(parsed) &&
    parsed > preAuthLimit;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (Number.isNaN(parsed)) {
      setError(INVALID);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(parsed);
    } catch {
      // The update hook reports the failure; the input keeps what was typed.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form onSubmit={handleSubmit}>
      <Col>
        <Row>
          <Input
            label={LABEL}
            type="text"
            value={text}
            placeholder="Default"
            error={error}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" isLoading={saving} disabled={!dirty}>
            Save
          </Button>
        </Row>
        {warn && (
          <Alert variant="warning" size="sm">
            Above the per-IP limit of {preAuthLimit}/s before sign-in, so a
            caller {internalCaller && "outside the internal network "}from a
            single IP is capped there first.
          </Alert>
        )}
      </Col>
    </Form>
  );
};
