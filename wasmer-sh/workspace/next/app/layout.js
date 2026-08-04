import "./globals.css";

export const metadata = {
  title: "Next.js on Wasmer",
  description: "A Next.js application running inside the browser with Wasmer.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
