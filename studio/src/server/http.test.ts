import { describe, expect, it } from "vitest";
import { clientIp } from "./http";

const req = (xff?: string) => new Request("http://studio.test/", xff === undefined ? undefined : { headers: { "x-forwarded-for": xff } });

describe("clientIp", () => {
  it("takes the entry the nearest trusted proxy appended, not the client-supplied first hop", () => {
    expect(clientIp(req("spoofed, 1.2.3.4"), 1)).toBe("1.2.3.4");
  });

  it("counts back through more trusted proxies", () => {
    expect(clientIp(req("spoofed, 1.2.3.4"), 2)).toBe("spoofed");
    expect(clientIp(req("spoofed, 1.2.3.4, 10.0.0.1"), 2)).toBe("1.2.3.4");
  });

  it("trims the entry", () => {
    expect(clientIp(req("  1.2.3.4  "), 1)).toBe("1.2.3.4");
  });

  it("is 'unknown' without the header, with fewer entries than hops, or with an empty entry", () => {
    expect(clientIp(req(), 1)).toBe("unknown");
    expect(clientIp(req("1.2.3.4"), 2)).toBe("unknown");
    expect(clientIp(req("1.2.3.4, "), 1)).toBe("unknown");
  });

  it("bounds the length of what it returns", () => {
    expect(clientIp(req("x".repeat(500)), 1)).toHaveLength(64);
  });
});
