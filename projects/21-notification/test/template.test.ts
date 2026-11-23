import { describe, expect, it } from "vitest";
import { escapeHtml, placeholders, renderTemplate, renderText } from "../src/template.js";
import { errorCode } from "./helpers.js";

describe("templates", () => {
  it("fills flat and dotted placeholders, with spaces inside the braces", () => {
    expect(renderText("Hi {{ user.name }}, order {{orderId}}", { user: { name: "Asha" }, orderId: "A7" }, false)).toBe(
      "Hi Asha, order A7",
    );
  });

  it("renders numbers and booleans, refuses objects, arrays, NaN and Infinity", () => {
    expect(renderText("{{n}} {{b}} {{z}}", { n: 20, b: false, z: 0 }, false)).toBe("20 false 0");
    for (const bad of [{ x: 1 }, [1], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorCode(() => renderText("{{v}}", { v: bad }, false))).toBe("INVALID_REQUEST");
    }
  });

  it("a missing, null or undefined value is an error, never an empty string", () => {
    expect(errorCode(() => renderText("Code {{code}}", {}, false))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(errorCode(() => renderText("Code {{code}}", { code: null }, false))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(errorCode(() => renderText("Code {{code}}", { code: undefined }, false))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(errorCode(() => renderText("{{a.b}}", { a: "text" }, false))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(errorCode(() => renderText("{{a.b}}", { a: null }, false))).toBe("TEMPLATE_VARIABLE_MISSING");
  });

  it("reads only own properties: {{constructor}} and {{toString}} are missing, not Object internals", () => {
    expect(errorCode(() => renderText("{{constructor}}", {}, false))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(errorCode(() => renderText("{{a.toString}}", { a: {} }, false))).toBe("TEMPLATE_VARIABLE_MISSING");
  });

  it("HTML-escapes values only when asked (email bodies), never the template text itself", () => {
    const data = { name: `<script>alert("x")</script> & 'co'` };
    expect(renderText("<p>{{name}}</p>", data, true)).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;</p>",
    );
    expect(renderText("{{name}}", data, false)).toBe(data.name);
  });

  it("an email subject is plain text; only the body is escaped", () => {
    const out = renderTemplate({ subject: "Hi {{n}}", body: "<p>{{n}}</p>" }, { n: "A&B" }, true);
    expect(out).toEqual({ subject: "Hi A&B", body: "<p>A&amp;B</p>" });
  });

  it("a value that looks like a placeholder is not rendered again, and $ patterns are literal", () => {
    expect(renderText("{{a}}", { a: "{{b}}", b: "no" }, false)).toBe("{{b}}");
    expect(renderText("{{a}}", { a: "$& $1 $$" }, false)).toBe("$& $1 $$");
  });

  it("placeholders() lists paths once in order and rejects malformed braces", () => {
    expect(placeholders("{{a}} {{b.c}} {{a}}")).toEqual(["a", "b.c"]);
    expect(placeholders("no placeholders")).toEqual([]);
    for (const bad of ["{{ bad-name }}", "{{a}", "a}}", "{{}}", "{{1x}}"]) {
      expect(errorCode(() => placeholders(bad))).toBe("INVALID_TYPE");
    }
  });

  it("escapeHtml escapes & first (no double escaping of the others)", () => {
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});
