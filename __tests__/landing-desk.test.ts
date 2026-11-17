import { describe, expect, test } from "vitest";
import {
  EXAMPLES,
  MAX_CAPTURE,
  START_BALANCE,
  SUGGESTIONS,
  copilotAnswer,
  fileCapture,
  forecast,
  initialDesk,
  money,
  readCapture,
  sparkline,
  toggleTask,
} from "@/app/_components/landing/desk-demo";

describe("readCapture", () => {
  test("bare text is a task for today", () => {
    expect(readCapture("call the bank")).toMatchObject({
      lane: "today",
      glyph: "›",
      title: "call the bank",
      chips: ["task", "today"],
    });
  });

  test("lifts a trailing time, repeat and estimate off a task", () => {
    expect(readCapture("buy milk 5pm")).toMatchObject({
      title: "buy milk",
      chips: ["task", "today", "17:00"],
    });
    expect(readCapture("gym mon/wed/fri")).toMatchObject({
      title: "gym",
      chips: ["task", "↻ mon/wed/fri"],
    });
    expect(readCapture("standup 9:15am weekdays")).toMatchObject({
      title: "standup",
      chips: ["task", "↻ weekdays", "09:15"],
    });
    expect(readCapture("read chapter 4 ~45m")).toMatchObject({
      title: "read chapter 4",
      chips: ["task", "today", "~45m"],
    });
  });

  test("$ is a spend and ? is the copilot", () => {
    expect(readCapture("$4.50 coffee")).toMatchObject({
      lane: "money",
      glyph: "$",
      title: "coffee",
      amount: 4.5,
      chips: ["spend", "$4.50"],
    });
    expect(readCapture("$ coffee")).toMatchObject({
      lane: "money",
      amount: null,
      chips: ["spend"],
    });
    expect(readCapture("? what now")).toMatchObject({
      lane: "copilot",
      glyph: "?",
      title: "what now",
    });
  });
});

describe("fileCapture", () => {
  test("a task goes to the top of today, in the inbox", () => {
    const next = fileCapture(initialDesk(), "buy milk 5pm");
    expect(next.tasks).toHaveLength(4);
    expect(next.tasks[0]).toMatchObject({
      title: "buy milk",
      group: "inbox",
      meta: "today 17:00",
      done: false,
      fresh: true,
    });
    expect(next.last).toEqual({ ok: true, lane: "today", text: "task · today 17:00" });
  });

  test("a spend comes off the balance and is remembered", () => {
    const next = fileCapture(initialDesk(), "$4.50 coffee");
    expect(next.balance).toBe(START_BALANCE - 4.5);
    expect(next.spends[0]).toMatchObject({ amount: 4.5, label: "coffee" });
    expect(next.last).toMatchObject({ ok: true, lane: "money" });
    expect(next.tasks).toHaveLength(3);
  });

  test("a spend with no amount is refused with a hint, and changes nothing else", () => {
    const start = initialDesk();
    const next = fileCapture(start, "$ coffee");
    expect(next.balance).toBe(start.balance);
    expect(next.seq).toBe(start.seq);
    expect(next.last).toMatchObject({ ok: false, lane: "money" });
  });

  test("a question is answered from the board as it stands", () => {
    const next = fileCapture(initialDesk(), "? what should i do tonight");
    expect(next.ask?.question).toBe("what should i do tonight");
    expect(next.ask?.answer).toContain("call the landlord");
    expect(fileCapture(initialDesk(), "?").last).toMatchObject({ ok: false });
  });

  test("empty lines are ignored and long ones are cut", () => {
    const start = initialDesk();
    expect(fileCapture(start, "   ")).toBe(start);
    const long = fileCapture(start, "x".repeat(MAX_CAPTURE * 2));
    expect(long.tasks[0].title).toHaveLength(MAX_CAPTURE);
  });

  test("every id is new and the lists stay short", () => {
    let desk = initialDesk();
    for (let i = 0; i < 20; i++) desk = fileCapture(desk, `thing ${i}`);
    for (let i = 0; i < 20; i++) desk = fileCapture(desk, `$1 thing ${i}`);
    expect(desk.tasks.length).toBeLessThanOrEqual(8);
    expect(desk.spends.length).toBeLessThanOrEqual(4);
    expect(new Set(desk.tasks.map((task) => task.id)).size).toBe(desk.tasks.length);
  });

  test("the lines the page types and suggests all file cleanly", () => {
    for (const line of [...EXAMPLES, ...SUGGESTIONS]) {
      expect(line.length).toBeLessThanOrEqual(MAX_CAPTURE);
      expect(fileCapture(initialDesk(), line).last?.ok).toBe(true);
    }
  });
});

describe("toggleTask", () => {
  test("flips one task and leaves the rest", () => {
    const next = toggleTask(initialDesk(), 2);
    expect(next.tasks.map((task) => task.done)).toEqual([false, true, false]);
    expect(toggleTask(next, 2).tasks[1].done).toBe(false);
  });
});

describe("forecast", () => {
  test("a fortnight: rent takes it down, payday brings it back", () => {
    const { series, low, survives } = forecast(START_BALANCE);
    expect(series).toHaveLength(14);
    expect(series[0]).toBe(START_BALANCE);
    expect(series[3]).toBeLessThan(series[2] - 800);
    expect(series[10]).toBeGreaterThan(series[9] + 2000);
    expect(low).toBe(142.5);
    expect(survives).toBe(true);
  });

  test("spending past the low point stops it surviving", () => {
    expect(forecast(START_BALANCE - 142.5).survives).toBe(true);
    const short = forecast(START_BALANCE - 200);
    expect(short.survives).toBe(false);
    expect(short.low).toBe(-57.5);
  });
});

describe("sparkline", () => {
  test("spans the box and only shows zero when the line crosses it", () => {
    const fine = sparkline(forecast(START_BALANCE).series, 240, 54);
    expect(fine.points.split(" ")).toHaveLength(14);
    expect(fine.xs[0]).toBe(0);
    expect(fine.xs[13]).toBe(240);
    expect(fine.zeroY).toBeNull();
    for (const y of fine.ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(54);
    }

    const short = sparkline(forecast(100).series, 240, 54);
    expect(short.zeroY).not.toBeNull();
  });

  test("zero stays inside the box even when every day is in the red", () => {
    const sunk = sparkline(forecast(-4000).series, 240, 54);
    expect(sunk.zeroY).toBeGreaterThanOrEqual(0);
    expect(sunk.zeroY).toBeLessThanOrEqual(54);
    for (const y of sunk.ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(54);
    }
  });

  test("a flat series does not divide by zero", () => {
    const flat = sparkline([0, 0, 0], 100, 40);
    expect(flat.ys.every(Number.isFinite)).toBe(true);
  });
});

describe("copilotAnswer", () => {
  test("says what is open, and whether the money holds", () => {
    const desk = initialDesk();
    expect(copilotAnswer(desk)).toMatch(/^3 open\. start with call the landlord/);
    expect(copilotAnswer(desk)).toContain("money holds through rent");
  });

  test("counts what is done and warns when the money is short", () => {
    let desk = initialDesk();
    for (const task of desk.tasks) desk = toggleTask(desk, task.id);
    expect(copilotAnswer(desk)).toMatch(/^nothing open today/);

    const broke = fileCapture(initialDesk(), "$5000 yacht");
    expect(copilotAnswer(broke)).toContain("short before payday");
  });
});

describe("money", () => {
  test("formats with two decimals and a real minus", () => {
    expect(money(1240.5)).toBe("$1,240.50");
    expect(money(-4.5)).toBe("−$4.50");
  });
});
