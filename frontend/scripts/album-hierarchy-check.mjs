// Exercise album navigation with in-memory data, without starting a service.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const fixture = await build({
  stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
    import { render } from "preact";
    import { useState } from "preact/hooks";
    import { AlbumChildren, AlbumHeading, AlbumsView } from "./src/AlbumsView";
    const albums = ["Live", "Live/Apple", "Live/Apple/2023", "Live/Samsung", "Live2", "收藏", "收藏/Apple"]
      .map(path => ({ path, name: path.split("/").at(-1), count: 1, cover: null }));
    function Fixture() {
      const [path, setPath] = useState(""), [search, setSearch] = useState("");
      const open = path => { setPath(path); setSearch(""); };
      const album = albums.find(album => album.path === path);
      return <main>
        {album ? <><AlbumHeading album={album} onOpen={open} /><AlbumChildren albums={albums} path={path} onOpen={open} /></> : <>
          <input aria-label="搜索相册" value={search} onInput={event => setSearch(event.currentTarget.value)} />
          <AlbumsView albums={albums} search={search} onOpen={open} />
        </>}
      </main>;
    }
    render(<Fixture />, document.getElementById("root"));
  ` },
  bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: "preact",
});
const css = (await Promise.all(["styles.css", "albums.css"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<base href="https://pixhelf.test/"><div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    const paths = () => page.locator("[data-album-path]").evaluateAll(cards => cards.map(card => card.dataset.albumPath));
    const album = path => page.locator(`[data-album-path="${path}"]`);
    assert.deepEqual(await paths(), ["Live", "Live2", "收藏"]);
    await album("Live").click();
    assert.deepEqual(await paths(), ["Live/Apple", "Live/Samsung"]);
    assert.equal(await album("Live/Apple").getAttribute("href"), "/?view=albums&album=Live%2FApple");
    await album("Live/Apple").click();
    assert.deepEqual(await paths(), ["Live/Apple/2023"]);
    await album("Live/Apple/2023").click();
    assert.equal(await page.locator(".album-card").count(), 0);
    await page.getByRole("navigation", { name: "相册路径" }).getByRole("link", { name: "Apple", exact: true }).click();
    assert.deepEqual(await paths(), ["Live/Apple/2023"]);
    await page.getByRole("navigation", { name: "相册路径" }).getByRole("link", { name: "相册", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索相册" }).fill("Apple");
    assert.deepEqual(await paths(), ["Live/Apple", "Live/Apple/2023", "收藏/Apple"]);
    await album("收藏/Apple").click();
    assert.equal(await page.getByRole("heading", { name: "Apple", exact: true }).count(), 1);
    assert.equal(await page.locator(".album-card").count(), 0);
    await page.getByRole("navigation", { name: "相册路径" }).getByRole("link", { name: "相册", exact: true }).click();
    assert.deepEqual(await paths(), ["Live", "Live2", "收藏"]);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ noServer: true, rootFolders: true, directChildren: true, breadcrumbs: true, nestedSearch: true, distinctSameNames: true }));
} finally {
  await browser.close();
}
