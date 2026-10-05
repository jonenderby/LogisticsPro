import { describe, expect, it } from "vitest";
import { AlertPreferences, type ShipmentEta, alertMessage, digestMessage, dueSlots, isAlertableChange, isRepeat, localClock } from "../src/index.js";

const eta = (over: Partial<ShipmentEta> = {}): ShipmentEta => ({
  loadId: "l1",
  status: "LATE",
  eta: "2026-10-08T22:00:00Z",
  etaSource: "COMPUTED",
  window: { start: "2026-10-08T14:00:00Z", end: "2026-10-08T18:00:00Z" },
  reasons: ["Expected 4 h after the delivery window closes"],
  ...over,
});

describe("alert preferences", () => {
  it("validate statuses, times and time zones", () => {
    expect(AlertPreferences.safeParse({ statuses: ["LATE", "AT_RISK"], instant: true, timeZone: "America/Chicago", schedule: { times: ["07:00", "15:30"], days: [1, 2, 3, 4, 5] } }).success).toBe(true);
    expect(AlertPreferences.safeParse({ statuses: [], instant: true, timeZone: "America/Chicago" }).success).toBe(false);
    expect(AlertPreferences.safeParse({ statuses: ["LATE"], instant: true, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(AlertPreferences.safeParse({ statuses: ["LATE"], instant: true, timeZone: "UTC", schedule: { times: ["7am"], days: [1] } }).success).toBe(false);
  });
});

describe("scheduled summaries", () => {
  // 2026-10-08 is a Thursday. 12:05Z is 07:05 in Chicago (CDT, UTC-5).
  const schedule = { times: ["07:00", "15:00"], days: [1, 2, 3, 4, 5], skipWhenEmpty: true };

  it("fire in the person's own time zone", () => {
    expect(localClock(new Date("2026-10-08T12:05:00Z"), "America/Chicago")).toEqual({ date: "2026-10-08", time: "07:05", day: 4 });
    expect(dueSlots(schedule, "America/Chicago", new Date("2026-10-08T12:05:00Z"))).toEqual(["2026-10-08T07:00"]);
    expect(dueSlots(schedule, "Europe/London", new Date("2026-10-08T12:05:00Z"))).toEqual([]);
  });

  it("catch up for 30 minutes, then let the slot go, and skip days not chosen", () => {
    expect(dueSlots(schedule, "America/Chicago", new Date("2026-10-08T11:59:00Z"))).toEqual([]);
    expect(dueSlots(schedule, "America/Chicago", new Date("2026-10-08T12:30:00Z"))).toEqual(["2026-10-08T07:00"]);
    expect(dueSlots(schedule, "America/Chicago", new Date("2026-10-08T12:31:00Z"))).toEqual([]);
    expect(dueSlots(schedule, "America/Chicago", new Date("2026-10-10T12:05:00Z"))).toEqual([]); // Saturday
  });
});

describe("instant alerts", () => {
  it("announce changes, but only bad news on first sight", () => {
    expect(isAlertableChange(undefined, "AT_RISK")).toBe(true);
    expect(isAlertableChange(undefined, "LATE")).toBe(true);
    expect(isAlertableChange(undefined, "ON_TIME")).toBe(false);
    expect(isAlertableChange(undefined, "EARLY")).toBe(false);
    expect(isAlertableChange("ON_TIME", "AT_RISK")).toBe(true);
    expect(isAlertableChange("AT_RISK", "LATE")).toBe(true);
    expect(isAlertableChange("AT_RISK", "ON_TIME")).toBe(true);
    expect(isAlertableChange("LATE", "LATE")).toBe(false);
    expect(isAlertableChange("ON_TIME", "UNKNOWN")).toBe(false);
  });

  it("do not repeat a flip-flop within four hours", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(isRepeat({ status: "AT_RISK", at: "2026-10-08T10:00:00Z" }, "AT_RISK", now)).toBe(true);
    expect(isRepeat({ status: "AT_RISK", at: "2026-10-08T07:00:00Z" }, "AT_RISK", now)).toBe(false);
    expect(isRepeat({ status: "AT_RISK", at: "2026-10-08T11:00:00Z" }, "LATE", now)).toBe(false);
  });
});

describe("messages", () => {
  it("say what changed, with times in the person's zone", () => {
    const m = alertMessage({ loadNumber: "LP-1", origin: "Dallas, TX", destination: "Houston, TX", eta: eta() }, "LATE", "America/Chicago");
    expect(m.title).toBe("LP-1 will be late");
    expect(m.body).toBe("Dallas, TX to Houston, TX. ETA Thu 5:00 PM, window Thu 9:00 AM to Thu 1:00 PM. Expected 4 h after the delivery window closes.");
  });

  it("summarize the most urgent first", () => {
    const items = [
      { loadNumber: "LP-3", origin: "A", destination: "Memphis, TN", eta: eta({ eta: "2026-10-08T20:00:00Z" }), status: "AT_RISK" as const },
      { loadNumber: "LP-1", origin: "A", destination: "Houston, TX", eta: eta(), status: "LATE" as const },
      { loadNumber: "LP-2", origin: "A", destination: "Austin, TX", eta: eta({ eta: "2026-10-08T19:00:00Z" }), status: "AT_RISK" as const },
    ];
    const d = digestMessage(items, ["LATE", "AT_RISK"], "UTC", 2);
    expect(d.title).toBe("Shipments: 1 late, 2 at risk");
    expect(d.body.split("\n")).toEqual(["LP-1 late, ETA Thu 10:00 PM (Houston, TX)", "LP-2 at risk, ETA Thu 7:00 PM (Austin, TX)", "and 1 more"]);
    expect(digestMessage([], ["EARLY"], "UTC").body).toBe("No shipments are early right now.");
  });
});
