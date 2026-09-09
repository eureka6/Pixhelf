import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/justified.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { layoutJustifiedImages, layoutJustifiedSkeleton } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

function checkLayout(images, metrics, rowLimit) {
  const layout = layoutJustifiedImages(images, metrics);
  assert.deepEqual(layout.items.map(item => item.image), images, "reading order changed");
  const rows = Map.groupBy(layout.items, item => item.row);
  assert.equal(rows.size, layout.rowCount);
  let bottom = 0;
  for (const [index, row] of rows) {
    assert.ok(row.length <= rowLimit, `row has ${row.length} images; limit is ${rowLimit}`);
    let right = 0;
    for (const { image, style } of row) {
      assert.ok(Object.values(style).every(Number.isFinite));
      assert.ok(style.width > 0 && style.height > 0);
      near(style.width / style.height, image.width / image.height, "aspect ratio changed");
      near(style.height, row[0].style.height, "unequal row heights");
      near(style.left, right, "horizontal gap or overlap");
      near(style.top, index ? bottom + metrics.gap : 0, "vertical gap or overlap");
      right = style.left + style.width + metrics.gap;
    }
    right -= metrics.gap;
    if (index < rows.size - 1) near(right, metrics.width, "row does not fill the container");
    else assert.ok(right <= metrics.width + 1e-6, "last row overflows");
    bottom = row[0].style.top + row[0].style.height;
  }
  near(layout.height, bottom, "incorrect gallery height");
  return layout;
}

let checks = 0;
for (const [width, rowLimit] of [
  [1, 2], [288, 2], [359, 2], [664, 2], [720, 2],
  [721, 5], [737, 5], [1162, 5], [1599, 5], [1600, 6], [2307, 6],
]) {
  for (const gap of [4, 6]) {
    const metrics = { width, gap };
    for (const ratios of [
      [1], [0.7], [1.5], [30],
      Array(100).fill(1.5), Array(100).fill(0.65), Array(100).fill(1),
      Array.from({ length: 185 }, (_, i) => [1.5, 0.67, 1, 1.78, 0.75, 2.1][i % 6]),
      Array.from({ length: 185 }, (_, i) => [0.025, 40, 1.5, 0.7, 1, 4][i % 6]),
    ]) {
      const images = ratios.map((ratio, id) => ({ id, width: ratio * 100, height: 100 }));
      checkLayout(images, metrics, rowLimit);
      for (const count of [1, 5, 59, 60, 61, 120]) {
        if (count >= images.length) continue;
        const before = checkLayout(images.slice(0, count), metrics, rowLimit);
        const after = checkLayout(images.slice(0, count + 30), metrics, rowLimit);
        const completed = before.items.filter(item => item.row < before.rowCount - 1);
        assert.deepEqual(after.items.slice(0, completed.length), completed, "pagination moved a completed row");
      }
      checks++;
    }
    const skeleton = layoutJustifiedSkeleton(metrics);
    checkLayout(skeleton.items.map(item => item.image), metrics, rowLimit);
  }
}

const portraits = Array.from({ length: 20 }, (_, id) => ({ id, width: 600, height: 900 }));
for (const [width, rowLimit, minimumHeight] of [[359, 2, 260], [1162, 5, 300], [2307, 6, 500]]) {
  const metrics = { width, gap: 4 };
  const before = checkLayout(portraits.slice(0, rowLimit), metrics, rowLimit);
  assert.equal(before.rowCount, 1, "portraits split before reaching the row limit");
  assert.ok(before.height > minimumHeight, "portrait row did not grow to fill the width");
  const after = checkLayout(portraits, metrics, rowLimit);
  assert.deepEqual(after.items.slice(0, rowLimit), before.items, "pagination moved a row closed by the limit");
}
const landscapes = Array.from({ length: 12 }, () => ({ width: 1800, height: 1000 }));
const landscapeLayout = checkLayout(landscapes, { width: 1162, gap: 6 }, 5);
assert.equal(landscapeLayout.items.filter(item => item.row === 0).length, 3, "landscape rows changed unnecessarily");
assert.deepEqual(layoutJustifiedImages([], { width: 900, gap: 6 }), { height: 0, rowCount: 0, items: [] });
assert.equal(layoutJustifiedImages([{ width: 100, height: 100 }], { width: 0, gap: 6 }).items.length, 0);
const single = layoutJustifiedImages([{ width: 600, height: 900 }], { width: 1200, gap: 6 });
assert.ok(single.items[0].style.height <= 220, "a sparse final row was enlarged");
console.log(`Justified layout: ${checks} cases passed, including row limits, pagination, panoramas, portraits and skeletons.`);
