import type { Metadata } from "next";

import { Agentation } from "agentation";

import "./globals.css";

export const metadata: Metadata = {
  title: "MailXP",
  description: "MailXP — office mail game frontend built with Next.js and Phaser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {/* Agentation annotation toolbar — development only; syncs to the local
            agentation-mcp server (port 4747) configured in opencode.json. */}
        {process.env.NODE_ENV === "development" && <Agentation endpoint="http://localhost:4747" />}
      </body>
    </html>
  );
}
