export default function Home() {
  return (
    <main>
      <p className="eyebrow">Vinext + WASIX</p>
      <h1>Welcome to Vinext on Wasmer.</h1>
      <p className="lede">
        This Vite-powered Next.js application is running entirely inside your
        browser with Edge.js and the Wasmer SDK.
      </p>
      <div className="actions">
        <a href="/api/hello">Open the API route</a>
        <a href="https://vinext.io" target="_blank" rel="noreferrer">
          Explore Vinext
        </a>
      </div>
    </main>
  );
}
