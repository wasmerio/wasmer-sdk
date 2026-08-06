export default function Home() {
  return (
    <main>
      <style jsx global>{`
        :root {
          color-scheme: dark;
          font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          background: #09090d;
          color: #f4f2f7;
        }
        * { box-sizing: border-box; }
        body {
          min-height: 100vh;
          margin: 0;
          display: grid;
          place-items: center;
          background: radial-gradient(circle at 50% 20%, #30303b 0, transparent 38%), #09090d;
        }
        main { width: min(680px, calc(100% - 48px)); }
        .eyebrow {
          margin: 0 0 18px;
          color: #aaa8b2;
          font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        h1 {
          max-width: 620px;
          margin: 0;
          font-size: clamp(42px, 8vw, 76px);
          font-weight: 560;
          letter-spacing: -0.06em;
          line-height: 0.98;
        }
        .lede {
          max-width: 540px;
          margin: 28px 0;
          color: #aaa8b2;
          font-size: 18px;
          line-height: 1.6;
        }
        .actions { display: flex; flex-wrap: wrap; gap: 12px; }
        a {
          padding: 11px 16px;
          border: 1px solid #363640;
          border-radius: 9px;
          color: inherit;
          text-decoration: none;
        }
      `}</style>
      <p className="eyebrow">Next.js + WASIX</p>
      <h1>Welcome to Next.js on Wasmer.</h1>
      <p className="lede">
        This page is rendered by Edge.js entirely inside your browser.
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
