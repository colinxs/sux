import type { Fn } from "../registry";
import { LOCAL_SHOP_TOOL, runLocalShop } from "../tools/localshop";

// local_shop — local Google-Shopping (search snippets + best-effort price). Wraps
// the working implementation from tools/localshop.ts as a registry Fn.
export const localShop: Fn = {
	name: LOCAL_SHOP_TOOL.name,
	description: LOCAL_SHOP_TOOL.description,
	inputSchema: LOCAL_SHOP_TOOL.inputSchema,
	cacheable: true,
	run: (env, args) => runLocalShop(env, args),
};
