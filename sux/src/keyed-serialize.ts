// Per-isolate serialization of a read-modify-write on a single KV key. Cloudflare
// KV has no compare-and-set, so two RMWs of the same key that interleave lose an
// update: the later put clobbers the earlier writer's just-appended entry. When the
// racing writers share an isolate — a JMAP webhook burst, back-to-back operator
// enqueues, a cron tick overlapping an agent — chaining same-key operations so each
// runs only after the previous one SETTLES (and thus reads the prior's write)
// eliminates that lost update. It does NOT span isolates (a Durable Object would);
// it collapses the common in-isolate burst — the same reduce-not-eliminate posture
// as metrics.ts's sharding. Sibling of single-flight.ts: that coalesces identical
// reads onto one execution; this serializes distinct writes so none is lost.

/**
 * Run `task` after every prior `keyedSerialize` on `key` (in this `chains` map) has
 * settled, so same-key tasks never interleave. `chains` is a per-isolate mutex tail
 * per key; the entry is GC'd once its task is the last one queued. A task's rejection
 * propagates to its own caller but never stalls or rejects the chain (followers still
 * run), mirroring single-flight's rejection handling.
 */
export function keyedSerialize<T>(chains: Map<string, Promise<unknown>>, key: string, task: () => Promise<T>): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	// Start once prev settles regardless of outcome, so one failure can't wedge the queue.
	const run = prev.then(task, task);
	// Followers chain onto a non-rejecting tail so a prior failure doesn't reject them.
	const tail = run.then(
		() => {},
		() => {},
	);
	chains.set(key, tail);
	tail.finally(() => {
		if (chains.get(key) === tail) chains.delete(key);
	});
	return run;
}
