// Function manifest — one import per capability file. Adding a function =
// create fns/<name>.ts and list it here. The registry projects these into the
// MCP tools/list and dispatches tools/call.

import type { Fn } from "../registry";
import { protocol } from "./protocol";
import { scrape } from "./scrape";
import { extract } from "./extract";
import { hash } from "./hash";
import { encode } from "./encode";
import { localShop } from "./local_shop";
import { youtube } from "./youtube";

export const FUNCTIONS: Fn[] = [
	// working
	protocol,
	scrape,
	extract,
	hash,
	encode,
	localShop,
	// stubs (greenlit — fill in per phases)
	youtube,
];
