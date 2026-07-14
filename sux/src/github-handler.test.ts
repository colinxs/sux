import { describe, expect, it } from "vitest";
import { redactPublicHealth } from "./github-handler";

describe("redactPublicHealth", () => {
	it("strips cron sub-job error text but keeps the ok/stale/age_ms signal", () => {
		const h = {
			status: "ok",
			cron: {
				mail_triage: { seen: true, ok: false, stale: false, age_ms: 1000, error: "upstream 500: http://10.0.0.1/secret leaked" },
				briefing: { seen: true, ok: true, stale: false, age_ms: 2000 },
			},
		};
		const redacted = redactPublicHealth(h) as any;
		expect(redacted.cron.mail_triage).toMatchObject({ seen: true, ok: false, stale: false, age_ms: 1000 });
		expect(redacted.cron.mail_triage.error).toBeUndefined();
		expect(redacted.cron.briefing).toMatchObject({ seen: true, ok: true, stale: false, age_ms: 2000 });
		expect(JSON.stringify(redacted)).not.toContain("leaked");
	});

	it("drops the residential exit and node hostname/IPs, keeping the datacenter exit", () => {
		const h = {
			tailscale: {
				residential: { ip: "1.2.3.4", org: "Comcast" },
				node: { hostname: "my-mac.tail.ts.net", tailscaleIPs: ["100.1.2.3"], online: true },
			},
		};
		const redacted = redactPublicHealth(h) as any;
		expect(redacted.tailscale.residential).toBeNull();
		expect(redacted.tailscale.node.hostname).toBeUndefined();
		expect(redacted.tailscale.node.tailscaleIPs).toBeUndefined();
		expect(redacted.tailscale.node.online).toBe(true);
	});
});
