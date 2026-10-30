import { describe, expect, it } from "vitest";
import { LOG_CAP, appendLog, shown, type LogEntry } from "./ActivityLog";

describe("activity log", () => {
  it("keeps lease and safe-state events, not a Reset's own e-stop or per-tick notes", () => {
    expect(shown({ op: "ev", kind: "lease_granted", holder: "x" })).toBe(true);
    expect(shown({ op: "ev", kind: "lease_released", why: "y" })).toBe(true);
    expect(shown({ op: "ev", kind: "safe_state", state: "estopped", reason: "estop", source: "studio-ui" })).toBe(true);
    expect(shown({ op: "ev", kind: "safe_state", state: "estopped", reason: "estop", source: "studio-reset" })).toBe(false);
    expect(shown({ op: "ev", kind: "safe_state", state: "holding", reason: "manual" })).toBe(true);
    expect(shown({ type: "deadman", held: true })).toBe(false);
  });

  it("is newest first and capped", () => {
    let rows: LogEntry[] = [];
    for (let id = 1; id <= LOG_CAP + 5; id += 1) rows = appendLog(rows, { id, at: id, event: {} });
    expect(rows).toHaveLength(LOG_CAP);
    expect(rows[0].id).toBe(LOG_CAP + 5);
    expect(rows.at(-1)!.id).toBe(6);
  });
});
