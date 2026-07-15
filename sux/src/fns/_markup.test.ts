import { describe, expect, it } from "vitest";
import { decodeEntities } from "./_markup";

// decodeEntities is the canonical HTML/XML entity decoder shared by _convert.ts
// (XML text/attribute decoding) and the retail scrapers (amazon/lowes/homedepot/
// ace/costco), replacing five near-identical copies that had each drifted on which
// specific numeric entities (&#38; vs &#34; vs &#39; vs &#x27;) they special-cased.

describe("decodeEntities (canonical HTML/XML entity decoder)", () => {
	it("decodes the named entities", () => {
		expect(decodeEntities("a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;&nbsp;e")).toBe(`a <b> & "c" 'd' e`);
	});

	it("decodes general numeric entities, hex and decimal, including leading zeros", () => {
		expect(decodeEntities("&#39;")).toBe("'");
		expect(decodeEntities("&#039;")).toBe("'");
		expect(decodeEntities("&#x27;")).toBe("'");
		expect(decodeEntities("&#x027;")).toBe("'");
		expect(decodeEntities("&#38;")).toBe("&");
		expect(decodeEntities("&#8217;")).toBe("’"); // right single quotation mark
	});

	it("decodes &amp; LAST so a double-escaped &amp;lt; stays literal '&lt;' text, not '<'", () => {
		expect(decodeEntities("a &amp;lt; b")).toBe("a &lt; b");
	});

	it("leaves an out-of-range numeric entity intact instead of throwing RangeError", () => {
		// > U+10FFFF is not a valid code point; String.fromCodePoint throws. The
		// decoder must survive it (leaving the raw entity) so one bad entity can't
		// abort the whole conversion.
		expect(decodeEntities("a &#x110000; b")).toBe("a &#x110000; b");
		expect(decodeEntities("a &#1114112; b")).toBe("a &#1114112; b");
		// A valid neighbour still decodes.
		expect(decodeEntities("&#x27;&#x110000;")).toBe("'&#x110000;");
	});
});
