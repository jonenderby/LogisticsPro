import { describe, expect, it } from "vitest";
import { type DutyEvent, hosClock, isMoving, milesDriven } from "../src/index.js";

const ev = (status: DutyEvent["status"], at: string): DutyEvent => ({ status, at, source: "DRIVER" });
// Thursday 2026-10-08. The driver rested overnight and came on duty at 06:00.
const shift = [ev("OFF_DUTY", "2026-10-07T18:00:00Z"), ev("ON_DUTY", "2026-10-08T06:00:00Z"), ev("DRIVING", "2026-10-08T06:30:00Z")];

describe("hours of service", () => {
  it("takes a status set this very moment as the current one", () => {
    const c = hosClock([ev("OFF_DUTY", "2026-10-07T18:00:00Z"), ev("ON_DUTY", "2026-10-08T06:00:00Z")], "2026-10-08T06:00:00Z");
    expect(c).toMatchObject({ status: "ON_DUTY", since: "2026-10-08T06:00:00.000Z", shiftStart: "2026-10-08T06:00:00.000Z", windowLeftMin: 840 });
  });

  it("is fully available after 10 hours off", () => {
    const c = hosClock([ev("OFF_DUTY", "2026-10-07T18:00:00Z")], "2026-10-08T05:00:00Z");
    expect(c).toMatchObject({ status: "OFF_DUTY", drivingLeftMin: 660, windowLeftMin: 840, breakLeftMin: 480, availableMin: 480, limitedBy: "BREAK", violations: [] });
    expect(c.shiftStart).toBeUndefined();
  });

  it("counts driving, the 14-hour window and the 8-hour break", () => {
    // 06:30-11:30 driving = 5 h.
    const c = hosClock(shift, "2026-10-08T11:30:00Z");
    expect(c).toMatchObject({ status: "DRIVING", shiftStart: "2026-10-08T06:00:00.000Z", drivingUsedMin: 300, drivingLeftMin: 360, windowLeftMin: 510, breakLeftMin: 180, availableMin: 180, limitedBy: "BREAK" });
  });

  it("resets the break clock after 30 minutes without driving", () => {
    const log = [...shift, ev("ON_DUTY", "2026-10-08T14:30:00Z"), ev("DRIVING", "2026-10-08T15:00:00Z")];
    // 8 h driving, 30 min fueling, 1 h driving.
    const c = hosClock(log, "2026-10-08T16:00:00Z");
    expect(c).toMatchObject({ drivingUsedMin: 540, drivingLeftMin: 120, breakLeftMin: 420, windowLeftMin: 240, availableMin: 120, limitedBy: "DRIVING", violations: [] });
  });

  it("closes the window at 14 hours even with driving time left", () => {
    const log = [...shift, ev("OFF_DUTY", "2026-10-08T10:30:00Z"), ev("ON_DUTY", "2026-10-08T18:00:00Z"), ev("DRIVING", "2026-10-08T18:30:00Z")];
    // 4 h driving, then 7.5 h off (not a full reset), then driving from 18:30.
    const c = hosClock(log, "2026-10-08T19:30:00Z");
    expect(c).toMatchObject({ drivingUsedMin: 300, windowLeftMin: 30, availableMin: 30, limitedBy: "WINDOW" });
    expect(hosClock(log, "2026-10-08T20:30:00Z").violations).toEqual(["Drove 30 min after the 14-hour window closed"]);
  });

  it("flags driving past 11 hours and without a break", () => {
    const c = hosClock(shift, "2026-10-08T18:00:00Z"); // 11.5 h straight
    expect(c.availableMin).toBe(0);
    expect(c.violations).toEqual(["Drove 30 min past the 11-hour driving limit", "Drove more than 8 hours without a 30-minute break"]);
  });

  it("starts a fresh shift after 10 hours of rest, sleeper berth included", () => {
    const log = [...shift, ev("SLEEPER", "2026-10-08T16:30:00Z")];
    expect(hosClock(log, "2026-10-08T22:00:00Z")).toMatchObject({ status: "SLEEPER", restCompleteAt: "2026-10-09T02:30:00.000Z", drivingLeftMin: 60 });
    expect(hosClock(log, "2026-10-09T02:30:00Z")).toMatchObject({ drivingLeftMin: 660, windowLeftMin: 840, restCompleteAt: undefined });
  });

  it("limits the 70-hour cycle over 8 days and restarts after 34 hours off", () => {
    const log: DutyEvent[] = [];
    // Seven 10-hour on-duty days, Oct 1-7.
    for (let d = 1; d <= 7; d++) log.push(ev("ON_DUTY", `2026-10-0${d}T06:00:00Z`), ev("OFF_DUTY", `2026-10-0${d}T16:00:00Z`));
    const c = hosClock(log, "2026-10-08T05:00:00Z");
    expect(c).toMatchObject({ cycleUsedMin: 4200, cycleLeftMin: 0, availableMin: 0, limitedBy: "CYCLE" });
    expect(hosClock(log, "2026-10-08T05:00:00Z", "60/7").cycleLeftMin).toBe(0);
    // 34 hours off from Oct 7 16:00 restarts the cycle.
    expect(hosClock(log, "2026-10-09T02:00:00Z").cycleUsedMin).toBe(0);
  });
});

describe("miles from the phone's trail", () => {
  const p = (lat: number, at: string, speedMps?: number) => ({ geo: { lat, lng: -90 }, at, speedMps });
  it("adds up the trail, estimates gaps and skips glitches", () => {
    const track = [p(35, "2026-10-08T10:00:00Z"), p(35.0145, "2026-10-08T10:01:00Z"), p(35.029, "2026-10-08T10:02:00Z"), p(36, "2026-10-08T10:03:00Z"), p(35.0435, "2026-10-08T10:03:30Z"), p(35.75, "2026-10-08T11:00:00Z")];
    // Three 1-mile hops (the glitch at 36.0 is dropped), then about 58 road miles over a 56-minute gap.
    expect(milesDriven(track, "2026-10-08T10:00:00Z", "2026-10-08T11:00:00Z")).toBeCloseTo(3 + (35.75 - 35.0435) * 69.05 * 1.18, 0);
  });

  it("detects movement from speed or from distance over time", () => {
    expect(isMoving(undefined, p(35, "2026-10-08T10:00:00Z", 20))).toBe(true);
    expect(isMoving(undefined, p(35, "2026-10-08T10:00:00Z", 1))).toBe(false);
    expect(isMoving(p(35, "2026-10-08T10:00:00Z"), p(35.0145, "2026-10-08T10:01:00Z"))).toBe(true);
    expect(isMoving(p(35, "2026-10-08T10:00:00Z"), p(35.0001, "2026-10-08T10:05:00Z"))).toBe(false);
    // 200 miles in 5 minutes is a glitch, not driving.
    expect(isMoving(p(35, "2026-10-08T10:00:00Z"), p(37.9, "2026-10-08T10:05:00Z"))).toBe(false);
  });
});
