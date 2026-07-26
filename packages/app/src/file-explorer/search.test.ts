import { describe, expect, it } from "vitest";
import {
  buildSearchRows,
  expandedPathsForReveal,
  explorerEntryFromSearchSuggestion,
  filterSearchSuggestions,
} from "./search";

describe("file explorer search helpers", () => {
  it("maps suggestion entries to explorer rows with relative path labels", () => {
    const rows = buildSearchRows(
      [
        { path: "src/app.tsx", kind: "file" },
        { path: "src/components", kind: "directory" },
      ],
      "name",
      true,
    );
    expect(rows.map((row) => row.displayName)).toEqual(["src/components", "src/app.tsx"]);
    expect(rows.find((row) => row.entry.name === "app.tsx")?.entry.name).toBe("app.tsx");
  });

  it("filters hidden paths when hidden files are off", () => {
    const filtered = filterSearchSuggestions(
      [
        { path: "src/.env", kind: "file" },
        { path: "src/app.tsx", kind: "file" },
      ],
      false,
    );
    expect(filtered).toEqual([{ path: "src/app.tsx", kind: "file" }]);
  });

  it("builds ancestor paths for tree reveal", () => {
    expect(expandedPathsForReveal("src/components/ui")).toEqual([
      ".",
      "src",
      "src/components",
      "src/components/ui",
    ]);
  });

  it("uses the path basename for icon lookup", () => {
    const entry = explorerEntryFromSearchSuggestion({
      path: "packages/app/index.ts",
      kind: "file",
    });
    expect(entry.name).toBe("index.ts");
    expect(entry.path).toBe("packages/app/index.ts");
  });
});
