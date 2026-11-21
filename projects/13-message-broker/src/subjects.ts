/**
 * Subjects and the subscription trie.
 *
 * A subject is dot-separated tokens: "orders.eu.created". In a SUBSCRIPTION two tokens are special:
 *   "*"  matches exactly one token          orders.*.created  matches orders.eu.created
 *   ">"  matches one or more tokens, last   orders.>          matches orders.eu and orders.eu.created (not "orders")
 * A wildcard is only a wildcard when it is the WHOLE token: "ord*" is a literal token.
 * A PUBLISH subject must not contain wildcards.
 */

export function tokenize(subject: string): string[] {
  return subject.split(".");
}

/** Valid for SUB: non-empty tokens, no whitespace, ">" only as the last token. */
export function isValidSubscribeSubject(subject: string): boolean {
  if (subject.length === 0 || /\s/.test(subject)) return false;
  const tokens = tokenize(subject);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length === 0) return false;
    if (t === ">" && i !== tokens.length - 1) return false;
  }
  return true;
}

/** Valid for PUB: a valid subject with no wildcard tokens. */
export function isValidPublishSubject(subject: string): boolean {
  if (!isValidSubscribeSubject(subject)) return false;
  return tokenize(subject).every((t) => t !== "*" && t !== ">");
}

interface Node<T> {
  next: Map<string, Node<T>>;
  subs: Set<T>;
}

const newNode = <T>(): Node<T> => ({ next: new Map(), subs: new Set() });

/**
 * A trie keyed by subject tokens. "*" and ">" are stored as ordinary keys; matching treats them specially.
 * Matching cost depends on the subject's depth and on how many wildcard branches exist, NOT on the total number
 * of subscriptions, which is the point of a trie over a flat list.
 */
export class SubjectTrie<T> {
  private readonly root: Node<T> = newNode();
  private count = 0;

  get size(): number {
    return this.count;
  }

  insert(subject: string, item: T): void {
    let node = this.root;
    for (const t of tokenize(subject)) {
      let child = node.next.get(t);
      if (!child) {
        child = newNode();
        node.next.set(t, child);
      }
      node = child;
    }
    if (!node.subs.has(item)) {
      node.subs.add(item);
      this.count++;
    }
  }

  /** Removes the item and prunes nodes that became empty, so a long-running server does not keep dead branches. */
  remove(subject: string, item: T): boolean {
    const tokens = tokenize(subject);
    const path: Node<T>[] = [this.root];
    let node = this.root;
    for (const t of tokens) {
      const child = node.next.get(t);
      if (!child) return false;
      node = child;
      path.push(node);
    }
    if (!node.subs.delete(item)) return false;
    this.count--;
    for (let i = tokens.length; i > 0; i--) {
      const n = path[i]!;
      if (n.subs.size > 0 || n.next.size > 0) break;
      path[i - 1]!.next.delete(tokens[i - 1]!);
    }
    return true;
  }

  /** Every item whose subscription matches a (literal) publish subject. An item appears once per subscription. */
  match(subject: string): T[] {
    const out: T[] = [];
    this.walk(this.root, tokenize(subject), 0, out);
    return out;
  }

  /** Number of trie nodes below the root (used by tests to prove pruning). */
  nodeCount(): number {
    const count = (n: Node<T>): number => {
      let c = 0;
      for (const child of n.next.values()) c += 1 + count(child);
      return c;
    };
    return count(this.root);
  }

  private walk(node: Node<T>, tokens: string[], i: number, out: T[]): void {
    if (i === tokens.length) {
      for (const s of node.subs) out.push(s);
      return;
    }
    const literal = node.next.get(tokens[i]!);
    if (literal) this.walk(literal, tokens, i + 1, out);
    const star = node.next.get("*");
    if (star) this.walk(star, tokens, i + 1, out);
    // ">" is always a leaf in a valid subscription, and here at least one token (tokens[i]) is left for it to match.
    const rest = node.next.get(">");
    if (rest) for (const s of rest.subs) out.push(s);
  }
}
