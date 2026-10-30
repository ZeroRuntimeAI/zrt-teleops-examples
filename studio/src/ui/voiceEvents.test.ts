import { describe, expect, it } from "vitest";
import { LIMITS, TRANSCRIPT_CAP, acceptRobotEvent, initialVoice, parseRobotEvent, reduceVoice, type VoiceEvent, type VoiceState } from "./voiceEvents";

const run = (events: VoiceEvent[], from: VoiceState = initialVoice) => events.reduce(reduceVoice, from);
const on = (...events: VoiceEvent[]) => run([{ t: "dispatched" }, ...events]);

describe("voice reducer", () => {
  it("starts off, with nothing said", () => {
    expect(initialVoice).toEqual({ agent: "off", transcript: [], tools: [] });
  });

  it("queued carries the position, dispatched clears it", () => {
    const queued = run([{ t: "queued", position: 2 }]);
    expect(queued).toMatchObject({ agent: "queued", position: 2 });
    expect(run([{ t: "queued", position: 1 }], queued)).toMatchObject({ position: 1 });
    expect(run([{ t: "dispatched" }], queued)).toMatchObject({ agent: "idle", position: undefined });
  });

  it("agent-state speaking sets agent speaking, and an unknown state changes nothing", () => {
    expect(on({ t: "agent", state: "speaking" }).agent).toBe("speaking");
    expect(on({ t: "agent", state: "thinking" }, { t: "agent", state: "nonsense" }).agent).toBe("thinking");
  });

  it("ignores agent states while voice is off or queued", () => {
    expect(run([{ t: "agent", state: "speaking" }]).agent).toBe("off");
    expect(run([{ t: "queued", position: 1 }, { t: "agent", state: "speaking" }]).agent).toBe("queued");
  });

  it("a tool event with an executor adds a tool row that keeps the label", () => {
    const executor = "scripted planner · uses exact simulator positions";
    const s = on({ t: "tool", name: "pick_up", ok: true, args: { item: "yellow" }, result: { executor } });
    expect(s.tools).toEqual([{ name: "pick_up", ok: true, executor, args: 'item="yellow"' }]);
  });

  it("a tool without an executor has none", () => {
    const s = on({ t: "tool", name: "move_to", ok: false, result: { error: "unreachable" } });
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ name: "move_to", ok: false });
    expect(s.tools[0].executor).toBeUndefined();
  });

  it("caps the transcript at 100 rows, dropping the oldest", () => {
    const events: VoiceEvent[] = Array.from({ length: TRANSCRIPT_CAP + 20 }, (_, i) => ({ t: "say", who: i % 2 ? "agent" : "you", text: `line ${i}` }));
    const s = on(...events);
    expect(s.transcript).toHaveLength(TRANSCRIPT_CAP);
    expect(s.transcript[0].text).toBe("line 20");
    expect(s.transcript.at(-1)?.text).toBe(`line ${TRANSCRIPT_CAP + 19}`);
  });

  it("drops the same line from the same speaker arriving twice (room event and SDK transcript)", () => {
    const s = on({ t: "say", who: "you", text: "Pick up the cube" }, { t: "say", who: "you", text: " pick up the cube. " }, { t: "say", who: "agent", text: "On it." });
    expect(s.transcript.map((r) => r.text)).toEqual(["Pick up the cube", "On it."]);
  });

  it("ignores empty lines", () => {
    expect(on({ t: "say", who: "you", text: "  " }).transcript).toEqual([]);
  });

  it("off keeps what was said and clears the queue", () => {
    const s = run([{ t: "queued", position: 3 }, { t: "say", who: "you", text: "hi" }, { t: "off" }]);
    expect(s).toMatchObject({ agent: "off", position: undefined });
    expect(s.transcript).toHaveLength(1);
  });
});

