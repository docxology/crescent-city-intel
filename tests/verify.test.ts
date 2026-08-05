/**
 * Unit tests for the pure verification helpers in src/verify.ts.
 *
 * Only pure logic is exercised — nothing here launches a browser or re-runs
 * the full verification (main() is guarded by import.meta.main).
 * `collectDescendantSections` must mirror the scraper's section enumeration so
 * the verifier's "expected sections" count matches what content.ts actually
 * fetches for a deeply nested tree.
 */
import { describe, test, expect } from "bun:test";
import type { TocNode } from "../src/types.ts";
import { collectDescendantSections } from "../src/verify.ts";

function node(partial: Partial<TocNode>& { children?: TocNode[] }): TocNode {
  return {
    prefix: "", tocName: "Code", guid: partial.guid ?? "g", parent: null, href: "",
    title: partial.title ?? "", number: "", indexNum: "", type: partial.type ?? "article",
    label: "", hideNumber: false, children: partial.children ?? [],
  };
}

describe("collectDescendantSections", () => {
  test("collects sections nested under every container type (division/chapter/part)", () => {
    const tree = node({
      guid: "root",
      type: "article",
      children: [
        node({ guid: "div-1", type: "division", children: [
          node({ guid: "chap-1", type: "chapter", children: [
            node({ guid: "sec-1", type: "section" }),
            node({ guid: "part-1", type: "part", children: [
              node({ guid: "sec-2", type: "section" }),
            ] }),
          ] }),
        ] }),
        node({ guid: "sec-3", type: "section" }),
      ],
    });
    const guids = collectDescendantSections(tree).map((n) => n.guid).sort();
    expect(guids).toEqual(["sec-1", "sec-2", "sec-3"]);
  });

  test("single-level sections are collected", () => {
    const tree = node({ guid: "root", children: [node({ guid: "a", type: "section" })] });
    expect(collectDescendantSections(tree).map((n) => n.guid)).toEqual(["a"]);
  });
});
