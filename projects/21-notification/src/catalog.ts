// The catalog of notification TYPES ("order_shipped", "otp", "weekly_digest"). A type is data, not a class: its
// category, its channels in order of preference, its delivery mode and a template per channel. Everything is checked
// at registration, so a typo in a template is found at startup, not when the first user triggers the type.
import { NotificationError } from "./errors.js";
import { placeholders, type Template } from "./template.js";
import { isCategory, isChannel, type Category, type Channel, type DeliveryMode } from "./types.js";

export interface NotificationTypeDef {
  id: string;
  category: Category;
  channels: Channel[]; // order matters in "first" mode
  mode: DeliveryMode;
  templates: Partial<Record<Channel, Template>>; // one per listed channel (and no others)
}

const TYPE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;

function invalid(message: string): never {
  throw new NotificationError("INVALID_TYPE", message);
}

export class NotificationCatalog {
  private readonly types = new Map<string, NotificationTypeDef>();

  register(def: NotificationTypeDef): void {
    if (typeof def.id !== "string" || !TYPE_ID.test(def.id)) invalid(`type id must match ${TYPE_ID}: ${String(def.id)}`);
    if (this.types.has(def.id)) throw new NotificationError("DUPLICATE_TYPE", `type ${def.id} is already registered`);
    if (!isCategory(def.category)) invalid(`${def.id}: unknown category ${String(def.category)}`);
    if (def.mode !== "all" && def.mode !== "first") invalid(`${def.id}: mode must be "all" or "first"`);
    if (!Array.isArray(def.channels) || def.channels.length === 0) invalid(`${def.id}: at least one channel`);
    const seen = new Set<Channel>();
    for (const channel of def.channels) {
      if (!isChannel(channel)) invalid(`${def.id}: unknown channel ${String(channel)}`);
      if (seen.has(channel)) invalid(`${def.id}: channel ${channel} listed twice`);
      seen.add(channel);
    }
    const templates = def.templates ?? {};
    for (const key of Object.keys(templates)) {
      if (!isChannel(key) || !seen.has(key)) invalid(`${def.id}: template for a channel not in the list: ${key}`);
    }
    for (const channel of def.channels) {
      const template = templates[channel];
      if (!template || typeof template.body !== "string" || template.body.trim() === "") {
        invalid(`${def.id}: no template body for ${channel}`);
      }
      if (channel === "email" && (typeof template.subject !== "string" || template.subject.trim() === "")) {
        invalid(`${def.id}: an email template needs a subject`);
      }
      // in_app may have one (the item's title); sms and push have no subject line.
      if ((channel === "sms" || channel === "push") && template.subject !== undefined) invalid(`${def.id}: ${channel} has no subject`);
      placeholders(template.body); // throws on a malformed placeholder
      if (template.subject !== undefined) placeholders(template.subject);
    }
    // Store a copy, so the caller changing its object later cannot change a registered type.
    const copy: NotificationTypeDef = {
      id: def.id,
      category: def.category,
      mode: def.mode,
      channels: [...def.channels],
      templates: Object.fromEntries(def.channels.map((c) => [c, { ...templates[c]! }])),
    };
    this.types.set(def.id, copy);
  }

  get(id: string): NotificationTypeDef | undefined {
    return this.types.get(id);
  }

  ids(): string[] {
    return [...this.types.keys()];
  }
}
