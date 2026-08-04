export default function Home() {
  return (
    <main>
      <p className="eyebrow">Next.js + WASIX</p>
      <h1>Welcome to Next.js on Wasmer.</h1>
      <p className="lede">
        This App Router page is rendered by Edge.js entirely inside your browser.
      </p>
      <div className="actions">
        <a href="/api/hello">Open the API route</a>
        <a href="https://docs.wasmer.io/runtime/runners/wasix" target="_blank">
          Learn about WASIX
        </a>
      </div>
    </main>
  );
}
