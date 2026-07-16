// Shared constant-time string compare. Every bearer-token/signature/gate check in
// this repo should import this instead of writing its own — #570 happened because
// one of three near-identical copies had silently regressed to a plain !==, and
// nothing caught it since there was no single implementation to review or test.

/** Constant-time compare (avoids leaking a secret via early-exit timing). */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
