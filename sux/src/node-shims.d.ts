// Minimal ambient shims for the Node built-ins we use under `nodejs_compat`,
// so the project keeps its lean no-@types/node setup. The real implementations
// come from the Workers nodejs_compat layer at runtime (and from node in vitest).
declare module "node:zlib" {
	const zlib: any;
	export default zlib;
}
