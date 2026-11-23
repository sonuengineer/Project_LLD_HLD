import { describe, expect, it } from "vitest";
import { NotificationCatalog, type NotificationTypeDef } from "../src/catalog.js";
import { errorCode, OTP, ORDER } from "./helpers.js";

const with_ = (patch: Partial<NotificationTypeDef>): NotificationTypeDef => ({ ...ORDER, ...patch });

describe("catalog", () => {
  it("registers valid types and returns them", () => {
    const c = new NotificationCatalog();
    c.register(OTP);
    c.register(ORDER);
    expect(c.ids()).toEqual(["otp", "order_shipped"]);
    expect(c.get("otp")?.channels).toEqual(["push", "sms", "email"]);
    expect(c.get("nope")).toBeUndefined();
  });

  it("rejects a duplicate id", () => {
    const c = new NotificationCatalog();
    c.register(OTP);
    expect(errorCode(() => c.register(OTP))).toBe("DUPLICATE_TYPE");
  });

  it.each([
    ["bad id", with_({ id: "Order Shipped" })],
    ["empty id", with_({ id: "" })],
    ["unknown category", with_({ category: "promo" as never })],
    ["unknown mode", with_({ mode: "some" as never })],
    ["no channels", with_({ channels: [] })],
    ["unknown channel", with_({ channels: ["push", "fax" as never] })],
    ["channel twice", with_({ channels: ["push", "push"], templates: { push: ORDER.templates.push } })],
    ["missing template", with_({ templates: { push: ORDER.templates.push } })],
    ["empty body", with_({ templates: { ...ORDER.templates, push: { body: "  " } } })],
    ["template for an unlisted channel", with_({ templates: { ...ORDER.templates, sms: { body: "x" } } })],
    ["email without subject", with_({ templates: { ...ORDER.templates, email: { body: "x" } } })],
    ["subject on push", with_({ templates: { ...ORDER.templates, push: { subject: "s", body: "x" } } })],
    ["malformed placeholder in body", with_({ templates: { ...ORDER.templates, push: { body: "{{order-id}}" } } })],
    ["malformed placeholder in subject", with_({ templates: { ...ORDER.templates, email: { subject: "{{a", body: "x" } } })],
  ])("rejects %s with INVALID_TYPE and registers nothing", (_name, def) => {
    const c = new NotificationCatalog();
    expect(errorCode(() => c.register(def))).toBe("INVALID_TYPE");
    expect(c.ids()).toEqual([]);
  });

  it("stores a copy: changing the caller's object later does not change the registered type", () => {
    const c = new NotificationCatalog();
    const def = structuredClone(ORDER);
    c.register(def);
    def.channels.push("sms");
    def.templates.push!.body = "changed";
    expect(c.get(ORDER.id)?.channels).toEqual(["push", "email"]);
    expect(c.get(ORDER.id)?.templates.push?.body).toBe(ORDER.templates.push!.body);
  });
});