describe("parseRobotEvent", () => {
  it("maps heard, agent and tool messages", () => {
    expect(parseRobotEvent('{"t":"heard","text":"hello"}')).toEqual({ t: "say", who: "you", text: "hello" });
    expect(parseRobotEvent('{"t":"agent","state":"thinking"}')).toEqual({ t: "agent", state: "thinking" });
    expect(parseRobotEvent('{"t":"tool","name":"place","args":{"x":1},"ok":true,"result":{"executor":"e"}}')).toEqual({
      t: "tool",
      name: "place",
      ok: true,
      args: { x: 1 },
      result: { executor: "e" },
    });
  });

  it("ignores state summaries, malformed JSON and unknown shapes", () => {
    expect(parseRobotEvent('{"t":"state","gripper":0.5}')).toBeNull();
    expect(parseRobotEvent("not json")).toBeNull();
    expect(parseRobotEvent('{"t":"heard"}')).toBeNull();
    expect(parseRobotEvent('{"t":"tool","ok":true}')).toBeNull();
    expect(parseRobotEvent("null")).toBeNull();
  });
});

describe("untrusted input", () => {
  const long = (n: number) => "x".repeat(n);

  it("truncates oversize text, tool names, executors and arguments, with an ellipsis", () => {
    const s = on(
      { t: "say", who: "you", text: long(LIMITS.text + 500) },
      { t: "tool", name: long(200), ok: true, args: { note: long(5000), other: long(5000), third: long(5000) }, result: { executor: long(1000) } },
    );
    expect(s.transcript[0].text).toHaveLength(LIMITS.text);
    expect(s.transcript[0].text.endsWith("…")).toBe(true);
    const [tool] = s.tools;
    expect(tool.name).toHaveLength(LIMITS.name);
    expect(tool.executor).toHaveLength(LIMITS.executor);
    expect(tool.args!.length).toBeLessThanOrEqual(LIMITS.args);
    expect(tool.args!.endsWith("…")).toBe(true);
  });

  it("leaves text at the limit alone", () => {
    expect(on({ t: "say", who: "you", text: long(LIMITS.text) }).transcript[0].text).toBe(long(LIMITS.text));
  });

  it("formats deeply nested and wide arguments in bounded space", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i += 1) deep = { next: deep };
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const s = on({ t: "tool", name: "t", args: { deep, wide, list: Array.from({ length: 1000 }, (_, i) => i) } as Record<string, unknown> });
    expect(s.tools[0].args!.length).toBeLessThanOrEqual(LIMITS.args);
    expect(s.tools[0].args).toContain("deep={next: {next: {…}}}");
  });

  it("survives malformed rows given to the reducer", () => {
    const bad = [{ t: "say", who: "you", text: undefined }, { t: "say", who: "you", text: 7 }, { t: "say", who: "you", text: { a: 1 } }, { t: "tool", name: 3 }] as unknown as VoiceEvent[];
    expect(on(...bad)).toMatchObject({ transcript: [], tools: [] });
  });

  it("refuses a message that is far too large", () => {
    expect(parseRobotEvent(JSON.stringify({ t: "heard", text: long(100_000) }))).toBeNull();
  });
});

describe("acceptRobotEvent", () => {
  const heard = '{"t":"heard","text":"hi"}';
  it("believes only the room's agent participant", () => {
    expect(acceptRobotEvent(heard, "agent-1", "agent-1")).toEqual({ t: "say", who: "you", text: "hi" });
    expect(acceptRobotEvent(heard, "intruder", "agent-1")).toBeNull();
    expect(acceptRobotEvent('{"t":"tool","name":"pick_up","ok":true,"result":{"executor":"forged"}}', "intruder", "agent-1")).toBeNull();
    expect(acceptRobotEvent('{"t":"agent","state":"speaking"}', "intruder", "agent-1")).toBeNull();
  });
  it("drops everything before an agent is known", () => {
    expect(acceptRobotEvent(heard, "agent-1", null)).toBeNull();
  });
});
