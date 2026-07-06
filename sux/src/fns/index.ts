import type { Fn } from "../registry";

import { protocol } from "./protocol";
import { proxyFn } from "./proxy";
import { scrape } from "./scrape";
import { dns } from "./dns";
import { whois } from "./whois";
import { ipGeo } from "./ip_geo";
import { tlsInfo } from "./tls_info";
import { headers } from "./headers";
import { redirects } from "./redirects";
import { robots } from "./robots";

import { extract } from "./extract";
import { grep } from "./grep";
import { readability } from "./readability";
import { tables } from "./tables";
import { metadata } from "./metadata";
import { feed } from "./feed";
import { sitemap } from "./sitemap";
import { gtin } from "./gtin";
import { contacts } from "./contacts";
import { select } from "./select";
import { crawl } from "./crawl";

import { htmlMarkdown } from "./html_markdown";
import { csvJson } from "./csv_json";
import { yamlJson } from "./yaml_json";
import { xmlJson } from "./xml_json";
import { subtitles } from "./subtitles";
import { htmlToPdf } from "./html_to_pdf";
import { pdfToText } from "./pdf_to_text";
import { pdfToImages } from "./pdf_to_images";
import { officeToPdf } from "./office_to_pdf";
import { imageConvert } from "./image_convert";

import { compress } from "./compress";
import { archive } from "./archive";
import { optimize } from "./optimize";
import { shrink } from "./shrink";
import { encode } from "./encode";
import { hash } from "./hash";
import { qr } from "./qr";
import { jwt } from "./jwt";

import { summarize } from "./summarize";
import { translate } from "./translate";
import { classify } from "./classify";
import { embed } from "./embed";
import { ocr } from "./ocr";
import { redact } from "./redact";
import { diff } from "./diff";
import { entities } from "./entities";

import { search } from "./search";
import { localShop } from "./local_shop";
import { barcodeLookup } from "./barcode_lookup";
import { wayback } from "./wayback";
import { youtube } from "./youtube";

export const FUNCTIONS: Fn[] = [

	protocol,
	proxyFn,
	scrape,
	dns,
	whois,
	ipGeo,
	tlsInfo,
	headers,
	redirects,
	robots,

	extract,
	grep,
	readability,
	tables,
	metadata,
	feed,
	sitemap,
	gtin,
	contacts,
	select,
	crawl,

	htmlMarkdown,
	csvJson,
	yamlJson,
	xmlJson,
	subtitles,
	htmlToPdf,
	pdfToText,
	pdfToImages,
	officeToPdf,
	imageConvert,

	compress,
	archive,
	optimize,
	shrink,
	encode,
	hash,
	qr,
	jwt,

	summarize,
	translate,
	classify,
	embed,
	ocr,
	redact,
	diff,
	entities,

	search,
	localShop,
	barcodeLookup,
	wayback,
	youtube,
];
