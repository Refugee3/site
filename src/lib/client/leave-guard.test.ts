import { describe, expect, it } from "vitest";
import { shouldGuardClick, type LinkClick } from "./leave-guard";

const HERE = "https://grader.example/teacher/assignments/a1/key?manual=1";

function click(o: Partial<LinkClick> = {}): LinkClick {
  return {
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
    href: "/teacher/assignments/a1", target: null, download: false, ...o,
  };
}

describe("shouldGuardClick", () => {
  it("guards a plain click on a link to another page of the app", () => {
    expect(shouldGuardClick(click(), HERE)).toBe(true);
    expect(shouldGuardClick(click({ href: "../a1/settings" }), HERE)).toBe(true);
    expect(shouldGuardClick(click({ href: "https://grader.example/teacher" }), HERE)).toBe(true);
    expect(shouldGuardClick(click({ target: "_self" }), HERE)).toBe(true);
    expect(shouldGuardClick(click({ target: "" }), HERE)).toBe(true);
  });

  it("guards a change of the query string on the same path", () => {
    expect(shouldGuardClick(click({ href: "/teacher/assignments/a1/key" }), HERE)).toBe(true);
    expect(shouldGuardClick(click({ href: "?filter=failed" }), HERE)).toBe(true);
  });

  it("lets clicks that open another tab or window through", () => {
    expect(shouldGuardClick(click({ metaKey: true }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ ctrlKey: true }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ shiftKey: true }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ altKey: true }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ button: 1 }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ target: "_blank" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ target: "receipt" }), HERE)).toBe(false);
  });

  it("lets downloads, in-page jumps and already-handled clicks through", () => {
    expect(shouldGuardClick(click({ download: true }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "#item-3" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "/teacher/assignments/a1/key?manual=1#top" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "/teacher/assignments/a1/key?manual=1" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ defaultPrevented: true }), HERE)).toBe(false);
  });

  it("leaves other sites and schemes to the browser", () => {
    expect(shouldGuardClick(click({ href: "https://other.example/teacher" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "http://grader.example/teacher" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "mailto:someone@example.com" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "javascript:void(0)" }), HERE)).toBe(false);
    expect(shouldGuardClick(click({ href: "http://[" }), HERE)).toBe(false);
  });
});
