// sux-compute — the Docker plane skeleton (v10 L3).
//
// One Container-enabled Durable Object class ("SuxBox") fronts dind pet boxes:
// each named box is a Linux VM running the compute/Dockerfile image (dockerd
// inside). The Worker routes:
//   GET  /            -> plane manifest (how to use it)
//   ANY  /box/:name/* -> that box's status server (starts the box on demand)
//   GET  /vpc/*       -> through the MAC_VPC Workers-VPC binding (private reach
//                        proof: edge -> sux-home tunnel -> Mac -> local service)
import { Container, getContainer } from "@cloudflare/containers";

export class SuxBox extends Container {
	defaultPort = 8080;
	sleepAfter = "30m";
}

type Env = {
	SUX_BOX: DurableObjectNamespace<SuxBox>;
	MAC_VPC?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
};

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 1), {
		status,
		headers: { "Content-Type": "application/json" },
	});

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		const box = url.pathname.match(/^\/box\/([a-z0-9-]{1,32})(\/.*)?$/);
		if (box) {
			return getContainer(env.SUX_BOX, box[1]).fetch(request);
		}

		if (url.pathname.startsWith("/vpc")) {
			if (!env.MAC_VPC) return json({ error: "no VPC binding deployed" }, 501);
			const upstream = await env.MAC_VPC.fetch("http://sux-mac-test/");
			return json({
				vpc: "sux-home tunnel -> Mac -> 127.0.0.1:18080",
				status: upstream.status,
				body: (await upstream.text()).slice(0, 500),
			});
		}

		return json({
			plane: "sux-compute",
			boxes: "GET /box/:name/ — dind VM per name, starts on demand, sleeps after 30m idle",
			vpc: "GET /vpc — private-reach proof through the sux-home tunnel",
			ssh: "wrangler containers instances sux-compute-suxbox; wrangler containers ssh <INSTANCE_ID>",
		});
	},
};
