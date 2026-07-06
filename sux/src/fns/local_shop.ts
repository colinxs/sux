import type { Fn } from "../registry";
import { LOCAL_SHOP_TOOL, runLocalShop } from "../tools/localshop";

export const localShop: Fn = {
	name: LOCAL_SHOP_TOOL.name,
	description: LOCAL_SHOP_TOOL.description,
	inputSchema: LOCAL_SHOP_TOOL.inputSchema,
	cacheable: true,
	run: (env, args) => runLocalShop(env, args),
};
